# DuckAI (SideAI)

Always-on **macOS-first** AI side panel: Electron shell + React UI + local FastAPI backend on `127.0.0.1:8000`. Reads screen context (OCR), chats with that context, suggests actions, searches the web, and integrates with calendar, Slack, GitHub, Notion, and more.

## Stack

| Layer | Technology |
|--------|------------|
| Shell | Electron 28 |
| UI | React 18, TypeScript, Vite, Tailwind |
| API | FastAPI, Uvicorn, SQLite (`sideai.db`) |
| Screen | Python `pyautogui` + Tesseract; Electron `desktopCapturer` ingest when panel is collapsed |
| AI (by plan) | **Free:** Hugging Face → NVIDIA NIM → Groq · **Premium/Ultra:** Anthropic Haiku/Sonnet |
| Auth (optional) | Clerk (`VITE_CLERK_PUBLISHABLE_KEY`) |

## UI tabs

| Tab | Purpose |
|-----|---------|
| **Chat** | Streaming chat, screen context, `/search`, Write it, memory modes |
| **History** | Saved conversations, export |
| **Templates** | Reusable prompts + global hotkeys |
| **Web search** | DuckDuckGo + synthesis |
| **Actions** | KB, code analysis, annotations, favorites |
| **Settings** | Privacy, plan, permissions, browser history context, Calendar, Notion, Memory |

There is no separate “Everything” tab; many power APIs (reminders, focus timer, shopping, etc.) are available via backend routes and partial Settings/Actions surfaces.

## Screen context (how capture works)

1. **Python loop** — Foreground app + screenshot (excluding panel width) + Tesseract OCR. Privacy blocklist, meeting focus, and redaction apply before text is stored.
2. **Electron ingest** — When the panel is **collapsed** (or right after you focus another app), Electron captures the display every ~4s and POSTs to `/api/ingest_screenshot` (works when Electron has Screen Recording but Python does not).
3. **App watcher** — Switching to watched apps (Gmail, Notion, Slack, browsers, …) triggers a fresh capture after ~1.5s stability (5s cooldown).
4. **UI poll** — Frontend refreshes `/api/context` about every 1s when the backend is up.

**Tip:** If context is empty but permissions look granted, **collapse DuckAI** to the side strip so Electron ingest runs.

## AI providers

Plans are stored in SQLite (`user_plan`):

| Plan | Models |
|------|--------|
| `free` | `HF_TOKEN` → `NVIDIA_API_KEY` → `GROQ_API_KEY` (cascade) |
| `premium` | Anthropic Claude Haiku |
| `ultra` | Anthropic Claude Sonnet |

Configure keys in `backend/.env` (see `.env.example`). Optional HF token can also be saved from onboarding.

Legacy `AI_PROVIDER=openrouter` env docs are **not** used by the current `ai_engine.py`.

## Browser history context

Settings → **Browser History Context** toggles local reads of Chrome/Firefox/Safari history SQLite files (no network). APIs:

- `GET /api/browser/status`
- `POST /api/browser/toggle`
- `GET /api/browser/recent-urls`

When enabled, recent URLs are attached to chat context as untrusted data.

## macOS permissions

1. **Screen Recording** — Required for capture. Enable **DuckAI** or **Electron** (dev). In dev, also enable **Python/Terminal** for the uvicorn process. Electron ingest can work when only Electron is listed.
2. **Accessibility** — Required for **Write it** (typing into other apps).
3. **Tesseract** — `brew install tesseract` (OCR).

Permission health: `GET /api/permissions/health` (unified Python + Electron ingest + real Accessibility check).

## Prerequisites

- Node.js 18+
- Python 3.10+
- Tesseract
- macOS Screen Recording (+ Accessibility for Write it)

## Installation

### Backend

```bash
cd sideai/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env: HF_TOKEN, GROQ_API_KEY, ANTHROPIC_API_KEY, etc.
```

Optional macOS app detection:

```bash
pip install pyobjc-framework-Quartz pyobjc-framework-AppKit
```

### Frontend

```bash
cd sideai/frontend
npm install
cp .env.example .env.local   # optional: VITE_CLERK_PUBLISHABLE_KEY
npm run build
```

### Electron

```bash
cd sideai/electron
npm install
```

## How to run

### Full app (recommended)

```bash
cd sideai
npm run build
cd electron && npm start
```

Electron starts the backend, opens the panel, and runs Electron screen ingest when collapsed.

### Development

**Terminal 1 — backend:**

```bash
cd sideai/backend && source venv/bin/activate
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

**Terminal 2 — frontend:**

```bash
cd sideai/frontend && npm run dev
```

**Terminal 3 — Electron:**

```bash
cd sideai/electron && npm run start:dev
```

## Environment variables (backend)

| Variable | Description |
|----------|-------------|
| `HF_TOKEN` / `HUGGINGFACE_API_KEY` | Free-tier primary (Fine-grained, Inference permission) |
| `NVIDIA_API_KEY` | Free-tier fallback |
| `GROQ_API_KEY` | Free-tier fallback |
| `ANTHROPIC_API_KEY` | Premium / Ultra |
| `SCREEN_TEXT_MAX_LENGTH` | OCR cap (default `2000`) |
| `SIDEAI_API_KEY` | Optional localhost API lock (`X-DuckAI-Key`) |
| `SIDEAI_CORS_ORIGINS` | CORS allowlist |
| `SLACK_BOT_TOKEN`, `GITHUB_TOKEN`, `CALENDAR_*` | Integrations |

## Environment variables (frontend)

| Variable | Description |
|----------|-------------|
| `VITE_CLERK_PUBLISHABLE_KEY` | Optional; app runs in local mode without it |
| `VITE_SIDEAI_API_KEY` | Must match `SIDEAI_API_KEY` if set |
| `VITE_SIDEAI_API_BASE` | Default `http://127.0.0.1:8000` |

## Project structure

```
sideai/
├── frontend/     # React panel
├── backend/      # FastAPI, OCR, AI, SQLite
├── electron/     # Main process, tray, capture ingest
├── vscode-extension/
└── README.md
```

## Security

- Do not commit `.env` or API keys.
- Local API on `127.0.0.1`; optional API key + Clerk JWT on sensitive routes.
- OCR is treated as untrusted in prompts.

## Validation

```bash
cd sideai/backend
python3 -m py_compile main.py utils/permissions_health.py
./venv/bin/python -m unittest tests/test_smoke.py

cd ../frontend
npm run build
```

## CI

See `.github/workflows/` — backend smoke, frontend build/test, gitleaks.
