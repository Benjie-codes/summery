require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const PORT = Number(process.env.PORT || 3001);
const ALLOWED_ORIGIN = String(process.env.ALLOWED_ORIGIN || process.env.ALLOWED_ORIGINS || "")
  .split(",")[0]
  .trim();

function mergeApiKeys(pluralEnv, singularEnv) {
  const fromList = String(process.env[pluralEnv] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const single = String(process.env[singularEnv] || "").trim();
  const out = [...fromList];
  if (single && !out.includes(single)) {
    out.push(single);
  }
  return out;
}

const GEMINI_API_KEYS = mergeApiKeys("GEMINI_API_KEYS", "GEMINI_API_KEY");
const GROQ_API_KEYS = mergeApiKeys("GROQ_API_KEYS", "GROQ_API_KEY");
const OPENROUTER_API_KEYS = mergeApiKeys("OPENROUTER_API_KEYS", "OPENROUTER_API_KEY");

if (!ALLOWED_ORIGIN) {
  throw new Error("Startup failed: ALLOWED_ORIGIN is missing in .env");
}
if (!GEMINI_API_KEYS.length && !GROQ_API_KEYS.length && !OPENROUTER_API_KEYS.length) {
  throw new Error(
    "Startup failed: set at least one API key — GEMINI_API_KEY / GEMINI_API_KEYS, GROQ_API_KEY / GROQ_API_KEYS, and/or OPENROUTER_API_KEY / OPENROUTER_API_KEYS"
  );
}

const app = express();
app.use(helmet());
app.use(express.json({ limit: "50kb" }));

let upstreamCooldownUntil = 0;

function envNumber(name, fallback) {
  const raw = process.env[name];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function envModelCandidates() {
  const raw = String(process.env.GEMINI_MODEL_CANDIDATES || process.env.GEMINI_MODEL || "gemini-2.5-flash");
  const list = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return list.length ? list : ["gemini-2.5-flash"];
}

// Simple sliding-window limiter: Map<ip, { count, resetTime }>
const rateMap = new Map();
const WINDOW_MS = envNumber("RATE_LIMIT_WINDOW_MS", 60 * 1000);
const MAX_REQUESTS = envNumber("RATE_LIMIT_MAX_REQUESTS", 10);
const UPSTREAM_COOLDOWN_MS = envNumber("UPSTREAM_COOLDOWN_MS", 45000);
const MODEL_CANDIDATES = envModelCandidates();
const GEMINI_MAX_OUTPUT_TOKENS = envNumber("GEMINI_MAX_OUTPUT_TOKENS", 4096);
const GROQ_MODEL = String(process.env.GROQ_MODEL || "llama-3.3-70b-versatile").trim();
const OPENROUTER_MODEL = String(process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini").trim();
const OPENROUTER_HTTP_REFERER = String(process.env.OPENROUTER_HTTP_REFERER || "http://localhost").trim();
const OPENROUTER_APP_TITLE = String(process.env.OPENROUTER_APP_TITLE || "Sumry proxy").trim();

function envProviderOrder() {
  const raw = String(process.env.LLM_PROVIDER_ORDER || "gemini,groq,openrouter")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set(["gemini", "groq", "openrouter"]);
  const seen = new Set();
  const ordered = [];
  for (const p of raw) {
    if (allowed.has(p) && !seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }
  for (const p of ["gemini", "groq", "openrouter"]) {
    if (!seen.has(p)) {
      ordered.push(p);
    }
  }
  return ordered;
}
const PROVIDER_ORDER = envProviderOrder();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateMap.entries()) {
    if (entry.resetTime <= now) {
      rateMap.delete(ip);
    }
  }
}, WINDOW_MS).unref();

function sanitizeContent(input) {
  return String(input || "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .trim();
}

function getPrompt(mode, sanitizedContent, url, title) {
  return `You are a precise content summarizer. Base your answer only on the provided page content.
Avoid vague statements like "this article discusses" unless followed by concrete details from the text.
${mode === "bullets" ? "Provide exactly 3 bullet points summary with concrete facts, names, dates, numbers, or outcomes when available." : "Provide a 3-5 sentence summary that includes the main claim, key evidence/details, and conclusion."}
Respond with this exact JSON structure:
{
"summary": "string — ${mode === "bullets" ? "exactly 3 bullet points as a single string, each starting with • " : "3-5 sentence paragraph"}",
"keyInsights": ["string", "string", "string"],
"readingTime": number,
"wordCount": number
}

Page title: ${title || "unknown"}
Page URL: ${url}

Content to analyze:
${sanitizedContent}`;
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) {
      throw error;
    }
    return JSON.parse(match[0]);
  }
}

