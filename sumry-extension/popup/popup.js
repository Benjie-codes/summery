const States = {
  IDLE: "idle",
  LOADING: "loading",
  SUMMARY: "summary",
  ERROR: "error"
};

const LOADING_MESSAGES = [
  "Reading the page...",
  "Thinking...",
  "Almost there...",
  "Crafting insights..."
];

let currentState = States.IDLE;
let currentSummary = null;
let isHighlighting = false;
let currentMode = "full";
let currentTab = null;
let loadingInterval = null;
let copyResetTimeout = null;
let lastFocusedBeforeSettings = null;

function sanitize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toBase64(input) {
  try {
    return btoa(input);
  } catch (error) {
    return btoa(unescape(encodeURIComponent(input)));
  }
}

function getCacheKey(url) {
  return `sumry_${toBase64(String(url || "")).slice(0, 50)}`;
}

function fmtWords(count) {
  const n = Number(count || 0);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function fmtDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (error) {
    return "unknown";
  }
}

function q(id) {
  return document.getElementById(id);
}

function setState(state, data = {}) {
  currentState = state;
  const ids = ["state-idle", "state-loading", "state-summary", "state-error"];
  ids.forEach((id) => {
    const el = q(id);
    const active = id === `state-${state}`;
    el.classList.toggle("hidden", !active);
    el.classList.remove("state-enter");
    if (active) {
      requestAnimationFrame(() => el.classList.add("state-enter"));
    }
  });

  const toolbarButtons = [q("copyBtn"), q("highlightBtn"), q("clearBtn"), q("modeToggle")];
  const summaryReady = state === States.SUMMARY;
  toolbarButtons.forEach((btn) => {
    if (!btn) return;
    btn.disabled = !summaryReady && btn.id !== "modeToggle";
    btn.setAttribute("aria-disabled", btn.disabled ? "true" : "false");
  });

  if (state === States.ERROR) {
    q("errorText").textContent = sanitize(data.message || "Unable to summarize.");
  }

  if (state === States.LOADING) {
    q("loadingText").textContent = LOADING_MESSAGES[0];
  }
}

function startMessageCycle(messages, delayMs) {
  const label = q("loadingText");
  let index = 0;
  label.textContent = messages[0];
  return setInterval(() => {
    index = (index + 1) % messages.length;
    label.textContent = messages[index];
  }, delayMs);
}

function setTheme(theme) {
  const normalized = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", normalized);
  q("themeIcon").textContent = normalized === "light" ? "☾" : "☀";
}

function updateModeUI(mode) {
  currentMode = mode === "bullets" ? "bullets" : "full";
  q("modeToggle").textContent = currentMode === "full" ? "Full ↔ 3 Bullets" : "3 Bullets ↔ Full";
  q("metaMode").textContent = currentMode === "full" ? "FULL" : "3-BULLETS";
}

function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    q("app").appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1800);
}

async function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response);
    });
  });
}

async function sendTabMessage(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response);
    });
  });
}

function updatePageInfo(tab) {
  q("pageTitle").textContent = sanitize(tab?.title) || "Untitled Page";
  q("pageDomain").textContent = fmtDomain(tab?.url || "");
  if (tab?.favIconUrl) {
    q("pageFavicon").src = tab.favIconUrl;
    q("pageFavicon").classList.remove("hidden");
  } else {
    q("pageFavicon").classList.add("hidden");
  }
}

function renderSummary(data) {
  q("metaWordCount").textContent = `${fmtWords(data.wordCount)} words`;
  q("metaReadingTime").textContent = `${Math.max(1, Number(data.readingTime || 1))}m read`;
  q("cacheBadge").classList.toggle("hidden", data.source !== "cache");

  updateModeUI(data.mode || currentMode);

  const insights = Array.isArray(data.keyInsights) ? data.keyInsights.slice(0, 3) : [];
  const summarySection = q("summarySection");
  const summaryText = q("summaryText");
  const insightsList = q("insightsList");
  insightsList.innerHTML = "";

  if (currentMode === "bullets") {
    summarySection.classList.add("hidden");
  } else {
    summarySection.classList.remove("hidden");
    summaryText.textContent = sanitize(data.summary);
  }

  insights.forEach((insight, index) => {
    const li = document.createElement("li");
    li.style.opacity = "0";
    li.style.transform = "translateY(4px)";
    li.style.transition = "opacity 150ms ease-out, transform 150ms ease-out";

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.textContent = "•";

    const body = document.createElement("div");
    const text = document.createElement("div");
    text.className = "insight-text";
    text.textContent = sanitize(insight);
    body.appendChild(text);

    li.appendChild(dot);
    li.appendChild(body);
    insightsList.appendChild(li);

    setTimeout(() => {
      li.style.opacity = "1";
      li.style.transform = "translateY(0)";
    }, 80 * index);

    requestAnimationFrame(() => {
      if (text.scrollHeight > text.clientHeight + 2) {
        const btn = document.createElement("button");
        btn.className = "expand-btn";
        btn.textContent = "Expand";
        btn.addEventListener("click", () => {
          const expanded = text.classList.toggle("expanded");
          btn.textContent = expanded ? "Collapse" : "Expand";
        });
        body.appendChild(btn);
      }
    });
  });
}

