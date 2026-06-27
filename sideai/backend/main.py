"""
FastAPI backend for DuckAI: screen context, chat, suggestions, type-text, and context loop.
"""

import difflib
import json
import logging
import os
import re
import threading
import time
from base64 import b64encode
from contextlib import asynccontextmanager
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from pydantic import BaseModel, Field

from ai_engine import chat as ai_chat
from ai_engine import chat_for_web_synthesis
from ai_engine import chat_stream as ai_chat_stream
from ai_engine import get_suggestions
from ai_engine import get_answer_followups
from ai_engine import verify_answer_with_sources
from ai_engine import extract_memories_from_chat
from config import load_settings
from database import (
    add_message,
    build_pdf_export,
    build_markdown_export,
    create_conversation,
    create_hotkey,
    create_template,
    delete_conversation,
    delete_hotkey,
    delete_template,
    get_conversation as db_get_conversation,
    get_settings,
    import_templates,
    init_db,
    list_saved_responses,
    list_conversations,
    list_hotkeys,
    list_templates,
    memory_get_all_for_prompt,
    memory_upsert,
    reminder_create as db_reminder_create,
    reminder_list as db_reminder_list,
    reminder_set_done as db_reminder_set_done,
    reminder_snooze as db_reminder_snooze,
    semantic_search_history,
    save_response,
    set_conversation_starred,
    set_conversation_memory_mode,
    set_setting,
    get_setting,
    get_device_id,
    get_today_usage,
    increment_usage,
)
from services.productivity import APP_MODES, analyze_clipboard_content, resolve_app_mode
from services.shopping_cheaper import find_cheaper_alternatives
from services.web_search import search_web_duckduckgo
from routes.integrations import create_integrations_router
from routes.phase2 import router as phase2_router
from routes.phase3 import create_phase3_router
from routes.everything import create_everything_router
from routes.writeback import create_writeback_router
from routes.memory import router as memory_router
from routes.email_draft import router as email_draft_router
from routes.calendar import router as calendar_router
from routes.notion import router as notion_router
from routes.summarize import router as summarize_router
from routes.browser_history import router as browser_history_router
from routes.content import router as content_router
from utils.permissions_health import build_permissions_health
from screen_capture import get_screen_context, set_panel_geometry
from screen_capture import redact_sensitive_text
from type_text import type_text as do_type_text
from utils.due_parser import parse_due_string

SETTINGS = load_settings()
_APP_START_MONO = time.monotonic()
logger = logging.getLogger("sideai")
SIDEAI_API_KEY = os.getenv("SIDEAI_API_KEY", "").strip()

# In-memory state
_current_context: dict[str, Any] = {}
_current_suggestions: list[str] = []
_context_timeline: list[dict[str, Any]] = []
_loop_lock = threading.Lock()
_transparency_lock = threading.Lock()
_last_chat_transparency: dict[str, Any] = {}
_context_snapshots: dict[str, dict[str, Any]] = {}
_capture_paused = False

# Suggestion debounce — only regenerate when context changes meaningfully.
# MIN_COOLDOWN: minimum gap between any two LLM suggestion calls, even if context changes.
# SAFETY_FALLBACK: force refresh after this many seconds of no change (stale content guard).
_SUGGESTIONS_MIN_COOLDOWN = 120.0    # 2 minutes — prevents LLM spam on every tab/scroll
_SUGGESTIONS_SAFETY_FALLBACK = 1800.0  # 30 minutes
_privacy_settings: dict[str, Any] = {
    "blocked_apps": [],
    "redact_sensitive": True,
    "meeting_focus": False,
    "context_allowlist_only": False,
    "allowed_apps": [],
}
_DEFAULT_MEETING_SUBSTRINGS = ("zoom", "teams", "meet", "webex", "skype", "discord", "around.co", "gather.town")
MAX_TIMELINE_ITEMS = 15

# Apps that trigger automatic screenshot + suggestions when active
AUTO_CAPTURE_APPS: list[str] = [
    "gmail", "mail.google", "outlook", "thunderbird",
    "notion", "slack", "linear", "jira", "asana", "trello", "monday",
    "github", "gitlab", "figma", "airtable",
    "google docs", "docs.google", "google sheets", "sheets.google",
    "calendar.google", "google calendar",
    "discord", "teams",
]
_auto_capture_last_app: str = ""
_auto_capture_last_at: float = 0.0
AUTO_CAPTURE_COOLDOWN_SECONDS = 5.0


def _hydrate_privacy_from_db() -> None:
    """Load blocked-apps list + redact flag from SQLite (survives backend restart)."""
    global _privacy_settings
    try:
        settings = get_settings()
        raw_apps = (settings.get("privacy_blocked_apps") or {}).get("value")
        if raw_apps is not None and str(raw_apps).strip():
            parsed = json.loads(raw_apps)
            if isinstance(parsed, list):
                _privacy_settings["blocked_apps"] = [str(a).strip() for a in parsed if str(a).strip()]
        raw_redact = (settings.get("privacy_redact_sensitive") or {}).get("value")
        if raw_redact is not None and str(raw_redact).strip() != "":
            _privacy_settings["redact_sensitive"] = str(raw_redact).lower() in ("1", "true", "yes")
        raw_mf = (settings.get("privacy_meeting_focus") or {}).get("value")
        if raw_mf is not None and str(raw_mf).strip() != "":
            _privacy_settings["meeting_focus"] = str(raw_mf).lower() in ("1", "true", "yes")
        raw_alo = (settings.get("privacy_allowlist_only") or {}).get("value")
        if raw_alo is not None and str(raw_alo).strip() != "":
            _privacy_settings["context_allowlist_only"] = str(raw_alo).lower() in ("1", "true", "yes")
        raw_allowed = (settings.get("privacy_allowed_apps") or {}).get("value")
        if raw_allowed is not None and str(raw_allowed).strip():
            try:
                parsed_a = json.loads(raw_allowed)
                if isinstance(parsed_a, list):
                    _privacy_settings["allowed_apps"] = [str(a).strip().lower() for a in parsed_a if str(a).strip()]
            except Exception:
                pass
    except Exception:
        pass


def _suggestions_context_key(ctx: dict[str, Any]) -> str:
    """Stable string that changes when the context is meaningfully different."""
    app = str(ctx.get("active_app") or "")
    title = str(ctx.get("window_title") or "")
    # Use first 120 chars of visible text as signal — enough to detect page change without hashing gigabytes
    text_prefix = str(ctx.get("visible_text") or "")[:120]
    return f"{app}||{title}||{text_prefix}"


_suggestions_last_key: str = ""
_suggestions_last_at: float = 0.0


