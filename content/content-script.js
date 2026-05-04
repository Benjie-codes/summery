const ARTICLE_SELECTORS = [
  "article",
  "[role='main']",
  "main",
  ".article-content",
  ".post-content",
  ".entry-content",
  ".content-body",
  "#article-body",
  ".story-body",
  ".article__body"
];

const NOISE_KEYWORDS = [
  "nav",
  "menu",
  "sidebar",
  "footer",
  "header",
  "advertisement",
  "ad-",
  "-ad",
  "cookie",
  "popup",
  "modal",
  "banner",
  "social",
  "share",
  "comment",
  "related",
  "recommended",
  "newsletter",
  "subscribe"
];

const HIGHLIGHT_STYLE_ID = "sumry-highlight-style";
const highlightWeakSet = new WeakSet();

function normalizeText(input) {
  return String(input || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getWordCount(text) {
  const clean = normalizeText(text);
  if (!clean) {
    return 0;
  }
  return clean.split(/\s+/).length;
}

function hasNoiseMarker(el) {
  const className = String(el.className || "").toLowerCase();
  const id = String(el.id || "").toLowerCase();
  return NOISE_KEYWORDS.some((keyword) => className.includes(keyword) || id.includes(keyword));
}

function pruneNoise(root) {
  root
    .querySelectorAll("script,style,noscript,nav,header,footer,aside,[hidden],[aria-hidden='true']")
    .forEach((el) => el.remove());

  root.querySelectorAll("*").forEach((el) => {
    const style = String(el.getAttribute("style") || "").toLowerCase();
    if (style.includes("display:none") || style.includes("visibility:hidden") || hasNoiseMarker(el)) {
      el.remove();
    }
  });
}

function getTextDensity(el) {
  const textLen = normalizeText(el.textContent || "").length;
  const htmlLen = Math.max(String(el.innerHTML || "").length, 1);
  return textLen / htmlLen;
}

function scoreCandidate(el) {
  const text = normalizeText(el.textContent || "");
  const words = text.split(/\s+/).filter(Boolean).length;
  const density = getTextDensity(el);
  return words * density;
}

function findBestByDensity(root) {
  const candidates = Array.from(root.querySelectorAll("article,main,section,div"))
    .filter((el) => normalizeText(el.textContent || "").length > 250)
    .slice(0, 500);
  if (!candidates.length) {
    return null;
  }

  let best = candidates[0];
  let bestScore = scoreCandidate(best);
  candidates.forEach((el) => {
    const score = scoreCandidate(el);
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  });
  return best;
}

function extractFromElement(sourceEl) {
  const clone = sourceEl.cloneNode(true);
  pruneNoise(clone);

  const blocks = Array.from(clone.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,pre"))
    .map((el) => normalizeText(el.textContent || ""))
    .filter((line) => line.length > 30)
    .slice(0, 1200);

  let text = normalizeText(blocks.join("\n\n"));
  if (text.length < 300) {
    text = normalizeText(clone.textContent || "");
  }
  return text.slice(0, 50000);
}

function extractPageContent() {
  let target = null;

  for (const selector of ARTICLE_SELECTORS) {
    const match = document.querySelector(selector);
    if (match && normalizeText(match.textContent || "").length > 150) {
      target = match;
      break;
    }
  }

  if (!target) {
    target = findBestByDensity(document.body);
  }
  if (!target) {
    target = document.body;
  }

  const text = extractFromElement(target);
  const wordCount = getWordCount(text);

  if (text.length < 100) {
    return { error: "insufficient_content" };
  }

  return {
    text,
    title: normalizeText(document.title),
    url: window.location.href,
    wordCount
  };
}

function ensureHighlightStyle() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    mark.sumry-highlight {
      background: rgba(242, 146, 29, 0.25);
      border-bottom: 2px solid #F2921D;
      border-radius: 2px;
      padding: 0 1px;
    }
  `;
  document.head.appendChild(style);
}

function clearHighlights() {
  document.querySelectorAll("mark.sumry-highlight").forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent || ""));
  });
  const style = document.getElementById(HIGHLIGHT_STYLE_ID);
  if (style) {
    style.remove();
  }
}

function shouldSkipTextNode(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest("mark.sumry-highlight")) {
    return true;
  }
  return Boolean(
    parent.closest(
      "script,style,noscript,textarea,input,[contenteditable='true'],[contenteditable=''],[contenteditable]"
    )
  );
}

function escapeRegex(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightTermWithLimit(term, maxOccurrences) {
  const regex = new RegExp(escapeRegex(term), "gi");
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || !node.textContent.trim()) {
        return NodeFilter.FILTER_REJECT;
      }
      return shouldSkipTextNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });

  let count = 0;
  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }

  for (const node of nodes) {
    if (count >= maxOccurrences) {
      break;
    }

    const source = node.textContent || "";
    regex.lastIndex = 0;
    const firstMatch = regex.exec(source);
    if (!firstMatch) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    let last = 0;
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(source)) && count < maxOccurrences) {
      const start = match.index;
      const end = start + match[0].length;
      if (start > last) {
        fragment.appendChild(document.createTextNode(source.slice(last, start)));
      }
      const mark = document.createElement("mark");
      mark.className = "sumry-highlight";
      mark.textContent = source.slice(start, end);
      highlightWeakSet.add(mark);
      fragment.appendChild(mark);
      last = end;
      count += 1;
    }
    if (last < source.length) {
      fragment.appendChild(document.createTextNode(source.slice(last)));
    }
    node.replaceWith(fragment);
  }

  return count;
}

function runWhenIdle(fn) {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => fn(), { timeout: 800 });
    return;
  }
  setTimeout(fn, 0);
}

function highlightKeyTerms(terms) {
  return new Promise((resolve) => {
    runWhenIdle(() => {
      clearHighlights();
      ensureHighlightStyle();
      const cleanTerms = (Array.isArray(terms) ? terms : [])
        .map((term) => normalizeText(term))
        .filter(Boolean)
        .slice(0, 10);

      let total = 0;
      cleanTerms.forEach((term) => {
        total += highlightTermWithLimit(term, 5);
      });

      resolve({ success: true, highlighted: total });
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.action && !message?.type) {
    sendResponse({ success: false, error: "unsupported_action" });
    return true;
  }

  const action = message.action || message.type;

  try {
    if (action === "EXTRACT_CONTENT") {
      const data = extractPageContent();
      if (data.error) {
        sendResponse({ success: false, error: data.error });
      } else {
        sendResponse({ success: true, data });
      }
      return true;
    }

    if (action === "HIGHLIGHT_TERMS" || action === "HIGHLIGHT_CONTENT") {
      highlightKeyTerms(message.terms || message.phrases || [])
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ success: false, error: "highlight_failed" }));
      return true;
    }

    if (action === "CLEAR_HIGHLIGHTS") {
      clearHighlights();
      sendResponse({ success: true });
      return true;
    }

    sendResponse({ success: false, error: "unsupported_action" });
  } catch (error) {
    sendResponse({ success: false, error: "content_script_error" });
  }
  return true;
});
