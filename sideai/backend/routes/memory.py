"""User memory — persist facts across sessions."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import (
    memory_delete,
    memory_list,
    memory_upsert,
    pending_memory_add,
    pending_memory_approve,
    pending_memory_dismiss,
    pending_memory_list,
)

router = APIRouter(prefix="/api/memory", tags=["memory"])


class MemoryUpsertRequest(BaseModel):
    key: str
    value: str
    category: str = "general"
    source: str = "manual"


# ── Confirmed memories ────────────────────────────────────────────────────────

@router.get("")
def list_memories() -> dict:
    return {"items": memory_list()}


@router.post("")
def upsert_memory(req: MemoryUpsertRequest) -> dict:
    if not req.key.strip() or not req.value.strip():
        raise HTTPException(status_code=400, detail="key and value must not be empty")
    if len(req.key) > 200 or len(req.value) > 2000:
        raise HTTPException(status_code=400, detail="key (max 200) or value (max 2000) too long")
    return memory_upsert(req.key.strip(), req.value.strip(), req.category, req.source)


@router.delete("/{key}")
def delete_memory(key: str) -> dict:
    deleted = memory_delete(key)
    if not deleted:
        raise HTTPException(status_code=404, detail="Memory key not found")
    return {"ok": True}


# ── Pending memories (AI-suggested, awaiting approval) ───────────────────────

@router.get("/pending")
def list_pending() -> dict:
    return {"items": pending_memory_list()}


@router.post("/pending/{pid}/approve")
def approve_pending(pid: str) -> dict:
    ok = pending_memory_approve(pid)
    if not ok:
        raise HTTPException(status_code=404, detail="Pending memory not found")
    return {"ok": True}


@router.post("/pending/{pid}/dismiss")
def dismiss_pending(pid: str) -> dict:
    ok = pending_memory_dismiss(pid)
    if not ok:
        raise HTTPException(status_code=404, detail="Pending memory not found")
    return {"ok": True}
