"""
Read recent browser history from Chrome, Firefox, and Safari local SQLite files.
No network requests — purely local file access.
"""

from __future__ import annotations

import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from typing import Any


def _chrome_history_paths() -> list[str]:
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
        profiles = [
            os.path.join(base, "Google/Chrome/Default/History"),
            os.path.join(base, "Google/Chrome/Profile 1/History"),
            os.path.join(base, "Chromium/Default/History"),
            os.path.join(base, "Microsoft Edge/Default/History"),
            os.path.join(base, "Brave Browser/Default/History"),
        ]
    elif sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA", "")
        profiles = [
            os.path.join(base, r"Google\Chrome\User Data\Default\History"),
            os.path.join(base, r"Microsoft\Edge\User Data\Default\History"),
            os.path.join(base, r"BraveSoftware\Brave-Browser\User Data\Default\History"),
        ]
    else:
        profiles = []
    return [p for p in profiles if os.path.exists(p)]


def _firefox_history_paths() -> list[str]:
    if sys.platform == "darwin":
        ff_root = os.path.expanduser("~/Library/Application Support/Firefox/Profiles")
    elif sys.platform.startswith("win"):
        ff_root = os.path.join(os.environ.get("APPDATA", ""), "Mozilla/Firefox/Profiles")
    else:
        ff_root = os.path.expanduser("~/.mozilla/firefox")
    if not os.path.isdir(ff_root):
        return []
    paths = []
    for d in os.listdir(ff_root):
        p = os.path.join(ff_root, d, "places.sqlite")
        if os.path.exists(p):
            paths.append(p)
    return paths


def _safari_history_path() -> str | None:
    if sys.platform != "darwin":
        return None
    p = os.path.expanduser("~/Library/Safari/History.db")
    return p if os.path.exists(p) else None


def _read_chrome_history(db_path: str, limit: int, since_ts: float) -> list[dict[str, Any]]:
    """Chrome stores timestamps as microseconds since 1601-01-01."""
    EPOCH_DIFF = 11644473600  # seconds between 1601-01-01 and 1970-01-01
    since_chrome = int((since_ts + EPOCH_DIFF) * 1_000_000)
    tmp = None
    try:
        # Copy so we don't lock the live DB
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            tmp = f.name
        shutil.copy2(db_path, tmp)
        conn = sqlite3.connect(tmp)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT url, title, last_visit_time
            FROM urls
            WHERE last_visit_time > ?
            ORDER BY last_visit_time DESC
            LIMIT ?
            """,
            (since_chrome, limit),
        ).fetchall()
        conn.close()
        results = []
        for r in rows:
            visited_at = (r["last_visit_time"] / 1_000_000) - EPOCH_DIFF
            results.append({
                "url": r["url"],
                "title": r["title"] or "",
                "visited_at": visited_at,
            })
        return results
    except Exception:
        return []
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)


def _read_firefox_history(db_path: str, limit: int, since_ts: float) -> list[dict[str, Any]]:
    """Firefox stores timestamps as microseconds since Unix epoch."""
    since_ff = int(since_ts * 1_000_000)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            tmp = f.name
        shutil.copy2(db_path, tmp)
        conn = sqlite3.connect(tmp)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT p.url, p.title, h.visit_date
            FROM moz_historyvisits h
            JOIN moz_places p ON p.id = h.place_id
            WHERE h.visit_date > ?
            ORDER BY h.visit_date DESC
            LIMIT ?
            """,
            (since_ff, limit),
        ).fetchall()
        conn.close()
        return [{"url": r["url"], "title": r["title"] or "", "visited_at": r["visit_date"] / 1_000_000} for r in rows]
    except Exception:
        return []
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)


