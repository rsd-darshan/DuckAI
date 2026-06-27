"""Content extraction for the Summarize feature.

Supports: YouTube (transcript API), articles/webpages (httpx + HTML parsing).
Browser URL is read via AppleScript on macOS (works for Chrome, Safari, Arc,
Firefox, Brave, Edge). Falls back to None gracefully on Windows or when no
browser is active.
"""
import re
import subprocess
from html.parser import HTMLParser
from typing import Optional

import httpx

# ── Browser URL detection (never launch apps — running processes only) ───────

# AppleScript application name -> process names as shown in Activity Monitor
_BROWSER_APPS: dict[str, list[str]] = {
    "Google Chrome": ["Google Chrome"],
    "Arc": ["Arc"],
    "Brave Browser": ["Brave Browser", "Brave"],
    "Safari": ["Safari"],
    "Firefox": ["Firefox"],
    "Microsoft Edge": ["Microsoft Edge"],
    "Chromium": ["Chromium"],
}

_URL_SCRIPTS_CHROMIUM = 'tell application "{app}" to get URL of active tab of front window'
_URL_SCRIPT_SAFARI = 'tell application "Safari" to get URL of current tab of front window'


def _run_osascript(script: str, timeout: float = 2) -> str:
    try:
        r = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return (r.stdout or "").strip()
    except Exception:
        return ""


def _is_process_running(process_names: list[str]) -> bool:
    """True if any of the given process names is already running (does not launch apps)."""
    for name in process_names:
        # Exact match in process list — avoids substring false positives
        esc = name.replace('"', '\\"')
        script = (
            f'tell application "System Events" to '
            f'((name of processes) contains "{esc}")'
        )
        if _run_osascript(script, timeout=1.5).lower() == "true":
            return True
    return False


def _frontmost_process_name() -> Optional[str]:
    return _run_osascript(
        'tell application "System Events" to get name of first process whose frontmost is true',
        timeout=1.5,
    ) or None


def _app_name_for_process(process_name: str) -> Optional[str]:
    for app_name, aliases in _BROWSER_APPS.items():
        if process_name in aliases:
            return app_name
    return None


def _running_browser_apps() -> list[str]:
    """Browser app names that are already running — never launches anything."""
    return [app for app, procs in _BROWSER_APPS.items() if _is_process_running(procs)]


def _browser_apps_to_query() -> list[str]:
    """Order: frontmost browser (if running), then other running browsers. No inactive apps."""
    running = _running_browser_apps()
    if not running:
        return []
    front_proc = _frontmost_process_name()
    front_app = _app_name_for_process(front_proc) if front_proc else None
    if front_app and front_app in running:
        return [front_app] + [a for a in running if a != front_app]
    return running


def _get_url_from_browser(app_name: str) -> Optional[str]:
    if not _is_process_running(_BROWSER_APPS.get(app_name, [app_name])):
        return None
    if app_name == "Safari":
        script = _URL_SCRIPT_SAFARI
    else:
        script = _URL_SCRIPTS_CHROMIUM.format(app=app_name)
    url = _run_osascript(script, timeout=2)
    if url and url.startswith("http"):
        return url
    return None


def get_browser_url() -> Optional[str]:
    """URL of the active tab in a running browser. Never starts Brave/Safari/etc."""
    import platform
    if platform.system() != "Darwin":
        return None
    for app_name in _browser_apps_to_query():
        url = _get_url_from_browser(app_name)
        if url:
            return url
    return None


