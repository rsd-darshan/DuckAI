"""Email drafting — screen OCR context, then LLM reply."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from ai_engine import draft_email_reply
from database import memory_get_all_for_prompt
from services.content_resolve import prepare_email_thread, resolve_readable_content

router = APIRouter(prefix="/api/email", tags=["email"])

TONE_OPTIONS = frozenset(("professional", "friendly", "concise", "formal", "casual"))


class DraftReplyRequest(BaseModel):
    thread_text: str = Field("", max_length=6000)
    tone: str = Field("professional", max_length=32)
    window_title: str = Field("", max_length=500)
    active_app: str = Field("", max_length=200)
    screen_text: str = Field("", max_length=4000)
    force_fresh: bool = False

    @field_validator("tone", mode="before")
    @classmethod
    def sanitize_tone(cls, v: object) -> str:
        """Reject anything not in the allowlist — prevents prompt injection via tone."""
        tone = str(v).strip().lower() if v else "professional"
        return tone if tone in TONE_OPTIONS else "professional"

    @field_validator("thread_text", "screen_text", "window_title", "active_app", mode="before")
    @classmethod
    def coerce_str(cls, v: object) -> str:
        return str(v) if v is not None else ""


@router.post("/draft")
def draft_reply(req: DraftReplyRequest) -> dict:
    tone = req.tone  # already sanitized by validator
    thread = prepare_email_thread(req.thread_text.strip())

    if len(thread) < 80:
        screen_text = req.screen_text
        window_title = req.window_title
        active_app = req.active_app
        if req.force_fresh:
            from screen_capture import get_screen_context
            fresh = get_screen_context()
            screen_text = fresh.get("visible_text") or screen_text
            window_title = fresh.get("window_title") or window_title
            active_app = fresh.get("active_app") or active_app

        resolved = resolve_readable_content(
            screen_text=screen_text,
            window_title=window_title,
            active_app=active_app,
            purpose="email_draft",
        )

        if resolved.get("sufficient") and resolved.get("text"):
            thread = str(resolved["text"])
        else:
            return {
                "reply": "",
                "tone": tone,
                "error": "no_content",
                "message": (
                    "Could not read enough of the email. Open the full message body, "
                    "keep it visible, and click ↻ Refresh capture."
                ),
                "source": resolved.get("source"),
            }

    memory_ctx = memory_get_all_for_prompt()
    reply = draft_email_reply(thread, tone=tone, memory_context=memory_ctx)
    return {"reply": reply, "tone": tone, "source": "resolved"}


@router.get("/tones")
def list_tones() -> dict:
    return {"tones": sorted(TONE_OPTIONS)}
