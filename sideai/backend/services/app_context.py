"""Detect what kind of app/page the user is on (email vs coding vs browser)."""

from __future__ import annotations

import re

# ── Strong signals ─────────────────────────────────────────────────────────────

_EMAIL_URL_RE = re.compile(
    r"mail\.google\.com|"
    r"outlook\.(live|office)\.com|"
    r"mail\.yahoo\.com|"
    r"mail\.proton\.me|"
    r"mail\.aol\.com|"
    r"webmail\.|"
    r"/mail/",
    re.I,
)

_NON_EMAIL_URL_RE = re.compile(
    r"neetcode\.io|leetcode\.com|hackerrank\.com|codewars\.com|"
    r"github\.com|gitlab\.com|stackoverflow\.com|"
    r"notion\.so|figma\.com|docs\.google\.com|"
    r"youtube\.com|youtu\.be|"
    r"neetcode\.io|geeksforgeeks\.org|codeforces\.com",
    re.I,
)

_GMAIL_TITLE_RE = re.compile(
    r"\bgmail\b|mail\.google\.com|inbox\s*\(|inbox\s*-",
    re.I,
)

_OUTLOOK_TITLE_RE = re.compile(
    r"\boutlook\b.*(@|\||-)|microsoft outlook",
    re.I,
)

_MAIL_APP_RE = re.compile(
    r"^(mail|apple mail|thunderbird|superhuman|microsoft outlook)$",
    re.I,
)

_CODING_IN_TEXT_RE = re.compile(
    r"neetcode\.io|leetcode\.com|hackerrank|codewars|"
    r"products of array|submissions|discuss\s+question|"
    r"run\s+code|submit\s+solution|time complexity|space complexity",
    re.I,
)


def _norm(s: str) -> str:
    return (s or "").strip()


def is_coding_context(
    active_app: str = "",
    window_title: str = "",
    url: str | None = None,
    visible_text: str = "",
) -> bool:
    blob = f"{_norm(active_app)} {_norm(window_title)} {url or ''} {_norm(visible_text)[:600]}".lower()
    if _NON_EMAIL_URL_RE.search(blob) and not _EMAIL_URL_RE.search(blob):
        return True
    if _CODING_IN_TEXT_RE.search(blob):
        return True
    title = _norm(window_title).lower()
    if "neetcode" in title or "leetcode" in title:
        return True
    return False


def is_email_context(
    active_app: str = "",
    window_title: str = "",
    url: str | None = None,
    visible_text: str = "",
) -> bool:
    """
    True only when the user is in a mail client or webmail inbox — not coding sites,
    and not generic pages that mention the word 'email'.
    """
    active_app = _norm(active_app)
    window_title = _norm(window_title)
    url = _norm(url or "")
    snippet = _norm(visible_text)[:800]

    if is_coding_context(active_app, window_title, url, snippet):
        return False

    if url:
        if _EMAIL_URL_RE.search(url):
            return True
        if _NON_EMAIL_URL_RE.search(url):
            return False

    app_key = active_app.lower()
    if _MAIL_APP_RE.match(app_key) or app_key in ("mail", "thunderbird", "superhuman"):
        return True
    if "outlook" in app_key and "visual studio" not in app_key:
        return True

    if _GMAIL_TITLE_RE.search(window_title):
        return True
    if _OUTLOOK_TITLE_RE.search(window_title):
        return True

    # Webmail hints in captured text (Gmail UI), not bare "email" substring
    if snippet:
        low = snippet.lower()
        if "mail.google.com" in low or "inbox" in low and "compose" in low and "gmail" in low:
            return True

    return False


def is_browser_context(active_app: str = "", window_title: str = "") -> bool:
    blob = f"{_norm(active_app)} {_norm(window_title)}".lower()
    browsers = (
        "chrome", "safari", "firefox", "arc", "brave", "edge", "opera", "vivaldi", "chromium",
    )
    return any(b in blob for b in browsers)
