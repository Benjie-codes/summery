const STORAGE_KEYS = {
  theme: "theme",
  settings: "settings",
  summaryCache: "summaryCache"
};

const DEFAULT_SETTINGS = {
  apiKey: "",
  summaryMode: "full",
  highlightToggle: false
};

let currentTabUrl = "";
let currentSummaryData = null;
let toastTimer = null;

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(data) {
  return new Promise((resolve) => chrome.storage.local.set(data, resolve));
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const tab = tabs[0];
      if (!tab?.id) {
        reject(new Error("No active tab found"));
        return;
      }

      resolve(tab);
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function sanitizeForDisplay(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyTheme(theme) {
  const app = document.getElementById("app");
  app.classList.remove("theme-dark", "theme-light");
  app.classList.add(theme === "theme-light" ? "theme-light" : "theme-dark");
  document.getElementById("themeToggle").textContent = theme === "theme-light" ? "☾" : "☀";
}

function showToast(message) {
  const app = document.getElementById("app");
  let toast = app.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    app.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("show");
  }, 2000);
}

function setMeta(meta) {
  const pageMeta = document.getElementById("pageMeta");
  const pageTitle = document.getElementById("pageTitle");
  const wordCount = document.getElementById("wordCount");
  const readingTime = document.getElementById("readingTime");

  if (!meta) {
    pageMeta.classList.add("hidden");
    pageTitle.textContent = "";
    wordCount.textContent = "";
    readingTime.textContent = "";
    return;
  }

  pageMeta.classList.remove("hidden");
  pageTitle.textContent = sanitizeForDisplay(meta.title || "Untitled page");
  wordCount.textContent = `${Number(meta.wordCount || 0).toLocaleString()} words`;
  readingTime.textContent = `${Math.max(1, Number(meta.readingTime || 1))} min read`;
}

function makeLabel(text) {
  const label = document.createElement("div");
  label.className = "summary-section-label";
  label.textContent = text;
  return label;
}

function renderSummary(data) {
  const stateArea = document.getElementById("stateArea");
  const summary = data?.summary || {};
  const root = document.createElement("div");
  root.className = "state-summary";

  const tldrSection = document.createElement("section");
  tldrSection.appendChild(makeLabel("SUMMARY"));
  const tldr = document.createElement("p");
  tldr.className = "summary-tldr";
  tldr.textContent = sanitizeForDisplay(summary.tldr || "");
  tldrSection.appendChild(tldr);
  root.appendChild(tldrSection);

  const keyPoints = Array.isArray(summary.keyPoints) ? summary.keyPoints : [];
  if (keyPoints.length) {
    const pointsSection = document.createElement("section");
    pointsSection.appendChild(makeLabel("KEY POINTS"));
    const ul = document.createElement("ul");
    ul.className = "summary-points";
    for (const point of keyPoints) {
      const li = document.createElement("li");
      li.textContent = sanitizeForDisplay(point);
      ul.appendChild(li);
    }
    pointsSection.appendChild(ul);
    root.appendChild(pointsSection);
  }

  const insights = Array.isArray(summary.insights) ? summary.insights : [];
  if (insights.length) {
    const insightSection = document.createElement("section");
    insightSection.appendChild(makeLabel("INSIGHTS"));
    const list = document.createElement("div");
    list.className = "insight-list";
    for (const insight of insights) {
      const card = document.createElement("div");
      card.className = "insight-card";
      card.textContent = sanitizeForDisplay(insight);
      list.appendChild(card);
    }
    insightSection.appendChild(list);
    root.appendChild(insightSection);
  }

  stateArea.appendChild(root);
}

