import re
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

from ai_engine import summarize_content
from services.content_resolve import is_email_context, is_private_url, prepare_email_thread, resolve_readable_content
from services.summarizer import (
    get_browser_url,
    get_browser_page_text,
    extract_youtube_id,
    fetch_youtube_transcript,
    fetch_article_text,
)

router = APIRouter()


@router.get("/api/browser_url")
def current_browser_url():
    url = get_browser_url()
    return {"url": url}


@router.get("/api/browser_page_text")
def current_browser_page_text():
    return get_browser_page_text()


# Domains / patterns that typically indicate paywalled or login-required content
_PAYWALL_SIGNALS = re.compile(
    r"(subscribe\s+to\s+read|sign\s+in\s+to\s+continue|create\s+a\s+free\s+account|"
    r"members.only|premium\s+content|this\s+article\s+is\s+(for\s+)?subscribers|"
    r"you.ve\s+reached\s+your\s+(free\s+)?article\s+limit|"
    r"log\s*in\s+to\s+(view|access|read)|already\s+a\s+subscriber)",
    re.IGNORECASE,
)

_SAFE_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


class SummarizeRequest(BaseModel):
    url: Optional[str] = None
    text: Optional[str] = None
    screen_text: Optional[str] = None
    title: Optional[str] = None
    content_type: Optional[str] = None
    window_title: Optional[str] = None
    active_app: Optional[str] = None


def _error_payload(code: str, message: str, **extra) -> dict:
    return {
        "error": code,
        "message": message,
        "title": extra.get("title", ""),
        "type": extra.get("type", "webpage"),
        "summary": message,
        "key_points": extra.get("key_points", []),
        "sentiment": "neutral",
    }


@router.post("/api/summarize")
def summarize(req: SummarizeRequest):
    title = (req.title or req.window_title or "").strip()
    active_app = (req.active_app or "").strip()
    url = (req.url or "").strip()

    # Explicit text from client (or auto-resolve from screen OCR / ingest)
    text_in = (req.text or req.screen_text or "").strip()
    if not text_in or len(text_in) < 40:
        resolved = resolve_readable_content(
            screen_text=req.screen_text or req.text or "",
            window_title=title,
            active_app=active_app,
            purpose="summarize",
            prefer_browser_dom=False,
        )
        if resolved.get("sufficient") and resolved.get("text"):
            text_in = str(resolved["text"])
            if resolved.get("email_context"):
                req.content_type = req.content_type or "email"
            if not title and resolved.get("url"):
                url = str(resolved["url"])

    if text_in and len(text_in.strip()) >= 40:
        screen_snip = req.screen_text or req.text or ""
        body = prepare_email_thread(text_in) if (
            req.content_type == "email" or is_email_context(active_app, title, url, screen_snip)
        ) else text_in.strip()
        ctype = req.content_type or (
            "email" if is_email_context(active_app, title, url, screen_snip) else "article"
        )
        return summarize_content(body, title or "On screen", ctype)

    screen_snip = req.screen_text or req.text or ""
    email_mode = (
        is_email_context(active_app, title, url, screen_snip)
        or is_private_url(url)
        or req.content_type == "email"
    )

    if email_mode:
        resolved = resolve_readable_content(
            screen_text=req.screen_text or "",
            window_title=title,
            active_app=active_app,
            purpose="summarize",
            prefer_browser_dom=False,
        )
        if resolved.get("needs_chrome_js"):
            return _error_payload(
                "needs_chrome_js",
                "Enable Chrome JS: View → Developer → Allow JavaScript from Apple Events, then try again.",
                type="email",
                key_points=["One-time Chrome setting", "Re-open the email", "Click Summarize again"],
            )
        if resolved.get("sufficient") and resolved.get("text"):
            return summarize_content(
                str(resolved["text"]),
                title or "Email",
                "email",
            )
        return _error_payload(
            "no_content",
            "Could not read enough email text. Open the message body and collapse DuckAI to refresh capture.",
            type="email",
            key_points=[
                "Open the full email thread",
                "Collapse DuckAI to the side strip for a fresh capture",
                "Or enable Chrome JavaScript from Apple Events",
            ],
        )

    if not url:
        url = (get_browser_url() or "").strip()
    if not url:
        return _error_payload(
            "no_url",
            "Could not detect a browser tab. Open a page in Chrome, Safari, or Arc, or paste a URL.",
        )

    if not _SAFE_URL_RE.match(url):
        return {"error": "invalid_url", "message": "Only http/https URLs are supported."}

    video_id = extract_youtube_id(url)

    if video_id:
        try:
            transcript, yt_title = fetch_youtube_transcript(video_id)
        except RuntimeError as e:
            msg = str(e)
            if "not installed" in msg:
                friendly = "The youtube-transcript-api library is missing. Run: pip install youtube-transcript-api"
            elif "disabled" in msg.lower() or "no transcript" in msg.lower():
                friendly = "This video doesn't have transcripts or captions enabled. Try a different video."
            else:
                friendly = f"Could not fetch transcript: {msg}"
            return _error_payload("transcript_unavailable", friendly, type="youtube")
        result = summarize_content(transcript, yt_title, "youtube")
        result["url"] = url
        result["video_id"] = video_id
        return result

    try:
        text, page_title = fetch_article_text(url)
    except Exception as e:
        return _error_payload("fetch_failed", f"Could not load the page: {e}")

    if text and len(text) < 600 and _PAYWALL_SIGNALS.search(text):
        return _error_payload(
            "paywall",
            "This page appears to be paywalled or requires login. DuckAI can only summarize publicly accessible content.",
        )

    content_type = "article" if len(text) > 800 else "webpage"
    result = summarize_content(text, page_title or title, content_type)
    result["url"] = url
    return result
