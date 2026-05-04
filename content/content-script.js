const REMOVE_SELECTORS = [
  "nav",
  "header",
  "footer",
  "aside",
  ".sidebar",
  ".advertisement",
  ".ad",
  ".ads",
  ".social-share",
  ".comments",
  ".related-posts",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]'
];

const MAIN_SELECTORS = [
  "main",
  '[role="main"]',
  ".post-content",
  ".article-body",
  ".entry-content",
  ".content-body"
];

function getTextLength(node) {
  return (node?.textContent || "").replace(/\s+/g, " ").trim().length;
}

function getLinkTextRatio(node) {
  const totalText = getTextLength(node);
  if (!totalText) {
    return 1;
  }

  const linkText = Array.from(node.querySelectorAll("a"))
    .map((anchor) => getTextLength(anchor))
    .reduce((sum, length) => sum + length, 0);

  return linkText / totalText;
}

function filterExtractedElement(element) {
  const clone = element.cloneNode(true);

  clone.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
  clone.querySelectorAll(REMOVE_SELECTORS.join(",")).forEach((el) => el.remove());

  // Remove shallow/noisy blocks while preserving content-dense containers.
  Array.from(clone.querySelectorAll("*")).forEach((node) => {
    const textLength = getTextLength(node);
    if (textLength < 50 || getLinkTextRatio(node) > 0.6) {
      node.remove();
    }
  });

  return clone;
}

function getParagraphDensity(element) {
  const paragraphChars = Array.from(element.querySelectorAll("p"))
    .map((paragraph) => getTextLength(paragraph))
    .reduce((sum, count) => sum + count, 0);

  const rect = element.getBoundingClientRect();
  const area = Math.max(rect.width * rect.height, 1);

  return paragraphChars / area;
}

function getHighestDensityElement() {
  const candidates = Array.from(document.querySelectorAll("article, main, section, div"));
  let best = null;
  let bestDensity = 0;

  for (const candidate of candidates) {
    const density = getParagraphDensity(candidate);
    if (density > bestDensity) {
      best = candidate;
      bestDensity = density;
    }
  }

  // Optional fallback to bundled readability-like scoring when density is weak.
  if (!best && window.SimpleReadability?.extractMainContent) {
    return window.SimpleReadability.extractMainContent(document);
  }

  return best;
}

function cleanTitle(rawTitle) {
  return String(rawTitle || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtSentenceBoundary(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  const clipped = text.slice(0, maxLength);
  const lastSentenceEnd = Math.max(
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("!"),
    clipped.lastIndexOf("?")
  );

  if (lastSentenceEnd > Math.floor(maxLength * 0.6)) {
    return clipped.slice(0, lastSentenceEnd + 1).trim();
  }

  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim();
}

function getWordCount(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return 0;
  }
  return normalized.split(/\s+/).length;
}

function chooseBaseElement() {
  const article = document.querySelector("article");
  if (article) {
    return { element: article, method: "article" };
  }

  const mainLike = document.querySelector(MAIN_SELECTORS.join(","));
  if (mainLike) {
    return { element: mainLike, method: "main" };
  }

  const densityElement = getHighestDensityElement();
  if (densityElement) {
    return { element: densityElement, method: "density" };
  }

  return { element: document.body, method: "body" };
}

function extractContent() {
  const { element, method } = chooseBaseElement();
  const filteredElement = filterExtractedElement(element || document.body);
  const content = filteredElement.innerText || filteredElement.textContent || "";
  const fullPageText = document.body?.innerText || "";
  const wordCount = getWordCount(fullPageText);

  return {
    title: cleanTitle(document.title),
    url: window.location.href,
    content,
    wordCount,
    readingTime: Math.ceil(wordCount / 238),
    extractionMethod: method
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "EXTRACT_CONTENT") {
    return true;
  }

  try {
    const result = extractContent();
    const sanitized = window.sanitizeHTML
      ? window.sanitizeHTML(result.content)
      : result.content;

    result.content = truncateAtSentenceBoundary(sanitized, 15000);
    sendResponse(result);
  } catch (error) {
    sendResponse({
      error: "Content extraction failed",
      title: cleanTitle(document.title),
      url: window.location.href
    });
  }

  return true;
});
