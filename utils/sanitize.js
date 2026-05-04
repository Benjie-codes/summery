(function attachSanitizer(globalScope) {
  function isNoiseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return true;
    }

    // Remove purely punctuation lines and single-character lines.
    if (trimmed.length <= 1) {
      return true;
    }

    return /^[\p{P}\p{S}\s]+$/u.test(trimmed);
  }

  function sanitizeHTML(str) {
    const withoutTags = String(str ?? "")
      .replace(/<[^>]*>/g, "")
      .replace(/\r\n?/g, "\n");

    const cleanedLines = [];
    for (const line of withoutTags.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        cleanedLines.push("");
        continue;
      }
      if (!isNoiseLine(trimmed)) {
        cleanedLines.push(trimmed);
      }
    }

    // Collapse empty blocks to at most two newlines between paragraphs.
    return cleanedLines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  globalScope.sanitizeHTML = sanitizeHTML;
})(typeof window !== "undefined" ? window : globalThis);