# JS injected into the active tab to extract readable page text.
# Tries smart selectors first (Gmail, Outlook, article body), then falls back.
_PAGE_TEXT_JS = r"""
(function() {
  var MAX = 6000;
  function t(el) { return el ? (el.innerText || el.textContent || "").trim() : ""; }
  function enc(s) {
    try { return encodeURIComponent(String(s).substring(0, MAX)); }
    catch (e) { return ""; }
  }
  function pick(nodes) {
    var parts = [];
    for (var i = 0; i < nodes.length && parts.join("\n").length < MAX; i++) {
      var x = t(nodes[i]);
      if (x.length > 20) parts.push(x);
    }
    return parts.join("\n\n");
  }

  // Gmail: message bodies (classic + newer UI)
  var gmailBodies = document.querySelectorAll(
    '.a3s.aiL, .ii.gt .a3s, div[data-message-id] .a3s, [role="listitem"] .a3s, .gs .a3s'
  );
  if (gmailBodies.length) {
    var g = pick(gmailBodies);
    if (g.length > 40) return enc(g);
  }
  var main = document.querySelector('[role="main"]');
  if (main) {
    var m = t(main);
    if (m.length > 80) return enc(m);
  }
  var thread = document.querySelector('.AO, [role="main"] .nH');
  if (thread) {
    var th = t(thread);
    if (th.length > 80) return enc(th);
  }

  // Outlook web
  var outlook = document.querySelector('[aria-label="Message body"], [role="document"]');
  if (outlook) return enc(t(outlook));

  // Article / blog
  var article = document.querySelector('article, [role="article"], main');
  if (article) return enc(t(article));

  return enc((document.body && document.body.innerText) ? document.body.innerText : "");
})()
"""

_CHROMIUM_JS_APPS = frozenset({"Google Chrome", "Arc", "Brave Browser", "Microsoft Edge", "Chromium"})

_CHROME_JS_BLOCKED_SIGNAL = "Executing JavaScript through AppleScript is turned off"


def _decode_js_payload(raw: str) -> str:
    from urllib.parse import unquote

    s = (raw or "").strip()
    if not s:
        return ""
    try:
        return unquote(s.replace("+", " "))
    except Exception:
        return s


def get_browser_page_text(email_only: bool = False) -> dict:
    """
    Extract visible page text from the frontmost browser tab.

    Strategy (in order):
    1. AppleScript JS injection (best — reads live DOM, gets Gmail/Outlook body directly).
       Requires Chrome: View > Developer > Allow JavaScript from Apple Events (one-time setup).
    2. URL + server-side HTTP fetch (works for public articles, GitHub issues, docs, etc.)
    3. Return {"text": "", "needs_chrome_js": True} if only Gmail/authenticated pages are open
       and Chrome JS is blocked, so the frontend can show a one-time setup prompt.
    """
    import platform
    if platform.system() != "Darwin":
        return {"text": ""}

    js = _PAGE_TEXT_JS.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    chrome_js_blocked = False

    url = get_browser_url()
    # Only touch browsers that are already running; prefer the one with the active tab
    browsers_to_try = _browser_apps_to_query()
    if email_only and url and "mail.google" in url:
        if "Google Chrome" in browsers_to_try:
            browsers_to_try = ["Google Chrome"] + [b for b in browsers_to_try if b != "Google Chrome"]

    # ── 1. AppleScript JS injection (single running browser at a time) ─────────
    for browser in browsers_to_try:
        if browser == "Safari":
            if email_only:
                continue
            script = (
                f'tell application "Safari"\n'
                f'  do JavaScript "{js}" in current tab of front window\n'
                f'end tell'
            )
        elif browser in _CHROMIUM_JS_APPS:
            script = (
                f'tell application "{browser}"\n'
                f'  execute active tab of front window javascript "{js}"\n'
                f'end tell'
            )
        else:
            continue
        try:
            r = subprocess.run(
                ["osascript", "-e", script], capture_output=True, text=True, timeout=3
            )
            if _CHROME_JS_BLOCKED_SIGNAL in (r.stderr or ""):
                chrome_js_blocked = True
                continue
            text = _decode_js_payload(r.stdout)
            if text and len(text) > 40:
                return {"text": text}
        except Exception:
            continue

    # ── 2. URL + server-side HTTP fetch (public pages) ─────────────────────────
    if url and not email_only:
        is_private = any(d in url for d in (
            "mail.google.com", "outlook.live.com", "outlook.office.com",
            "localhost", "127.0.0.1",
        ))
        if not is_private:
            try:
                text, _title = fetch_article_text(url)
                if text and len(text) > 80:
                    return {"text": text}
            except Exception:
                pass

    # ── 3. Nothing worked — tell the frontend why ──────────────────────────────
    return {"text": "", "needs_chrome_js": chrome_js_blocked}