function render(state, data = {}) {
  const stateArea = document.getElementById("stateArea");
  const actionBar = document.getElementById("actionBar");
  stateArea.innerHTML = "";

  if (state === "idle") {
    stateArea.innerHTML = `
      <section class="state-idle">
        <div class="idle-icon">◈</div>
        <h2 class="idle-title">Ready to summarize</h2>
        <p class="idle-subtext">Capture key ideas and reading time from this page in one click.</p>
        <button id="idleSummarizeBtn" class="action-btn primary">Summarize</button>
      </section>
    `;
    setMeta(null);
    actionBar.classList.add("hidden");
  }

  if (state === "loading") {
    stateArea.innerHTML = `
      <section class="state-loading">
        <div class="loading-dots"><span></span><span></span><span></span></div>
        <p class="loading-text">Analyzing page...</p>
      </section>
    `;
    actionBar.classList.add("hidden");
    setMeta(data.meta || null);
  }

  if (state === "error") {
    stateArea.innerHTML = `
      <section class="state-error">
        <div class="error-icon">⚠</div>
        <p class="error-text"></p>
        <button id="retryBtn" class="action-btn secondary">Try Again</button>
      </section>
    `;
    const errorText = stateArea.querySelector(".error-text");
    errorText.textContent = sanitizeForDisplay(data.message || "Something went wrong.");
    actionBar.classList.add("hidden");
    setMeta(data.meta || null);
  }

  if (state === "summary") {
    renderSummary(data);
    setMeta(data.meta || null);
    actionBar.classList.remove("hidden");
  }

  bindStateButtons();
}

function bindStateButtons() {
  const idleSummarizeBtn = document.getElementById("idleSummarizeBtn");
  const footerSummarizeBtn = document.getElementById("summarizeBtn");
  const retryBtn = document.getElementById("retryBtn");

  if (idleSummarizeBtn) {
    idleSummarizeBtn.addEventListener("click", summarizeCurrentPage);
  }
  if (footerSummarizeBtn) {
    footerSummarizeBtn.onclick = summarizeCurrentPage;
  }
  if (retryBtn) {
    retryBtn.addEventListener("click", summarizeCurrentPage);
  }
}

function buildSummaryText(data) {
  const summary = data?.summary || {};
  const tldr = sanitizeForDisplay(summary.tldr || "");
  const points = (summary.keyPoints || []).map((point) => `- ${sanitizeForDisplay(point)}`);
  const insights = (summary.insights || []).map((item) => `- ${sanitizeForDisplay(item)}`);

  const chunks = [`TLDR\n${tldr}`];
  if (points.length) {
    chunks.push(`\nKEY POINTS\n${points.join("\n")}`);
  }
  if (insights.length) {
    chunks.push(`\nINSIGHTS\n${insights.join("\n")}`);
  }
  return chunks.join("\n");
}

async function clearCurrentCache() {
  if (!currentTabUrl) {
    return;
  }
  const storage = await storageGet(STORAGE_KEYS.summaryCache);
  const summaryCache = { ...(storage[STORAGE_KEYS.summaryCache] || {}) };
  delete summaryCache[currentTabUrl];
  await storageSet({ [STORAGE_KEYS.summaryCache]: summaryCache });
  currentSummaryData = null;
  render("idle");
  showToast("Cache cleared");
}

function toggleSettings(show) {
  const panel = document.getElementById("settingsPanel");
  if (show) {
    panel.classList.remove("hidden");
    requestAnimationFrame(() => panel.classList.add("open"));
    return;
  }

  panel.classList.remove("open");
  const onDone = () => {
    panel.classList.add("hidden");
    panel.removeEventListener("transitionend", onDone);
  };
  panel.addEventListener("transitionend", onDone);
}

async function saveSettings() {
  const apiKey = document.getElementById("apiKeyInput").value.trim();
  const summaryMode = document.getElementById("summaryMode").value;
  const highlightToggle = document.getElementById("highlightToggle").checked;

  if (apiKey && (!apiKey.startsWith("AIza") || apiKey.length !== 39)) {
    showToast("Invalid API key format");
    return;
  }

  await storageSet({
    [STORAGE_KEYS.settings]: {
      apiKey,
      summaryMode,
      highlightToggle
    }
  });
  showToast("Settings saved");
  toggleSettings(false);
}

