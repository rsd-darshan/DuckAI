"""Resolve readable page/email text for summarize and draft panels."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from services.content_resolve import resolve_readable_content

router = APIRouter(tags=["content"])


class ResolveContentRequest(BaseModel):
    screen_text: str = ""
    window_title: str = ""
    active_app: str = ""
    purpose: str = "general"  # general | summarize | email_draft
    force_fresh: bool = False
    use_browser_dom: bool = False  # slow Chrome/Safari AppleScript — opt-in only


@router.post("/api/content/resolve")
def api_resolve_content(req: ResolveContentRequest) -> dict:
    """Best-effort text for summarize/email UIs (screen OCR first, browser DOM optional)."""
    purpose = (req.purpose or "general").strip().lower()
    if purpose not in ("general", "summarize", "email_draft"):
        purpose = "general"

    return resolve_readable_content(
        screen_text=req.screen_text,
        window_title=req.window_title,
        active_app=req.active_app,
        purpose=purpose,
        force_fresh_capture=req.force_fresh,
        prefer_browser_dom=req.use_browser_dom,
    )
