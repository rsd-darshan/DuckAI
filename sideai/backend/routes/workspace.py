"""
Team Workspace API — Phase 3.

All endpoints require a valid Clerk JWT (RequireUser).
Workspace membership is checked on every mutating operation.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from auth import RequireUser, get_current_user
from database import (
    workspace_create,
    workspace_get,
    workspace_invite_accept,
    workspace_invite_create,
    workspace_list_for_user,
    workspace_member_role,
    workspace_members_list,
    workspace_template_create,
    workspace_template_delete,
    workspace_templates_list,
)

router = APIRouter(prefix="/api/workspace", tags=["workspace"])

# ─── Helper ───────────────────────────────────────────────────────────────────

def _require_member(ws_id: str, clerk_user_id: str, min_role: str = "member") -> str:
    """Return role or raise 403."""
    role = workspace_member_role(ws_id, clerk_user_id)
    if not role:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a member of this workspace")
    rank = {"member": 0, "admin": 1, "owner": 2}
    if rank.get(role, -1) < rank.get(min_role, 0):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Requires {min_role} role")
    return role


# ─── Schemas ──────────────────────────────────────────────────────────────────

class CreateWorkspaceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class InviteMemberRequest(BaseModel):
    email: str
    role: str = "member"


class AcceptInviteRequest(BaseModel):
    token: str


class CreateTemplateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1)
    description: str = ""
    tags: list[str] = []
    category: str = "general"


# ─── Workspace CRUD ───────────────────────────────────────────────────────────

@router.post("")
def create_workspace(req: CreateWorkspaceRequest, user: dict = RequireUser):
    return workspace_create(req.name, user["sub"])


@router.get("")
def list_workspaces(user: dict = RequireUser):
    return {"items": workspace_list_for_user(user["sub"])}


@router.get("/{ws_id}")
def get_workspace(ws_id: str, user: dict = RequireUser):
    _require_member(ws_id, user["sub"])
    ws = workspace_get(ws_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


# ─── Members ──────────────────────────────────────────────────────────────────

@router.get("/{ws_id}/members")
def list_members(ws_id: str, user: dict = RequireUser):
    _require_member(ws_id, user["sub"])
    return {"items": workspace_members_list(ws_id)}


@router.post("/{ws_id}/invite")
def invite_member(ws_id: str, req: InviteMemberRequest, user: dict = RequireUser):
    _require_member(ws_id, user["sub"], min_role="admin")
    if req.role not in ("member", "admin"):
        raise HTTPException(status_code=400, detail="role must be member or admin")
    invite = workspace_invite_create(ws_id, req.email, req.role, user["sub"])
    # In production: send an email with the invite link here
    # e.g. send_invite_email(req.email, invite["token"])
    return invite


@router.post("/accept-invite")
def accept_invite(req: AcceptInviteRequest, user: dict = RequireUser):
    email = user.get("email", "")
    result = workspace_invite_accept(req.token, user["sub"], email)
    if not result:
        raise HTTPException(
            status_code=404,
            detail="Invite not found, already accepted, or expired. Ask the workspace owner to send a new invite.",
        )
    return {"ok": True, "workspace_id": result["workspace_id"]}


# ─── Shared Templates ─────────────────────────────────────────────────────────

@router.get("/{ws_id}/templates")
def list_workspace_templates(ws_id: str, user: dict = RequireUser):
    _require_member(ws_id, user["sub"])
    return {"items": workspace_templates_list(ws_id)}


@router.post("/{ws_id}/templates")
def create_workspace_template(ws_id: str, req: CreateTemplateRequest, user: dict = RequireUser):
    _require_member(ws_id, user["sub"])
    return workspace_template_create(
        ws_id, req.name, req.prompt, req.description, req.tags, req.category, user["sub"]
    )


@router.delete("/{ws_id}/templates/{template_id}")
def delete_workspace_template(ws_id: str, template_id: str, user: dict = RequireUser):
    _require_member(ws_id, user["sub"], min_role="admin")
    deleted = workspace_template_delete(template_id, ws_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"ok": True}
