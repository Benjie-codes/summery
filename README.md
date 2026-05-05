# Sumly — local AI page summarizer

This repository contains a **Manifest V3 browser extension** plus a **Node.js proxy** (`proxy-server/`) that calls LLM APIs. The proxy can be run locally or deployed to platforms like Railway. It is intended for **personal use**. **Do not publish this extension to the Chrome Web Store** unless you complete store policies, MV3 packaging, privacy disclosures, and key-handling requirements—this README assumes you load the extension unpacked from disk only.

---

## Setup instructions

### Prerequisites

- **Node.js 18+** (global `fetch` is used by the proxy).
- **Google Chrome** or another Chromium browser that supports unpacked MV3 extensions.

### 1. Get the code

Either clone the repository or download it as a ZIP and extract it:

```bash
git clone https://github.com/Benjie-codes/summery.git
cd summery
```

### 2. Configure and run the proxy

You can run the proxy locally or deploy it to a platform like **Railway**.

#### Option A: Local Deployment

```bash
cd proxy-server
cp .env.example .env
```

Edit `.env`:

1. Add at least one LLM credential (see `.env.example` for `GEMINI_*`, `GROQ_*`, `OPENROUTER_*`).
2. Set **`ALLOWED_ORIGINS`** to your extension origin **after** you know it (step 4). Format: `chrome-extension://YOUR_EXTENSION_ID` (or `chrome-extension://*` to allow any local extension).

Install dependencies and start:

```bash
npm install
npm start
```

By default the proxy listens on **`http://localhost:3001`** (`PORT` in `.env`). Health check: `GET http://localhost:3001/health`.

#### Option B: Railway Deployment

1. Deploy the `proxy-server` directory to Railway.
2. In the Railway dashboard, configure the Environment Variables using the same keys listed in `.env.example` (e.g., `GEMINI_API_KEY`, `GROQ_API_KEY`).
3. Set **`ALLOWED_ORIGINS`** to `chrome-extension://*` (allows any local installation to connect) or to your specific extension ID.

### 3. Build extension CSS (optional but recommended)

From the project root:

```bash
npm install
npm run build:css
```

Use `npm run watch:css` while editing Tailwind sources.

### 4. Load the extension unpacked

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the **`sumly`** folder (the directory that contains `manifest.json`).

The extension is pre-configured to use the production Railway proxy, so **you are ready to use it immediately!**

#### Optional: Configuring a Custom Proxy
If you are running your own local or custom Railway proxy:
1. Copy your proxy URL into the extension's Settings (e.g. `http://localhost:3001`).
2. Chrome assigns an **extension ID** when you load it. Set **`ALLOWED_ORIGINS`** in your proxy `.env` to:

```text
chrome-extension://<paste-extension-id-here>
```
*(Alternatively, use `chrome-extension://*` to allow any extension origin.)*

Restart your custom proxy after changing `.env`.

### 5. Use it

1. Ensure the proxy is running.
2. Open a normal webpage (articles work best).
3. Click the extension icon → **Summarize**.
4. Optional: open **Settings** in the popup and **Test Connection** against `/health`.

---

## Architecture explanation

### Components

| Piece | Role |
|-------|------|
| **`popup/`** | UI: triggers summarize, shows results, settings (proxy URL, theme, cache). |
| **`background/service-worker.js`** | Orchestration: reads settings, asks the active tab’s content script for text, `fetch`es the proxy `/summarize`, caches responses in `chrome.storage`. |
| **`content/content-script.js`** | Runs on pages (`<all_urls>`): extracts readable text for summarization and handles highlight helpers. Can be re-injected if messaging fails after an extension reload. |
| **`proxy-server/server.js`** | Express server: CORS gate, rate limiting, HTML-ish sanitization of body text, LLM calls, JSON normalization/fallback parsing, returns structured summary payload. |

### Request flow

