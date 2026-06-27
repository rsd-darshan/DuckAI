"""
Optional outbound integrations: Notion, Obsidian (local file), Linear, Jira.
Configure via environment variables; endpoints return clear errors when unset.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any

import httpx

NOTION_VERSION = "2022-06-28"


def _notion_token() -> str:
    return os.getenv("NOTION_INTEGRATION_TOKEN", "").strip() or os.getenv("NOTION_TOKEN", "").strip()


def append_notion_page_text(page_id: str, text: str) -> dict[str, Any]:
    token = _notion_token()
    if not token:
        raise ValueError("Set NOTION_INTEGRATION_TOKEN (or NOTION_TOKEN) in backend .env")
    pid = (page_id or "").strip()
    if len(pid) < 32:
        raise ValueError("Notion page_id looks invalid (use the page UUID from Share → Copy link)")
    # Notion rich_text limit ~2000 per segment
    chunks: list[str] = []
    t = text.strip()
    while t:
        chunks.append(t[:1800])
        t = t[1800:]
    if not chunks:
        chunks = [""]
    children = [
        {
            "object": "block",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": c}}],
            },
        }
        for c in chunks
    ]
    url = f"https://api.notion.com/v1/blocks/{pid}/children"
    with httpx.Client(timeout=60.0) as client:
        r = client.patch(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
            json={"children": children},
        )
        r.raise_for_status()
        return {"ok": True, "notion": r.json()}


def append_obsidian_markdown(rel_path: str, text: str) -> dict[str, Any]:
    vault = os.getenv("OBSIDIAN_VAULT_PATH", "").strip()
    if not vault:
        raise ValueError("Set OBSIDIAN_VAULT_PATH to your vault root (absolute path)")
    rel = (rel_path or "SideAI-inbox.md").strip().lstrip("/")
    path = os.path.normpath(os.path.join(vault, rel))
    vault_n = os.path.normpath(vault)
    if not path.startswith(vault_n):
        raise ValueError("Invalid path")
    block = f"\n\n---\n\n{text.strip()}\n"
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(block)
    return {"ok": True, "path": path}


def create_linear_issue(title: str, description: str = "") -> dict[str, Any]:
    key = os.getenv("LINEAR_API_KEY", "").strip()
    team = os.getenv("LINEAR_TEAM_ID", "").strip()
    if not key or not team:
        raise ValueError("Set LINEAR_API_KEY and LINEAR_TEAM_ID (UUID from Linear API / team settings)")
    q = """
    mutation($teamId: String!, $title: String!, $description: String) {
      issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
        success
        issue { id identifier url title }
      }
    }
    """
    with httpx.Client(timeout=60.0) as client:
        r = client.post(
            "https://api.linear.app/graphql",
            headers={"Authorization": key, "Content-Type": "application/json"},
            json={"query": q, "variables": {"teamId": team, "title": title[:500], "description": description[:15000] or None}},
        )
        r.raise_for_status()
        data = r.json()
    err = data.get("errors")
    if err:
        raise ValueError(json.dumps(err)[:800])
    payload = (data.get("data") or {}).get("issueCreate") or {}
    return {"ok": bool(payload.get("success")), "linear": payload}


def create_jira_issue(summary: str, description: str = "") -> dict[str, Any]:
    host = os.getenv("JIRA_HOST", "").strip().rstrip("/")
    email = os.getenv("JIRA_EMAIL", "").strip()
    token = os.getenv("JIRA_API_TOKEN", "").strip()
    project = os.getenv("JIRA_PROJECT_KEY", "").strip()
    issue_type = os.getenv("JIRA_ISSUE_TYPE", "Task").strip() or "Task"
    if not host or not email or not token or not project:
        raise ValueError("Set JIRA_HOST (https://your.atlassian.net), JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY")
    auth = base64.b64encode(f"{email}:{token}".encode()).decode()
    body = {
        "fields": {
            "project": {"key": project},
            "summary": summary[:250],
            "description": {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": {"text": description[:32000] or "(no description)"}}],
                    }
                ],
            },
            "issuetype": {"name": issue_type},
        }
    }
    url = f"{host}/rest/api/3/issue"
    with httpx.Client(timeout=60.0) as client:
        r = client.post(
            url,
            headers={
                "Authorization": f"Basic {auth}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json=body,
        )
        if r.status_code >= 400:
            raise ValueError(r.text[:1200])
        return {"ok": True, "jira": r.json()}
