"""Resolve readable text for summarize / email-draft from browser DOM, OCR, or cache."""

from __future__ import annotations

import re
from typing import Any

from services.app_context import is_email_context as _is_email_context
from services.summarizer import get_browser_url

_PRIVATE_URL_RE = re.compile(
    r"mail\.google\.com|outlook\.(live|office)\.com|localhost|127\.0\.0\.1",
    re.I,
)

# Matches standalone Gmail UI chrome lines — only exact full-line matches,
# never substrings inside real email content.
_OCR_NOISE_LINE = re.compile(
    r"^(?:inbox|snoozed|sent|drafts|spam|trash|compose|search mail|"
    r"gmail|primary|promotions|social|updates|forums|unread|refresh)$",
    re.I,
)


def is_email_context(
    active_app: str = "",
    window_title: str = "",
    url: str | None = None,
    visible_text: str = "",
) -> bool:
    return _is_email_context(active_app, window_title, url, visible_text)


def is_private_url(url: str | None) -> bool:
    return bool(url and _PRIVATE_URL_RE.search(url))


def min_chars_for(purpose: str, source: str) -> int:
    if purpose == "email_draft":
        return 50 if source == "browser_js" else 55
    if purpose == "summarize":
        return 35 if source == "browser_js" else 45
    return 50 if source == "browser_js" else 55


_QUOTE_HEADER_RE = re.compile(
    r"^On .{5,120} wrote:$|^-{3,}\s*Original Message\s*-{3,}$",
    re.I,
)


def prepare_email_thread(text: str) -> str:
    if not text:
        return ""
    # OCR often returns one long line — split on sentence-like boundaries too
    normalized = text.replace("  ", " ")
    if "\n" not in normalized and len(normalized) > 120:
        normalized = re.sub(r"(?<=[.!?])\s+(?=[A-Z])", "\n", normalized)
    lines = [ln.strip() for ln in normalized.splitlines() if ln.strip()]
    kept: list[str] = []
    in_quoted_block = False
    for ln in lines:
        # Stop collecting once we hit a quoted-reply header ("On Mon... wrote:")
        if _QUOTE_HEADER_RE.match(ln):
            in_quoted_block = True
            break
        # Skip Gmail UI chrome — exact full-line noise only
        if _OCR_NOISE_LINE.match(ln):
            continue
        # Skip 1-2 char lines (e.g. stray OCR artefacts)
        if len(ln) <= 2:
            continue
        # Skip very short non-data lines (but keep email addresses and numbers)
        if len(ln) < 10 and "@" not in ln and not re.search(r"\d", ln):
            continue
        kept.append(ln)
    _ = in_quoted_block  # consumed above via break
    body = "\n".join(kept) if kept else text.strip()
    return re.sub(r"\n{3,}", "\n\n", body).strip()[:6000]


def _merge_live_context(
    screen_text: str,
    window_title: str,
    active_app: str,
) -> tuple[str, str, str]:
    """Prefer Electron-ingested OCR over stale/empty Python capture when the panel is focused."""
    try:
        import main as main_mod

        with main_mod._loop_lock:
            live = dict(main_mod._current_context)
    except Exception:
        live = {}

    live_text = (live.get("visible_text") or "").strip()
    if len(live_text) > len((screen_text or "").strip()):
        screen_text = live_text
    if not window_title and live.get("window_title"):
        window_title = str(live["window_title"])
    if not active_app and live.get("active_app"):
        active_app = str(live["active_app"])
    return screen_text, window_title, active_app


def resolve_readable_content(
    *,
    screen_text: str = "",
    window_title: str = "",
    active_app: str = "",
    purpose: str = "general",
    force_fresh_capture: bool = False,
    prefer_browser_dom: bool = False,  # kept for API compat but ignored
) -> dict[str, Any]:
    screen_text, window_title, active_app = _merge_live_context(screen_text, window_title, active_app)

    url: str | None = get_browser_url()
    email_ctx = is_email_context(active_app, window_title, url, screen_text)

    if force_fresh_capture:
        from screen_capture import get_screen_context
        fresh = get_screen_context()
        fresh_text = (fresh.get("visible_text") or "").strip()
        if len(fresh_text) > len((screen_text or "").strip()):
            screen_text = fresh_text
        window_title = fresh.get("window_title") or window_title
        active_app = fresh.get("active_app") or active_app
        screen_text, window_title, active_app = _merge_live_context(screen_text, window_title, active_app)

    cached_raw = screen_text.strip()
    text = prepare_email_thread(cached_raw) if email_ctx else cached_raw
    source = "screen_cache" if text else "none"
    min_c = min_chars_for(purpose, "screen_cache")

    # Pull OCR confidence from live context — low-confidence OCR is not sufficient
    # even if the character count looks fine (e.g. garbled text from a bad frame).
    try:
        import main as main_mod
        with main_mod._loop_lock:
            ocr_conf = float(main_mod._current_context.get("ocr_confidence") or 1.0)
    except Exception:
        ocr_conf = 1.0

    length_ok = len(text) >= min_c
    confidence_ok = ocr_conf >= 0.35 or source == "none"
    sufficient = length_ok and confidence_ok

    return {
        "text": text,
        "source": source,
        "needs_chrome_js": False,
        "sufficient": sufficient,
        "min_chars": min_c,
        "url": url,
        "email_context": email_ctx,
        "context_limited_reason": None,
    }
