"""
Detect grocery/shopping context, extract product from screen, find cheaper alternatives via search,
and return the best link for the user (no chat—auto-detect and paste).
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from ai_engine import _chat_completion
from services.web_search import search_web_duckduckgo

logger = logging.getLogger("sideai.shopping")

# Cooldown: same product query within this many seconds reuses cached result
COOLDOWN_SEC = 300
_MAX_CACHE_SIZE = 100
_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _normalize_query(q: str) -> str:
    return re.sub(r"\s+", " ", (q or "").strip().lower())[:80]


def _evict_cache() -> None:
    """Remove oldest entries when cache exceeds max size."""
    global _cache
    if len(_cache) > _MAX_CACHE_SIZE:
        oldest = sorted(_cache.items(), key=lambda kv: kv[1][0])
        for key, _ in oldest[: len(_cache) - _MAX_CACHE_SIZE]:
            del _cache[key]


# Strong-signal phrases that reliably indicate a shopping product page
_STRONG_SHOPPING_SIGNALS = (
    "add to cart",
    "add to basket",
    "buy now",
    "add to bag",
    "per lb",
    "per oz",
    "per item",
    "in stock",
    "out of stock",
    "free shipping",
    "ships to",
    "sold by",
    "fulfilled by",
)

# Domain substrings that confirm a shopping site
_SHOPPING_DOMAINS = (
    "amazon.", "walmart.", "target.", "bestbuy.", "ebay.",
    "instacart.", "costco.", "wholefoodsmarket.", "kroger.",
    "etsy.", "wayfair.", "homedepot.", "lowes.", "chewy.",
    "shop.", "store.", "buy.", "cart.", "checkout.",
)


def is_grocery_shopping_context(visible_text: str, window_title: str) -> bool:
    """True if screen context looks like an online shopping product page."""
    text = f" {(visible_text or '').lower()} "
    title_lower = (window_title or "").lower()

    # Strong signals in visible text are the most reliable indicator
    if any(k in text for k in _STRONG_SHOPPING_SIGNALS):
        return True

    # Shopping domain in the window title (browser shows "Amazon: product")
    if any(d in title_lower for d in _SHOPPING_DOMAINS):
        return True

    return False


def extract_product_query(visible_text: str) -> str:
    """Use AI to extract a short product/search query from shopping page text."""
    excerpt = (visible_text or "")[:2000].strip()
    if not excerpt:
        return ""
    system = (
        "You extract the single product or search query that a shopper is looking at from a grocery/shopping page. "
        "Reply with ONLY the product name or short search query (e.g. 'organic milk 1 gallon', 'chicken breast'). "
        "No explanation, no quotes, no extra text. One line only."
    )
    try:
        out = _chat_completion(
            [{"role": "user", "content": f"From this shopping page text, what product is the user looking at?\n\n{excerpt}"}],
            system=system,
            max_tokens=80,
            temperature=0.2,
        )
        return (out or "").strip()[:120]
    except Exception:
        return ""


def find_cheaper_alternatives(context: dict[str, Any]) -> dict[str, Any]:
    """
    Detect grocery context, extract product, search for cheaper/same product on other platforms,
    return best_link and alternatives. Uses cooldown per product query.
    """
    visible = (context.get("visible_text") or "").strip()
    title = (context.get("window_title") or "").strip()
    if not is_grocery_shopping_context(visible, title):
        return {"detected": False, "reason": "not_grocery"}

    product_query = extract_product_query(visible)
    if not product_query:
        return {"detected": True, "reason": "no_product", "product_query": "", "alternatives": [], "best_link": None}

    cache_key = _normalize_query(product_query)
    now = time.time()
    if cache_key in _cache:
        ts, cached = _cache[cache_key]
        if now - ts < COOLDOWN_SEC:
            logger.debug("Shopping cache hit for %r", product_query)
            return {**cached, "cached": True}
    _evict_cache()

    # Search: same product across platforms (generic + walmart + amazon style)
    queries = [
        f"{product_query} buy price",
        f"{product_query} walmart",
        f"{product_query} amazon",
    ]
    all_results: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for q in queries:
        for hit in search_web_duckduckgo(q, limit=4):
            u = (hit.get("url") or "").strip()
            if u and u not in seen_urls and u.startswith("http"):
                seen_urls.add(u)
                all_results.append({"title": hit.get("title") or "", "url": u, "snippet": hit.get("snippet") or ""})
        if len(all_results) >= 10:
            break

    if not all_results:
        out = {
            "detected": True,
            "product_query": product_query,
            "alternatives": [],
            "best_link": None,
            "reason": "no_results",
        }
        _cache[cache_key] = (now, out)
        return out

    # AI: pick 1–2 best (same/similar product, preferably cheaper)
    list_text = "\n".join([f"- Title: {r['title']}\n  URL: {r['url']}\n  Snippet: {r['snippet']}" for r in all_results[:12]])
    system = (
        "You are a shopping assistant. Given search results for a product, pick 1 or 2 results that are the SAME or very similar product, ideally at a lower price or on another store. "
        "Reply with ONLY a JSON array of objects, each with keys: title, url, price_text. "
        "price_text can be empty if not visible. No other text, no markdown, just the JSON array."
    )
    try:
        pick = _chat_completion(
            [{"role": "user", "content": f"Product: {product_query}\n\nSearch results:\n{list_text}\n\nPick best 1-2 options as JSON array."}],
            system=system,
            max_tokens=400,
            temperature=0.2,
        )
        alternatives = _parse_alternatives_json(pick)
    except Exception:
        alternatives = [{"title": all_results[0].get("title"), "url": all_results[0].get("url"), "price_text": ""}]

    if not alternatives:
        alternatives = [{"title": r.get("title"), "url": r.get("url"), "price_text": ""} for r in all_results[:2]]

    best_link = (alternatives[0].get("url") or "").strip() if alternatives else None
    out = {
        "detected": True,
        "product_query": product_query,
        "alternatives": alternatives[:5],
        "best_link": best_link,
        "reason": "ok",
    }
    _cache[cache_key] = (now, out)
    return out


def _parse_alternatives_json(raw: str) -> list[dict[str, Any]]:
    """Parse AI JSON array of {title, url, price_text}."""
    raw = (raw or "").strip()
    # Try to find JSON array
    start = raw.find("[")
    if start == -1:
        return []
    end = raw.rfind("]") + 1
    if end <= start:
        return []
    try:
        arr = json.loads(raw[start:end])
        out = []
        for item in arr if isinstance(arr, list) else []:
            if isinstance(item, dict) and item.get("url"):
                out.append({
                    "title": str(item.get("title") or ""),
                    "url": str(item.get("url") or ""),
                    "price_text": str(item.get("price_text") or ""),
                })
        return out
    except Exception:
        return []