# ── YouTube ───────────────────────────────────────────────────────────────────

_YT_PATTERNS = [
    r'youtube\.com/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})',
    r'youtu\.be/([a-zA-Z0-9_-]{11})',
    r'youtube\.com/embed/([a-zA-Z0-9_-]{11})',
    r'youtube\.com/shorts/([a-zA-Z0-9_-]{11})',
]


def extract_youtube_id(url: str) -> Optional[str]:
    for pat in _YT_PATTERNS:
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return None


def fetch_youtube_transcript(video_id: str) -> tuple[str, str]:
    """Return (transcript_text, video_title). Raises RuntimeError if unavailable."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        api = YouTubeTranscriptApi()
        # v1.x uses .fetch(); v0.x used .get_transcript() — handle both
        if hasattr(api, "fetch"):
            transcript = api.fetch(video_id)
            text = " ".join(s.text for s in transcript)
        else:
            snippets = YouTubeTranscriptApi.get_transcript(video_id)  # type: ignore[attr-defined]
            text = " ".join(s["text"] for s in snippets)
        return text, ""
    except ImportError:
        raise RuntimeError(
            "youtube-transcript-api is not installed. "
            "Run: pip install youtube-transcript-api"
        )
    except Exception as e:
        err = str(e).lower()
        if "disabled" in err or "no transcript" in err or "transcripts are disabled" in err:
            raise RuntimeError("This video doesn't have transcripts or captions enabled. Try a different video.")
        raise RuntimeError(f"Could not fetch transcript: {e}")


# ── Article / webpage ─────────────────────────────────────────────────────────

class _MetaParser(HTMLParser):
    """Minimal HTML parser that extracts title + og:description."""

    def __init__(self):
        super().__init__()
        self.title: str = ""
        self.description: str = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        if tag == "title":
            self._in_title = True
        if tag == "meta":
            name = attr.get("name", "").lower()
            prop = attr.get("property", "").lower()
            content = attr.get("content", "")
            if name == "description" or prop in ("og:description", "twitter:description"):
                if not self.description:
                    self.description = content
            if prop in ("og:title", "twitter:title") and not self.title:
                self.title = content

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and not self.title:
            self.title += data


def fetch_article_text(url: str) -> tuple[str, str]:
    """Return (body_text, title). Uses trafilatura if available, else raw parse."""
    # --- Try trafilatura (best quality) ---
    try:
        import trafilatura  # type: ignore
        downloaded = trafilatura.fetch_url(url)
        if downloaded:
            text = trafilatura.extract(
                downloaded,
                include_comments=False,
                include_tables=False,
                no_fallback=False,
            )
            meta = trafilatura.extract_metadata(downloaded)
            title = (meta.title if meta else "") or ""
            if text:
                return text[:8000], title
    except ImportError:
        pass

    # --- Fallback: httpx + HTMLParser ---
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
        )
    }
    r = httpx.get(url, headers=headers, timeout=12, follow_redirects=True)
    r.raise_for_status()
    html = r.text

    parser = _MetaParser()
    parser.feed(html)

    # Strip scripts, styles, then all tags
    clean = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.DOTALL | re.IGNORECASE)
    clean = re.sub(r"<[^>]+>", " ", clean)
    clean = re.sub(r"\s+", " ", clean).strip()

    return clean[:8000], parser.title.strip()