function stripCodeFences(text) {
  return String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractSummaryStringFromJsonBlob(text) {
  const s = String(text || "");
  const m = s.match(/"summary"\s*:\s*"/);
  if (!m || m.index === undefined) {
    return null;
  }
  let i = m.index + m[0].length;
  let out = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '"') {
      break;
    }
    out += c;
    i++;
  }
  const trimmed = out.trim();
  return trimmed || null;
}

function extractKeyInsightsLoose(text) {
  const s = String(text || "");
  const m = s.match(/"keyInsights"\s*:\s*\[/);
  if (!m || m.index === undefined) {
    return [];
  }
  let i = m.index + m[0].length;
  const out = [];
  while (i < s.length && out.length < 5) {
    while (i < s.length && /\s|,/.test(s[i])) {
      i++;
    }
    if (s[i] === "]") {
      break;
    }
    if (s[i] !== '"') {
      break;
    }
    i++;
    let chunk = "";
    while (i < s.length) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length) {
        chunk += s[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        break;
      }
      chunk += c;
      i++;
    }
    if (chunk.trim()) {
      out.push(chunk.trim());
    }
  }
  return out.slice(0, 3);
}

function splitIntoSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildFallbackPayload(rawText, mode, sanitizedContent) {
  const clean = stripCodeFences(rawText);
  const extractedSummary = extractSummaryStringFromJsonBlob(clean);
  const looseInsights = extractKeyInsightsLoose(clean);
  const proseBase = extractedSummary || clean;
  const sentences = splitIntoSentences(proseBase);
  const fallbackSummary =
    mode === "bullets"
      ? sentences.slice(0, 3).map((s) => `• ${s.replace(/^•\s*/, "")}`).join("\n")
      : (sentences.slice(0, 5).join(" ") || proseBase.slice(0, 1200));

  const keyInsightsFromText = sentences.slice(0, 3).map((s) => s.replace(/^•\s*/, ""));
  const keyInsights =
    looseInsights.length >= 3
      ? looseInsights.slice(0, 3)
      : cleanInsightList(looseInsights.concat(keyInsightsFromText), proseBase);
  const wordCount = sanitizedContent.split(/\s+/).filter(Boolean).length;
  const readingTime = Math.max(1, Math.ceil(wordCount / 238));

  return {
    summary: String(fallbackSummary || ""),
    keyInsights: [keyInsights[0] || "", keyInsights[1] || "", keyInsights[2] || ""],
    readingTime,
    wordCount,
    mode,
    warning: "Model returned malformed or truncated JSON. Extracted readable fields where possible."
  };
}

function tryParseNestedJson(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return null;
  }
}

function cleanInsightList(insights, summaryText) {
  const list = (Array.isArray(insights) ? insights : [])
    .map((v) => String(v || "").trim().replace(/^•\s*/, ""))
    .filter(Boolean);

  if (list.length >= 3) {
    return [list[0], list[1], list[2]];
  }

  const fallbackSentences = splitIntoSentences(summaryText)
    .map((s) => s.replace(/^•\s*/, ""))
    .filter(Boolean);

  const merged = [...list];
  for (const sentence of fallbackSentences) {
    if (merged.length >= 3) {
      break;
    }
    if (!merged.includes(sentence)) {
      merged.push(sentence);
    }
  }

  if (
    merged.filter(Boolean).length < 3 &&
    fallbackSentences.length < 2 &&
    summaryText.length > 60
  ) {
    const plain = summaryText.includes('"summary"')
      ? (extractSummaryStringFromJsonBlob(summaryText) || summaryText)
      : summaryText;
    const words = plain.split(/\s+/).filter(Boolean);
    if (words.length >= 12) {
      const n = Math.ceil(words.length / 3);
      for (let k = 0; k < 3 && merged.filter(Boolean).length < 3; k++) {
        const chunk = words.slice(k * n, (k + 1) * n).join(" ").trim();
        if (chunk && !merged.includes(chunk)) {
          merged.push(chunk);
        }
      }
    }
  }

  while (merged.length < 3) {
    merged.push("");
  }
  return [merged[0], merged[1], merged[2]];
}

function normalizeParsedPayload(parsed, rawText, mode, sanitizedContent) {
  const rawClean = stripCodeFences(rawText);
  let payloadLike = parsed;
  const nested = tryParseNestedJson(parsed?.summary);
  if (nested && typeof nested === "object") {
    payloadLike = nested;
  }

  let summaryText = String(payloadLike?.summary || parsed?.summary || "").trim();

  const extractedFromSummaryField = extractSummaryStringFromJsonBlob(summaryText);
  const extractedFromRaw = extractSummaryStringFromJsonBlob(rawClean);
  if (extractedFromSummaryField) {
    summaryText = extractedFromSummaryField;
  } else if (extractedFromRaw) {
    summaryText = extractedFromRaw;
  } else if (!summaryText || summaryText.startsWith("{")) {
    summaryText = extractedFromRaw || summaryText || rawClean.slice(0, 1200).trim();
  }

  const looseInsights = extractKeyInsightsLoose(rawClean);
  const modelInsights = Array.isArray(payloadLike?.keyInsights) ? payloadLike.keyInsights : [];
  const keyInsights = cleanInsightList([...modelInsights.map(String), ...looseInsights], summaryText);
  const wordCount = Number(payloadLike?.wordCount) || sanitizedContent.split(/\s+/).filter(Boolean).length;
  const readingTime = Number(payloadLike?.readingTime) || Math.max(1, Math.ceil(wordCount / 238));

  return {
    summary: summaryText,
    keyInsights,
    readingTime,
    wordCount,
    mode
  };
}

function normalizeErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }
  if (typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch (jsonError) {
    return String(error);
  }
}

function isModelUnavailableError(error) {
  const message = normalizeErrorMessage(error).toLowerCase();
  return message.includes("404") || message.includes("not found") || message.includes("unsupported model");
}

function isRetryableUpstreamError(error) {
  const message = normalizeErrorMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("quota exceeded") ||
    message.includes("please retry in") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
}

function shouldTryNextApiKey(error) {
  const message = normalizeErrorMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("quota exceeded") ||
    message.includes("please retry in") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504") ||
    message.includes("timeout") ||
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("403") ||
    message.includes("forbidden") ||
    message.includes("payment required") ||
    message.includes("insufficient")
  );
}

async function geminiGenerateWithKey(prompt, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastModelError;
  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          responseMimeType: "application/json"
        }
      });
      const rawText = result?.response?.text() || "";
      if (!rawText.trim()) {
        throw new Error("Gemini returned an empty response.");
      }
      return rawText;
    } catch (error) {
      lastModelError = error;
      if (shouldTryNextApiKey(error)) {
        throw error;
      }
      if (!isModelUnavailableError(error)) {
        throw error;
      }
    }
  }
  throw lastModelError || new Error("No Gemini model was available.");
}

async function groqChatComplete(prompt, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: GEMINI_MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" }
    })
  });
  const bodyText = await res.text();
  if (!res.ok) {
    const err = new Error(`Groq HTTP ${res.status}: ${bodyText.slice(0, 800)}`);
    err.statusCode = res.status;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (parseErr) {
    const err = new Error(`Groq invalid JSON response: ${bodyText.slice(0, 200)}`);
    err.statusCode = 502;
    throw err;
  }
  const rawText = data?.choices?.[0]?.message?.content || "";
  if (!rawText.trim()) {
    throw new Error("Groq returned an empty response.");
  }
  return rawText;
}

async function openRouterChatComplete(prompt, apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": OPENROUTER_HTTP_REFERER,
    "X-Title": OPENROUTER_APP_TITLE
  };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: GEMINI_MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" }
    })
  });
  const bodyText = await res.text();
  if (!res.ok) {
    const err = new Error(`OpenRouter HTTP ${res.status}: ${bodyText.slice(0, 800)}`);
    err.statusCode = res.status;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (parseErr) {
    const err = new Error(`OpenRouter invalid JSON response: ${bodyText.slice(0, 200)}`);
    err.statusCode = 502;
    throw err;
  }
  const rawText = data?.choices?.[0]?.message?.content || "";
  if (!rawText.trim()) {
    throw new Error("OpenRouter returned an empty response.");
  }
  return rawText;
}

async function generateWithProviderAndKeyChain(prompt) {
  let lastError;
  for (const provider of PROVIDER_ORDER) {
    if (provider === "gemini") {
      for (const apiKey of GEMINI_API_KEYS) {
        try {
          const rawText = await geminiGenerateWithKey(prompt, apiKey);
          console.log(`Summarize OK via gemini (${MODEL_CANDIDATES[0]}…)`);
          return rawText;
        } catch (error) {
          lastError = error;
          if (shouldTryNextApiKey(error) || isModelUnavailableError(error)) {
            console.warn("Gemini key/model failed, trying next key/provider:", normalizeErrorMessage(error).slice(0, 120));
            continue;
          }
          throw error;
        }
      }
      continue;
    }

    if (provider === "groq") {
      for (const apiKey of GROQ_API_KEYS) {
        try {
          const rawText = await groqChatComplete(prompt, apiKey);
          console.log(`Summarize OK via groq (${GROQ_MODEL})`);
          return rawText;
        } catch (error) {
          lastError = error;
          console.warn("Groq failed, trying next key:", normalizeErrorMessage(error).slice(0, 120));
          continue;
        }
      }
      continue;
    }

    if (provider === "openrouter") {
      for (const apiKey of OPENROUTER_API_KEYS) {
        try {
          const rawText = await openRouterChatComplete(prompt, apiKey);
          console.log(`Summarize OK via openrouter (${OPENROUTER_MODEL})`);
          return rawText;
        } catch (error) {
          lastError = error;
          console.warn("OpenRouter failed, trying next key:", normalizeErrorMessage(error).slice(0, 120));
          continue;
        }
      }
    }
  }

  throw lastError || new Error("All configured LLM providers and API keys failed.");
}

