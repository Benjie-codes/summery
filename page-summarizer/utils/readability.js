(function attachReadability(globalScope) {
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

  function textLength(node) {
    return (node?.textContent || "").replace(/\s+/g, " ").trim().length;
  }

  function linkTextRatio(node) {
    const total = textLength(node);
    if (!total) {
      return 1;
    }
    const linkText = Array.from(node.querySelectorAll("a"))
      .map((anchor) => textLength(anchor))
      .reduce((sum, len) => sum + len, 0);
    return linkText / total;
  }

  function stripNoise(root) {
    root.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
    root.querySelectorAll(REMOVE_SELECTORS.join(",")).forEach((el) => el.remove());

    Array.from(root.querySelectorAll("*")).forEach((el) => {
      const len = textLength(el);
      if (len < 50 || linkTextRatio(el) > 0.6) {
        el.remove();
      }
    });
  }

  function scoreElement(el) {
    const paragraphText = Array.from(el.querySelectorAll("p"))
      .map((p) => textLength(p))
      .reduce((sum, len) => sum + len, 0);
    const totalText = textLength(el);
    const commas = (el.textContent || "").split(",").length - 1;
    const linkPenalty = 1 - Math.min(linkTextRatio(el), 0.95);
    return paragraphText + totalText * 0.3 + commas * 10 * linkPenalty;
  }

  function extractMainContent(doc) {
    const clone = doc.body ? doc.body.cloneNode(true) : null;
    if (!clone) {
      return null;
    }

    stripNoise(clone);

    const candidates = Array.from(clone.querySelectorAll("article, main, section, div"));
    let best = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const score = scoreElement(candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best || clone;
  }

  // Simplified, bundled readability-like extractor for extension use.
  globalScope.SimpleReadability = { extractMainContent };
})(typeof window !== "undefined" ? window : globalThis);