def _context_loop_iteration(force: bool = False) -> None:
    global _current_context, _current_suggestions, _suggestions_last_key, _suggestions_last_at
    if _capture_paused and not force:
        return
    try:
        ctx = get_screen_context()

        # If pyautogui returned an empty image (common when Screen Recording is
        # denied to the Python process), fall back to whatever Electron ingested.
        if not ctx.get("visible_text"):
            with _loop_lock:
                prior = _current_context
            if prior.get("source") == "electron_desktop_capturer" and prior.get("visible_text"):
                ctx["visible_text"] = prior["visible_text"]
                ctx["ocr_confidence"] = prior.get("ocr_confidence", 0.0)

        active_app = (ctx.get("active_app") or "").strip().lower()
        blocked = {str(app).strip().lower() for app in _privacy_settings.get("blocked_apps", [])}
        privacy_blocked = active_app in blocked if active_app else False
        ctx["context_limited_reason"] = None
        meeting_strip = False
        if not privacy_blocked and _privacy_settings.get("meeting_focus") and active_app:
            meeting_strip = any(s in active_app for s in _DEFAULT_MEETING_SUBSTRINGS)
        allowlist_strip = False
        allowed = [str(a).strip().lower() for a in _privacy_settings.get("allowed_apps", []) if str(a).strip()]
        if (
            not privacy_blocked
            and not meeting_strip
            and _privacy_settings.get("context_allowlist_only")
            and allowed
            and active_app
        ):
            allowlist_strip = not any(a in active_app for a in allowed)
        if privacy_blocked:
            ctx["visible_text"] = ""
            ctx["blocked_fields"] = ["visible_text"]
            ctx["redacted_fields"] = []
            ctx["context_limited_reason"] = "blocklist"
        elif meeting_strip or allowlist_strip:
            ctx["visible_text"] = ""
            ctx["blocked_fields"] = ["visible_text"]
            ctx["redacted_fields"] = []
            ctx["context_limited_reason"] = "meeting_focus" if meeting_strip else "allowlist"
        elif _privacy_settings.get("redact_sensitive", True):
            ctx["visible_text"] = redact_sensitive_text(str(ctx.get("visible_text") or ""))
            ctx["blocked_fields"] = []
            ctx["redacted_fields"] = _redaction_fields(str(ctx.get("visible_text") or ""))
        else:
            ctx["blocked_fields"] = []
            ctx["redacted_fields"] = []
        ctx["privacy_blocked"] = privacy_blocked
        ctx["meeting_focus_active"] = bool(meeting_strip)
        ctx["captured_at"] = int(time.time())
        with _loop_lock:
            _current_context = ctx
            snap = dict(ctx)
            snap["id"] = f"ctx_{ctx['captured_at']}_{len(_context_timeline)}"
            _context_timeline.insert(0, snap)
            del _context_timeline[MAX_TIMELINE_ITEMS:]
        # Debounce: only call the LLM for suggestions when context has changed
        # meaningfully OR enough time has passed, to avoid expensive calls every tick.
        now = time.monotonic()
        ctx_key = _suggestions_context_key(ctx)
        context_changed = ctx_key != _suggestions_last_key
        cooldown_ok = (now - _suggestions_last_at) >= _SUGGESTIONS_MIN_COOLDOWN
        safety_fallback = (now - _suggestions_last_at) >= _SUGGESTIONS_SAFETY_FALLBACK
        if (context_changed and cooldown_ok) or safety_fallback or force:
            try:
                suggestions = get_suggestions(ctx)
                _suggestions_last_key = ctx_key
                _suggestions_last_at = now
                with _loop_lock:
                    _current_suggestions = suggestions
            except Exception:
                logger.debug("Suggestion generation failed", exc_info=True)
    except Exception:
        logger.debug("Context loop iteration failed", exc_info=True)
        with _loop_lock:
            _current_context = _current_context or {}
            _current_suggestions = _current_suggestions or []


def _run_app_watcher() -> None:
    """Lightweight thread: reads active app name and triggers capture when the user
    switches to a watched app (Gmail, Notion, Slack, etc.).

    Debounce: the app must be stable (unchanged) for DEBOUNCE_SECONDS before capture
    fires, preventing OCR spam on rapid Alt-Tab switching.
    """
    global _auto_capture_last_app, _auto_capture_last_at
    from screen_capture import get_active_app

    DEBOUNCE_SECONDS = 1.5  # app must remain stable this long before capture
    _pending_app: str = ""
    _pending_since: float = 0.0

    while True:
        try:
            if not _capture_paused:
                app_name, window_title = get_active_app()
                combined = f"{app_name} {window_title}".lower()
                now = time.time()
                is_watched = any(a in combined for a in AUTO_CAPTURE_APPS)

                if combined != _pending_app:
                    # New app seen — start debounce timer
                    _pending_app = combined
                    _pending_since = now
                elif is_watched and combined != _auto_capture_last_app:
                    # App is stable; check debounce window
                    stable_for = now - _pending_since
                    cooldown_ok = (now - _auto_capture_last_at) >= AUTO_CAPTURE_COOLDOWN_SECONDS
                    if stable_for >= DEBOUNCE_SECONDS and cooldown_ok:
                        _auto_capture_last_app = combined
                        _auto_capture_last_at = now
                        _context_loop_iteration(force=True)
        except Exception:
            pass
        time.sleep(1.0)


_loop_thread: threading.Thread | None = None


def _restore_context_snapshots() -> None:
    """Restore context snapshots from DB on startup so A/B diff survives backend restarts."""
    global _context_snapshots
    try:
        from database import get_setting
        for slot in ("a", "b"):
            raw = get_setting(f"context_snapshot_{slot}")
            if raw:
                snap = json.loads(raw)
                if isinstance(snap, dict) and snap.get("visible_text"):
                    _context_snapshots[slot] = snap
    except Exception:
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _loop_thread
    init_db()
    _hydrate_privacy_from_db()
    _restore_context_snapshots()
    _loop_thread = threading.Thread(target=_run_app_watcher, daemon=True)
    _loop_thread.start()
    yield
    _loop_thread = None


app = FastAPI(title="DuckAI Backend", lifespan=lifespan)


class SideaiApiKeyMiddleware(BaseHTTPMiddleware):
    """Optional shared-secret guard for localhost API (set SIDEAI_API_KEY). CORS stays outer (added after this)."""

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        if not SIDEAI_API_KEY:
            return await call_next(request)
        if request.method == "OPTIONS":
            return await call_next(request)
        path = request.url.path
        if path == "/health" or path in ("/openapi.json", "/redoc") or path.startswith("/docs"):
            return await call_next(request)
        provided = (request.headers.get("x-duckai-key") or request.headers.get("X-DuckAI-Key") or "").strip()
        if provided != SIDEAI_API_KEY:
            return JSONResponse({"detail": "Unauthorized"}, status_code=403)
        return await call_next(request)