def _read_safari_history(db_path: str, limit: int, since_ts: float) -> list[dict[str, Any]]:
    """Safari stores timestamps as seconds since 2001-01-01 (CoreData epoch)."""
    COREDATA_OFFSET = 978307200  # seconds between 1970 and 2001-01-01
    since_safari = since_ts - COREDATA_OFFSET
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            tmp = f.name
        shutil.copy2(db_path, tmp)
        conn = sqlite3.connect(tmp)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT i.url, v.title, v.visit_time
            FROM history_visits v
            JOIN history_items i ON i.id = v.history_item
            WHERE v.visit_time > ?
            ORDER BY v.visit_time DESC
            LIMIT ?
            """,
            (since_safari, limit),
        ).fetchall()
        conn.close()
        return [{"url": r["url"], "title": r["title"] or "", "visited_at": r["visit_time"] + COREDATA_OFFSET} for r in rows]
    except Exception:
        return []
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)


# Sensitive domain patterns — URLs matching these are never sent to the AI
_SENSITIVE_DOMAINS = re.compile(
    r"(?:^|\.)(?:"
    # Banking & finance
    r"bankofamerica\.com|chase\.com|wellsfargo\.com|citibank\.com|"
    r"capitalone\.com|usbank\.com|tdbank\.com|pnc\.com|"
    r"paypal\.com|venmo\.com|stripe\.com|coinbase\.com|robinhood\.com|"
    # Medical / health
    r"mychart\.com|healthgrades\.com|webmd\.com|mayoclinic\.org|"
    r"drugs\.com|rxlist\.com|nih\.gov|cdc\.gov|"
    # Password managers / secrets
    r"1password\.com|lastpass\.com|bitwarden\.com|dashlane\.com|keepass\..*|"
    # Adult content (generic TLDs handled separately below)
    r"pornhub\.com|xvideos\.com|xnxx\.com|"
    # Government / sensitive personal docs
    r"irs\.gov|ssa\.gov|healthcare\.gov|"
    # General auth / private
    r"accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com"
    r")",
    re.IGNORECASE,
)

_SENSITIVE_SCHEMES = {"chrome://", "about:", "chrome-extension://", "moz-extension://", "file://"}

import re as _re


def _is_sensitive_url(url: str) -> bool:
    """Return True if this URL should be excluded from AI context."""
    if not url:
        return True
    # Strip scheme for domain matching
    lower = url.lower()
    for scheme in _SENSITIVE_SCHEMES:
        if lower.startswith(scheme):
            return True
    # Extract hostname
    try:
        from urllib.parse import urlparse
        host = urlparse(url).hostname or ""
        if _SENSITIVE_DOMAINS.search(host):
            return True
    except Exception:
        pass
    # Query strings containing passwords / tokens
    if _re.search(r"[?&](?:password|token|secret|api_?key|access_token)=", url, _re.IGNORECASE):
        return True
    return False


def get_recent_urls(limit: int = 30, hours: int = 8) -> list[dict[str, Any]]:
    """Return up to `limit` recent browser URLs from the past `hours` hours.

    Sensitive domains (banking, medical, auth, adult) are filtered out before returning.
    """
    since = time.time() - hours * 3600
    results: list[dict[str, Any]] = []

    for p in _chrome_history_paths():
        results.extend(_read_chrome_history(p, limit, since))

    for p in _firefox_history_paths():
        results.extend(_read_firefox_history(p, limit, since))

    safari = _safari_history_path()
    if safari:
        results.extend(_read_safari_history(safari, limit, since))

    # Deduplicate by URL, keep most recent visit, then filter sensitive
    seen: dict[str, dict[str, Any]] = {}
    for item in results:
        url = item["url"]
        if _is_sensitive_url(url):
            continue
        if url not in seen or item["visited_at"] > seen[url]["visited_at"]:
            seen[url] = item

    sorted_results = sorted(seen.values(), key=lambda x: x["visited_at"], reverse=True)
    return sorted_results[:limit]


def format_for_context(urls: list[dict[str, Any]]) -> str:
    """Format recent URLs as a compact string for injection into the AI context."""
    if not urls:
        return ""
    lines = []
    for u in urls[:20]:
        title = u.get("title", "").strip()
        url = u.get("url", "")
        if _is_sensitive_url(url):
            continue
        label = title if title else url
        lines.append(f"- {label[:100]}")
    if not lines:
        return ""
    return "Recent browser tabs/history:\n" + "\n".join(lines)
