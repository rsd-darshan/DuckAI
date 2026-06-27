"""
Screen capture and context extraction for SideAI.
Captures screenshot, detects active app (macOS), and extracts visible text via OCR.
"""

import os
import re
import sys
from typing import Any

import pyautogui
from PIL import Image

# Optional: limit pyautogui fail-safe to corner only
pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.1

TEXT_MAX_LENGTH = int(os.getenv("SCREEN_TEXT_MAX_LENGTH", "2000"))

# ── Tesseract path resolution ──────────────────────────────────────────────────
# Electron does not inherit the login shell PATH, so /usr/local/bin is missing.
# Resolve in this priority order:
#   1. SIDEAI_TESSERACT_CMD env var  (set by Electron launcher)
#   2. Common macOS Homebrew/system paths
#   3. Let pytesseract search PATH itself (works when launched from Terminal)
def _resolve_tesseract_cmd() -> str:
    explicit = os.getenv("SIDEAI_TESSERACT_CMD", "").strip()
    if explicit and os.path.isfile(explicit):
        return explicit
    for candidate in (
        "/usr/local/bin/tesseract",
        "/opt/homebrew/bin/tesseract",
        "/usr/bin/tesseract",
    ):
        if os.path.isfile(candidate):
            return candidate
    return "tesseract"  # rely on PATH

try:
    import pytesseract as _pytesseract_init
    _pytesseract_init.tesseract_cmd = _resolve_tesseract_cmd()
except ImportError:
    pass

# Panel geometry — kept mutable so the API can update them at runtime
# when the user resizes/collapses the panel without restarting the backend.
_panel_width: int = int(os.getenv("SIDEAI_PANEL_WIDTH", "320"))
_strip_width: int = int(os.getenv("SIDEAI_STRIP_WIDTH", "48"))
_panel_collapsed: bool = False

# Back-compat alias used by capture_screenshot()
PANEL_WIDTH = _panel_width  # updated via set_panel_geometry()


def set_panel_geometry(
    width: int | None = None,
    strip_width: int | None = None,
    collapsed: bool | None = None,
    position: str | None = None,
) -> None:
    """Called by the API route when Electron reports a geometry change."""
    global _panel_width, _strip_width, _panel_collapsed, PANEL_WIDTH, _SIDEBAR_POSITION
    if width is not None:
        _panel_width = max(48, width)
        PANEL_WIDTH = _panel_width
    if strip_width is not None:
        _strip_width = max(16, strip_width)
    if collapsed is not None:
        _panel_collapsed = collapsed
    if position is not None and position in ("left", "right"):
        _SIDEBAR_POSITION = position


def _effective_panel_width() -> int:
    """Return the pixel width currently occupied by the DuckAI window."""
    return _strip_width if _panel_collapsed else _panel_width


def _get_active_app_macos() -> tuple[str, str]:
    """Get active application name and window title on macOS using PyObjC."""
    try:
        from AppKit import NSWorkspace
        from Quartz import (
            kCGWindowListOptionOnScreenOnly,
            kCGNullWindowID,
            CGWindowListCopyWindowInfo,
        )

        workspace = NSWorkspace.sharedWorkspace()
        front = workspace.frontmostApplication()
        if not front:
            return "Unknown", ""
        app_name = front.localizedName() or "Unknown"
        pid = front.processIdentifier()

        window_list = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly, kCGNullWindowID
        )
        window_title = ""
        for w in window_list or []:
            if w.get("kCGWindowOwnerPID") == pid:
                window_title = w.get("kCGWindowName") or ""
                if window_title:
                    break
        return (app_name, window_title or "")
    except Exception:
        return "Unknown", ""


def _get_active_app_windows() -> tuple[str, str]:
    """Get active application name and window title on Windows using ctypes (no extra deps)."""
    try:
        import ctypes
        import ctypes.wintypes

        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return "Unknown", ""

        # Window title
        length = user32.GetWindowTextLengthW(hwnd) + 1
        buf = ctypes.create_unicode_buffer(length)
        user32.GetWindowTextW(hwnd, buf, length)
        window_title = buf.value or ""

        # Process name from PID
        pid = ctypes.wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        PROCESS_QUERY_INFORMATION = 0x0400
        PROCESS_VM_READ = 0x0010
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        h_proc = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
        app_name = "Unknown"
        if h_proc:
            try:
                psapi = ctypes.windll.psapi  # type: ignore[attr-defined]
                name_buf = ctypes.create_unicode_buffer(1024)
                if psapi.GetModuleFileNameExW(h_proc, None, name_buf, 1024):
                    import os as _os
                    app_name = _os.path.splitext(_os.path.basename(name_buf.value))[0]
            finally:
                kernel32.CloseHandle(h_proc)

        return (app_name, window_title)
    except Exception:
        return "Unknown", ""


def get_active_app() -> tuple[str, str]:
    """Return (active_app_name, window_title). Implemented on macOS and Windows."""
    if sys.platform == "darwin":
        return _get_active_app_macos()
    if sys.platform.startswith("win"):
        return _get_active_app_windows()
    return "Unknown", ""


