"""Unified macOS permission and screen-capture health checks."""

from __future__ import annotations

import sys
import time
from typing import Any


def _check_accessibility_darwin() -> tuple[bool, str | None]:
    if sys.platform != "darwin":
        return True, None
    try:
        import ctypes
        import ctypes.util

        lib_path = ctypes.util.find_library("ApplicationServices")
        if not lib_path:
            return False, "ApplicationServices not found"
        lib = ctypes.CDLL(lib_path)
        trusted = bool(lib.AXIsProcessTrusted())
        return trusted, None
    except Exception as e:
        return False, str(e)


def _app_binary_hint() -> str:
    if sys.platform == "darwin":
        return "DuckAI (or Electron in dev, Python/Terminal for the backend in dev)"
    return "DuckAI"


def assess_screen_capture_health(
    current_context: dict[str, Any],
    capture_paused: bool,
) -> dict[str, Any]:
    """Return structured screen-capture health (not just TCC status)."""
    from screen_capture import capture_screenshot, extract_visible_text

    hint_app = _app_binary_hint()
    ctx = current_context or {}
    visible = (ctx.get("visible_text") or "").strip()
    visible_len = len(visible)
    source = str(ctx.get("source") or "")
    limited = ctx.get("context_limited_reason")
    captured_at = int(ctx.get("captured_at") or 0)
    ingest_age = int(time.time()) - captured_at if captured_at else None
    ingest_recent = source == "electron_desktop_capturer" and ingest_age is not None and ingest_age <= 120

    python_image_ok = False
    python_text_len = 0
    python_error: str | None = None
    try:
        img = capture_screenshot()
        if img is not None:
            python_image_ok = True
            text, _ = extract_visible_text(img)
            python_text_len = len((text or "").strip())
    except Exception as e:
        python_error = str(e)

    if capture_paused:
        blocked_reason = "paused"
        ok = False
    elif limited:
        blocked_reason = str(limited)
        ok = visible_len >= 20
    elif visible_len >= 20:
        blocked_reason = None
        ok = True
    elif ingest_recent and visible_len > 0:
        blocked_reason = None
        ok = True
    elif python_image_ok:
        blocked_reason = "ocr_empty" if python_text_len < 20 else None
        ok = python_text_len >= 20
    elif ingest_recent:
        blocked_reason = "ocr_empty"
        ok = False
    else:
        blocked_reason = "permission"
        ok = False

    if blocked_reason == "permission":
        hint = (
            f"Enable Screen Recording for {hint_app} in "
            "System Settings → Privacy & Security → Screen Recording, then relaunch. "
            "In dev, enable both Electron and Python/Terminal."
        )
    elif blocked_reason == "paused":
        hint = "Screen capture is paused. Resume capture from the tray menu or Settings."
    elif blocked_reason in ("blocklist", "meeting_focus", "allowlist"):
        hint = "Screen text is withheld by your privacy settings (Settings → Privacy)."
    elif blocked_reason == "ocr_empty":
        hint = (
            "Capture ran but no readable text was found. Try a text-heavy window, "
            "collapse DuckAI to the side strip, or install Tesseract (brew install tesseract)."
        )
    else:
        hint = f"Screen context is active ({visible_len} characters)."

    return {
        "ok": ok,
        "hint": hint,
        "error": python_error,
        "blocked_reason": blocked_reason,
        "visible_text_len": visible_len,
        "python_capture_ok": python_image_ok,
        "python_visible_text_len": python_text_len,
        "electron_ingest_recent": ingest_recent,
        "context_source": source or None,
        "context_limited_reason": limited,
    }


def assess_accessibility_health() -> dict[str, Any]:
    hint_app = _app_binary_hint()
    if sys.platform != "darwin":
        return {
            "ok": True,
            "hint": "Accessibility is required on macOS for Write it (typing into other apps).",
            "error": None,
        }
    ok, err = _check_accessibility_darwin()
    hint = (
        f"Enable Accessibility for {hint_app} in "
        "System Settings → Privacy & Security → Accessibility (required for Write it)."
    )
    return {"ok": ok, "hint": hint, "error": err}


def build_permissions_health(
    current_context: dict[str, Any],
    capture_paused: bool,
) -> dict[str, Any]:
    import os

    return {
        "platform": os.name,
        "screen_recording": assess_screen_capture_health(current_context, capture_paused),
        "accessibility": assess_accessibility_health(),
    }