# ── Per-minute rate limiter for chat/LLM endpoints ────────────────────────────
_RATE_LIMIT_RPM = int(os.getenv("DUCKAI_CHAT_RPM", "60"))  # requests per minute
_rate_buckets: dict[str, list[float]] = {}
_rate_lock = threading.Lock()
_RATE_LIMITED_PATHS = {"/api/chat", "/api/chat/stream", "/api/synthesize"}


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window rate limiter for LLM endpoints. Default: 60 req/min per source IP."""

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        if request.url.path not in _RATE_LIMITED_PATHS:
            return await call_next(request)
        client_ip = (request.headers.get("x-forwarded-for") or request.client.host or "local").split(",")[0].strip()
        now = time.monotonic()
        with _rate_lock:
            bucket = _rate_buckets.setdefault(client_ip, [])
            cutoff = now - 60.0
            _rate_buckets[client_ip] = [t for t in bucket if t > cutoff]
            if len(_rate_buckets[client_ip]) >= _RATE_LIMIT_RPM:
                return JSONResponse(
                    {"detail": f"Rate limit exceeded — max {_RATE_LIMIT_RPM} requests/minute per client."},
                    status_code=429,
                )
            _rate_buckets[client_ip].append(now)
        return await call_next(request)


# Localhost-only API: restrict CORS. Use SIDEAI_CORS_RELAXED=1 for open dev (allow_origins * , no credentials).
_cors_relaxed = os.getenv("SIDEAI_CORS_RELAXED", "").lower() in ("1", "true", "yes")
if _cors_relaxed:
    _cors_origins = ["*"]
    _cors_credentials = False
else:
    _raw = os.getenv(
        "SIDEAI_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,null",
    )
    _cors_origins = [o.strip() for o in _raw.split(",") if o.strip()]
    _cors_credentials = False

app.add_middleware(RateLimitMiddleware)
app.add_middleware(SideaiApiKeyMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(phase2_router)
app.include_router(create_phase3_router(SETTINGS))
app.include_router(create_integrations_router(SETTINGS))
app.include_router(create_everything_router(SETTINGS))
app.include_router(create_writeback_router())
app.include_router(memory_router)
app.include_router(email_draft_router)
app.include_router(calendar_router)
app.include_router(notion_router)
app.include_router(summarize_router)
app.include_router(browser_history_router)
app.include_router(content_router)


class PanelGeometryRequest(BaseModel):
    width: int | None = None
    strip_width: int | None = None
    collapsed: bool | None = None
    position: str | None = None


@app.post("/api/panel_geometry")
def update_panel_geometry(req: PanelGeometryRequest):
    set_panel_geometry(
        width=req.width,
        strip_width=req.strip_width,
        collapsed=req.collapsed,
        position=req.position,
    )
    return {"ok": True}


class ChatRequest(BaseModel):
    messages: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    context: dict[str, Any] | None = None
    conversation_id: str | None = Field(default=None, max_length=128)
    # When False, do not merge live screen capture into context (web-only / grounded answers).
    use_screen_context: bool = True
    # this_chat_only | remember_24h | never_remember
    memory_mode: str = Field(default="this_chat_only", max_length=32)


def _chat_request_context(req: ChatRequest) -> dict[str, Any]:
    if req.use_screen_context:
        ctx = req.context
        if not ctx:
            with _loop_lock:
                ctx = dict(_current_context)
        return dict(ctx or {})
    return dict(req.context or {})


class ChatResponse(BaseModel):
    content: str
    conversation_id: str | None = None
    context_receipt_v2: dict[str, Any] | None = None
    confidence: dict[str, Any] | None = None
    verification: dict[str, Any] | None = None
    smart_followups: list[str] = []


class TypeTextRequest(BaseModel):
    text: str
    method: str = "auto"  # type | paste | auto
    delay_seconds: float = 2.0  # time for user to focus the input field
    restore_clipboard: bool = True
    paste_retries: int = Field(2, ge=1, le=8)
    clipboard_settle_ms: int = Field(95, ge=0, le=3000)
    inter_paste_ms: int = Field(85, ge=0, le=3000)


class CapturePausedRequest(BaseModel):
    paused: bool


class PrivacySettingsRequest(BaseModel):
    blocked_apps: list[str] = []
    redact_sensitive: bool = True
    meeting_focus: bool | None = None
    context_allowlist_only: bool | None = None
    allowed_apps: list[str] | None = None


class ReminderCreateRequest(BaseModel):
    title: str
    due: str | None = None


class ReminderDoneRequest(BaseModel):
    done: bool


class ReminderSnoozeRequest(BaseModel):
    minutes: int = 10


class ShoppingFindCheaperRequest(BaseModel):
    context: dict[str, Any] | None = None  # If omitted, backend uses current screen context


class ConversationCreateRequest(BaseModel):
    title: str = "New conversation"
    tags: list[str] = []
    app_context: str = ""
    memory_mode: str = "this_chat_only"


class ConversationMessageRequest(BaseModel):
    role: str
    content: str


class ConversationStarRequest(BaseModel):
    starred: bool


class SearchHistoryRequest(BaseModel):
    query: str
    limit: int = 12


class TemplateCreateRequest(BaseModel):
    name: str
    prompt: str
    description: str = ""
    tags: list[str] = []
    supported_apps: list[str] = []
    category: str = "general"
    input_schema: list[dict[str, Any]] = []
    source_message: str = ""


class TemplateImportRequest(BaseModel):
    items: list[dict[str, Any]]


class HotkeyCreateRequest(BaseModel):
    key_combo: str
    template_id: str
    enabled: bool = True


class SettingPatchRequest(BaseModel):
    value: str
    type: str = "string"


class SearchRequest(BaseModel):
    query: str
    limit: int = 3


class SynthesizeRequest(BaseModel):
    query: str
    context: dict[str, Any] | None = None
    limit: int | None = None  # web hit count; default from settings


class SaveResponseRequest(BaseModel):
    content: str
    app_context: str = ""
    tags: list[str] = []
    context: str = ""


class AnalyzeClipboardRequest(BaseModel):
    content: str


class ConversationMemoryRequest(BaseModel):
    memory_mode: str


class VerifyAnswerRequest(BaseModel):
    question: str
    answer: str
    hits: list[dict[str, Any]] = []
    conversation_id: str | None = None


class WorkflowFromResponseRequest(BaseModel):
    name: str
    response_text: str
    description: str = ""
    tags: list[str] = []


class ContextSnapshotSlotRequest(BaseModel):
    slot: str  # "a" | "b"


_VALID_PLANS = {"free", "premium", "ultra"}
_PLAN_LABELS = {
    "free":    {"name": "Free",    "model": "Llama-4-Scout-17B (HuggingFace)", "price": "$0/mo",  "context": "2 500 chars"},
    "premium": {"name": "Premium", "model": "Claude Haiku 4.5 (Anthropic)",    "price": "$19/mo", "context": "5 000 chars"},
    "ultra":   {"name": "Ultra",   "model": "Claude Sonnet 4.6 (Anthropic)",   "price": "$49/mo", "context": "8 000 chars"},
}


@app.get("/api/plan")
def get_plan() -> dict[str, Any]:
    plan = (get_setting("user_plan") or "free").strip().lower()
    if plan not in _VALID_PLANS:
        plan = "free"
    info = _PLAN_LABELS[plan]
    return {"plan": plan, **info}


class PlanUpdateRequest(BaseModel):
    plan: str

@app.post("/api/plan")
def set_plan(req: PlanUpdateRequest) -> dict[str, Any]:
    plan = (req.plan or "").strip().lower()
    if plan not in _VALID_PLANS:
        raise HTTPException(status_code=400, detail=f"Invalid plan. Choose from: {', '.join(_VALID_PLANS)}")
    set_setting("user_plan", plan)
    info = _PLAN_LABELS[plan]
    return {"plan": plan, **info}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/meta")
def api_meta() -> dict[str, Any]:
    """Lightweight capability / uptime for clients and debugging."""
    with _loop_lock:
        ctx_age = int(time.time()) - int(_current_context.get("captured_at") or 0) if _current_context.get("captured_at") else None
    return {
        "app": "sideai-backend",
        "uptime_seconds": int(time.monotonic() - _APP_START_MONO),
        "capture_paused": _capture_paused,
        "context_stale_seconds": ctx_age,
        "features": [
            "chat",
            "chat_stream",
            "screen_context",
            "web_search",
            "web_synthesize",
            "slash_search_chat",
            "chat_verify",
            "templates",
            "workflows_from_response",
            "last_chat_transparency",
            "reminder_snooze",
            "context_snapshots_diff",
            "writeback_notion_obsidian_linear_jira",
            "hotkeys",
            "conversations",
            "conversation_memory_modes",
            "type_text",
            "clipboard_analyze",
        ],
    }


@app.get("/api/context")
def get_context() -> dict[str, Any]:
    with _loop_lock:
        return dict(_current_context)


@app.get("/api/context/fresh")
def get_fresh_context() -> dict[str, Any]:
    """Force a fresh screen capture right now, bypassing the debounce cache."""
    _context_loop_iteration(force=True)
    with _loop_lock:
        return dict(_current_context)


@app.post("/api/capture_screen_excluding_self")
def capture_screen_excluding_self() -> dict[str, Any]:
    """
    Capture the screen via CGWindowListCreateImage excluding the DuckAI window.
    The panel is rendered as transparent glass — no hide, no flicker.
    Stores the result in _current_context and returns OCR stats.
    Called by Electron's sideai-capture-screen IPC before falling back to hide-show.
    """
    from screen_capture import capture_screenshot_excluding_self, extract_visible_text, get_active_app

    img = capture_screenshot_excluding_self()

    # Detect if image is all-black (Screen Recording denied to this process)
    no_permission = True
    if img is not None:
        try:
            sample = list(img.getdata())[:50]
            no_permission = not any(sum(p[:3]) > 30 for p in sample)
        except Exception:
            no_permission = True

    if img is None or no_permission:
        return {"ok": False, "reason": "screen_recording_unavailable", "visible_text_len": 0}

    visible_text, ocr_confidence = extract_visible_text(img)
    if _privacy_settings.get("redact_sensitive", True):
        visible_text = redact_sensitive_text(visible_text)

    active_app, window_title = get_active_app()
    ctx: dict[str, Any] = {
        "active_app": active_app,
        "window_title": window_title,
        "visible_text": visible_text,
        "ocr_confidence": ocr_confidence,
        "task": "",
        "captured_at": int(time.time()),
        "source": "cg_excluding_self",
        "blocked_fields": [],
        "redacted_fields": [],
        "privacy_blocked": False,
        "meeting_focus_active": False,
        "context_limited_reason": None,
    }
    with _loop_lock:
        existing_len = len((_current_context.get("visible_text") or "").strip())
        new_len = len(visible_text.strip())
        if new_len >= existing_len or not _current_context:
            _current_context.update(ctx)
        snap = dict(ctx)
        snap["id"] = f"ctx_{ctx['captured_at']}_{len(_context_timeline)}"
        _context_timeline.insert(0, snap)
        del _context_timeline[MAX_TIMELINE_ITEMS:]

    return {
        "ok": True,
        "visible_text_len": len(visible_text),
        "ocr_confidence": ocr_confidence,
        "active_app": active_app,
        "window_title": window_title,
    }


class ScreenshotIngestRequest(BaseModel):
    # base64-encoded PNG (with or without data URL prefix)
    image_data: str
    # active app info from Electron (optional, fills in what PyObjC provides anyway)
    active_app: str = ""
    window_title: str = ""


@app.post("/api/ingest_screenshot")
def ingest_screenshot(req: ScreenshotIngestRequest) -> dict[str, Any]:
    """Receive a screenshot from Electron's desktopCapturer and run OCR on it.
    Electron always has Screen Recording permission; Python never needs it this way.
    """
    import base64
    import io
    from PIL import Image as _Image
    from screen_capture import extract_visible_text, _effective_panel_width, _SIDEBAR_POSITION

    raw = req.image_data
    if "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        img = _Image.open(io.BytesIO(base64.b64decode(raw)))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image data: {e}")

    # Crop out the DuckAI panel so OCR doesn't read its own UI
    panel_w = _effective_panel_width()
    iw, ih = img.size
    if _SIDEBAR_POSITION == "right":
        img = img.crop((0, 0, max(1, iw - panel_w), ih))
    else:
        img = img.crop((min(panel_w, iw - 1), 0, iw, ih))

    visible_text, ocr_confidence = extract_visible_text(img)

    # Get active app/window from Electron or fall back to PyObjC
    active_app = req.active_app.strip()
    window_title = req.window_title.strip()
    if not active_app:
        from screen_capture import get_active_app
        active_app, window_title = get_active_app()

    if _privacy_settings.get("redact_sensitive", True):
        visible_text = redact_sensitive_text(visible_text)

    ctx = {
        "active_app": active_app,
        "window_title": window_title,
        "visible_text": visible_text,
        "ocr_confidence": ocr_confidence,
        "task": "",
        "captured_at": int(time.time()),
        "source": "electron_desktop_capturer",
        "blocked_fields": [],
        "redacted_fields": [],
        "privacy_blocked": False,
        "meeting_focus_active": False,
        "context_limited_reason": None,
    }
    with _loop_lock:
        existing_len = len((_current_context.get("visible_text") or "").strip())
        new_len = len(visible_text.strip())
        # Only overwrite context when the new capture has more text — prevents
        # a blank/failed desktopCapturer frame from wiping out good OCR from
        # the background loop.
        if new_len >= existing_len or not _current_context:
            _current_context.update(ctx)
        snap = dict(ctx)
        snap["id"] = f"ctx_{ctx['captured_at']}_{len(_context_timeline)}"
        _context_timeline.insert(0, snap)
        del _context_timeline[MAX_TIMELINE_ITEMS:]

    return {"ok": True, "visible_text_len": len(visible_text), "ocr_confidence": ocr_confidence}


@app.get("/api/debug/screenshot")
def debug_screenshot() -> dict[str, Any]:
    """Diagnose screenshot pipeline: pixel stats + OCR from this process."""
    from screen_capture import capture_screenshot, _effective_panel_width, extract_visible_text
    import pyautogui
    screen_w, screen_h = pyautogui.size()
    img = capture_screenshot()
    if img is None:
        return {"error": "capture_screenshot returned None", "screen_size": [screen_w, screen_h]}
    pixels = list(img.getdata())
    sample = pixels[:200]
    non_black = [p for p in sample if sum(p[:3]) > 30]
    all_same = len(set(p[:3] for p in sample)) == 1
    text, conf = extract_visible_text(img)
    return {
        "screen_size": [screen_w, screen_h],
        "image_size": list(img.size),
        "panel_width_used": _effective_panel_width(),
        "sample_non_black_pixels": len(non_black),
        "all_pixels_identical": all_same,
        "first_pixel": list(sample[0][:3]) if sample else [],
        "ocr_text_len": len(text),
        "ocr_text_preview": text[:200],
        "ocr_confidence": conf,
    }


@app.post("/api/context/snapshot")
def save_context_snapshot(req: ContextSnapshotSlotRequest) -> dict[str, Any]:
    slot = (req.slot or "").strip().lower()
    if slot not in ("a", "b"):
        raise HTTPException(status_code=400, detail='slot must be "a" or "b"')
    with _loop_lock:
        ctx = dict(_current_context)
    vis = str(ctx.get("visible_text") or "")
    snap = {
        "visible_text": vis,
        "captured_at": ctx.get("captured_at"),
        "active_app": ctx.get("active_app"),
        "window_title": ctx.get("window_title"),
    }
    _context_snapshots[slot] = snap
    # Persist to DB so snapshots survive backend restart
    try:
        set_setting(f"context_snapshot_{slot}", json.dumps(snap), "json")
    except Exception:
        pass
    return {"ok": True, "slot": slot, "chars": len(vis)}


@app.get("/api/context/snapshots/status")
def context_snapshots_status() -> dict[str, Any]:
    def pack(slot: str) -> dict[str, Any] | None:
        s = _context_snapshots.get(slot)
        if not s:
            return None
        return {
            "chars": len(str(s.get("visible_text") or "")),
            "captured_at": s.get("captured_at"),
            "active_app": s.get("active_app"),
            "window_title": s.get("window_title"),
        }

    return {"a": pack("a"), "b": pack("b")}


@app.post("/api/context/diff")
def context_diff_two_captures(summarize: bool = Query(default=False)) -> dict[str, Any]:
    a = _context_snapshots.get("a") or {}
    b = _context_snapshots.get("b") or {}
    ta = str(a.get("visible_text") or "")
    tb = str(b.get("visible_text") or "")
    if not ta.strip() and not tb.strip():
        raise HTTPException(status_code=400, detail="Save snapshot A and B first (POST /api/context/snapshot)")
    diff_lines = list(
        difflib.unified_diff(
            ta.splitlines(),
            tb.splitlines(),
            fromfile="capture_a",
            tofile="capture_b",
            lineterm="",
            n=3,
        )
    )
    diff_text = "\n".join(diff_lines[:8000])
    out: dict[str, Any] = {
        "unified_diff": diff_text,
        "a_chars": len(ta),
        "b_chars": len(tb),
        "a_meta": {k: a.get(k) for k in ("captured_at", "active_app", "window_title")},
        "b_meta": {k: b.get(k) for k in ("captured_at", "active_app", "window_title")},
    }
    if summarize and diff_text.strip():
        try:
            prompt = (
                "Summarize what changed between two screen OCR captures. Be concrete; no raw diff.\n\n"
                f"```diff\n{diff_text[:12000]}\n```"
            )
            out["summary"] = ai_chat(
                [{"role": "user", "content": prompt}],
                context={},
            ).strip()
        except Exception as e:
            out["summary_error"] = str(e)[:500]
    return out


@app.get("/api/suggestions")
def api_suggestions() -> dict[str, list[str]]:
    with _loop_lock:
        return {"suggestions": list(_current_suggestions)}


@app.get("/api/context_timeline")
def get_context_timeline() -> dict[str, list[dict[str, Any]]]:
    with _loop_lock:
        return {"timeline": list(_context_timeline)}


@app.get("/api/privacy_settings")
def get_privacy_settings() -> dict[str, Any]:
    return dict(_privacy_settings)


@app.post("/api/privacy_settings")
def set_privacy_settings(req: PrivacySettingsRequest) -> dict[str, Any]:
    _privacy_settings["blocked_apps"] = [a.strip() for a in req.blocked_apps if a.strip()]
    _privacy_settings["redact_sensitive"] = bool(req.redact_sensitive)
    if req.meeting_focus is not None:
        _privacy_settings["meeting_focus"] = bool(req.meeting_focus)
    if req.context_allowlist_only is not None:
        _privacy_settings["context_allowlist_only"] = bool(req.context_allowlist_only)
    if req.allowed_apps is not None:
        _privacy_settings["allowed_apps"] = [a.strip().lower() for a in req.allowed_apps if a.strip()]
    set_setting("privacy_blocked_apps", json.dumps(_privacy_settings["blocked_apps"]), "json")
    set_setting(
        "privacy_redact_sensitive",
        "true" if _privacy_settings["redact_sensitive"] else "false",
        "bool",
    )
    set_setting(
        "privacy_meeting_focus",
        "true" if _privacy_settings.get("meeting_focus") else "false",
        "bool",
    )
    set_setting(
        "privacy_allowlist_only",
        "true" if _privacy_settings.get("context_allowlist_only") else "false",
        "bool",
    )
    set_setting("privacy_allowed_apps", json.dumps(_privacy_settings.get("allowed_apps", [])), "json")
    return dict(_privacy_settings)


@app.get("/api/transparency/last_chat")
def api_last_chat_transparency() -> dict[str, Any]:
    """Sanitized summary of screen context attached to the most recent chat stream (on-device)."""
    with _transparency_lock:
        return dict(_last_chat_transparency) if _last_chat_transparency else {}


@app.get("/api/permissions/health")
def get_permissions_health() -> dict[str, Any]:
    """Unified capture + accessibility diagnostics (Electron ingest + Python OCR)."""
    with _loop_lock:
        ctx = dict(_current_context)
    return build_permissions_health(ctx, _capture_paused)


@app.get("/api/capture_paused")
def get_capture_paused() -> dict[str, bool]:
    return {"paused": _capture_paused}


@app.post("/api/capture_paused")
def set_capture_paused(req: CapturePausedRequest) -> dict[str, bool]:
    global _capture_paused
    _capture_paused = req.paused
    return {"paused": _capture_paused}


@app.post("/api/capture_now")
def capture_now() -> dict[str, str]:
    _context_loop_iteration(force=True)
    return {"status": "ok"}


@app.post("/api/copy_context")
def copy_context() -> dict[str, str]:
    """Capture current screen and return a human-readable summary for clipboard."""
    from ai_engine import describe_screen_context
    ctx = get_screen_context()
    active_app = (ctx.get("active_app") or "").strip().lower()
    blocked = {str(a).strip().lower() for a in _privacy_settings.get("blocked_apps", [])}
    if active_app in blocked:
        return {"text": f"[Screen context blocked for {ctx.get('active_app', 'this app')}]"}
    if _privacy_settings.get("redact_sensitive", True):
        ctx["visible_text"] = redact_sensitive_text(str(ctx.get("visible_text") or ""))
    text = describe_screen_context(ctx)
    return {"text": text}


class AutoCaptureAppsRequest(BaseModel):
    apps: list[str]


@app.get("/api/auto_capture_apps")
def get_auto_capture_apps() -> dict[str, list[str]]:
    return {"apps": AUTO_CAPTURE_APPS}


@app.put("/api/auto_capture_apps")
def set_auto_capture_apps(req: AutoCaptureAppsRequest) -> dict[str, list[str]]:
    global AUTO_CAPTURE_APPS
    AUTO_CAPTURE_APPS = [a.strip().lower() for a in req.apps if a.strip()]
    return {"apps": AUTO_CAPTURE_APPS}


def _run_delayed_type_text(
    text: str,
    method: str,
    delay_seconds: float,
    restore_clipboard: bool,
    paste_retries: int,
    clipboard_settle_ms: int,
    inter_paste_ms: int,
) -> None:
    """Runs in a worker thread via BackgroundTasks; failures are logged (client already got 200)."""
    try:
        if delay_seconds > 0:
            time.sleep(delay_seconds)
        do_type_text(
            text,
            method=method,
            restore_clipboard=restore_clipboard,
            paste_retries=paste_retries,
            clipboard_settle_ms=clipboard_settle_ms,
            inter_paste_ms=inter_paste_ms,
        )
    except Exception:
        logger.exception("type_text background job failed")


@app.post("/api/type_text")
def type_text_endpoint(req: TypeTextRequest, background_tasks: BackgroundTasks) -> dict[str, str]:
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    background_tasks.add_task(
        _run_delayed_type_text,
        text,
        req.method,
        float(req.delay_seconds),
        bool(req.restore_clipboard),
        int(req.paste_retries),
        int(req.clipboard_settle_ms),
        int(req.inter_paste_ms),
    )
    return {"status": "ok"}


@app.post("/api/chat", response_model=ChatResponse)
def post_chat(req: ChatRequest) -> ChatResponse:
    ctx = _context_with_mode(_chat_request_context(req))
    memory_mode = _normalize_memory_mode(req.memory_mode)
    last_u = ""
    for m in reversed(req.messages or []):
        if str(m.get("role") or "") == "user":
            last_u = str(m.get("content") or "")
            break
    # Inject persistent memory facts into context
    ctx["memory_context"] = memory_get_all_for_prompt()

    # Optionally inject browser history context
    try:
        from database import app_config_get as _cfg_get
        if (_cfg_get("browser_history_enabled") or "false").lower() == "true":
            from services.browser_history import format_for_context, get_recent_urls
            ctx["browser_history_context"] = format_for_context(get_recent_urls(limit=20, hours=6))
    except Exception:
        pass

    _record_chat_transparency(ctx, use_screen_context=req.use_screen_context, last_user_chars=len(last_u))
    receipt = _build_context_receipt_v2(ctx)
    try:
        content = ai_chat(req.messages, ctx)
        smart_followups = get_answer_followups(
            content,
            ctx,
            user_prompt=str((req.messages[-1] if req.messages else {}).get("content") or ""),
        )
        confidence = _build_confidence(ctx=ctx, verification=None, used_hits=[])
        conversation_id = req.conversation_id
        if req.messages:
            user_msg = req.messages[-1]
            if user_msg.get("role") == "user" and user_msg.get("content"):
                if not conversation_id and _should_persist_memory(memory_mode):
                    created = create_conversation(
                        title=(user_msg.get("content") or "New conversation")[:64],
                        tags=[],
                        app_context=str(ctx.get("active_app") or ""),
                        memory_mode=memory_mode,
                    )
                    conversation_id = created["id"]
                if conversation_id and _should_persist_memory(memory_mode):
                    add_message(
                        conversation_id,
                        "user",
                        user_msg.get("content", ""),
                        annotations={"memory_mode": memory_mode},
                    )
                    add_message(
                        conversation_id,
                        "assistant",
                        content,
                        annotations={
                            "memory_mode": memory_mode,
                            "context_receipt_v2": receipt,
                            "confidence": confidence,
                            "smart_followups": smart_followups,
                        },
                    )
        # Background: extract new memory facts from the conversation (non-blocking)
        threading.Thread(
            target=_extract_and_queue_memories,
            args=(req.messages + [{"role": "assistant", "content": content}],),
            daemon=True,
        ).start()

        return ChatResponse(
            content=content,
            conversation_id=conversation_id,
            context_receipt_v2=receipt,
            confidence=confidence,
            verification=None,
            smart_followups=smart_followups,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _parse_due_string(raw: str | None) -> tuple[str | None, int | None]:
    return parse_due_string(raw)


def _search_web_duckduckgo(query: str, limit: int = 3) -> list[dict[str, str]]:
    return search_web_duckduckgo(query, limit)


def _analyze_clipboard_content(content: str) -> dict[str, Any]:
    return analyze_clipboard_content(content)


def _context_with_mode(context: dict[str, Any]) -> dict[str, Any]:
    ctx = dict(context or {})
    active_app = str(ctx.get("active_app") or "")
    mode = resolve_app_mode(active_app)
    ctx["app_mode"] = mode.get("mode", "general")
    mode_prompt = mode.get("system_prompt", "")
    if mode_prompt:
        existing = str(ctx.get("visible_text") or "")
        ctx["visible_text"] = f"{existing}\n\n[App mode guidance]: {mode_prompt}".strip()
    return ctx


def _get_default_memory_mode() -> str:
    """Read the user's saved global default memory mode from settings."""
    try:
        from database import get_setting
        val = get_setting("default_memory_mode")
        return _normalize_memory_mode(val)
    except Exception:
        return "this_chat_only"


