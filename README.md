<div align="center">

# 🦆 DuckAI

**An always-on AI sidebar that already knows what's on your screen.**

No copy-pasting. No re-explaining your context. Open Gmail, DuckAI knows it's an email. Watch a YouTube video, DuckAI can summarize it. It's the AI assistant that doesn't need to be told what you're looking at — it just sees it.

[![CI](https://github.com/<your-username>/DuckAI/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![Secret scan](https://github.com/<your-username>/DuckAI/actions/workflows/gitleaks.yml/badge.svg)](.github/workflows/gitleaks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## What it does

DuckAI is a desktop sidebar (Electron) that sits alongside whatever app you're using and stays context-aware in real time:

- **Reads your screen** — captures and OCRs the active window so the AI knows what you're doing without you explaining it
- **Chat with context baked in** — ask "what am I looking at?" or "summarize this" and get an answer grounded in your actual screen
- **One-click actions** — summarize any article/video, draft email replies, with multi-step progress feedback
- **Smart suggestions** — surfaces relevant follow-up prompts based on what's on screen
- **Web search + synthesis** — `/search` pulls in live results and blends them into the answer
- **Templates & hotkeys** — save reusable prompts, bind them to global keyboard shortcuts
- **Privacy controls** — app blocklist, meeting-focus mode, sensitive-content redaction, all configurable
- **Memory modes** — per-conversation control over what gets remembered and for how long

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Electron Shell                      │
│   tray icon · global hotkeys · collapsible side panel    │
└───────────────────────┬───────────────────────────────────┘
                         │
        ┌────────────────┴────────────────┐
        │                                  │
┌───────▼────────┐                ┌────────▼─────────┐
│  React Frontend │  HTTP/WS      │  FastAPI Backend  │
│  (Vite + TS)    │◄─────────────►│  (Python)         │
└─────────────────┘  localhost:8000└──────────────────┘
                                            │
                          ┌─────────────────┼─────────────────┐
                          │                 │                 │
                  ┌───────▼──────┐  ┌───────▼──────┐  ┌───────▼──────┐
                  │ Screen OCR    │  │ AI Provider   │  │ SQLite       │
                  │ (Tesseract)   │  │ cascade:      │  │ chat history,│
                  │               │  │ HF→NVIDIA→Groq│  │ templates,   │
                  │               │  │ or Anthropic  │  │ hotkeys      │
                  └───────────────┘  └───────────────┘  └──────────────┘
```

| Layer | Technology |
|---|---|
| Shell | Electron 28 |
| UI | React 18, TypeScript, Vite, Tailwind |
| API | FastAPI, Uvicorn, SQLite |
| Screen capture | Python (`pyautogui`) + Tesseract OCR; native macOS `CGWindowListCreateImage` for see-through capture |
| AI (free tier) | Hugging Face → NVIDIA NIM → Groq (automatic cascade/fallback) |
| AI (premium) | Anthropic Claude (Haiku / Sonnet) |
| Auth (optional) | Clerk |

## Why it's interesting

Most AI chat tools require you to copy-paste context before asking a question. DuckAI flips that — it observes the active application and feeds relevant context into every request automatically, with a fallback pipeline (live capture → cached context → manual paste) so it degrades gracefully instead of failing silently.

Engineering details worth a look if you're reviewing the code:

- **Context resolution pipeline** ([`resolveReadableContent.ts`](sideai/frontend/src/utils/resolveReadableContent.ts)) — polls with backoff for fresh OCR text, falls back to manual paste when capture is insufficient
- **Click-through collapsed mode** — the panel becomes a thin, click-through strip when unfocused (`setIgnoreMouseEvents`) so it never blocks clicks on the app behind it, while still detecting hover via IPC to re-enable interaction
- **Privacy-first capture** — screen text is redacted/blocked per user-configured app allowlists before it ever reaches the AI provider or disk
- **Multi-provider AI cascade** with automatic failover across free-tier providers, with usage-tier gating (free / premium / ultra)

## Project structure

```
DuckAI/
├── sideai/
│   ├── frontend/      # React panel (Vite, TypeScript, Tailwind)
│   ├── backend/        # FastAPI: OCR, AI cascade, SQLite, integrations
│   ├── electron/       # Main process, tray, global hotkeys, capture ingest
│   └── vscode-extension/
├── .github/workflows/  # CI: backend smoke tests, frontend build/test, gitleaks
└── README.md
```

See [`sideai/README.md`](sideai/README.md) for full setup, environment variables, and permission configuration.

## Quick start

```bash
# Backend
cd sideai/backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # add your own API key(s)

# Frontend
cd ../frontend
npm install
npm run build

# Electron (starts backend + opens the panel)
cd ../electron
npm install
npm start
```

Requires macOS Screen Recording permission (for screen context) and Tesseract (`brew install tesseract`).

## Security & privacy

- No API keys or secrets are committed — see [`sideai/.gitignore`](sideai/.gitignore)
- Screen content is processed locally; nothing is sent to a third party except the configured AI provider, and only for the active request
- CI runs [Gitleaks](.github/workflows/gitleaks.yml) on every push/PR to catch accidental secret commits
- Local API binds to `127.0.0.1` only; optional API key lock for shared machines

## License

[MIT](LICENSE)
