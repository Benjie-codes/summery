const PROXY_URL = "http://localhost:8787/summarize";
const CACHE_TTL_MS = 60 * 60 * 1000;

function getCacheKey(url) {
  return `summary_${url}`;
}

function truncateAtBoundary(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  const clipped = text.slice(0, maxLen);
  const boundary = Math.max(
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("!"),
    clipped.lastIndexOf("?")
  );
  return (boundary > maxLen * 0.6 ? clipped.slice(0, boundary + 1) : clipped).trim();
}

async function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

async function storageSet(payload) {
  return new Promise((resolve) => chrome.storage.local.set(payload, resolve));
}

async function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

async function pruneCache() {
  const all = await storageGet(null);
  const entries = Object.entries(all)
    .filter(([key, val]) => key.startsWith("summary_") && val && typeof val === "object")
    .map(([key, val]) => ({ key, timestamp: Number(val.timestamp || 0) }))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (entries.length <= 20) return;
  const toDelete = entries.slice(0, entries.length - 20).map((entry) => entry.key);
  await storageRemove(toDelete);
}

async function summarizeViaProxy({ content, title, url, summaryMode }) {
  if (!content || content.trim().length < 100) {
    return { error: "INSUFFICIENT_CONTENT", message: "Not enough page text to summarize." };
  }

  const safeContent = truncateAtBoundary(content, 15000);
  const cacheKey = getCacheKey(url);
  const existing = await storageGet(cacheKey);
  const cached = existing[cacheKey];
  if (cached && Date.now() - Number(cached.timestamp || 0) <= CACHE_TTL_MS) {
    return { success: true, ...cached, cached: true };
  }

  try {
    const response = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: String(title || ""),
        url: String(url || ""),
        content: safeContent,
        summaryMode: String(summaryMode || "full")
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        error: data.error || "API_ERROR",
        message: data.message || "Unable to summarize right now."
      };
    }

    const payload = {
      summary: data.summary,
      meta: data.meta,
      title: title || "",
      url,
      timestamp: Date.now()
    };
    await pruneCache();
    await storageSet({ [cacheKey]: payload });
    return { success: true, ...payload };
  } catch (error) {
    return { error: "NETWORK_ERROR", message: "Could not reach proxy server." };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "SUMMARIZE") return false;
  summarizeViaProxy(message).then((result) => sendResponse(result));
  return true;
});