_SIDEBAR_POSITION = os.getenv("SIDEAI_SIDEBAR_POSITION", "right").strip().lower()

# App names that identify the DuckAI panel window (dev = "Electron", prod = "DuckAI"/"SideAI")
_DUCKAI_OWNER_NAMES = {"electron", "duckai", "sideai"}


def _cgimage_to_pil(cg_image) -> "Image.Image | None":
    """Convert a Quartz CGImageRef to a PIL Image via NSBitmapImageRep."""
    try:
        from AppKit import NSBitmapImageRep, NSPNGFileType  # type: ignore
        import io as _io
        rep = NSBitmapImageRep.alloc().initWithCGImage_(cg_image)
        if rep is None:
            raise ValueError("initWithCGImage_ returned nil")
        data = rep.representationUsingType_properties_(NSPNGFileType, None)
        if data is None:
            raise ValueError("PNG conversion returned nil")
        return Image.open(_io.BytesIO(bytes(data)))
    except Exception:
        pass
    # Fallback: write to temp PNG file
    try:
        import tempfile, os as _os
        from Quartz import (  # type: ignore
            CGImageDestinationCreateWithURL,
            CGImageDestinationAddImage,
            CGImageDestinationFinalize,
        )
        from CoreFoundation import CFURLCreateWithFileSystemPath, kCFURLPOSIXPathStyle  # type: ignore
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            tmp = f.name
        try:
            url = CFURLCreateWithFileSystemPath(None, tmp, kCFURLPOSIXPathStyle, False)
            dest = CGImageDestinationCreateWithURL(url, "public.png", 1, None)
            if dest:
                CGImageDestinationAddImage(dest, cg_image, None)
                if CGImageDestinationFinalize(dest):
                    img = Image.open(tmp)
                    img.load()
                    return img
        finally:
            try:
                _os.unlink(tmp)
            except OSError:
                pass
    except Exception:
        pass
    return None


def capture_screenshot_excluding_self() -> "Image.Image | None":
    """
    Capture the full screen as if the DuckAI panel is transparent glass.

    Uses CGWindowListCreateImage with kCGWindowListOptionOnScreenBelowWindow:
    macOS composites every window rendered below DuckAI's z-order into one image,
    so the panel is completely absent — no hide, no flicker, no blink.

    Falls back to None if Screen Recording is unavailable or the window isn't found.
    """
    if sys.platform != "darwin":
        return None
    try:
        from Quartz import (  # type: ignore
            CGWindowListCopyWindowInfo,
            CGWindowListCreateImage,
            CGImageGetWidth,
            kCGWindowListOptionOnScreenOnly,
            kCGWindowListOptionOnScreenBelowWindow,
            kCGNullWindowID,
            kCGWindowImageDefault,
            CGRectInfinite,
        )

        windows = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly, kCGNullWindowID
        )

        # Find the DuckAI panel: Electron-based, alwaysOnTop (layer >= 3), on screen.
        # Normal app windows sit at layer 0; alwaysOnTop floats at layer 3+.
        # This excludes regular VS Code / other Electron apps at layer 0.
        duckai_wid: int | None = None
        highest_layer = -1
        for w in windows or []:
            owner = str(w.get("kCGWindowOwnerName") or "").lower()
            if not any(name in owner for name in _DUCKAI_OWNER_NAMES):
                continue
            if not w.get("kCGWindowIsOnscreen"):
                continue
            layer = int(w.get("kCGWindowLayer") or 0)
            wid = w.get("kCGWindowNumber")
            if wid and layer >= 3 and layer > highest_layer:
                highest_layer = layer
                duckai_wid = int(wid)

        if duckai_wid is None:
            return None

        image_ref = CGWindowListCreateImage(
            CGRectInfinite,
            kCGWindowListOptionOnScreenBelowWindow,
            duckai_wid,
            kCGWindowImageDefault,
        )
        if not image_ref or CGImageGetWidth(image_ref) == 0:
            return None

        return _cgimage_to_pil(image_ref)
    except Exception:
        return None


def capture_screenshot(retries: int = 2) -> "Image.Image | None":
    """
    Capture the screen without the DuckAI panel.

    Tries capture_screenshot_excluding_self() first (macOS CGWindowListCreateImage —
    panel is invisible without hiding it). Falls back to a pyautogui crop if that
    returns nothing (e.g. Screen Recording not granted to this process).
    """
    # Primary: see-through capture (no hide, no flicker)
    img = capture_screenshot_excluding_self()
    if img is not None:
        # Quick sanity check: all-black means Screen Recording was denied
        try:
            sample = list(img.getdata())[:50]
            if any(sum(p[:3]) > 30 for p in sample):
                return img
        except Exception:
            return img

    # Fallback: pyautogui with panel region cropped out
    import time as _time
    for attempt in range(retries + 1):
        try:
            screen_width, screen_height = pyautogui.size()
            effective_width = _effective_panel_width()
            capture_width = max(1, screen_width - effective_width)
            if _SIDEBAR_POSITION == "left":
                region = (effective_width, 0, capture_width, screen_height)
            else:
                region = (0, 0, capture_width, screen_height)
            return pyautogui.screenshot(region=region)
        except Exception:
            if attempt < retries:
                _time.sleep(0.3 * (attempt + 1))
    return None


