require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const PORT = Number(process.env.PORT || 3001);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = String(process.env.ALLOWED_ORIGIN || "").trim();

if (!GEMINI_API_KEY) {
  throw new Error("Startup failed: GEMINI_API_KEY is missing in .env");
}
if (!ALLOWED_ORIGIN) {
  throw new Error("Startup failed: ALLOWED_ORIGIN is missing in .env");
}

const app = express();
app.use(helmet());
app.use(express.json({ limit: "50kb" }));

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Simple sliding-window limiter: Map<ip, { count, resetTime }>
const rateMap = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 10;

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

function getPrompt(mode, sanitizedContent, url) {
  return `You are a precise content summarizer. Analyze the following webpage content and respond ONLY with valid JSON (no markdown, no code blocks).
${mode === "bullets" ? "Provide exactly 3 bullet points summary." : "Provide a comprehensive summary."}
Respond with this exact JSON structure:
{
"summary": "string — ${mode === "bullets" ? "exactly 3 bullet points as a single string, each starting with • " : "2-4 sentence paragraph"}",
"keyInsights": ["string", "string", "string"],
"readingTime": number,
"wordCount": number
}

Content to analyze:
${sanitizedContent}
Page URL: ${url}`;
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
    const { content, url, mode } = req.body || {};
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
    const prompt = getPrompt(mode, sanitizedContent, validUrl.toString());
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
        responseMimeType: "application/json"
      }
    });

    const rawText = result?.response?.text() || "";
    const parsed = parseJsonResponse(rawText);
    const wordCount = Number(parsed.wordCount) || sanitizedContent.split(/\s+/).filter(Boolean).length;
    const readingTime = Number(parsed.readingTime) || Math.max(1, Math.ceil(wordCount / 238));
    const keyInsights = Array.isArray(parsed.keyInsights)
      ? parsed.keyInsights.slice(0, 3).map((v) => String(v))
      : [];

    const payload = {
      summary: String(parsed.summary || ""),
      keyInsights: [
        keyInsights[0] || "",
        keyInsights[1] || "",
        keyInsights[2] || ""
      ],
      readingTime,
      wordCount,
      mode
    };

    if (warning) {
      payload.warning = warning;
    }
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ error: "Failed to summarize content." });
  }
});

app.listen(PORT, () => {
  console.log(`Sumry proxy server running on port ${PORT}`);
});
