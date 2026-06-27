"""Browser history context — serve recent URLs for AI context enrichment."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from services.browser_history import format_for_context, get_recent_urls
from database import app_config_get, app_config_set

router = APIRouter(prefix="/api/browser", tags=["browser"])


@router.get("/recent-urls")
def recent_urls(limit: int = 30, hours: int = 8) -> dict:
    enabled = app_config_get("browser_history_enabled") or "false"
    if enabled.lower() != "true":
        return {"enabled": False, "items": [], "context": ""}
    items = get_recent_urls(limit=min(limit, 100), hours=min(hours, 48))
    return {
        "enabled": True,
        "items": items,
        "context": format_for_context(items),
    }


class BrowserHistoryToggleRequest(BaseModel):
    enabled: bool


@router.post("/toggle")
def toggle_browser_history(req: BrowserHistoryToggleRequest) -> dict:
    app_config_set("browser_history_enabled", "true" if req.enabled else "false")
    return {"enabled": req.enabled}


@router.get("/status")
def browser_history_status() -> dict:
    enabled = (app_config_get("browser_history_enabled") or "false").lower() == "true"
    return {"enabled": enabled}