async function summarizeCurrentPage() {
  try {
    render("loading");
    const settingsData = await storageGet(STORAGE_KEYS.settings);
    const settings = { ...DEFAULT_SETTINGS, ...(settingsData[STORAGE_KEYS.settings] || {}) };
    if (!settings.apiKey) {
      throw new Error("Add your Gemini API key in Settings first.");
    }

    const tab = await queryActiveTab();
    currentTabUrl = tab.url || currentTabUrl;

    const extraction = await sendTabMessage(tab.id, { type: "EXTRACT_CONTENT" });
    if (!extraction || extraction.error) {
      throw new Error(extraction?.error || "Could not extract content from this page.");
    }

    const summaryResponse = await sendRuntimeMessage({
      type: "SUMMARIZE",
      content: extraction.content,
      title: extraction.title,
      url: extraction.url,
      apiKey: settings.apiKey,
      summaryMode: settings.summaryMode
    });

    if (!summaryResponse || summaryResponse.error) {
      throw new Error(summaryResponse?.error || "Failed to summarize this page.");
    }

    const result = {
      summary: summaryResponse.summary || summaryResponse,
      meta: {
        title: extraction.title,
        wordCount: extraction.wordCount,
        readingTime: extraction.readingTime
      },
      url: extraction.url
    };

    const storage = await storageGet(STORAGE_KEYS.summaryCache);
    const summaryCache = { ...(storage[STORAGE_KEYS.summaryCache] || {}) };
    summaryCache[result.url] = result;
    await storageSet({ [STORAGE_KEYS.summaryCache]: summaryCache });
    currentSummaryData = result;
    render("summary", result);
  } catch (error) {
    render("error", { message: error.message || "Unable to summarize page." });
  }
}

async function initialize() {
  const app = document.getElementById("app");
  const themeToggle = document.getElementById("themeToggle");
  const settingsBtn = document.getElementById("settingsBtn");
  const closeSettings = document.getElementById("closeSettings");
  const saveSettingsBtn = document.getElementById("saveSettings");
  const copyBtn = document.getElementById("copyBtn");
  const clearBtn = document.getElementById("clearBtn");
  const toggleKeyVisibility = document.getElementById("toggleKeyVisibility");
  const apiKeyInput = document.getElementById("apiKeyInput");

  const tab = await queryActiveTab().catch(() => null);
  currentTabUrl = tab?.url || "";

  const storage = await storageGet([
    STORAGE_KEYS.theme,
    STORAGE_KEYS.settings,
    STORAGE_KEYS.summaryCache
  ]);

  const savedTheme = storage[STORAGE_KEYS.theme] || "theme-dark";
  applyTheme(savedTheme);

  const settings = { ...DEFAULT_SETTINGS, ...(storage[STORAGE_KEYS.settings] || {}) };
  document.getElementById("apiKeyInput").value = settings.apiKey || "";
  document.getElementById("summaryMode").value = settings.summaryMode || "full";
  document.getElementById("highlightToggle").checked = Boolean(settings.highlightToggle);

  const summaryCache = storage[STORAGE_KEYS.summaryCache] || {};
  const cachedData = currentTabUrl ? summaryCache[currentTabUrl] : null;
  if (cachedData) {
    currentSummaryData = cachedData;
    render("summary", cachedData);
  } else {
    render("idle");
  }

  themeToggle.addEventListener("click", async () => {
    const nextTheme = app.classList.contains("theme-dark") ? "theme-light" : "theme-dark";
    applyTheme(nextTheme);
    await storageSet({ [STORAGE_KEYS.theme]: nextTheme });
  });

  settingsBtn.addEventListener("click", () => toggleSettings(true));
  closeSettings.addEventListener("click", () => toggleSettings(false));
  saveSettingsBtn.addEventListener("click", saveSettings);

  toggleKeyVisibility.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });

  copyBtn.addEventListener("click", async () => {
    if (!currentSummaryData) {
      return;
    }
    await navigator.clipboard.writeText(buildSummaryText(currentSummaryData));
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied ✓";
    showToast("Copied!");
    setTimeout(() => {
      copyBtn.textContent = original;
    }, 2000);
  });

  clearBtn.addEventListener("click", clearCurrentCache);
}

document.addEventListener("DOMContentLoaded", () => {
  initialize().catch((error) => {
    render("error", { message: error.message || "Popup initialization failed." });
  });
});
