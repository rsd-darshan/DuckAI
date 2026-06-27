from __future__ import annotations

from typing import Any

from config import Settings


def feature_flags(settings: Settings) -> dict[str, bool]:
    return {
        "browser_bridge": settings.enable_browser_bridge,
        "vscode_bridge": settings.enable_vscode_bridge,
        "macros": settings.enable_macros,
        "team_collab": settings.enable_team_collab,
    }


def integration_response(enabled: bool, name: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if not enabled:
        return {
            "enabled": False,
            "name": name,
            "status": "disabled",
            "message": f"{name} is scaffolded but disabled by feature flag.",
        }
    return {"enabled": True, "name": name, "status": "ready", "payload": payload or {}}