1. Popup sends **`SUMMARIZE`** to the service worker with `tabId`, page URL, and mode (`full` | `bullets`).
2. Worker checks cache → otherwise **`EXTRACT_CONTENT`** to the tab’s content script.
3. Worker **`POST`s JSON** to `{proxyUrl}/summarize` with `content`, `url`, `mode`, `title`.
4. Proxy returns `{ summary, keyInsights, readingTime, wordCount, mode }` (+ optional `warning`).
5. Worker stores result in **`chrome.storage.local`** with TTL and entry limits.

---

## AI integration explanation

### Why a proxy?

Browser extensions **must not embed LLM API keys** in shipped code if you care about abuse (they are trivially extractable). This design keeps **secrets securely on the server** (in `proxy-server/.env` or Railway variables), never in the extension bundle.

### Providers and fallback chain

The proxy supports **Gemini**, **Groq**, and **OpenRouter**:

- **`LLM_PROVIDER_ORDER`** — order of providers (e.g. `gemini,groq,openrouter`).
- **Multiple keys per provider** — comma-separated `*_API_KEYS`, merged with a single `*_API_KEY` where applicable. Failed quota, auth, or transient network errors typically advance to the **next key**, then the **next provider**.

Gemini uses `@google/generative-ai` with **`GEMINI_MODEL_CANDIDATES`** (model fallback inside one key). Groq and OpenRouter use **`fetch`** against OpenAI-compatible chat completions endpoints with **`response_format: { type: "json_object" }`** where supported.

### Prompt and response shape

The proxy asks the model for **strict JSON** (`summary`, `keyInsights`, `readingTime`, `wordCount`). If the model truncates or breaks JSON (common under token limits), the server applies **repair helpers**: partial JSON extraction, insight backfill, and optional warnings—so the UI still receives three insight slots when possible.

Configurable knobs include **`GEMINI_MAX_OUTPUT_TOKENS`**, **`GROQ_MODEL`**, **`OPENROUTER_MODEL`**, and proxy-side **`RATE_LIMIT_*`** / **`UPSTREAM_COOLDOWN_MS`**.

---

## Security decisions

1. **API keys only on the proxy host** — in `.env` or deployment variables, never committed.
2. **Strict CORS** — only origins matching `ALLOWED_ORIGINS` may call `/summarize`; wrong extension origins get **403**.
3. **`host_permissions`** — extension network access is scoped to your proxy URLs (e.g., `http://localhost/*`, `https://sumly-production.up.railway.app/*`) in `manifest.json`.
4. **Helmet** on Express for baseline HTTP headers.
5. **Rate limiting** on `/summarize` to reduce accidental abuse or tight loops while developing.
6. **Basic server-side sanitization** of pasted page HTML/text before sending to the model (not a substitute for full HTML parsing or malware guarantees).

Treat your `.env` like production secrets: restrictive file permissions, no screenshots in tickets, rotate keys if leaked.

---

## Trade-offs

| Benefit | Cost |
|---------|------|
| Keys stay off-extension | You **must run** the proxy (locally or via a service like Railway). |
| Multi-provider resilience | More moving parts; logs and quotas vary per vendor. |
| JSON-mode summaries | Some models/providers reject `json_object`; you may need to change **`OPENROUTER_MODEL`** / **`GROQ_MODEL`**. |
| Unpacked workflow | **Extension ID drift** when reloading unpacked builds → **`ALLOWED_ORIGIN`** must stay in sync. |
| Local-first | No managed hosting, SLA, or Chrome Web Store discovery—by design for this repo. |

---

## Troubleshooting

- **`403 Forbidden origin`** — `ALLOWED_ORIGINS` does not match `chrome-extension://<id>` (or `chrome-extension://*`); fix your `.env` or deployment variables and restart.
- **`Can't reach the summary server`** — proxy down, wrong port in extension settings, or missing `host_permissions` for your proxy URL.
- **`429` / quota messages** — upstream limits; wait or add keys / reorder **`LLM_PROVIDER_ORDER`**.
- After changing **`manifest.json`**, reload the extension in `chrome://extensions`.

---

## License / disclaimer

Summaries are generated by third-party LLMs and may be inaccurate or incomplete. You are responsible for compliance with sites you summarize and with each provider’s terms of use.
