const TIPS = [
  "Reading the page structure...",
  "Finding signal over noise...",
  "Distilling key arguments...",
  "Shaping concise output..."
];

let currentTab = null;
let currentData = null;
let toastTimer = null;
let tipTimer = null;
let tipIndex = 0;

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!tabs[0]) return reject(new Error("No active tab"));
      resolve(tabs[0]);
    });
  });
}

function sendTabMessage(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response);
    });
  });
}

function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response);
    });
  });
}

function getCacheKey(url) {
  return `summary_${url}`;
}

function fmtWords(value) {
  const n = Number(value || 0);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k words` : `${n} words`;
}

function sanitize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function showToast(message) {
  const app = document.getElementById("app");
  let toast = app.querySelector(".sumly-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "sumly-toast";
    app.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2000);
}

function applyTheme(theme) {
  const app = document.getElementById("app");
  app.classList.remove("theme-dark", "theme-light");
  app.classList.add(theme === "theme-light" ? "theme-light" : "theme-dark");
}

function setMeta(data, isCached = false) {
  const block = document.getElementById("pageMeta");
  if (!data?.meta) {
    block.classList.add("hidden");
    return;
  }

  block.classList.remove("hidden");
  document.getElementById("pageTitle").textContent = sanitize(data.title || data.meta.title || "");
  document.getElementById("wordCount").textContent = fmtWords(data.meta.wordCount);
  document.getElementById("readingTime").textContent = `~${Math.max(1, Number(data.meta.readingTime || 1))} min read`;

  const badge = document.getElementById("cacheBadge");
  if (isCached && data.timestamp) {
    const mins = Math.max(1, Math.floor((Date.now() - data.timestamp) / 60000));
    badge.textContent = `Cached · ${mins} min ago`;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function renderIdle() {
  return `
    <section class="sumly-idle">
      <div class="sumly-brand-mark" style="font-size:44px;">◈</div>
      <h2>Summarize this page</h2>
      <p class="sumly-muted">One click to get a compact read with key points and insights.</p>
      <button id="idleSummarizeBtn" class="sumly-btn sumly-btn-primary" style="margin-top:14px;">Summarize</button>
    </section>
  `;
}

function renderLoading() {
  return `
    <section class="sumly-loading">
      <div class="sumly-loader"><span></span><span></span><span></span></div>
      <p id="tipLabel" class="sumly-muted"></p>
    </section>
  `;
}

function renderSummary(data) {
  const summary = data.summary || {};
  const points = (summary.keyPoints || []).map((p) => `<li>${sanitize(p)}</li>`).join("");
  const insights = (summary.insights || [])
    .map((i) => `<div class="sumly-insight">${sanitize(i)}</div>`)
    .join("");

  return `
    <section class="sumly-section">
      <div class="sumly-label">SUMMARY</div>
      <p class="sumly-tldr">${sanitize(summary.tldr || "")}</p>
    </section>
    <section class="sumly-section">
      <div class="sumly-label">KEY POINTS</div>
      <ul class="sumly-points">${points}</ul>
    </section>
    ${insights ? `<section class="sumly-section"><div class="sumly-label">INSIGHTS</div>${insights}</section>` : ""}
  `;
}

function setLoadingTips() {
  clearInterval(tipTimer);
  tipIndex = 0;
  const el = document.getElementById("tipLabel");
  if (!el) return;
  el.textContent = TIPS[0];
  tipTimer = setInterval(() => {
    tipIndex = (tipIndex + 1) % TIPS.length;
    const label = document.getElementById("tipLabel");
    if (label) label.textContent = TIPS[tipIndex];
  }, 2000);
}

function render(state, data = null) {
  clearInterval(tipTimer);
  const stateArea = document.getElementById("stateArea");
  const actionBar = document.getElementById("actionBar");

  if (state === "idle") {
    stateArea.innerHTML = renderIdle();
    actionBar.classList.add("hidden");
    setMeta(null);
    document.getElementById("idleSummarizeBtn")?.addEventListener("click", summarizeCurrentPage);
    document.getElementById("idleSummarizeBtn")?.focus();
    return;
  }

  if (state === "loading") {
    stateArea.innerHTML = renderLoading();
    actionBar.classList.add("hidden");
    setLoadingTips();
    return;
  }

  if (state === "error") {
    stateArea.innerHTML = `
      <section class="sumly-section">
        <div class="sumly-label">ERROR</div>
        <p class="sumly-muted">${sanitize(data?.message || "Unable to summarize right now.")}</p>
      </section>
    `;
    actionBar.classList.add("hidden");
    return;
  }

  if (state === "summary") {
    stateArea.innerHTML = renderSummary(data);
    actionBar.classList.remove("hidden");
    setMeta(data, Boolean(data.cached));
    document.getElementById("copyBtn")?.focus();
  }
}

async function maybeHighlight(summary) {
  const settings = await storageGet("settings");
  if (!settings?.settings?.highlightToggle) return;
  const phrases = (summary?.keyPoints || []).slice(0, 3);
  if (!phrases.length || !currentTab?.id) return;
  await sendTabMessage(currentTab.id, { type: "HIGHLIGHT_CONTENT", phrases }).catch(() => null);
  showToast("Highlights applied");
}

function buildCopyText(data) {
  const summary = data.summary || {};
  const points = (summary.keyPoints || []).map((p) => `- ${sanitize(p)}`).join("\n");
  const insights = (summary.insights || []).map((i) => `→ ${sanitize(i)}`).join("\n");
  return [
    "=== SUMLY SUMMARY ===",
    `[${sanitize(data.title || data.meta?.title || "")}]`,
    "",
    "SUMMARY",
    sanitize(summary.tldr || ""),
    "",
    "KEY POINTS",
    points,
    "",
    "INSIGHTS",
    insights,
    "",
    `Source: ${sanitize(data.url || "")}`,
    "Summarized by Sumly",
    "==================="
  ].join("\n");
}

async function summarizeCurrentPage() {
  if (!currentTab?.id) return;
  render("loading");
  try {
    const extracted = await sendTabMessage(currentTab.id, { type: "EXTRACT_CONTENT" });
    if (!extracted || extracted.error) throw new Error(extracted?.message || "No content extracted.");

    const settings = await storageGet("settings");
    const summaryMode = settings?.settings?.summaryMode || "full";
    const result = await sendRuntimeMessage({
      type: "SUMMARIZE",
      content: extracted.content,
      title: extracted.title,
      url: extracted.url,
      summaryMode
    });
    if (!result || result.error) throw new Error(result?.message || "Summarization failed.");

    currentData = result;
    render("summary", result);
    await maybeHighlight(result.summary);
  } catch (error) {
    render("error", { message: error.message || "Unexpected summarization error." });
  }
}

async function init() {
  currentTab = await queryActiveTab().catch(() => null);
  const settings = await storageGet(["theme", "settings"]);
  applyTheme(settings.theme || "theme-dark");

  const cacheKey = currentTab?.url ? getCacheKey(currentTab.url) : null;
  const cached = cacheKey ? (await storageGet(cacheKey))[cacheKey] : null;

  if (cached && Date.now() - Number(cached.timestamp || 0) <= 3600000) {
    currentData = { ...cached, cached: true };
    render("summary", currentData);
  } else {
    if (cacheKey && cached) await storageRemove(cacheKey);
    render("idle");
  }

  document.getElementById("summarizeBtn").addEventListener("click", summarizeCurrentPage);
  document.getElementById("refreshBtn").addEventListener("click", summarizeCurrentPage);
  document.getElementById("clearBtn").addEventListener("click", async () => {
    if (!currentTab?.url) return;
    await storageRemove(getCacheKey(currentTab.url));
    if (currentTab.id) {
      await sendTabMessage(currentTab.id, { type: "CLEAR_HIGHLIGHTS" }).catch(() => null);
    }
    currentData = null;
    render("idle");
    showToast("Cache cleared");
  });
  document.getElementById("copyBtn").addEventListener("click", async () => {
    if (!currentData) return;
    await navigator.clipboard.writeText(buildCopyText(currentData));
    showToast("Copied!");
  });
  document.getElementById("themeToggle").addEventListener("click", async () => {
    const app = document.getElementById("app");
    const next = app.classList.contains("theme-dark") ? "theme-light" : "theme-dark";
    applyTheme(next);
    chrome.storage.local.set({ theme: next });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => render("error", { message: error.message || "Initialization failed." }));
});
