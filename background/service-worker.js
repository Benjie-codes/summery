const CACHE_PREFIX = "sumry_";
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const CONTENT_TIMEOUT_MS = 10000;

const DEFAULT_SETTINGS = {
  proxyUrl: "http://localhost:3001",
  defaultMode: "full",
  highlightEnabled: true,
  theme: "dark"
};

function toBase64(input) {
  try {
    return btoa(input);
  } catch (error) {
    return btoa(unescape(encodeURIComponent(input)));
  }
}

function getCacheKey(url) {
  return `${CACHE_PREFIX}${toBase64(String(url || "")).slice(0, 50)}`;
}

function mapError(error) {
  const message = String(error?.message || "");
  const lowered = message.toLowerCase();

  if (
    lowered.includes("receiving end does not exist") ||
    lowered.includes("could not establish connection") ||
    lowered.includes("no tab with id")
  ) {
    return {
      error: "Couldn't read this page yet. Try reloading the tab once, then summarize again.",
      errorCode: "CONTENT_SCRIPT_BLOCKED"
    };
  }

  if (error?.code === "CONTENT_TIMEOUT") {
    return {
      error: "Couldn't read this page. Some pages block content scripts.",
      errorCode: "CONTENT_TIMEOUT"
    };
  }
  if (message.includes("403") || lowered.includes("forbidden origin")) {
    return {
      error: "Proxy rejected this extension origin. Check ALLOWED_ORIGIN in proxy .env.",
      errorCode: "FORBIDDEN_ORIGIN"
    };
  }
  if (message.includes("401")) {
    return {
      error: "Proxy authentication failed. Check your Gemini API key in proxy .env.",
      errorCode: "AUTH_ERROR"
    };
  }
  if (message.includes("429")) {
    return {
      error: "Slow down! You've hit the rate limit. Try again in a minute.",
      errorCode: "RATE_LIMIT"
    };
  }
  if (
    message.includes("400") &&
    (lowered.includes("api key") || lowered.includes("model") || lowered.includes("gemini"))
  ) {
    return {
      error: "Proxy could not call Gemini. Check GEMINI_API_KEY and model configuration in proxy-server/.env.",
      errorCode: "PROXY_CONFIG_ERROR"
    };
  }
  if (message.includes("400")) {
    return {
      error: "This page doesn't have enough readable content to summarize.",
      errorCode: "BAD_CONTENT"
    };
  }
  if (message.includes("500")) {
    return {
      error: "The AI is having a moment. Try again shortly.",
      errorCode: "SERVER_ERROR"
    };
  }
  return {
    error: "Can't reach the summary server. Check proxy URL/port and extension host permissions, then ensure the proxy is running.",
    errorCode: "NETWORK_ERROR"
  };
}

async function localGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

async function localSet(value) {
  return new Promise((resolve) => chrome.storage.local.set(value, resolve));
}

async function localRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

async function syncGet(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}

async function syncSet(value) {
  return new Promise((resolve) => chrome.storage.sync.set(value, resolve));
}

async function getSettings() {
  const data = await syncGet("settings");
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

async function updateSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...(partial || {}) };
  await syncSet({ settings: next });
  return next;
}

async function getCached(url) {
  const key = getCacheKey(url);
  const data = await localGet(key);
  const entry = data[key];
  if (!entry) {
    return null;
  }
  if (Date.now() - Number(entry.timestamp || 0) > CACHE_TTL_MS) {
    await localRemove(key);
    return null;
  }
  return entry;
}

async function enforceCacheLimit() {
  const all = await localGet(null);
  const entries = Object.entries(all)
    .filter(([key, value]) => key.startsWith(CACHE_PREFIX) && value && typeof value === "object")
    .map(([key, value]) => ({ key, timestamp: Number(value.timestamp || 0) }))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (entries.length < MAX_CACHE_ENTRIES) {
    return;
  }

  const removeCount = entries.length - (MAX_CACHE_ENTRIES - 1);
  const keys = entries.slice(0, removeCount).map((entry) => entry.key);
  await localRemove(keys);
}

async function setCache(url, data) {
  const key = getCacheKey(url);
  await enforceCacheLimit();
  await localSet({
    [key]: {
      ...data,
      url,
      timestamp: Date.now()
    }
  });
}

async function clearCache() {
  const all = await localGet(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX));
  if (keys.length) {
    await localRemove(keys);
  }
  return { success: true };
}

async function sendExtractRequest(tabId) {
  async function injectContentScript(targetTabId) {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ["content/content-script.js"]
    });
  }

  function requestExtraction(targetTabId) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          const err = new Error("content_script_timeout");
          err.code = "CONTENT_TIMEOUT";
          reject(err);
        }
      }, CONTENT_TIMEOUT_MS);

      chrome.tabs.sendMessage(targetTabId, { action: "EXTRACT_CONTENT" }, (response) => {
        if (done) {
          return;
        }
        clearTimeout(timer);
        done = true;

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success || !response.data) {
          reject(new Error(response?.error || "extract_failed"));
          return;
        }
        resolve(response.data);
      });
    });
  }

  try {
    return await requestExtraction(tabId);
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    const shouldRetryAfterInject =
      message.includes("receiving end does not exist") ||
      message.includes("could not establish connection");

    if (!shouldRetryAfterInject) {
      throw error;
    }

    await injectContentScript(tabId);
    return requestExtraction(tabId);
  }
}

async function callProxy(content, url, mode, title) {
  const settings = await getSettings();
  const proxyBase = String(settings.proxyUrl || DEFAULT_SETTINGS.proxyUrl).replace(/\/$/, "");
  const response = await fetch(`${proxyBase}/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, url, mode, title })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Proxy error ${response.status}: ${err.error || "unknown"}`);
  }

  return response.json();
}

async function handleSummarize(message) {
  try {
    const { tabId, url, mode } = message || {};
    if (!tabId || !url) {
      return { error: "Invalid summarize request.", errorCode: "BAD_REQUEST" };
    }

    const cached = await getCached(url);
    if (cached) {
      return { source: "cache", ...cached };
    }

    const extracted = await sendExtractRequest(tabId);
    if (!extracted?.text || extracted.text.length < 100) {
      return {
        error: "This page doesn't have enough readable content to summarize.",
        errorCode: "BAD_CONTENT"
      };
    }

    const response = await callProxy(extracted.text, url, mode || "full", extracted.title || "");
    const payload = {
      summary: response.summary,
      keyInsights: response.keyInsights,
      readingTime: response.readingTime,
      wordCount: response.wordCount,
      mode: response.mode || mode || "full"
    };

    await setCache(url, payload);
    return { source: "api", ...payload, url };
  } catch (error) {
    return mapError(error);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message?.action || message?.type;

  if (action === "SUMMARIZE") {
    handleSummarize(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse(mapError(err)));
    return true;
  }

  if (action === "GET_SETTINGS") {
    getSettings()
      .then((settings) => sendResponse({ success: true, settings }))
      .catch(() => sendResponse({ success: false, error: "settings_read_failed" }));
    return true;
  }

  if (action === "UPDATE_SETTINGS") {
    updateSettings(message.settings || {})
      .then((settings) => sendResponse({ success: true, settings }))
      .catch(() => sendResponse({ success: false, error: "settings_update_failed" }));
    return true;
  }

  if (action === "CLEAR_CACHE") {
    clearCache()
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false, error: "cache_clear_failed" }));
    return true;
  }

  return false;
});
