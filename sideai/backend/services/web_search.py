"""
DuckDuckGo web search — no API key required.

Strategy (in order):
  1. DuckDuckGo JSON Instant-Answer API (fast, structured, no HTML parsing)
  2. DuckDuckGo HTML endpoint with CSS-class regex parser
  3. Return whatever partial results were accumulated

User-Agent pool rotated per request to reduce block risk.
"""

import html
import logging
import random
import re
from urllib.parse import parse_qs, unquote, urlparse

logger = logging.getLogger("sideai.web_search")

_UA_POOL = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
]


def _random_ua() -> str:
    return random.choice(_UA_POOL)


def _unwrap_ddg_url(raw: str) -> str:
    """Turn DuckDuckGo redirect links into real destination URLs."""
    u = (raw or "").strip()
    if not u:
        return u
    if u.startswith("//"):
        u = "https:" + u
    try:
        parsed = urlparse(u)
    except Exception:
        return u
    host = (parsed.netloc or "").lower()
    if "duckduckgo.com" in host and parsed.query:
        qs = parse_qs(parsed.query, keep_blank_values=True)
        inner = (qs.get("uddg") or [None])[0]
        if inner:
            return unquote(inner)
    return u


def _strip_tags(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "").strip()


def _html_decode(s: str) -> str:
    return html.unescape(s or "").strip()


# ── Strategy 1: DDG JSON Instant-Answer API ──────────────────────────────────

def _search_ddg_json(query: str, limit: int, client) -> list[dict[str, str]]:
    """
    DuckDuckGo Instant-Answer API returns RelatedTopics for many queries.
    Results have a FirstURL + Text field — fast, structured, no HTML parsing.
    """
    try:
        r = client.get(
            "https://api.duckduckgo.com/",
            params={"q": query, "format": "json", "no_redirect": "1", "no_html": "1", "skip_disambig": "1"},
            headers={"User-Agent": _random_ua(), "Accept": "application/json"},
        )
        r.raise_for_status()
        data = r.json()
    except Exception as exc:
        logger.debug("DDG JSON API failed: %s", exc)
        return []

    results: list[dict[str, str]] = []

    # AbstractURL is the main result when DDG recognises the query
    if data.get("AbstractURL") and data.get("AbstractText"):
        results.append({
            "title": _html_decode(data.get("Heading") or query),
            "url": data["AbstractURL"],
            "snippet": _html_decode(data["AbstractText"])[:300],
        })

    for topic in data.get("RelatedTopics") or []:
        if len(results) >= limit:
            break
        # Topics can be nested under a Topics key
        if "Topics" in topic:
            for sub in topic["Topics"]:
                if len(results) >= limit:
                    break
                url = sub.get("FirstURL", "")
                text = _html_decode(sub.get("Text") or "")
                if url and text:
                    results.append({"title": text[:80], "url": url, "snippet": text[:300]})
        else:
            url = topic.get("FirstURL", "")
            text = _html_decode(topic.get("Text") or "")
            if url and text:
                results.append({"title": text[:80], "url": url, "snippet": text[:300]})

    return results


# ── Strategy 2: DDG HTML endpoint ────────────────────────────────────────────

def _parse_ddg_html(page: str, limit: int) -> list[dict[str, str]]:
    """
    Parse DuckDuckGo HTML results. Uses three fallback patterns to handle
    layout changes — whichever matches first wins.
    """
    out: list[dict[str, str]] = []

    # Pattern A: standard result__a / result__snippet CSS classes
    for m in re.finditer(
        r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        page,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        if len(out) >= limit:
            break
        raw_href = html.unescape((m.group(1) or "").strip())
        url = _unwrap_ddg_url(raw_href)
        title = _strip_tags(m.group(2))
        if not title or not url:
            continue
        start = m.end()
        nxt = re.search(r'class="[^"]*result__a[^"]*"', page[start:], re.IGNORECASE)
        window_end = start + nxt.start() if nxt else min(start + 2000, len(page))
        chunk = page[start:window_end]
        sn_m = re.search(
            r'class="[^"]*result__snippet[^"]*"[^>]*>(.*?)(?:</a>|</div>)',
            chunk,
            flags=re.IGNORECASE | re.DOTALL,
        )
        snippet = _strip_tags(sn_m.group(1)) if sn_m else ""
        out.append({"title": title, "url": url, "snippet": snippet})

    if out:
        return out

    # Pattern B: data-result links (newer DDG layouts)
    for m in re.finditer(
        r'<a[^>]+data-testid="result-title-a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        page,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        if len(out) >= limit:
            break
        url = _unwrap_ddg_url(html.unescape(m.group(1).strip()))
        title = _strip_tags(m.group(2))
        if title and url:
            out.append({"title": title, "url": url, "snippet": ""})

    return out


def _search_ddg_html(query: str, limit: int, client) -> list[dict[str, str]]:
    try:
        r = client.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query},
            headers={
                "User-Agent": _random_ua(),
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        r.raise_for_status()
        return _parse_ddg_html(r.text, limit)
    except Exception as exc:
        logger.warning("DDG HTML search failed: %s", exc)
        return []


# ── Public API ────────────────────────────────────────────────────────────────

def search_web_duckduckgo(query: str, limit: int = 3) -> list[dict[str, str]]:
    """
    Fetch organic web results from DuckDuckGo (no API key).
    Returns list of {title, url, snippet} dicts.

    Tries the JSON Instant-Answer API first, falls back to HTML scraping.
    """
    q = (query or "").strip()
    if not q:
        return []
    lim = max(1, min(limit, 12))

    try:
        import httpx
    except ImportError:
        logger.error("httpx not installed — web search unavailable")
        return []

    with httpx.Client(timeout=14.0, follow_redirects=True) as client:
        # Strategy 1: JSON API (fast, structured)
        results = _search_ddg_json(q, lim, client)
        if results:
            logger.debug("DDG JSON returned %d results for %r", len(results), q)
            return results[:lim]

        # Strategy 2: HTML scraping
        results = _search_ddg_html(q, lim, client)
        if results:
            logger.debug("DDG HTML returned %d results for %r", len(results), q)
            return results[:lim]

    logger.warning("All DDG search strategies failed for query %r", q)
    return []
