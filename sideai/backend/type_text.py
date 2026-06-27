"""
Type or paste text into the focused application (e.g. reply field, IDE, browser).

Production behavior (especially ``method="paste"``):
- Serializes paste operations (global lock) so concurrent requests cannot corrupt clipboard.
- macOS: prefers ``NSPasteboard`` for UTF-8 text (emoji, RTL, CJK) instead of relying on ``pbcopy`` alone.
- Optionally restores the previous plain-text clipboard after paste (default: on).
- Retries paste hotkey with small delays for slow hosts / focus transitions.
- Sanitizes control characters that break some targets (NUL, etc.).

Requires macOS Accessibility permission for synthetic keyboard events.
"""

from __future__ import annotations

import logging
import sys
import threading
import time
from typing import Any

import pyautogui

logger = logging.getLogger(__name__)

# Use paste for long text to avoid slow typing and special-char issues
PASTE_THRESHOLD = 200
TYPING_INTERVAL = 0.02  # seconds between keystrokes
MAX_INPUT_CHARS = 500_000

# Short pause PyAutoGUI adds between actions; keep low for responsive paste bursts
pyautogui.PAUSE = 0.03

_CLIPBOARD_LOCK = threading.RLock()


def _platform() -> str:
    if sys.platform == "darwin":
        return "darwin"
    if sys.platform.startswith("win"):
        return "windows"
    return "linux"


def _sanitize_for_input(text: str) -> str:
    """Remove NULs and other problematic C0 controls; keep tabs/newlines."""
    if not text:
        return ""
    # Drop NUL (breaks many paste targets)
    out = text.replace("\x00", "")
    # Replace other C0 except \t \n \r
    buf: list[str] = []
    for ch in out:
        o = ord(ch)
        if o < 32 and ch not in "\t\n\r":
            buf.append(" ")
        else:
            buf.append(ch)
    return "".join(buf)


def _macos_clipboard_string_read() -> str | None:
    try:
        from AppKit import NSPasteboard, NSPasteboardTypeString

        pb = NSPasteboard.generalPasteboard()
        s = pb.stringForType_(NSPasteboardTypeString)
        if s is None:
            return None
        return str(s)
    except Exception:
        return None


def _macos_clipboard_string_write(text: str) -> bool:
    try:
        from AppKit import NSPasteboard, NSPasteboardTypeString

        pb = NSPasteboard.generalPasteboard()
        pb.clearContents()
        return bool(pb.setString_forType_(text, NSPasteboardTypeString))
    except Exception:
        return False


def _pyperclip_read() -> str | None:
    import pyperclip

    try:
        s = pyperclip.paste()
        if s is None:
            return None
        return str(s)
    except Exception:
        return None


def _pyperclip_write(text: str) -> bool:
    import pyperclip

    try:
        pyperclip.copy(text)
        return True
    except Exception:
        return False


def _read_clipboard_text() -> str | None:
    """Return previous UTF-8 plain text if readable; None if unknown / non-text-heavy clipboard."""
    if _platform() == "darwin":
        native = _macos_clipboard_string_read()
        if native is not None:
            return native
    return _pyperclip_read()


def _write_clipboard_text(text: str) -> bool:
    if _platform() == "darwin" and _macos_clipboard_string_write(text):
        return True
    return _pyperclip_write(text)


def _verify_clipboard_contains(prefix: str, max_check: int = 512) -> bool:
    """Best-effort: ensure clipboard round-trip after write (newline normalization)."""
    def norm(s: str) -> str:
        return s.replace("\r\n", "\n").replace("\r", "\n")

    sample = norm(prefix[:max_check])
    got_raw = _read_clipboard_text()
    if got_raw is None:
        return False
    got = norm(got_raw[: len(sample)])
    return got == sample


def _paste_hotkey() -> None:
    plat = _platform()
    if plat == "darwin":
        pyautogui.hotkey("command", "v")
    else:
        pyautogui.hotkey("ctrl", "v")