async function summarize() {
  setState(States.LOADING);
  loadingInterval = startMessageCycle(LOADING_MESSAGES, 2000);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await sendRuntimeMessage({
      action: "SUMMARIZE",
      tabId: tab.id,
      url: tab.url,
      mode: currentMode
    });

    clearInterval(loadingInterval);

    if (result?.error) {
      setState(States.ERROR, { message: result.error, code: result.errorCode });
      return;
    }

    currentSummary = result;
    renderSummary(result);
    setState(States.SUMMARY);
  } catch (err) {
    clearInterval(loadingInterval);
    setState(States.ERROR, { message: err.message });
  }
}

function extractHighlightTerms(insights) {
  const words = String((insights || []).join(" "))
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z]/g, ""))
    .filter((w) => w.length > 5);
  return [...new Set(words)].slice(0, 12);
}

async function toggleHighlight() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const btn = q("highlightBtn");

  if (isHighlighting) {
    await sendTabMessage(tab.id, { action: "CLEAR_HIGHLIGHTS" }).catch(() => null);
    isHighlighting = false;
    btn.classList.remove("active");
    return;
  }

  const terms = extractHighlightTerms(currentSummary?.keyInsights?.slice(0, 3) || []);
  if (!terms.length) return;
  await sendTabMessage(tab.id, { action: "HIGHLIGHT_TERMS", terms }).catch(() => null);
  isHighlighting = true;
  btn.classList.add("active");
}

async function copySummary() {
  if (!currentSummary) return;
  const insights = (currentSummary.keyInsights || []).slice(0, 3).map((x) => `• ${sanitize(x)}`).join("\n");
  const text = [
    "--- Sumry Summary ---",
    sanitize(currentTab?.url || ""),
    "",
    sanitize(currentSummary.summary || ""),
    "",
    "Key Insights:",
    insights,
    "",
    `Word count: ${Number(currentSummary.wordCount || 0)} | Reading time: ${Math.max(1, Number(currentSummary.readingTime || 1))}m`
  ].join("\n");

  await navigator.clipboard.writeText(text);

  const btn = q("copyBtn");
  const icon = q("copyIcon");
  const label = q("copyLabel");
  btn.classList.add("copied");
  icon.textContent = "✓";
  label.textContent = "Copied!";
  clearTimeout(copyResetTimeout);
  copyResetTimeout = setTimeout(() => {
    btn.classList.remove("copied");
    icon.textContent = "📋";
    label.textContent = "Copy";
  }, 2000);
}

function openSettings() {
  const panel = q("settingsPanel");
  lastFocusedBeforeSettings = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  const firstInput = q("proxyUrlInput");
  if (firstInput) {
    firstInput.focus();
    firstInput.select?.();
  }
}

function closeSettings() {
  const panel = q("settingsPanel");
  const active = document.activeElement;
  if (active instanceof HTMLElement && panel.contains(active)) {
    active.blur();
  }
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
  const fallbackFocus = q("settingsBtn");
  const returnFocus =
    lastFocusedBeforeSettings instanceof HTMLElement ? lastFocusedBeforeSettings : fallbackFocus;
  if (returnFocus instanceof HTMLElement) {
    returnFocus.focus();
  }
}

async function testConnection() {
  const status = q("connectionStatus");
  const proxyUrl = sanitize(q("proxyUrlInput").value || "http://localhost:3001").replace(/\/$/, "");
  status.textContent = "Testing...";
  try {
    const response = await fetch(`${proxyUrl}/health`);
    if (!response.ok) throw new Error("bad_health");
    status.textContent = "✓ Connected";
  } catch (error) {
    status.textContent = "✗ Failed";
  }
}