def _normalize_memory_mode(raw: str | None) -> str:
    # "default" sentinel means: apply the user's saved preference
    if not raw or raw.strip().lower() == "default":
        return _get_default_memory_mode()
    mode = raw.strip().lower()
    if mode not in ("this_chat_only", "remember_24h", "never_remember"):
        return "this_chat_only"
    return mode


def _should_persist_memory(mode: str) -> bool:
    return mode == "remember_24h"


def _redaction_fields(text: str) -> list[str]:
    markers = {
        "[REDACTED_EMAIL]": "email",
        "[REDACTED_PHONE]": "phone",
        "[REDACTED_KEY]": "api_key",
        "[REDACTED_SECRET]": "secret",
    }
    out: list[str] = []
    for marker, field in markers.items():
        if marker in text:
            out.append(field)
    return out


def _record_chat_transparency(ctx: dict[str, Any], *, use_screen_context: bool, last_user_chars: int) -> None:
    vis = str(ctx.get("visible_text") or "")
    global _last_chat_transparency
    with _transparency_lock:
        _last_chat_transparency = {
            "updated_at": int(time.time()),
            "use_screen_context": bool(use_screen_context),
            "active_app": str(ctx.get("active_app") or ""),
            "window_title": str(ctx.get("window_title") or ""),
            "visible_text_chars": len(vis),
            "privacy_blocked": bool(ctx.get("privacy_blocked")),
            "meeting_focus_active": bool(ctx.get("meeting_focus_active")),
            "context_limited_reason": ctx.get("context_limited_reason"),
            "last_user_message_chars": int(last_user_chars),
        }


