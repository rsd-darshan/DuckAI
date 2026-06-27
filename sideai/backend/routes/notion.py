"""Notion sync — save AI answers, notes, and context to a Notion database."""

from __future__ import annotations

import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import app_config_get, app_config_set, app_config_delete

router = APIRouter(prefix="/api/notion", tags=["notion"])

NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"


def _notion_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


def _get_token() -> str:
    token = app_config_get("notion_token") or os.getenv("NOTION_TOKEN", "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Notion not configured. Add your token in Settings → Notion.")
    return token


# ── Config ────────────────────────────────────────────────────────────────────

class NotionConfigRequest(BaseModel):
    token: str
    database_id: str = ""


@router.post("/config")
def save_notion_config(req: NotionConfigRequest) -> dict:
    app_config_set("notion_token", req.token.strip())
    if req.database_id.strip():
        app_config_set("notion_database_id", req.database_id.strip())
    return {"ok": True}


@router.get("/config")
def get_notion_config() -> dict:
    token = app_config_get("notion_token") or ""
    db_id = app_config_get("notion_database_id") or ""
    return {
        "configured": bool(token),
        "database_id": db_id,
        "token_preview": f"{token[:8]}…" if token else "",
    }


@router.delete("/config")
def delete_notion_config() -> dict:
    app_config_delete("notion_token")
    app_config_delete("notion_database_id")
    return {"ok": True}


# ── List databases ─────────────────────────────────────────────────────────────

@router.get("/databases")
def list_databases() -> dict:
    token = _get_token()
    try:
        resp = httpx.post(
            f"{NOTION_API}/search",
            headers=_notion_headers(token),
            json={"filter": {"value": "database", "property": "object"}, "page_size": 20},
            timeout=10,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
        dbs = [
            {
                "id": db["id"],
                "title": (
                    (db.get("title") or [{}])[0].get("plain_text", "Untitled")
                    if db.get("title")
                    else "Untitled"
                ),
            }
            for db in results
        ]
        return {"databases": dbs}
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)


# ── Save content ───────────────────────────────────────────────────────────────

class SaveToNotionRequest(BaseModel):
    title: str
    content: str
    tags: list[str] = []
    source: str = "SideAI"


def _rich_text(text: str) -> list[dict[str, Any]]:
    chunks = [text[i:i + 2000] for i in range(0, len(text), 2000)]
    return [{"type": "text", "text": {"content": chunk}} for chunk in chunks]


@router.post("/save")
def save_to_notion(req: SaveToNotionRequest) -> dict:
    token = _get_token()
    db_id = app_config_get("notion_database_id") or ""
    if not db_id:
        raise HTTPException(status_code=400, detail="No Notion database selected. Set it in Settings → Notion.")

    body: dict[str, Any] = {
        "parent": {"database_id": db_id},
        "properties": {
            "Name": {"title": _rich_text(req.title[:200])},
        },
        "children": [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {"rich_text": _rich_text(req.content[:2000])},
            }
        ],
    }
    # Add tags if the db has a multi-select "Tags" property (best-effort)
    if req.tags:
        body["properties"]["Tags"] = {"multi_select": [{"name": t[:100]} for t in req.tags[:10]]}

    try:
        resp = httpx.post(
            f"{NOTION_API}/pages",
            headers=_notion_headers(token),
            json=body,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        return {"ok": True, "page_id": data.get("id", ""), "url": data.get("url", "")}
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
