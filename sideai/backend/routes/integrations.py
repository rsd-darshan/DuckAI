from __future__ import annotations

from fastapi import APIRouter

from config import Settings
from models.schemas import BrowserBridgeSyncRequest, VSCodeBridgeSyncRequest
from services.integrations import feature_flags, integration_response


def create_integrations_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @router.get("/api/integrations/flags")
    def api_integration_flags():
        return feature_flags(settings)

    @router.post("/api/integrations/browser/sync")
    def api_browser_sync(req: BrowserBridgeSyncRequest):
        return integration_response(
            settings.enable_browser_bridge,
            "browser_bridge",
            {"tab_id": req.tab_id, "url": req.url, "title": req.title},
        )

    @router.post("/api/integrations/vscode/sync")
    def api_vscode_sync(req: VSCodeBridgeSyncRequest):
        return integration_response(
            settings.enable_vscode_bridge,
            "vscode_bridge",
            {"workspace": req.workspace, "active_file": req.active_file},
        )

    return router
