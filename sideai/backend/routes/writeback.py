from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.writeback_integrations import (
    append_notion_page_text,
    append_obsidian_markdown,
    create_jira_issue,
    create_linear_issue,
)


class NotionAppendRequest(BaseModel):
    page_id: str = Field(..., description="Notion page UUID")
    text: str


class ObsidianAppendRequest(BaseModel):
    relative_path: str = Field(default="SideAI-inbox.md", description="Path inside vault")
    text: str


class LinearIssueRequest(BaseModel):
    title: str
    description: str = ""


class JiraIssueRequest(BaseModel):
    summary: str
    description: str = ""


def create_writeback_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/integrations/notion/append")
    def notion_append(req: NotionAppendRequest) -> dict[str, Any]:
        try:
            return append_notion_page_text(req.page_id, req.text)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e)[:1200])

    @router.post("/api/integrations/obsidian/append")
    def obsidian_append(req: ObsidianAppendRequest) -> dict[str, Any]:
        try:
            return append_obsidian_markdown(req.relative_path, req.text)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e)[:1200])

    @router.post("/api/integrations/linear/issue")
    def linear_issue(req: LinearIssueRequest) -> dict[str, Any]:
        try:
            return create_linear_issue(req.title, req.description)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e)[:1200])

    @router.post("/api/integrations/jira/issue")
    def jira_issue(req: JiraIssueRequest) -> dict[str, Any]:
        try:
            return create_jira_issue(req.summary, req.description)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e)[:1200])

    return router