function inferStatusFromMessage(message) {
  const lowered = String(message || "").toLowerCase();
  if (
    lowered.includes("429") ||
    lowered.includes("too many requests") ||
    lowered.includes("quota exceeded") ||
    lowered.includes("please retry in")
  ) {
    return 429;
  }
  if (lowered.includes("403") || lowered.includes("forbidden")) {
    return 403;
  }
  if (lowered.includes("401") || lowered.includes("unauthorized") || lowered.includes("api key")) {
    return 401;
  }
  if (lowered.includes("400") || lowered.includes("invalid argument")) {
    return 400;
  }
  if (lowered.includes("fetch failed") || lowered.includes("network")) {
    return 503;
  }
  return 500;
}

function extractRetryDelayMs(message) {
  const text = String(message || "");
  const secMatch = text.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (secMatch) {
    return Math.ceil(Number(secMatch[1]) * 1000);
  }
  const genericSec = text.match(/retry(?:[^0-9]{1,20})([0-9]+)\s*seconds?/i);
  if (genericSec) {
    return Number(genericSec[1]) * 1000;
  }
  return 0;
}

function applyCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: "Forbidden origin." });
  }

  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  return next();
}

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = rateMap.get(ip);

  if (!current || current.resetTime <= now) {
    rateMap.set(ip, { count: 1, resetTime: now + WINDOW_MS });
    return next();
  }

  if (current.count >= MAX_REQUESTS) {
    return res.status(429).json({
      error: "Rate limit exceeded. Please wait before summarizing again."
    });
  }

  current.count += 1;
  rateMap.set(ip, current);
  return next();
}

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${durationMs}ms`);
  });
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.options("/summarize", applyCors);
app.post("/summarize", applyCors, rateLimit, async (req, res) => {
  try {
    if (Date.now() < upstreamCooldownUntil) {
      const retryInMs = Math.max(1000, upstreamCooldownUntil - Date.now());
      const retryInSec = Math.ceil(retryInMs / 1000);
      return res.status(429).json({
        error: `Upstream LLM quota is cooling down. Please retry in ${retryInSec}s.`
      });
    }

    const { content, url, mode, title } = req.body || {};
    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "Invalid content. Expected non-empty string." });
    }
    if (typeof url !== "string") {
      return res.status(400).json({ error: "Invalid url. Expected string." });
    }
    if (mode !== "full" && mode !== "bullets") {
      return res.status(400).json({ error: "Invalid mode. Expected 'full' or 'bullets'." });
    }

    let validUrl;
    try {
      validUrl = new URL(url);
    } catch (error) {
      return res.status(400).json({ error: "Invalid URL format." });
    }

    let workingContent = content;
    let warning;
    if (workingContent.length > 50000) {
      workingContent = workingContent.slice(0, 50000);
      warning = "Content exceeded 50,000 characters and was truncated.";
    }

    const sanitizedContent = sanitizeContent(workingContent);
    const prompt = getPrompt(mode, sanitizedContent, validUrl.toString(), String(title || ""));
    const rawText = await generateWithProviderAndKeyChain(prompt);
    if (!rawText.trim()) {
      throw new Error("LLM returned an empty response.");
    }
    let payload;
    try {
      const parsed = parseJsonResponse(rawText);
      payload = normalizeParsedPayload(parsed, rawText, mode, sanitizedContent);
    } catch (parseError) {
      console.warn("LLM JSON parse failed, falling back to plain text parsing:", normalizeErrorMessage(parseError));
      payload = buildFallbackPayload(rawText, mode, sanitizedContent);
    }

    if (warning) {
      payload.warning = warning;
    }
    return res.json(payload);
  } catch (error) {
    const message = normalizeErrorMessage(error);
    const status = Number(error?.status || error?.statusCode || inferStatusFromMessage(message));
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    if (safeStatus === 429) {
      const retryMs = extractRetryDelayMs(message) || UPSTREAM_COOLDOWN_MS;
      upstreamCooldownUntil = Date.now() + Math.max(1000, retryMs);
    }
    console.error("Summarize failed:", message);
    return res.status(safeStatus).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Sumry proxy server running on port ${PORT}`);
  console.log(
    `LLM chain: ${PROVIDER_ORDER.join(" → ")} | keys: gemini=${GEMINI_API_KEYS.length} groq=${GROQ_API_KEYS.length} openrouter=${OPENROUTER_API_KEYS.length}`
  );
});