def _build_context_receipt_v2(ctx: dict[str, Any]) -> dict[str, Any]:
    visible_text = str(ctx.get("visible_text") or "")
    receipt = {
        "schema_version": "2.0",
        "active_app": str(ctx.get("active_app") or ""),
        "window_title": str(ctx.get("window_title") or ""),
        "captured_at": ctx.get("captured_at"),
        "capture_size_chars": len(visible_text),
        "ocr_confidence": float(ctx.get("ocr_confidence") or 0.0),
        "privacy_blocked": bool(ctx.get("privacy_blocked")),
        "blocked_fields": list(ctx.get("blocked_fields") or (["visible_text"] if bool(ctx.get("privacy_blocked")) else [])),
        "redacted_fields": list(ctx.get("redacted_fields") or _redaction_fields(visible_text)),
    }
    return receipt


def _confidence_band(score: float) -> str:
    if score >= 0.75:
        return "high"
    if score >= 0.45:
        return "medium"
    return "low"


def _build_confidence(
    *,
    ctx: dict[str, Any],
    verification: dict[str, Any] | None,
    used_hits: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    ver_conf = float((verification or {}).get("confidence") or 0.0)
    ocr = float(ctx.get("ocr_confidence") or 0.0)
    hit_bonus = min(0.25, 0.05 * len(used_hits or []))
    stale_seconds = max(0, int(time.time()) - int(ctx.get("captured_at") or int(time.time())))
    freshness = 1.0 if stale_seconds <= 5 else 0.75 if stale_seconds <= 20 else 0.55 if stale_seconds <= 120 else 0.35
    base = 0.25 + (0.3 * ocr) + (0.25 * freshness) + hit_bonus
    if verification:
        base = 0.35 * base + 0.65 * ver_conf
    score = max(0.0, min(base, 1.0))
    return {
        "score": round(score, 3),
        "band": _confidence_band(score),
        "factors": {
            "ocr_confidence": round(ocr, 3),
            "context_freshness": round(freshness, 3),
            "sources_count": len(used_hits or []),
            "verification_confidence": round(ver_conf, 3),
        },
    }


def _recent_assistant_for_contradictions(messages: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for m in reversed(messages or []):
        if str(m.get("role") or "") == "assistant":
            text = str(m.get("content") or "").strip()
            if text:
                out.append(text[:500])
            if len(out) >= 3:
                break
    return list(reversed(out))


def _extract_reminders_from_visible_text(text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not text:
        return out
    clauses = re.split(r"[.;\n]", text)
    for chunk in clauses:
        cleaned = chunk.strip()
        if not cleaned:
            continue
        is_task = bool(
            re.search(r"\b(todo|to do|follow up|deadline|need to|must|action item|remember)\b", cleaned, re.IGNORECASE)
        )
        if not is_task:
            continue
        due_text, due_at = _parse_due_string(cleaned)
        out.append(
            {
                "id": f"rem_{int(time.time() * 1000)}_{len(out)}",
                "title": cleaned[:120],
                "due": due_text,
                "due_at": due_at,
                "done": False,
                "created_at": int(time.time()),
            }
        )
    return out[:8]


@app.post("/api/reminders/extract")
def extract_reminders() -> dict[str, list[dict[str, Any]]]:
    with _loop_lock:
        text = str(_current_context.get("visible_text") or "")
    extracted = _extract_reminders_from_visible_text(text)
    for item in extracted:
        try:
            due_text = item.get("due")
            due_at = item.get("due_at")
            db_reminder_create(item["title"], due_text=due_text, due_at=due_at or 0)
        except Exception:
            pass
    return {"items": db_reminder_list(include_done=True)}


@app.get("/api/reminders")
def get_reminders() -> dict[str, list[dict[str, Any]]]:
    return {"items": db_reminder_list(include_done=True)}


@app.post("/api/reminders")
def create_reminder(req: ReminderCreateRequest) -> dict[str, Any]:
    if not req.title.strip():
        raise HTTPException(status_code=400, detail="Reminder title is required")
    due_text, due_at = _parse_due_string(req.due)
    return db_reminder_create(req.title.strip()[:120], due_text=due_text, due_at=due_at or 0)


@app.post("/api/reminders/{reminder_id}/done")
def set_reminder_done(reminder_id: str, req: ReminderDoneRequest) -> dict[str, Any]:
    updated = db_reminder_set_done(reminder_id, req.done)
    if not updated:
        raise HTTPException(status_code=404, detail="Reminder not found")
    return updated


@app.post("/api/reminders/{reminder_id}/snooze")
def snooze_reminder(reminder_id: str, req: ReminderSnoozeRequest) -> dict[str, Any]:
    updated = db_reminder_snooze(reminder_id, req.minutes)
    if not updated:
        raise HTTPException(status_code=404, detail="Reminder not found")
    return updated


@app.post("/api/shopping/find-cheaper")
def api_shopping_find_cheaper(req: ShoppingFindCheaperRequest) -> dict[str, Any]:
    """Detect grocery/shopping context, extract product, find cheaper alternatives, return best link (for clipboard)."""
    if req.context:
        ctx = req.context
    else:
        with _loop_lock:
            ctx = dict(_current_context)
    try:
        return find_cheaper_alternatives(ctx)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _persist_stream_result(
    messages: list,
    assistant_content: str,
    memory_mode: str,
    conversation_id: str | None,
    ctx: dict[str, Any],
    receipt: dict[str, Any],
    confidence: dict[str, Any],
    followups: list[str],
) -> str | None:
    """Persist user + assistant messages to DB after a stream finishes. Returns conversation_id."""
    if not assistant_content or not messages:
        return conversation_id
    try:
        user_msg = next(
            (m for m in reversed(messages) if str(m.get("role") or "") == "user"), None
        )
        if not user_msg or not user_msg.get("content"):
            return conversation_id
        conv_id = conversation_id
        if _should_persist_memory(memory_mode):
            if not conv_id:
                created = create_conversation(
                    title=(str(user_msg.get("content") or "New conversation"))[:64],
                    tags=[],
                    app_context=str(ctx.get("active_app") or ""),
                    memory_mode=memory_mode,
                )
                conv_id = created["id"]
            add_message(conv_id, "user", str(user_msg.get("content") or ""), annotations={"memory_mode": memory_mode})
            add_message(
                conv_id,
                "assistant",
                assistant_content,
                annotations={
                    "memory_mode": memory_mode,
                    "context_receipt_v2": receipt,
                    "confidence": confidence,
                    "smart_followups": followups,
                },
            )
        # Background memory extraction — same pipeline as non-streaming chat
        threading.Thread(
            target=_extract_and_queue_memories,
            args=(messages + [{"role": "assistant", "content": assistant_content}],),
            daemon=True,
        ).start()
        return conv_id
    except Exception:
        logger.exception("Failed to persist streaming conversation")
        return conversation_id


def _extract_and_queue_memories(all_messages: list) -> None:
    """Extract memory facts from a completed conversation and queue them for approval."""
    try:
        from database import (
            memory_list as _mem_list,
            pending_memory_add,
            pending_memory_purge_old,
            create_notification,
        )
        existing_keys = [m["key"] for m in _mem_list()]
        new_facts = extract_memories_from_chat(all_messages, existing_keys)
        pending_memory_purge_old(days=3)
        added = 0
        for fact in new_facts:
            pending_memory_add(
                fact["key"], fact["value"],
                category=fact.get("category", "general"),
            )
            added += 1
        if added:
            noun = "memory" if added == 1 else "memories"
            create_notification(
                title=f"DuckAI learned {added} new {noun}",
                body="Open Settings → Memory to review and approve.",
                level="info",
            )
    except Exception:
        logger.debug("Memory extraction skipped (non-critical)", exc_info=True)


def _stream_chat(
    messages: list,
    context: dict[str, Any],
    memory_mode: str,
    conversation_id: str | None = None,
    *,
    use_screen_context: bool = True,
):
    ctx = _context_with_mode(context)
    last_u = ""
    for m in reversed(messages or []):
        if str(m.get("role") or "") == "user":
            last_u = str(m.get("content") or "")
            break
    _record_chat_transparency(ctx, use_screen_context=use_screen_context, last_user_chars=len(last_u))
    receipt = _build_context_receipt_v2(ctx)
    full_text = ""
    try:
        for chunk in ai_chat_stream(messages, ctx):
            full_text += chunk
            yield f"data: {json.dumps({'content': chunk})}\n\n"
        followups = get_answer_followups(
            full_text,
            ctx,
            user_prompt=str((messages[-1] if messages else {}).get("content") or ""),
        )
        confidence = _build_confidence(ctx=ctx, verification=None, used_hits=[])
        # Persist conversation after streaming completes
        saved_conv_id = _persist_stream_result(
            messages, full_text, memory_mode, conversation_id, ctx, receipt, confidence, followups
        )
        final_payload = {
            "event": "final",
            "metadata": {
                "memory_mode": memory_mode,
                "conversation_id": saved_conv_id,
                "context_receipt_v2": receipt,
                "confidence": confidence,
                "verification": None,
                "smart_followups": followups,
            },
        }
        yield f"data: {json.dumps(final_payload)}\n\n"
    except Exception as e:
        logger.error("Stream chat error: %s", e)
        yield f"data: {json.dumps({'error': str(e)})}\n\n"


@app.post("/api/chat/stream")
def post_chat_stream(req: ChatRequest):
    ctx = _chat_request_context(req)
    memory_mode = _normalize_memory_mode(req.memory_mode)
    return StreamingResponse(
        _stream_chat(
            req.messages, ctx, memory_mode,
            conversation_id=req.conversation_id,
            use_screen_context=req.use_screen_context,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/conversations")
def api_create_conversation(req: ConversationCreateRequest) -> dict[str, Any]:
    return create_conversation(
        title=req.title,
        tags=req.tags,
        app_context=req.app_context,
        memory_mode=_normalize_memory_mode(req.memory_mode),
    )


@app.get("/api/conversations")
def api_list_conversations(
    query: str = Query(default=""),
    tag: str = Query(default=""),
    starred: bool | None = Query(default=None),
) -> dict[str, list[dict[str, Any]]]:
    return {"items": list_conversations(query=query, tag=tag, starred=starred)}


@app.get("/api/conversations/{conversation_id}")
def api_get_conversation(conversation_id: str) -> dict[str, Any]:
    item = db_get_conversation(conversation_id)
    if not item:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return item


@app.delete("/api/conversations/{conversation_id}")
def api_delete_conversation(conversation_id: str) -> dict[str, bool]:
    deleted = delete_conversation(conversation_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"deleted": True}


@app.post("/api/conversations/{conversation_id}/messages")
def api_add_conversation_message(conversation_id: str, req: ConversationMessageRequest) -> dict[str, Any]:
    if req.role not in ("user", "assistant"):
        raise HTTPException(status_code=400, detail="role must be user or assistant")
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="content required")
    if not db_get_conversation(conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    try:
        return add_message(conversation_id, req.role, req.content.strip())
    except ValueError:
        raise HTTPException(status_code=404, detail="Conversation not found")


@app.post("/api/conversations/{conversation_id}/star")
def api_star_conversation(conversation_id: str, req: ConversationStarRequest) -> dict[str, bool]:
    updated = set_conversation_starred(conversation_id, req.starred)
    if not updated:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"ok": True}


@app.post("/api/conversations/{conversation_id}/memory")
def api_set_conversation_memory(conversation_id: str, req: ConversationMemoryRequest) -> dict[str, Any]:
    updated = set_conversation_memory_mode(conversation_id, _normalize_memory_mode(req.memory_mode))
    if not updated:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return updated


@app.post("/api/search-history")
def api_search_history(req: SearchHistoryRequest) -> dict[str, list[dict[str, Any]]]:
    return {"items": semantic_search_history(req.query, limit=req.limit)}


@app.post("/api/conversations/{conversation_id}/export")
def api_export_conversation(conversation_id: str, format: str = Query(default="markdown")):
    conv = db_get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    export_format = format.strip().lower()
    if export_format in ("markdown", "md"):
        content, filename = build_markdown_export(conversation_id)
        return JSONResponse({"format": "markdown", "filename": filename, "content": content})
    if export_format == "json":
        filename = f"{conv['title'].strip().replace(' ', '_')[:40] or 'conversation'}.json"
        return JSONResponse({"format": "json", "filename": filename, "content": json.dumps(conv, indent=2)})
    if export_format == "pdf":
        try:
            pdf_bytes, filename = build_pdf_export(conversation_id)
        except ValueError as e:
            raise HTTPException(status_code=500, detail=str(e))
        return JSONResponse(
            {
                "format": "pdf",
                "filename": filename,
                "content_base64": b64encode(pdf_bytes).decode("utf-8"),
            }
        )
    raise HTTPException(status_code=400, detail="Unsupported export format")


@app.get("/api/templates")
def api_get_templates(query: str = Query(default=""), tag: str = Query(default="")) -> dict[str, list[dict[str, Any]]]:
    return {"items": list_templates(query=query, tag=tag)}


@app.post("/api/templates")
def api_create_template(req: TemplateCreateRequest) -> dict[str, Any]:
    if not req.name.strip() or not req.prompt.strip():
        raise HTTPException(status_code=400, detail="name and prompt are required")
    return create_template(
        name=req.name,
        prompt=req.prompt,
        description=req.description,
        tags=req.tags,
        supported_apps=req.supported_apps,
        category=req.category,
        input_schema=req.input_schema,
        source_message=req.source_message,
    )


@app.post("/api/workflows/from-response")
def api_workflow_from_response(req: WorkflowFromResponseRequest) -> dict[str, Any]:
    name = req.name.strip()
    body = req.response_text.strip()
    if not name or not body:
        raise HTTPException(status_code=400, detail="name and response_text are required")
    placeholders = sorted({m.group(1).strip() for m in re.finditer(r"\{\{([^{}]+)\}\}", body) if m.group(1).strip()})
    input_schema = [{"name": p, "type": "text", "required": True, "default": ""} for p in placeholders]
    return create_template(
        name=name,
        prompt=body,
        description=req.description.strip() or "Generated from assistant response",
        tags=req.tags,
        supported_apps=[],
        category="workflow",
        input_schema=input_schema,
        source_message=body[:3000],
    )


@app.delete("/api/templates/{template_id}")
def api_delete_template(template_id: str) -> dict[str, bool]:
    deleted = delete_template(template_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Template not found or protected")
    return {"deleted": True}


@app.post("/api/templates/import")
def api_import_templates(req: TemplateImportRequest) -> dict[str, list[dict[str, Any]]]:
    return {"items": import_templates(req.items)}


@app.get("/api/hotkeys")
def api_get_hotkeys() -> dict[str, list[dict[str, Any]]]:
    return {"items": list_hotkeys()}


@app.post("/api/hotkeys")
def api_create_hotkey(req: HotkeyCreateRequest) -> dict[str, Any]:
    valid_combo = bool(re.fullmatch(r"[a-z0-9+_-]{3,40}", req.key_combo.strip().lower()))
    if not valid_combo:
        raise HTTPException(status_code=400, detail="Invalid key combo format")
    # Confirm the referenced template actually exists so the hotkey isn't orphaned
    from database import list_templates as _list_templates
    all_templates = _list_templates()
    if not any(t.get("id") == req.template_id for t in all_templates):
        raise HTTPException(status_code=404, detail="Template not found — delete it and reassign the hotkey")
    try:
        return create_hotkey(req.key_combo, req.template_id, req.enabled)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/hotkeys/{hotkey_id}")
def api_delete_hotkey(hotkey_id: str) -> dict[str, bool]:
    deleted = delete_hotkey(hotkey_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Hotkey not found")
    return {"deleted": True}


@app.get("/api/settings")
def api_get_settings() -> dict[str, Any]:
    return {"items": get_settings()}


@app.patch("/api/settings/{key}")
def api_patch_setting(key: str, req: SettingPatchRequest) -> dict[str, Any]:
    return set_setting(key, req.value, req.type)


@app.get("/api/app-modes")
def api_app_modes() -> dict[str, Any]:
    return {"items": APP_MODES}


@app.get("/api/app-modes/resolve")
def api_resolve_app_mode(active_app: str = Query(default="")) -> dict[str, Any]:
    mode = resolve_app_mode(active_app)
    return {"active_app": active_app, "mode": mode}


@app.post("/api/search")
def api_search(req: SearchRequest) -> dict[str, Any]:
    limit = req.limit or SETTINGS.default_web_search_limit
    return {"items": _search_web_duckduckgo(req.query, limit)}


@app.post("/api/chat/verify")
def api_chat_verify(req: VerifyAnswerRequest) -> dict[str, Any]:
    if not req.question.strip() or not req.answer.strip():
        raise HTTPException(status_code=400, detail="question and answer are required")
    hits = req.hits
    if not hits:
        hits = _search_web_duckduckgo(req.question, limit=5)
    recent_assistant_answers = _recent_assistant_for_contradictions([])
    if req.conversation_id:
        conv = db_get_conversation(req.conversation_id)
        if conv:
            recent_assistant_answers = _recent_assistant_for_contradictions(conv.get("messages") or [])
    verification = verify_answer_with_sources(
        question=req.question,
        answer=req.answer,
        hits=hits,
        recent_assistant_answers=recent_assistant_answers,
    )
    return {"verification": verification, "hits": hits}


@app.post("/api/synthesize")
def api_synthesize(req: SynthesizeRequest) -> dict[str, Any]:
    """Always returns `hits` when DuckDuckGo returns; LLM failures set `synthesis_error` instead of HTTP 500."""
    lim = req.limit if req.limit is not None and req.limit > 0 else SETTINGS.default_web_search_limit
    lim = min(max(lim, 1), 12)
    web_hits = _search_web_duckduckgo(req.query, lim)
    hits_compact = json.dumps(web_hits, ensure_ascii=False, separators=(",", ":"))
    prompt = (
        f"User question: {req.query}\n\nWeb hits (title, url, snippet each):\n{hits_compact}\n\n"
        "Answer in concise prose only. Do not name or list the hit titles or URLs in your answer—the UI shows sources."
    )
    try:
        # Must not use `chat()` here — it injects screen-capture system prompts and confuses web-only Q&A.
        answer = chat_for_web_synthesis([{"role": "user", "content": prompt}])
        return {"answer": answer or "", "hits": web_hits, "synthesis_error": None}
    except ValueError as e:
        logger.warning("synthesize LLM error: %s", e)
        return {"answer": "", "hits": web_hits, "synthesis_error": str(e)}
    except Exception as e:
        logger.exception("synthesize failed")
        return {"answer": "", "hits": web_hits, "synthesis_error": str(e)}


@app.post("/api/responses/save")
def api_save_response(req: SaveResponseRequest) -> dict[str, Any]:
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="content required")
    return save_response(req.content, req.app_context, req.tags, req.context)


@app.get("/api/responses/favorites")
def api_favorites() -> dict[str, list[dict[str, Any]]]:
    return {"items": list_saved_responses()}


@app.post("/api/clipboard/analyze")
def api_clipboard_analyze(req: AnalyzeClipboardRequest) -> dict[str, Any]:
    return _analyze_clipboard_content(req.content)


# ─── Device identity & managed-tier usage ────────────────────────────────────

from ai_engine import MANAGED_DAILY_LIMIT, _is_managed_mode  # noqa: E402
from auth import get_optional_user  # noqa: E402


@app.get("/api/device/info")
def api_device_info(user: dict | None = Depends(get_optional_user)) -> dict[str, Any]:
    """Returns device ID and tier info. Signed-in users are not subject to managed daily limits."""
    managed = _is_managed_mode()
    signed_in = user is not None
    return {
        "device_id": get_device_id(),
        "managed_mode": managed,
        "signed_in": signed_in,
        "clerk_user_id": user.get("sub") if signed_in else None,
        # Signed-in users bypass managed-tier limits
        "daily_limit": None if (not managed or signed_in) else MANAGED_DAILY_LIMIT,
        "today_usage": get_today_usage() if (managed and not signed_in) else None,
    }


@app.get("/api/device/usage")
def api_device_usage(user: dict | None = Depends(get_optional_user)) -> dict[str, Any]:
    """Returns today's managed-tier usage. Signed-in users get unlimited."""
    managed = _is_managed_mode()
    signed_in = user is not None
    if not managed or signed_in:
        return {
            "managed_mode": managed,
            "signed_in": signed_in,
            "used": None,
            "limit": None,
            "remaining": None,
            "limit_reached": False,
        }
    used = get_today_usage()
    limit = MANAGED_DAILY_LIMIT
    return {
        "managed_mode": True,
        "signed_in": False,
        "used": used,
        "limit": limit,
        "remaining": max(0, limit - used),
        "limit_reached": used >= limit,
    }


@app.post("/api/device/usage/increment")
def api_device_usage_increment(user: dict | None = Depends(get_optional_user)) -> dict[str, Any]:
    """Increment managed-tier usage. Signed-in users are not counted against the limit."""
    managed = _is_managed_mode()
    signed_in = user is not None
    if not managed or signed_in:
        return {"managed_mode": managed, "signed_in": signed_in, "used": None}
    used = increment_usage()
    limit = MANAGED_DAILY_LIMIT
    return {
        "managed_mode": True,
        "signed_in": False,
        "used": used,
        "limit": limit,
        "remaining": max(0, limit - used),
        "limit_reached": used >= limit,
    }