def _paste_via_clipboard(
    text: str,
    *,
    restore_clipboard: bool,
    paste_retries: int,
    clipboard_settle_ms: int,
    inter_paste_ms: int,
) -> None:
    """
    Copy ``text`` to clipboard, send paste hotkey, then restore prior plain text if requested.
    """
    previous: str | None = None
    captured = False
    if restore_clipboard:
        try:
            previous = _read_clipboard_text()
            captured = True
        except Exception:
            logger.debug("clipboard read before paste failed", exc_info=True)

    if not _write_clipboard_text(text):
        raise RuntimeError("Failed to write text to clipboard")

    if not _verify_clipboard_contains(text):
        time.sleep(0.05)
        if _write_clipboard_text(text) and not _verify_clipboard_contains(text):
            logger.debug("clipboard read-back still mismatched after rewrite; continuing with paste")

    settle = max(0, int(clipboard_settle_ms)) / 1000.0
    if settle:
        time.sleep(settle)

    attempts = max(1, int(paste_retries))
    gap = max(0, int(inter_paste_ms)) / 1000.0
    last_err: Exception | None = None
    for i in range(attempts):
        try:
            _paste_hotkey()
            last_err = None
            break
        except Exception as e:
            last_err = e
            logger.warning("paste hotkey attempt %s/%s failed: %s", i + 1, attempts, e)
            if i + 1 < attempts:
                time.sleep(max(0.12, gap) + i * 0.04)
    if last_err is not None:
        raise last_err

    # Let the target app consume the paste before we restore clipboard
    time.sleep(max(settle, 0.08))

    if restore_clipboard and captured and previous is not None:
        try:
            if not _write_clipboard_text(previous):
                _pyperclip_write(previous)
        except Exception:
            logger.debug("clipboard restore failed (non-fatal)", exc_info=True)


def _paste_text(
    text: str,
    *,
    restore_clipboard: bool,
    paste_retries: int,
    clipboard_settle_ms: int,
    inter_paste_ms: int,
) -> None:
    with _CLIPBOARD_LOCK:
        _paste_via_clipboard(
            text,
            restore_clipboard=restore_clipboard,
            paste_retries=paste_retries,
            clipboard_settle_ms=clipboard_settle_ms,
            inter_paste_ms=inter_paste_ms,
        )


def _is_ascii(s: str) -> bool:
    return all(ord(c) < 128 for c in s)


def type_text(
    text: str,
    method: str = "auto",
    *,
    restore_clipboard: bool = True,
    paste_retries: int = 2,
    clipboard_settle_ms: int = 95,
    inter_paste_ms: int = 85,
) -> None:
    """
    Type or paste text into the focused window.

    method: ``type`` | ``paste`` | ``auto``
        - ``type``: character by character (ASCII-only path; needs Accessibility on macOS)
        - ``paste``: native clipboard + paste hotkey (UTF-8 safe, emoji-safe)
        - ``auto``: paste if long or non-ASCII, else type

    Clipboard paste options (``paste`` / ``auto`` when pasting):
        restore_clipboard: put back prior plain-text clipboard after paste.
        paste_retries: paste hotkey attempts (some hosts miss the first event).
        clipboard_settle_ms: wait after writing clipboard before Cmd/Ctrl+V.
        inter_paste_ms: gap between retry hotkeys.
    """
    if not text or not text.strip():
        return
    raw = text.strip()
    if len(raw) > MAX_INPUT_CHARS:
        logger.warning("truncating type_text input from %s to %s chars", len(raw), MAX_INPUT_CHARS)
        raw = raw[:MAX_INPUT_CHARS]
    raw = _sanitize_for_input(raw)

    method = (method or "auto").strip().lower()
    if method == "auto":
        if len(raw) > PASTE_THRESHOLD or not _is_ascii(raw):
            method = "paste"
        else:
            method = "type"

    if method == "paste":
        _paste_text(
            raw,
            restore_clipboard=restore_clipboard,
            paste_retries=paste_retries,
            clipboard_settle_ms=clipboard_settle_ms,
            inter_paste_ms=inter_paste_ms,
        )
        return

    if method != "type":
        raise ValueError(f"Unknown type_text method: {method}")

    with _CLIPBOARD_LOCK:
        try:
            pyautogui.write(raw, interval=TYPING_INTERVAL)
        except Exception:
            logger.info("pyautogui.write failed; falling back to paste", exc_info=True)
            _paste_via_clipboard(
                raw,
                restore_clipboard=restore_clipboard,
                paste_retries=paste_retries,
                clipboard_settle_ms=clipboard_settle_ms,
                inter_paste_ms=inter_paste_ms,
            )


def paste_text_production(
    text: str,
    *,
    restore_clipboard: bool = True,
    paste_retries: int = 3,
    clipboard_settle_ms: int = 110,
    inter_paste_ms: int = 95,
) -> dict[str, Any]:
    """
    Explicit high-reliability paste entrypoint (e.g. quick tools, automations).

    Returns a small status dict for logging / JSON APIs; raises RuntimeError on hard failure.
    """
    if not (text or "").strip():
        raise ValueError("text is required")
    cleaned = _sanitize_for_input(text.strip())
    if len(cleaned) > MAX_INPUT_CHARS:
        cleaned = cleaned[:MAX_INPUT_CHARS]
    type_text(
        cleaned,
        "paste",
        restore_clipboard=restore_clipboard,
        paste_retries=paste_retries,
        clipboard_settle_ms=clipboard_settle_ms,
        inter_paste_ms=inter_paste_ms,
    )
    return {
        "ok": True,
        "chars": len(cleaned),
        "restore_clipboard": restore_clipboard,
        "paste_retries": paste_retries,
    }
