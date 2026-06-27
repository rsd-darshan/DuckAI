<div align="center">

# 🦆 DuckAI

**An always-on AI sidebar that already knows what's on your screen.**

No copy-pasting. No re-explaining your context. Open Gmail, DuckAI knows it's an email. Watch a YouTube video, DuckAI can summarize it. It's the AI assistant that doesn't need to be told what you're looking at — it just sees it.

[![CI](https://github.com/rsd-darshan/DuckAI/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![Secret scan](https://github.com/rsd-darshan/DuckAI/actions/workflows/gitleaks.yml/badge.svg)](.github/workflows/gitleaks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

### Table of contents

- [What it does](#what-it-does)
- [Two clients, one backend](#two-clients-one-backend)
- [Architecture](#architecture)
- [Engineering highlights](#engineering-highlights)
- [Project structure](#project-structure)
- [Quick start](#quick-start)
- [Permissions](#permissions-macos)
- [Security & privacy](#security--privacy)
- [License](#license)

---

## What it does

DuckAI is a desktop sidebar (Electron) that sits alongside whatever app you're using and stays context-aware in real time:

- **Reads your screen** — captures and OCRs the active window so the AI knows what you're doing without you explaining it
- **Chat with context baked in** — ask "what am I looking at?" or "summarize this" and get an answer grounded in your actual screen
- **One-click actions** — summarize any article/video, draft email replies, with multi-step progress feedback
- **30+ quick tools** — translation, grammar fix, paraphrasing, code review, regex/SQL explainers, unit/price converters, meeting notes, and more, organized by category
- **Local knowledge base (RAG)** — ingest documents and query them with a dependency-free hybrid scorer (exact match + TF-IDF + fuzzy match) — no vector DB or embedding API required
- **Image tools** — OCR text extraction from any image, and pixel-diff similarity comparison between two images
- **Writeback integrations** — push AI output straight into Notion, Obsidian, Linear, or Jira
- **Smart suggestions** — surfaces relevant follow-up prompts based on what's on screen
- **Web search + synthesis** — `/search` pulls in live results and blends them into the answer
- **Templates & hotkeys** — save reusable prompts, bind them to global keyboard shortcuts
- **Privacy controls** — app blocklist, meeting-focus mode, sensitive-content redaction, all configurable
- **Memory modes** — per-conversation control over what gets remembered and for how long

## Two clients, one backend

DuckAI isn't a single app bolted to a screenshot — it's a **backend-first architecture** designed around two front-ends consuming the same FastAPI service:

| Client | Context source | Status |
|---|---|---|
| **Electron sidebar** | Screen OCR (Tesseract) | Working — the app described throughout this README |
| **VS Code extension** | Editor selection / file content (VS Code API) | Work in progress — compiles cleanly but untested end-to-end, not yet packaged or run inside VS Code |

Both are designed to talk to the same `http://127.0.0.1:8000` backend and chat pipeline. The VS Code extension's commands (**Ask About Selection**, **Explain Selection**, **Review This File**, **Insert AI Suggestion at Cursor**) are implemented in TypeScript and type-check, but the extension hasn't been loaded into VS Code or verified working yet — see [`sideai/vscode-extension/`](sideai/vscode-extension) if you want to pick that up.

## Architecture

```
┌────────────────────────────┐      ┌────────────────────────────────┐
│       Electron Shell       │      │       VS Code Extension        │
│   tray · hotkeys · panel   │      │  editor selection as context   │
└────────────────────────────┘      └────────────────────────────────┘
               │                                     │                
               │ HTTP polling                        │ HTTP           
               ▼                                     ▼                
          ┌────────────────────────────────────────────────┐
          │            FastAPI Backend (Python)            │
          │             http://127.0.0.1:8000              │
          └────────────────────────────────────────────────┘
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│     Screen OCR     │  │    AI cascade:     │  │      SQLite:       │
│    (Tesseract)     │  │   HF→NVIDIA→Groq   │  │  history, RAG KB,  │
│                    │  │    or Anthropic    │  │ templates, hotkeys │
└────────────────────┘  └────────────────────┘  └────────────────────┘
```

| Layer | Technology |
|---|---|
| Shell | Electron 28 |
| UI | React 18, TypeScript, Vite, Tailwind |
| Second client (WIP) | VS Code extension (TypeScript) — compiles, not yet verified running |
| API | FastAPI, Uvicorn, SQLite |
| Screen capture | Python (`pyautogui`) + Tesseract OCR; native macOS `CGWindowListCreateImage` for see-through capture |
| AI (free tier) | Hugging Face → NVIDIA NIM → Groq (automatic cascade/fallback) |
| AI (premium) | Anthropic Claude (Haiku / Sonnet) |
| Auth (optional) | Clerk |

## Engineering highlights

Most AI chat tools require you to copy-paste context before asking a question. DuckAI flips that — it observes the active application and feeds relevant context into every request automatically, with a fallback pipeline (live capture → cached context → manual paste) so it degrades gracefully instead of failing silently.

Worth a look if you're reviewing the code:

- **Context resolution pipeline** ([`resolveReadableContent.ts`](sideai/frontend/src/utils/resolveReadableContent.ts)) — polls with backoff for fresh OCR text, falls back to manual paste when capture is insufficient
- **Click-through collapsed mode** ([`main.js`](sideai/electron/main.js), [`CollapsedStrip.tsx`](sideai/frontend/src/components/CollapsedStrip.tsx)) — the panel becomes a thin, click-through strip when unfocused (`setIgnoreMouseEvents`) so it never blocks clicks on the app behind it, while IPC re-enables interaction the moment the cursor hovers over it
- **Dependency-free local RAG** ([`rag.py`](sideai/backend/services/rag.py)) — document retrieval scored by a hybrid of exact-match bonus, token overlap, TF-IDF, and fuzzy character similarity — no vector DB or embedding API, runs entirely offline
- **Privacy-first capture** — screen text is redacted/blocked per user-configured app allowlists before it ever reaches the AI provider or disk
- **Multi-provider AI cascade** with automatic failover across free-tier providers, with usage-tier gating (free / premium / ultra)
- **One backend, designed for multiple clients** — the Electron sidebar is the working front-end; the VS Code extension is a second client built against the same FastAPI service, still unverified (see [status](#two-clients-one-backend))

## Project structure

```
DuckAI/
├── sideai/
│   ├── frontend/          # React panel (Vite, TypeScript, Tailwind)
│   ├── backend/           # FastAPI: OCR, AI cascade, RAG, SQLite, integrations
│   ├── electron/          # Main process, tray, global hotkeys, capture ingest
│   └── vscode-extension/  # WIP second client — compiles, not yet verified running
├── .github/workflows/     # CI: backend smoke tests, frontend build/test, gitleaks
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

### VS Code extension (work in progress)

Compiles cleanly but hasn't been run inside VS Code yet — the manifest references icon assets (`media/icon.png`) that don't exist in the repo, so packaging with `vsce` currently fails. Treat this as a starting point, not a working feature:

```bash
cd sideai/vscode-extension
npm install
npm run compile   # succeeds — produces dist/*.js with no type errors
# Add media/icon.png + media/icon-mono.svg before `vsce package` will succeed
```

## Permissions (macOS)

DuckAI needs OS-level permissions to read your screen and type into other apps:

- **Screen Recording** — required for the Electron sidebar to capture and OCR the active window
- **Accessibility** — required for "Write it" (typing AI output directly into another app's focused field)
- **Tesseract** — `brew install tesseract` for OCR

The VS Code extension (work in progress) is designed to need none of this, since it reads context directly through the VS Code API rather than OCR.

## Security & privacy

- No API keys or secrets are committed — see [`sideai/.gitignore`](sideai/.gitignore)
- Screen content is processed locally; nothing is sent to a third party except the configured AI provider, and only for the active request
- CI runs [Gitleaks](.github/workflows/gitleaks.yml) on every push/PR to catch accidental secret commits
- Local API binds to `127.0.0.1` only; optional API key lock for shared machines
- Branch protection on `master`: force-push and deletion blocked, 5 CI checks required before merge

## License

[MIT](LICENSE)