async function saveSettings() {
  const modeEl = document.querySelector("input[name='defaultMode']:checked");
  const payload = {
    proxyUrl: sanitize(q("proxyUrlInput").value || "http://localhost:3001"),
    defaultMode: modeEl?.value === "bullets" ? "bullets" : "full",
    highlightEnabled: Boolean(q("highlightOnSummarize").checked),
    theme: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"
  };

  const response = await sendRuntimeMessage({ action: "UPDATE_SETTINGS", settings: payload });
  if (!response?.success) {
    showToast("Could not save settings");
    return;
  }

  highlightEnabled = payload.highlightEnabled;
  updateModeUI(payload.defaultMode);
  showToast("Settings saved");
  closeSettings();
}

async function hydrateFromCache(url) {
  if (!url) return null;
  const key = getCacheKey(url);
  const data = await new Promise((resolve) => chrome.storage.local.get(key, resolve));
  const cached = data[key];
  if (!cached) return null;
  if (Date.now() - Number(cached.timestamp || 0) > 30 * 60 * 1000) return null;
  return { ...cached, source: "cache" };
}

function bindButtonAccessibility() {
  document.querySelectorAll("button[role='button']").forEach((button) => {
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        button.click();
      }
    });
  });
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", async (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && currentState === States.SUMMARY) {
      event.preventDefault();
      await copySummary();
      return;
    }

    if (event.key === "Escape") {
      if (q("settingsPanel").classList.contains("open")) {
        closeSettings();
      } else if (currentState === States.SUMMARY) {
        setState(States.IDLE);
      } else {
        window.close();
      }
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;
    updatePageInfo(tab);

    const settingsResp = await sendRuntimeMessage({ action: "GET_SETTINGS" }).catch(() => ({ settings: {} }));
    const settings = settingsResp?.settings || {};

    setTheme(settings.theme || "dark");
    updateModeUI(settings.defaultMode || "full");
    highlightEnabled = settings.highlightEnabled !== false;

    q("proxyUrlInput").value = settings.proxyUrl || "http://localhost:3001";
    const modeRadio = document.querySelector(`input[name='defaultMode'][value='${currentMode}']`);
    if (modeRadio) modeRadio.checked = true;
    q("highlightOnSummarize").checked = highlightEnabled;

    const cached = await hydrateFromCache(tab?.url);
    if (cached) {
      currentSummary = cached;
      renderSummary(cached);
      setState(States.SUMMARY, cached);
    } else {
      setState(States.IDLE);
    }

    q("summarizeFullBtn").addEventListener("click", () => {
      updateModeUI("full");
      summarize();
    });
    q("summarizeBulletsBtn").addEventListener("click", () => {
      updateModeUI("bullets");
      summarize();
    });
    q("retryBtn").addEventListener("click", summarize);

    q("copyBtn").addEventListener("click", copySummary);
    q("highlightBtn").addEventListener("click", toggleHighlight);
    q("clearBtn").addEventListener("click", async () => {
      await sendRuntimeMessage({ action: "CLEAR_CACHE" }).catch(() => null);
      await sendTabMessage(currentTab.id, { action: "CLEAR_HIGHLIGHTS" }).catch(() => null);
      isHighlighting = false;
      q("highlightBtn").classList.remove("active");
      currentSummary = null;
      setState(States.IDLE);
    });

    q("modeToggle").addEventListener("click", async () => {
      const next = currentMode === "full" ? "bullets" : "full";
      updateModeUI(next);
      await sendRuntimeMessage({ action: "UPDATE_SETTINGS", settings: { defaultMode: next } }).catch(() => null);
    });

    q("themeToggle").addEventListener("click", async () => {
      const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
      const next = currentTheme === "dark" ? "light" : "dark";
      setTheme(next);
      await sendRuntimeMessage({ action: "UPDATE_SETTINGS", settings: { theme: next } }).catch(() => null);
    });

    q("settingsBtn").addEventListener("click", openSettings);
    q("closeSettingsBtn").addEventListener("click", closeSettings);
    q("saveSettingsBtn").addEventListener("click", saveSettings);
    q("testConnectionBtn").addEventListener("click", testConnection);
    q("clearCacheSettingsBtn").addEventListener("click", async () => {
      await sendRuntimeMessage({ action: "CLEAR_CACHE" }).catch(() => null);
      showToast("Cache cleared");
    });

    bindButtonAccessibility();
    bindKeyboardShortcuts();
  } catch (error) {
    setState(States.ERROR, { message: error.message || "Popup initialization failed." });
  }
});