import logging as _logging
_ocr_logger = _logging.getLogger("sideai.ocr")


def extract_visible_text(image: Image.Image) -> tuple[str, float]:
    """Extract text and OCR confidence using pytesseract."""
    try:
        import pytesseract
        from pytesseract import Output
    except ImportError:
        _ocr_logger.warning(
            "pytesseract not installed — OCR unavailable. "
            "Install it with: pip install pytesseract  (and install Tesseract: brew install tesseract)"
        )
        return ("", 0.0)

    try:
        text = pytesseract.image_to_string(image)
        if not text or not text.strip():
            # Blank screen or all whitespace — not an error, just nothing to read
            return ("", 0.0)
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        text = ("\n".join(lines) if lines else " ".join(text.split()))[:TEXT_MAX_LENGTH]
        # Compute confidence from OCR word-level data
        conf_data = pytesseract.image_to_data(image, output_type=Output.DICT)
        confidences: list[float] = []
        for raw in conf_data.get("conf", []):
            try:
                val = float(raw)
                if val >= 0:  # Tesseract uses -1 for non-text regions
                    confidences.append(val)
            except (TypeError, ValueError):
                pass
        # Normalize 0-100 Tesseract scale to 0.0-1.0
        confidence = round((sum(confidences) / len(confidences)) / 100.0, 3) if confidences else 0.0
        return (text.strip(), confidence)
    except pytesseract.TesseractNotFoundError:
        _ocr_logger.error(
            "Tesseract binary not found. Install it: brew install tesseract (macOS) "
            "or apt install tesseract-ocr (Linux). Screen context will be unavailable until installed."
        )
        return ("", 0.0)
    except Exception as exc:
        _ocr_logger.debug("OCR extraction error: %s", exc)
        return ("", 0.0)


def redact_sensitive_text(text: str) -> str:
    """Best-effort local redaction for PII, credentials, and secrets."""
    if not text:
        return text
    redacted = text

    # ── Email addresses ────────────────────────────────────────────────────────
    redacted = re.sub(
        r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b",
        "[REDACTED_EMAIL]", redacted,
    )

    # ── Phone numbers (international + local) ─────────────────────────────────
    # Require at least one clear separator or country-code prefix to reduce false positives on dates
    redacted = re.sub(
        r"(?<!\d)(?:\+\d{1,3}[\s\-]?)?(?:\(?\d{3}\)?[\s\-])\d{3}[\s\-]\d{4}(?!\d)",
        "[REDACTED_PHONE]", redacted,
    )

    # ── JWT tokens (header.payload.signature) ─────────────────────────────────
    redacted = re.sub(
        r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b",
        "[REDACTED_JWT]", redacted,
    )

    # ── PEM / certificate headers ──────────────────────────────────────────────
    redacted = re.sub(
        r"-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----",
        "[REDACTED_CERT]", redacted,
    )

    # ── AWS access key IDs ─────────────────────────────────────────────────────
    redacted = re.sub(
        r"\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b",
        "[REDACTED_AWS_KEY]", redacted,
    )

    # ── Common API key prefixes ────────────────────────────────────────────────
    redacted = re.sub(
        r"\b(?:sk|rk|pk|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|xoxa|xoxr|AIza|ya29\.|"
        r"SG\.|AC[a-z0-9]{32}|AP[a-z0-9]{32})[A-Za-z0-9_\-]{10,}\b",
        "[REDACTED_KEY]", redacted,
    )

    # ── Bearer / OAuth tokens on Authorization header lines ───────────────────
    redacted = re.sub(
        r"(?i)(?:authorization|bearer|token)\s*[:=]\s*[A-Za-z0-9_\-\.]{20,}",
        "[REDACTED_TOKEN]", redacted,
    )

    # ── Password fields (key=value style) ─────────────────────────────────────
    redacted = re.sub(
        r"(?i)(?:password|passwd|pwd|secret|api[_\-]?key)\s*[:=]\s*\S{6,}",
        "[REDACTED_CREDENTIAL]", redacted,
    )

    # ── High-entropy base64-ish strings (32+ chars, not URLs) ─────────────────
    redacted = re.sub(
        r"(?<![/\w])\b[A-Za-z0-9+/]{40,}={0,2}\b(?![/\w])",
        "[REDACTED_SECRET]", redacted,
    )

    return redacted


def get_screen_context() -> dict[str, Any]:
    """
    Capture screen and return structured context:
    - active_app, window_title, visible_text, task (inferred later by AI).
    """
    active_app, window_title = get_active_app()
    image = capture_screenshot()
    visible_text = ""
    ocr_confidence = 0.0
    if image:
        visible_text, ocr_confidence = extract_visible_text(image)

    return {
        "active_app": active_app,
        "window_title": window_title or "",
        "visible_text": visible_text,
        "ocr_confidence": ocr_confidence,
        "task": "",  # Filled by AI engine
    }
