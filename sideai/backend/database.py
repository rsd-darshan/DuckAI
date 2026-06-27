"""
SQLite persistence layer for SideAI Phase 1 features.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent / "sideai.db"

# Single write lock — all DB writes serialize through this.
# WAL mode allows concurrent reads while this lock gates writes.
_DB_WRITE_LOCK = threading.Lock()


BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "code_review",
        "name": "Code Review",
        "prompt": "Review this code for bugs, performance, and style: {{clipboard}}",
        "description": "Review code quality and suggest improvements.",
        "tags": ["coding", "review"],
        "supported_apps": ["vs-code", "cursor", "github"],
        "category": "coding",
        "is_built_in": True,
    },
    {
        "id": "debug_error",
        "name": "Debug Error",
        "prompt": "I'm getting this error: {{clipboard}}. What's wrong and how do I fix it?",
        "description": "Diagnose and fix an error quickly.",
        "tags": ["coding", "debug"],
        "supported_apps": ["vs-code", "terminal", "browser"],
        "category": "coding",
        "is_built_in": True,
    },
    {
        "id": "email_draft",
        "name": "Draft Professional Email",
        "prompt": "Help me draft a professional email about: {{clipboard}}",
        "description": "Write clear and professional emails.",
        "tags": ["writing"],
        "supported_apps": ["gmail", "mail"],
        "category": "writing",
        "is_built_in": True,
    },
    {
        "id": "email_reply",
        "name": "Draft Email Reply",
        "prompt": "Help me draft a professional reply to this email thread: {{clipboard}}.\n\nReturn ONLY the email body ready to paste (include greeting and closing). Do NOT include a subject line.\n\nCRITICAL RULES:\n- Use ONLY information present in the input. Do NOT guess names, dates, deadlines, or commitments.\n- If key details are missing, include 1-3 concise clarification questions or placeholders instead of hallucinating.\n- Match the tone (formal vs casual) implied by the original email.\n- Keep it accurate, concise, and action-oriented.",
        "description": "Draft a professional, accurate email reply to an existing thread.",
        "tags": ["writing", "communication"],
        "supported_apps": ["gmail", "mail"],
        "category": "writing",
        "is_built_in": True,
    },
    {
        "id": "brainstorm",
        "name": "Brainstorm Ideas",
        "prompt": "Brainstorm 5 creative ideas about: {{clipboard}}",
        "description": "Generate multiple ideas quickly.",
        "tags": ["brainstorm"],
        "supported_apps": [],
        "category": "brainstorm",
        "is_built_in": True,
    },
]


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    # WAL mode: concurrent reads don't block each other; writes still serialize via _DB_WRITE_LOCK
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")  # safe with WAL; faster than FULL
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    conn = _connect()
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            tags TEXT,
            created_at TEXT,
            updated_at TEXT,
            summary TEXT,
            app_context TEXT,
            starred INTEGER DEFAULT 0,
            memory_mode TEXT DEFAULT 'this_chat_only',
            expires_at TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            screenshot_path TEXT,
            annotations TEXT,
            model_used TEXT,
            tokens_used INTEGER,
            timestamp TEXT,
            FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS embeddings (
            message_id TEXT PRIMARY KEY,
            embedding_vector BLOB,
            created_at TEXT,
            FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            description TEXT,
            tags TEXT,
            supported_apps TEXT,
            category TEXT,
            is_built_in INTEGER DEFAULT 0,
            created_at TEXT,
            created_by TEXT,
            input_schema_json TEXT,
            source_message TEXT
        );

        CREATE TABLE IF NOT EXISTS hotkeys (
            id TEXT PRIMARY KEY,
            key_combo TEXT NOT NULL UNIQUE,
            template_id TEXT NOT NULL,
            enabled INTEGER DEFAULT 1,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS user_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            type TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS saved_responses (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            context TEXT,
            app_context TEXT,
            tags TEXT,
            saved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS kb_documents (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            source TEXT,
            tags TEXT,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS analytics_events (
            id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            tool_id TEXT,
            payload TEXT,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            body TEXT,
            level TEXT,
            read INTEGER DEFAULT 0,
            dismissed INTEGER DEFAULT 0,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS plugins (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            version TEXT,
            enabled INTEGER DEFAULT 1,
            manifest_json TEXT,
            permissions TEXT,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS clipboard_history (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            source TEXT,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS saved_links (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            title TEXT,
            tags TEXT,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS focus_timers (
            id TEXT PRIMARY KEY,
            duration_minutes INTEGER NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT,
            ended_at TEXT
        );

        CREATE TABLE IF NOT EXISTS reminders (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            due_text TEXT,
            due_at INTEGER,
            done INTEGER DEFAULT 0,
            notified INTEGER DEFAULT 0,
            snooze_until INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS daily_list_items (
            id TEXT PRIMARY KEY,
            list_key TEXT NOT NULL,
            item_text TEXT NOT NULL,
            done INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS daily_notes (
            date_iso TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS habits (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            cadence TEXT NOT NULL, -- daily|weekly (daily only used in UI for now)
            created_at TEXT NOT NULL,
            archived INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS habit_logs (
            id TEXT PRIMARY KEY,
            habit_id TEXT NOT NULL,
            date_iso TEXT NOT NULL, -- YYYY-MM-DD
            done INTEGER DEFAULT 1,
            created_at TEXT NOT NULL,
            UNIQUE(habit_id, date_iso),
            FOREIGN KEY(habit_id) REFERENCES habits(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS expenses (
            id TEXT PRIMARY KEY,
            amount_cents INTEGER NOT NULL,
            currency TEXT NOT NULL,
            category TEXT,
            merchant TEXT,
            note TEXT,
            occurred_at TEXT NOT NULL, -- ISO timestamp
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS routine_items (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            archived INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS routine_logs (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            date_iso TEXT NOT NULL,
            done INTEGER DEFAULT 1,
            created_at TEXT NOT NULL,
            UNIQUE(item_id, date_iso),
            FOREIGN KEY(item_id) REFERENCES routine_items(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS important_dates (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            date_iso TEXT NOT NULL, -- YYYY-MM-DD (year optional in UI usage; we store full)
            kind TEXT NOT NULL, -- birthday|anniversary|other
            created_at TEXT NOT NULL,
            archived INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS medications (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            dosage TEXT,
            times_json TEXT NOT NULL, -- JSON array like ["08:00","20:00"]
            created_at TEXT NOT NULL,
            active INTEGER DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS medication_logs (
            id TEXT PRIMARY KEY,
            medication_id TEXT NOT NULL,
            taken_at TEXT NOT NULL, -- ISO timestamp
            created_at TEXT NOT NULL,
            FOREIGN KEY(medication_id) REFERENCES medications(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS water_logs (
            date_iso TEXT PRIMARY KEY,
            count INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS device_info (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS usage_logs (
            date_iso TEXT PRIMARY KEY,
            message_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );

        -- ── User Memory ───────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS user_memory (
            id TEXT PRIMARY KEY,
            category TEXT NOT NULL DEFAULT 'general',
            key TEXT NOT NULL UNIQUE,
            value TEXT NOT NULL,
            source TEXT DEFAULT 'manual',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- ── OAuth tokens (Calendar, etc.) ──────────────────────────────────────
        CREATE TABLE IF NOT EXISTS oauth_tokens (
            provider TEXT PRIMARY KEY,
            access_token TEXT,
            refresh_token TEXT,
            token_type TEXT DEFAULT 'Bearer',
            expires_at REAL,
            scope TEXT,
            updated_at TEXT NOT NULL
        );

        -- ── App config (Notion key, etc.) ──────────────────────────────────────
        CREATE TABLE IF NOT EXISTS app_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- ── Team / Workspace (Phase 3) ─────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            owner_clerk_id TEXT NOT NULL,
            plan TEXT NOT NULL DEFAULT 'team',   -- team | business | enterprise
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_members (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            clerk_user_id TEXT NOT NULL,
            email TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
            invited_at TEXT NOT NULL,
            joined_at TEXT,
            UNIQUE(workspace_id, clerk_user_id),
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS workspace_templates (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            description TEXT,
            tags TEXT,
            category TEXT,
            created_by_clerk_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS workspace_settings (
            workspace_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(workspace_id, key),
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS workspace_invites (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            email TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            token TEXT NOT NULL UNIQUE,
            invited_by_clerk_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            accepted INTEGER DEFAULT 0,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS pending_memories (
            id TEXT PRIMARY KEY,
            category TEXT NOT NULL DEFAULT 'general',
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(key)
        );
        """
    )
    conn.commit()

    # Lightweight migrations for existing DBs
    try:
        cur.execute("ALTER TABLE reminders ADD COLUMN notified INTEGER DEFAULT 0")
        conn.commit()
    except Exception:
        pass
    try:
        cur.execute("ALTER TABLE reminders ADD COLUMN snooze_until INTEGER DEFAULT 0")
        conn.commit()
    except Exception:
        pass
    try:
        cur.execute("ALTER TABLE conversations ADD COLUMN memory_mode TEXT DEFAULT 'this_chat_only'")
        conn.commit()
    except Exception:
        pass
    try:
        cur.execute("ALTER TABLE conversations ADD COLUMN expires_at TEXT")
        conn.commit()
    except Exception:
        pass
    try:
        cur.execute("ALTER TABLE templates ADD COLUMN input_schema_json TEXT")
        conn.commit()
    except Exception:
        pass
    try:
        cur.execute("ALTER TABLE templates ADD COLUMN source_message TEXT")
        conn.commit()
    except Exception:
        pass

    # Performance indices — idempotent, safe to run on existing DBs
    index_stmts = [
        "CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)",
        "CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)",
        "CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_conversations_expires_at ON conversations(expires_at)",
        "CREATE INDEX IF NOT EXISTS idx_clipboard_history_created_at ON clipboard_history(created_at)",
        "CREATE INDEX IF NOT EXISTS idx_user_memory_key ON user_memory(key)",
        "CREATE INDEX IF NOT EXISTS idx_user_memory_category ON user_memory(category)",
        "CREATE INDEX IF NOT EXISTS idx_usage_logs_date ON usage_logs(date_iso)",
        "CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at)",
    ]
    for stmt in index_stmts:
        try:
            cur.execute(stmt)
        except Exception:
            pass
    conn.commit()

    # Seed built-in templates
    now = datetime.utcnow().isoformat()
    for t in BUILTIN_TEMPLATES:
        cur.execute(
            """
            INSERT OR IGNORE INTO templates
            (id, name, prompt, description, tags, supported_apps, category, is_built_in, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                t["id"],
                t["name"],
                t["prompt"],
                t.get("description", ""),
                json.dumps(t.get("tags", [])),
                json.dumps(t.get("supported_apps", [])),
                t.get("category", "general"),
                1 if t.get("is_built_in") else 0,
                now,
                "system",
            ),
        )

    # Seed defaults for settings
    defaults = {
        "panel_width": ("340", "number"),
        "panel_opacity": ("0.95", "number"),
        "theme": ("dark", "string"),
        "sidebar_position": ("right", "string"),
        "default_memory_mode": ("this_chat_only", "string"),
    }
    for key, (value, vtype) in defaults.items():
        cur.execute(
            "INSERT OR IGNORE INTO user_settings (key, value, type, updated_at) VALUES (?, ?, ?, ?)",
            (key, value, vtype, now),
        )

    conn.commit()
    conn.close()


# ─── Device identity & usage tracking ────────────────────────────────────────

def get_device_id() -> str:
    """Return a stable device UUID, creating one on first call."""
    conn = _connect()
    cur = conn.cursor()
    row = cur.execute("SELECT value FROM device_info WHERE key = 'device_id'").fetchone()
    if row:
        conn.close()
        return row["value"]
    new_id = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO device_info (key, value) VALUES ('device_id', ?)", (new_id,)
    )
    conn.commit()
    conn.close()
    return new_id


def get_today_usage() -> int:
    """Return the number of managed-tier messages sent today."""
    date_iso = datetime.utcnow().date().isoformat()
    conn = _connect()
    cur = conn.cursor()
    row = cur.execute(
        "SELECT message_count FROM usage_logs WHERE date_iso = ?", (date_iso,)
    ).fetchone()
    conn.close()
    return row["message_count"] if row else 0


def increment_usage() -> int:
    """Increment today's managed-tier message count and return the new total."""
    date_iso = datetime.utcnow().date().isoformat()
    now = datetime.utcnow().isoformat()
    conn = _connect()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO usage_logs (date_iso, message_count, updated_at) VALUES (?, 1, ?)
        ON CONFLICT(date_iso) DO UPDATE SET message_count = message_count + 1, updated_at = excluded.updated_at
        """,
        (date_iso, now),
    )
    conn.commit()
    row = cur.execute(
        "SELECT message_count FROM usage_logs WHERE date_iso = ?", (date_iso,)
    ).fetchone()
    conn.close()
    return row["message_count"] if row else 1


def _row_to_conv(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "tags": json.loads(row["tags"] or "[]"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "summary": row["summary"] or "",
        "app_context": row["app_context"] or "",
        "starred": bool(row["starred"] or 0),
        "memory_mode": row["memory_mode"] or "this_chat_only",
        "expires_at": row["expires_at"],
    }


def _iso_now() -> str:
    return datetime.utcnow().isoformat()


def _purge_expired_conversations(conn: sqlite3.Connection) -> None:
    now_iso = _iso_now()
    conn.execute("DELETE FROM conversations WHERE expires_at IS NOT NULL AND expires_at != '' AND expires_at <= ?", (now_iso,))
    conn.commit()


def create_conversation(
    title: str,
    tags: list[str] | None = None,
    app_context: str = "",
    memory_mode: str = "this_chat_only",
    expires_at: str | None = None,
) -> dict[str, Any]:
    conn = _connect()
    _purge_expired_conversations(conn)
    now = _iso_now()
    cid = str(uuid.uuid4())
    mode = (memory_mode or "this_chat_only").strip().lower()
    if mode not in ("this_chat_only", "remember_24h", "never_remember"):
        mode = "this_chat_only"
    exp = expires_at
    if mode == "remember_24h" and not exp:
        exp = (datetime.utcnow() + timedelta(hours=24)).isoformat()
    conn.execute(
        """
        INSERT INTO conversations (id, title, tags, created_at, updated_at, summary, app_context, starred, memory_mode, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        """,
        (cid, title.strip() or "New conversation", json.dumps(tags or []), now, now, "", app_context, mode, exp),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM conversations WHERE id = ?", (cid,)).fetchone()
    conn.close()
    return _row_to_conv(row)


def list_conversations(query: str = "", tag: str = "", starred: bool | None = None) -> list[dict[str, Any]]:
    conn = _connect()
    _purge_expired_conversations(conn)
    sql = "SELECT * FROM conversations WHERE 1=1"
    params: list[Any] = []
    if query.strip():
        sql += " AND (title LIKE ? OR summary LIKE ?)"
        like = f"%{query.strip()}%"
        params.extend([like, like])
    if tag.strip():
        sql += " AND tags LIKE ?"
        params.append(f'%"{tag.strip()}"%')
    if starred is not None:
        sql += " AND starred = ?"
        params.append(1 if starred else 0)
    sql += " ORDER BY updated_at DESC LIMIT 200"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [_row_to_conv(r) for r in rows]


def get_conversation(conversation_id: str) -> dict[str, Any] | None:
    conn = _connect()
    _purge_expired_conversations(conn)
    conv_row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
    if not conv_row:
        conn.close()
        return None
    message_rows = conn.execute(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
        (conversation_id,),
    ).fetchall()
    conn.close()
    return {
        **_row_to_conv(conv_row),
        "messages": [
            {
                "id": r["id"],
                "role": r["role"],
                "content": r["content"],
                "timestamp": r["timestamp"],
                "screenshot_path": r["screenshot_path"],
                "annotations": json.loads(r["annotations"] or "{}"),
            }
            for r in message_rows
        ],
    }


def add_message(
    conversation_id: str,
    role: str,
    content: str,
    screenshot_path: str | None = None,
    annotations: dict[str, Any] | None = None,
    model_used: str | None = None,
    tokens_used: int | None = None,
) -> dict[str, Any]:
    conn = _connect()
    _purge_expired_conversations(conn)
    conv = conn.execute("SELECT id FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
    if not conv:
        conn.close()
        raise ValueError("Conversation not found")
    mid = str(uuid.uuid4())
    now = _iso_now()
    conn.execute(
        """
        INSERT INTO messages
        (id, conversation_id, role, content, screenshot_path, annotations, model_used, tokens_used, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            mid,
            conversation_id,
            role,
            content,
            screenshot_path,
            json.dumps(annotations or {}),
            model_used,
            tokens_used,
            now,
        ),
    )
    conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
    conn.commit()
    conn.close()
    return {"id": mid, "conversation_id": conversation_id, "role": role, "content": content, "timestamp": now}


def set_conversation_starred(conversation_id: str, starred: bool) -> bool:
    conn = _connect()
    _purge_expired_conversations(conn)
    cur = conn.execute("UPDATE conversations SET starred = ? WHERE id = ?", (1 if starred else 0, conversation_id))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


def delete_conversation(conversation_id: str) -> bool:
    conn = _connect()
    cur = conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


def set_conversation_memory_mode(conversation_id: str, memory_mode: str) -> dict[str, Any] | None:
    conn = _connect()
    mode = (memory_mode or "this_chat_only").strip().lower()
    if mode not in ("this_chat_only", "remember_24h", "never_remember"):
        conn.close()
        return None
    expires_at: str | None = None
    if mode == "remember_24h":
        expires_at = (datetime.utcnow() + timedelta(hours=24)).isoformat()
    now = _iso_now()
    conn.execute(
        "UPDATE conversations SET memory_mode = ?, expires_at = ?, updated_at = ? WHERE id = ?",
        (mode, expires_at, now, conversation_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return _row_to_conv(row)


def semantic_search_history(query: str, limit: int = 12) -> list[dict[str, Any]]:
    conn = _connect()
    _purge_expired_conversations(conn)
    rows = conn.execute(
        """
        SELECT m.id AS message_id, m.conversation_id, m.content, m.timestamp, c.title
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        ORDER BY m.timestamp DESC
        LIMIT 2000
        """
    ).fetchall()
    conn.close()
    q = query.strip().lower()
    if not q:
        return []
    scored: list[tuple[float, dict[str, Any]]] = []
    for r in rows:
        content = (r["content"] or "").strip()
        text = content.lower()
        overlap = sum(1 for token in set(q.split()) if token and token in text)
        fuzzy = SequenceMatcher(None, q, text[: max(len(q) * 3, 120)]).ratio()
        score = overlap * 0.7 + fuzzy * 0.3
        if score <= 0:
            continue
        scored.append(
            (
                score,
                {
                    "message_id": r["message_id"],
                    "conversation_id": r["conversation_id"],
                    "conversation_title": r["title"],
                    "content": content,
                    "timestamp": r["timestamp"],
                    "score": round(score, 4),
                },
            )
        )
    scored.sort(key=lambda x: x[0], reverse=True)
    return [entry for _, entry in scored[: max(1, min(limit, 50))]]


def list_templates(query: str = "", tag: str = "") -> list[dict[str, Any]]:
    conn = _connect()
    sql = "SELECT * FROM templates WHERE 1=1"
    params: list[Any] = []
    if query.strip():
        sql += " AND (name LIKE ? OR prompt LIKE ? OR description LIKE ?)"
        like = f"%{query.strip()}%"
        params.extend([like, like, like])
    if tag.strip():
        sql += " AND tags LIKE ?"
        params.append(f'%"{tag.strip()}"%')
    sql += " ORDER BY is_built_in DESC, created_at DESC LIMIT 500"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "prompt": r["prompt"],
            "description": r["description"] or "",
            "tags": json.loads(r["tags"] or "[]"),
            "supported_apps": json.loads(r["supported_apps"] or "[]"),
            "category": r["category"] or "general",
            "is_built_in": bool(r["is_built_in"] or 0),
            "created_at": r["created_at"],
            "input_schema": json.loads(r["input_schema_json"] or "[]"),
            "source_message": r["source_message"] or "",
        }
        for r in rows
    ]


def create_template(
    name: str,
    prompt: str,
    description: str = "",
    tags: list[str] | None = None,
    supported_apps: list[str] | None = None,
    category: str = "general",
    input_schema: list[dict[str, Any]] | None = None,
    source_message: str = "",
) -> dict[str, Any]:
    conn = _connect()
    tid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    conn.execute(
        """
        INSERT INTO templates
        (id, name, prompt, description, tags, supported_apps, category, is_built_in, created_at, created_by, input_schema_json, source_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        """,
        (
            tid,
            name.strip(),
            prompt.strip(),
            description.strip(),
            json.dumps(tags or []),
            json.dumps(supported_apps or []),
            category.strip() or "general",
            now,
            "local-user",
            json.dumps(input_schema or []),
            source_message.strip()[:3000],
        ),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM templates WHERE id = ?", (tid,)).fetchone()
    conn.close()
    return {
        "id": row["id"],
        "name": row["name"],
        "prompt": row["prompt"],
        "description": row["description"] or "",
        "tags": json.loads(row["tags"] or "[]"),
        "supported_apps": json.loads(row["supported_apps"] or "[]"),
        "category": row["category"] or "general",
        "is_built_in": bool(row["is_built_in"] or 0),
        "created_at": row["created_at"],
        "input_schema": json.loads(row["input_schema_json"] or "[]"),
        "source_message": row["source_message"] or "",
    }


def delete_template(template_id: str) -> bool:
    conn = _connect()
    # built-ins are protected
    row = conn.execute("SELECT is_built_in FROM templates WHERE id = ?", (template_id,)).fetchone()
    if not row:
        conn.close()
        return False
    if bool(row["is_built_in"]):
        conn.close()
        return False
    cur = conn.execute("DELETE FROM templates WHERE id = ?", (template_id,))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


def import_templates(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    created: list[dict[str, Any]] = []
    for item in items:
        name = str(item.get("name") or "").strip()
        prompt = str(item.get("prompt") or "").strip()
        if not name or not prompt:
            continue
        created.append(
            create_template(
                name=name,
                prompt=prompt,
                description=str(item.get("description") or "").strip(),
                tags=[str(t) for t in (item.get("tags") or [])],
                supported_apps=[str(a) for a in (item.get("supported_apps") or [])],
                category=str(item.get("category") or "general"),
                input_schema=item.get("input_schema") if isinstance(item.get("input_schema"), list) else [],
                source_message=str(item.get("source_message") or ""),
            )
        )
    return created


def list_hotkeys() -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute(
        """
        SELECT h.*, t.name AS template_name
        FROM hotkeys h
        LEFT JOIN templates t ON t.id = h.template_id
        ORDER BY h.created_at DESC
        """
    ).fetchall()
    conn.close()
    return [
        {
            "id": r["id"],
            "key_combo": r["key_combo"],
            "template_id": r["template_id"],
            "template_name": r["template_name"] or "",
            "enabled": bool(r["enabled"] or 0),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def create_hotkey(key_combo: str, template_id: str, enabled: bool = True) -> dict[str, Any]:
    conn = _connect()
    hid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    conn.execute(
        "INSERT INTO hotkeys (id, key_combo, template_id, enabled, created_at) VALUES (?, ?, ?, ?, ?)",
        (hid, key_combo.strip().lower(), template_id, 1 if enabled else 0, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM hotkeys WHERE id = ?", (hid,)).fetchone()
    conn.close()
    return {
        "id": row["id"],
        "key_combo": row["key_combo"],
        "template_id": row["template_id"],
        "enabled": bool(row["enabled"] or 0),
        "created_at": row["created_at"],
    }


def delete_hotkey(hotkey_id: str) -> bool:
    conn = _connect()
    cur = conn.execute("DELETE FROM hotkeys WHERE id = ?", (hotkey_id,))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


def get_setting(key: str, default: str | None = None) -> str | None:
    """Return a single setting value by key, or default if not set."""
    conn = _connect()
    row = conn.execute("SELECT value FROM user_settings WHERE key = ?", (key.strip(),)).fetchone()
    conn.close()
    return row["value"] if row else default


def get_settings() -> dict[str, dict[str, str]]:
    conn = _connect()
    rows = conn.execute("SELECT key, value, type, updated_at FROM user_settings").fetchall()
    conn.close()
    return {
        r["key"]: {"value": r["value"], "type": r["type"] or "string", "updated_at": r["updated_at"]}
        for r in rows
    }


def set_setting(key: str, value: str, value_type: str = "string") -> dict[str, str]:
    conn = _connect()
    now = datetime.utcnow().isoformat()
    conn.execute(
        """
        INSERT INTO user_settings (key, value, type, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, type=excluded.type, updated_at=excluded.updated_at
        """,
        (key.strip(), value, value_type, now),
    )
    conn.commit()
    row = conn.execute("SELECT key, value, type, updated_at FROM user_settings WHERE key = ?", (key.strip(),)).fetchone()
    conn.close()
    return {"key": row["key"], "value": row["value"], "type": row["type"], "updated_at": row["updated_at"]}


def build_markdown_export(conversation_id: str) -> tuple[str, str]:
    conv = get_conversation(conversation_id)
    if not conv:
        raise ValueError("Conversation not found")
    title = conv["title"] or "Conversation"
    lines: list[str] = [f"# Conversation: {title}"]
    lines.append(f"**Created:** {conv['created_at']} | **Tags:** {', '.join(conv['tags']) or 'none'}")
    lines.append("")
    for idx, msg in enumerate(conv["messages"], start=1):
        role = "User" if msg["role"] == "user" else "Assistant"
        lines.append(f"## Message {idx}")
        lines.append(f"**{role} ({msg['timestamp']}):**")
        lines.append(msg["content"])
        lines.append("")
    filename = f"{title.strip().replace(' ', '_')[:40] or 'conversation'}.md"
    return ("\n".join(lines), filename)


def build_pdf_export(conversation_id: str) -> tuple[bytes, str]:
    conv = get_conversation(conversation_id)
    if not conv:
        raise ValueError("Conversation not found")
    try:
        from io import BytesIO
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas
    except Exception as e:
        raise ValueError(f"PDF export dependency missing: {e}")

    title = conv["title"] or "Conversation"
    filename = f"{title.strip().replace(' ', '_')[:40] or 'conversation'}.pdf"
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=letter)
    y = 760
    pdf.setFont("Helvetica-Bold", 14)
    pdf.drawString(50, y, f"Conversation: {title}")
    y -= 24
    pdf.setFont("Helvetica", 10)
    pdf.drawString(50, y, f"Created: {conv['created_at']}")
    y -= 16
    pdf.drawString(50, y, f"Tags: {', '.join(conv['tags']) or 'none'}")
    y -= 22
    for idx, msg in enumerate(conv["messages"], start=1):
        role = "User" if msg["role"] == "user" else "Assistant"
        pdf.setFont("Helvetica-Bold", 10)
        pdf.drawString(50, y, f"{idx}. {role} ({msg['timestamp']})")
        y -= 14
        pdf.setFont("Helvetica", 10)
        content = (msg["content"] or "").replace("\n", " ")
        for start in range(0, len(content), 110):
            if y < 50:
                pdf.showPage()
                y = 760
                pdf.setFont("Helvetica", 10)
            pdf.drawString(60, y, content[start : start + 110])
            y -= 13
        y -= 6
    pdf.save()
    data = buffer.getvalue()
    buffer.close()
    return (data, filename)


def save_response(content: str, app_context: str = "", tags: list[str] | None = None, context: str = "") -> dict[str, Any]:
    conn = _connect()
    sid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    conn.execute(
        """
        INSERT INTO saved_responses (id, content, context, app_context, tags, saved_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (sid, content, context, app_context, json.dumps(tags or []), now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM saved_responses WHERE id = ?", (sid,)).fetchone()
    conn.close()
    return {
        "id": row["id"],
        "content": row["content"],
        "context": row["context"] or "",
        "app_context": row["app_context"] or "",
        "tags": json.loads(row["tags"] or "[]"),
        "saved_at": row["saved_at"],
    }


def list_saved_responses() -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute("SELECT * FROM saved_responses ORDER BY saved_at DESC LIMIT 500").fetchall()
    conn.close()
    return [
        {
            "id": r["id"],
            "content": r["content"],
            "context": r["context"] or "",
            "app_context": r["app_context"] or "",
            "tags": json.loads(r["tags"] or "[]"),
            "saved_at": r["saved_at"],
        }
        for r in rows
    ]


def kb_add_document(title: str, content: str, source: str = "", tags: list[str] | None = None) -> dict[str, Any]:
    conn = _connect()
    did = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    conn.execute(
        """
        INSERT INTO kb_documents (id, title, content, source, tags, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (did, title.strip(), content, source.strip(), json.dumps(tags or []), now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM kb_documents WHERE id = ?", (did,)).fetchone()
    conn.close()
    return {
        "id": row["id"],
        "title": row["title"],
        "content": row["content"],
        "source": row["source"] or "",
        "tags": json.loads(row["tags"] or "[]"),
        "created_at": row["created_at"],
    }


def kb_list_documents() -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute("SELECT * FROM kb_documents ORDER BY created_at DESC").fetchall()
    conn.close()
    return [
        {
            "id": r["id"],
            "title": r["title"],
            "content": r["content"],
            "source": r["source"] or "",
            "tags": json.loads(r["tags"] or "[]"),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def kb_get_document(document_id: str) -> dict[str, Any] | None:
    conn = _connect()
    row = conn.execute("SELECT * FROM kb_documents WHERE id = ?", (document_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row["id"],
        "title": row["title"],
        "content": row["content"],
        "source": row["source"] or "",
        "tags": json.loads(row["tags"] or "[]"),
        "created_at": row["created_at"],
    }


def analytics_log_event(event_type: str, tool_id: str = "", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    conn = _connect()
    eid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    conn.execute(
        """
        INSERT INTO analytics_events (id, event_type, tool_id, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (eid, event_type.strip()[:80], tool_id.strip()[:120], json.dumps(payload or {}), now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM analytics_events WHERE id = ?", (eid,)).fetchone()
    conn.close()
    return {
        "id": row["id"],
        "event_type": row["event_type"],
        "tool_id": row["tool_id"] or "",
        "payload": json.loads(row["payload"] or "{}"),
        "created_at": row["created_at"],
    }


def analytics_summary(limit: int = 20) -> dict[str, Any]:
    conn = _connect()
    total = conn.execute("SELECT COUNT(*) as c FROM analytics_events").fetchone()["c"]
    by_tool_rows = conn.execute(
        """
        SELECT COALESCE(tool_id, '') as tool_id, COUNT(*) as c
        FROM analytics_events
        GROUP BY tool_id
        ORDER BY c DESC
        LIMIT ?
        """,
        (max(1, limit),),
    ).fetchall()
    by_event_rows = conn.execute(
        """
        SELECT event_type, COUNT(*) as c
        FROM analytics_events
        GROUP BY event_type
        ORDER BY c DESC
        LIMIT ?
        """,
        (max(1, limit),),
    ).fetchall()
    conn.close()
    return {
        "total_events": int(total or 0),
        "top_tools": [{"tool_id": r["tool_id"] or "n/a", "count": int(r["c"] or 0)} for r in by_tool_rows],
        "top_event_types": [{"event_type": r["event_type"], "count": int(r["c"] or 0)} for r in by_event_rows],
    }


def create_notification(title: str, body: str = "", level: str = "info") -> dict[str, Any]:
    conn = _connect()
    nid = str(uuid.uuid4())
    # Local wall time so Electron's Date.parse (no timezone suffix) matches the user's machine.
    now = datetime.now().isoformat()
    conn.execute(
        """
        INSERT INTO notifications (id, title, body, level, read, dismissed, created_at)
        VALUES (?, ?, ?, ?, 0, 0, ?)
        """,
        (nid, title.strip(), body, level.strip() or "info", now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM notifications WHERE id = ?", (nid,)).fetchone()
    conn.close()
    return {
        "id": row["id"],
        "title": row["title"],
        "body": row["body"] or "",
        "level": row["level"] or "info",
        "read": bool(row["read"] or 0),
        "dismissed": bool(row["dismissed"] or 0),
        "created_at": row["created_at"],
    }


def list_notifications(include_dismissed: bool = False) -> list[dict[str, Any]]:
    conn = _connect()
    if include_dismissed:
        rows = conn.execute("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 500").fetchall()
    else:
        rows = conn.execute("SELECT * FROM notifications WHERE dismissed = 0 ORDER BY created_at DESC LIMIT 500").fetchall()
    conn.close()
    return [
        {
            "id": r["id"],
            "title": r["title"],
            "body": r["body"] or "",
            "level": r["level"] or "info",
            "read": bool(r["read"] or 0),
            "dismissed": bool(r["dismissed"] or 0),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def update_notification(notification_id: str, read: bool | None = None, dismissed: bool | None = None) -> dict[str, Any] | None:
    conn = _connect()
    row = conn.execute("SELECT * FROM notifications WHERE id = ?", (notification_id,)).fetchone()
    if not row:
        conn.close()
        return None
    next_read = int(read if read is not None else bool(row["read"] or 0))
    next_dismissed = int(dismissed if dismissed is not None else bool(row["dismissed"] or 0))
    conn.execute(
        "UPDATE notifications SET read = ?, dismissed = ? WHERE id = ?",
        (next_read, next_dismissed, notification_id),
    )
    conn.commit()
    updated = conn.execute("SELECT * FROM notifications WHERE id = ?", (notification_id,)).fetchone()
    conn.close()
    return {
        "id": updated["id"],
        "title": updated["title"],
        "body": updated["body"] or "",
        "level": updated["level"] or "info",
        "read": bool(updated["read"] or 0),
        "dismissed": bool(updated["dismissed"] or 0),
        "created_at": updated["created_at"],
    }


def create_plugin(name: str, version: str = "0.1.0", manifest: dict[str, Any] | None = None, permissions: list[str] | None = None) -> dict[str, Any]:
    conn = _connect()
    pid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    conn.execute(
        """
        INSERT INTO plugins (id, name, version, enabled, manifest_json, permissions, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?)
        """,
        (pid, name.strip(), version.strip(), json.dumps(manifest or {}), json.dumps(permissions or []), now, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM plugins WHERE id = ?", (pid,)).fetchone()
    conn.close()
    return {
        "id": row["id"],
        "name": row["name"],
        "version": row["version"] or "0.1.0",
        "enabled": bool(row["enabled"] or 0),
        "manifest": json.loads(row["manifest_json"] or "{}"),
        "permissions": json.loads(row["permissions"] or "[]"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_plugins() -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute("SELECT * FROM plugins ORDER BY updated_at DESC").fetchall()
    conn.close()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "version": r["version"] or "0.1.0",
            "enabled": bool(r["enabled"] or 0),
            "manifest": json.loads(r["manifest_json"] or "{}"),
            "permissions": json.loads(r["permissions"] or "[]"),
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        }
        for r in rows
    ]


def set_plugin_enabled(plugin_id: str, enabled: bool) -> dict[str, Any] | None:
    conn = _connect()
    now = datetime.utcnow().isoformat()
    conn.execute("UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?", (1 if enabled else 0, now, plugin_id))
    conn.commit()
    row = conn.execute("SELECT * FROM plugins WHERE id = ?", (plugin_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "version": row["version"] or "0.1.0",
        "enabled": bool(row["enabled"] or 0),
        "manifest": json.loads(row["manifest_json"] or "{}"),
        "permissions": json.loads(row["permissions"] or "[]"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


_CLIPBOARD_MAX_ENTRIES = 100
_CLIPBOARD_MAX_AGE_HOURS = 24


def _purge_clipboard() -> None:
    """Delete clipboard entries older than 24 h and cap at 100 total."""
    conn = _connect()
    cutoff = (datetime.utcnow() - timedelta(hours=_CLIPBOARD_MAX_AGE_HOURS)).isoformat()
    with _DB_WRITE_LOCK:
        conn.execute("DELETE FROM clipboard_history WHERE created_at < ?", (cutoff,))
        # Keep only the 100 most recent entries
        conn.execute(
            """DELETE FROM clipboard_history WHERE id NOT IN (
                SELECT id FROM clipboard_history ORDER BY created_at DESC LIMIT ?
            )""",
            (_CLIPBOARD_MAX_ENTRIES,),
        )
        conn.commit()
    conn.close()


def add_clipboard_entry(content: str, source: str = "unknown") -> dict[str, Any]:
    from screen_capture import redact_sensitive_text
    safe_content = redact_sensitive_text(content)
    _purge_clipboard()
    conn = _connect()
    cid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with _DB_WRITE_LOCK:
        conn.execute(
            "INSERT INTO clipboard_history (id, content, source, created_at) VALUES (?, ?, ?, ?)",
            (cid, safe_content, source, now),
        )
        conn.commit()
    row = conn.execute("SELECT * FROM clipboard_history WHERE id = ?", (cid,)).fetchone()
    conn.close()
    return {"id": row["id"], "content": row["content"], "source": row["source"] or "unknown", "created_at": row["created_at"]}


def list_clipboard_history(limit: int = 50) -> list[dict[str, Any]]:
    _purge_clipboard()
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM clipboard_history ORDER BY created_at DESC LIMIT ?",
        (max(1, min(limit, _CLIPBOARD_MAX_ENTRIES)),),
    ).fetchall()
    conn.close()
    return [{"id": r["id"], "content": r["content"], "source": r["source"] or "unknown", "created_at": r["created_at"]} for r in rows]


def save_link(url: str, title: str = "", tags: list[str] | None = None) -> dict[str, Any]:
    conn = _connect()
    sid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    conn.execute(
        "INSERT INTO saved_links (id, url, title, tags, created_at) VALUES (?, ?, ?, ?, ?)",
        (sid, url.strip(), title.strip(), json.dumps(tags or []), now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM saved_links WHERE id = ?", (sid,)).fetchone()
    conn.close()
    return {"id": row["id"], "url": row["url"], "title": row["title"] or "", "tags": json.loads(row["tags"] or "[]"), "created_at": row["created_at"]}


def list_saved_links(limit: int = 200) -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute("SELECT * FROM saved_links ORDER BY created_at DESC LIMIT ?", (max(1, limit),)).fetchall()
    conn.close()
    return [{"id": r["id"], "url": r["url"], "title": r["title"] or "", "tags": json.loads(r["tags"] or "[]"), "created_at": r["created_at"]} for r in rows]


def create_focus_timer(duration_minutes: int) -> dict[str, Any]:
    conn = _connect()
    tid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    conn.execute(
        "INSERT INTO focus_timers (id, duration_minutes, status, started_at, ended_at) VALUES (?, ?, 'running', ?, NULL)",
        (tid, max(1, duration_minutes), now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM focus_timers WHERE id = ?", (tid,)).fetchone()
    conn.close()
    return {
        "id": row["id"],
        "duration_minutes": int(row["duration_minutes"]),
        "status": row["status"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
    }


def finish_focus_timer(timer_id: str) -> dict[str, Any] | None:
    conn = _connect()
    now = datetime.utcnow().isoformat()
    conn.execute("UPDATE focus_timers SET status = 'completed', ended_at = ? WHERE id = ?", (now, timer_id))
    conn.commit()
    row = conn.execute("SELECT * FROM focus_timers WHERE id = ?", (timer_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row["id"],
        "duration_minutes": int(row["duration_minutes"]),
        "status": row["status"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
    }


def latest_focus_timer() -> dict[str, Any] | None:
    conn = _connect()
    row = conn.execute("SELECT * FROM focus_timers ORDER BY started_at DESC LIMIT 1").fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row["id"],
        "duration_minutes": int(row["duration_minutes"]),
        "status": row["status"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
    }


# ---- Daily-life: reminders (persistent) ----
def _reminder_row_dict(row: sqlite3.Row) -> dict[str, Any]:
    try:
        sz = int(row["snooze_until"] or 0)
    except (KeyError, IndexError, TypeError, ValueError):
        sz = 0
    return {
        "id": row["id"],
        "title": row["title"],
        "due": row["due_text"] or None,
        "due_at": row["due_at"],
        "done": bool(row["done"]),
        "notified": bool(row["notified"] or 0),
        "snooze_until": sz,
        "created_at": row["created_at"],
    }


def reminder_create(title: str, due_text: str | None = None, due_at: int | None = None) -> dict[str, Any]:
    conn = _connect()
    rid = f"rem_{uuid.uuid4().hex[:12]}"
    now = int(datetime.utcnow().timestamp())
    conn.execute(
        "INSERT INTO reminders (id, title, due_text, due_at, done, notified, snooze_until, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?)",
        (rid, title.strip()[:200], due_text or "", due_at or 0, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM reminders WHERE id = ?", (rid,)).fetchone()
    conn.close()
    return _reminder_row_dict(row)


def reminder_list(include_done: bool = True) -> list[dict[str, Any]]:
    conn = _connect()
    sql = "SELECT * FROM reminders ORDER BY due_at ASC, created_at DESC"
    if not include_done:
        sql = "SELECT * FROM reminders WHERE done = 0 ORDER BY due_at ASC, created_at DESC"
    rows = conn.execute(sql).fetchall()
    conn.close()
    return [_reminder_row_dict(r) for r in rows]


def reminder_set_done(reminder_id: str, done: bool) -> dict[str, Any] | None:
    conn = _connect()
    conn.execute("UPDATE reminders SET done = ? WHERE id = ?", (1 if done else 0, reminder_id))
    conn.commit()
    row = conn.execute("SELECT * FROM reminders WHERE id = ?", (reminder_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return _reminder_row_dict(row)


def reminder_snooze(reminder_id: str, minutes: int) -> dict[str, Any] | None:
    """Push next notification to now + minutes; clears notified so tick can fire again."""
    conn = _connect()
    row = conn.execute("SELECT * FROM reminders WHERE id = ?", (reminder_id,)).fetchone()
    if not row:
        conn.close()
        return None
    add_sec = max(1, min(int(minutes), 10080)) * 60  # cap at 7 days
    until = int(datetime.utcnow().timestamp()) + add_sec
    conn.execute(
        "UPDATE reminders SET snooze_until = ?, notified = 0 WHERE id = ?",
        (until, reminder_id),
    )
    conn.commit()
    row2 = conn.execute("SELECT * FROM reminders WHERE id = ?", (reminder_id,)).fetchone()
    conn.close()
    return _reminder_row_dict(row2) if row2 else None


def reminder_due_soon(now_ts: int, within_sec: int = 300, limit: int = 20) -> list[dict[str, Any]]:
    """Reminders whose due time has passed (due_at <= now), not done, not yet notified.

    Poll runs every few seconds in Electron; users should see a banner shortly after the due instant.
    ``within_sec`` is kept for API compatibility with /api/daily-life/tick and is ignored.
    """
    _ = within_sec
    conn = _connect()
    rows = conn.execute(
        """
        SELECT * FROM reminders
        WHERE done = 0 AND notified = 0 AND due_at > 0 AND due_at <= ?
          AND (COALESCE(snooze_until, 0) = 0 OR snooze_until <= ?)
        ORDER BY due_at ASC LIMIT ?
        """,
        (now_ts, now_ts, max(1, min(limit, 100))),
    ).fetchall()
    conn.close()
    return [_reminder_row_dict(r) for r in rows]


def reminder_mark_notified(reminder_id: str) -> None:
    conn = _connect()
    conn.execute("UPDATE reminders SET notified = 1 WHERE id = ?", (reminder_id,))
    conn.commit()
    conn.close()


# ---- Daily-life: lists (shopping, grocery, etc.) ----
def daily_list_add(list_key: str, item_text: str) -> dict[str, Any]:
    conn = _connect()
    lid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    key = (list_key or "default").strip().lower()[:64]
    conn.execute(
        "INSERT INTO daily_list_items (id, list_key, item_text, done, created_at) VALUES (?, ?, ?, 0, ?)",
        (lid, key, item_text.strip()[:500], now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM daily_list_items WHERE id = ?", (lid,)).fetchone()
    conn.close()
    return {"id": row["id"], "list_key": row["list_key"], "item_text": row["item_text"], "done": False, "created_at": row["created_at"]}


def daily_list_items(list_key: str) -> list[dict[str, Any]]:
    conn = _connect()
    key = (list_key or "default").strip().lower()[:64]
    rows = conn.execute("SELECT * FROM daily_list_items WHERE list_key = ? ORDER BY created_at ASC", (key,)).fetchall()
    conn.close()
    return [{"id": r["id"], "list_key": r["list_key"], "item_text": r["item_text"], "done": bool(r["done"]), "created_at": r["created_at"]} for r in rows]


def daily_list_toggle(list_key: str, item_id: str) -> dict[str, Any] | None:
    conn = _connect()
    row = conn.execute("SELECT * FROM daily_list_items WHERE id = ? AND list_key = ?", (item_id, (list_key or "default").strip().lower()[:64])).fetchone()
    if not row:
        conn.close()
        return None
    new_done = 0 if row["done"] else 1
    conn.execute("UPDATE daily_list_items SET done = ? WHERE id = ?", (new_done, item_id))
    conn.commit()
    row = conn.execute("SELECT * FROM daily_list_items WHERE id = ?", (item_id,)).fetchone()
    conn.close()
    return {"id": row["id"], "list_key": row["list_key"], "item_text": row["item_text"], "done": bool(row["done"]), "created_at": row["created_at"]}


def daily_list_remove(list_key: str, item_id: str) -> bool:
    conn = _connect()
    key = (list_key or "default").strip().lower()[:64]
    cur = conn.execute("DELETE FROM daily_list_items WHERE id = ? AND list_key = ?", (item_id, key))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


# ---- Daily-life: daily note (one per day) ----
def daily_note_get(date_iso: str) -> dict[str, Any] | None:
    conn = _connect()
    row = conn.execute("SELECT * FROM daily_notes WHERE date_iso = ?", (date_iso.strip()[:10],)).fetchone()
    conn.close()
    if not row:
        return None
    return {"date_iso": row["date_iso"], "content": row["content"] or "", "updated_at": row["updated_at"]}


def daily_note_upsert(date_iso: str, content: str) -> dict[str, Any]:
    conn = _connect()
    now = datetime.utcnow().isoformat()
    d = date_iso.strip()[:10]
    conn.execute(
        "INSERT INTO daily_notes (date_iso, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(date_iso) DO UPDATE SET content = ?, updated_at = ?",
        (d, content, now, content, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM daily_notes WHERE date_iso = ?", (d,)).fetchone()
    conn.close()
    return {"date_iso": row["date_iso"], "content": row["content"] or "", "updated_at": row["updated_at"]}


# ---- Daily-life: habits ----
def habit_create(name: str, cadence: str = "daily") -> dict[str, Any]:
    conn = _connect()
    hid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    cad = (cadence or "daily").strip().lower()
    if cad not in ("daily", "weekly"):
        cad = "daily"
    conn.execute(
        "INSERT INTO habits (id, name, cadence, created_at, archived) VALUES (?, ?, ?, ?, 0)",
        (hid, name.strip()[:80], cad, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM habits WHERE id = ?", (hid,)).fetchone()
    conn.close()
    return {"id": row["id"], "name": row["name"], "cadence": row["cadence"], "archived": bool(row["archived"]), "created_at": row["created_at"]}


def habit_list(include_archived: bool = False) -> list[dict[str, Any]]:
    conn = _connect()
    if include_archived:
        rows = conn.execute("SELECT * FROM habits ORDER BY created_at DESC").fetchall()
    else:
        rows = conn.execute("SELECT * FROM habits WHERE archived = 0 ORDER BY created_at DESC").fetchall()
    conn.close()
    return [{"id": r["id"], "name": r["name"], "cadence": r["cadence"], "archived": bool(r["archived"]), "created_at": r["created_at"]} for r in rows]


def habit_archive(habit_id: str, archived: bool) -> dict[str, Any] | None:
    conn = _connect()
    conn.execute("UPDATE habits SET archived = ? WHERE id = ?", (1 if archived else 0, habit_id))
    conn.commit()
    row = conn.execute("SELECT * FROM habits WHERE id = ?", (habit_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return {"id": row["id"], "name": row["name"], "cadence": row["cadence"], "archived": bool(row["archived"]), "created_at": row["created_at"]}


def habit_checkin(habit_id: str, date_iso: str, done: bool = True) -> dict[str, Any]:
    """Upsert a check-in for a given date (YYYY-MM-DD)."""
    conn = _connect()
    cid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    d = (date_iso or "").strip()[:10]
    if not d:
        d = datetime.utcnow().strftime("%Y-%m-%d")
    conn.execute(
        "INSERT INTO habit_logs (id, habit_id, date_iso, done, created_at) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(habit_id, date_iso) DO UPDATE SET done = ?",
        (cid, habit_id, d, 1 if done else 0, now, 1 if done else 0),
    )
    conn.commit()
    row = conn.execute("SELECT habit_id, date_iso, done FROM habit_logs WHERE habit_id = ? AND date_iso = ?", (habit_id, d)).fetchone()
    conn.close()
    return {"habit_id": row["habit_id"], "date_iso": row["date_iso"], "done": bool(row["done"])}


def habit_status_for_date(date_iso: str) -> dict[str, bool]:
    """Return mapping habit_id -> done for the given date."""
    conn = _connect()
    d = (date_iso or "").strip()[:10]
    if not d:
        d = datetime.utcnow().strftime("%Y-%m-%d")
    rows = conn.execute("SELECT habit_id, done FROM habit_logs WHERE date_iso = ?", (d,)).fetchall()
    conn.close()
    return {r["habit_id"]: bool(r["done"]) for r in rows}


# ---- Daily-life: expenses ----
def expense_add(
    amount_cents: int,
    currency: str = "USD",
    category: str = "",
    merchant: str = "",
    note: str = "",
    occurred_at: str | None = None,
) -> dict[str, Any]:
    conn = _connect()
    eid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    occ = (occurred_at or now).strip()
    cur = (currency or "USD").strip().upper()[:8] or "USD"
    conn.execute(
        "INSERT INTO expenses (id, amount_cents, currency, category, merchant, note, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (eid, int(amount_cents), cur, (category or "").strip()[:40], (merchant or "").strip()[:80], (note or "").strip()[:200], occ, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM expenses WHERE id = ?", (eid,)).fetchone()
    conn.close()
    return {
        "id": row["id"],
        "amount_cents": int(row["amount_cents"]),
        "currency": row["currency"],
        "category": row["category"] or "",
        "merchant": row["merchant"] or "",
        "note": row["note"] or "",
        "occurred_at": row["occurred_at"],
        "created_at": row["created_at"],
    }


def expense_list(limit: int = 50) -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute("SELECT * FROM expenses ORDER BY occurred_at DESC LIMIT ?", (max(1, min(limit, 500)),)).fetchall()
    conn.close()
    return [
        {
            "id": r["id"],
            "amount_cents": int(r["amount_cents"]),
            "currency": r["currency"],
            "category": r["category"] or "",
            "merchant": r["merchant"] or "",
            "note": r["note"] or "",
            "occurred_at": r["occurred_at"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def expense_summary_last_days(days: int = 30) -> dict[str, Any]:
    conn = _connect()
    days = max(1, min(int(days or 30), 365))
    # SQLite date compare on ISO strings works for UTC isoformat
    since = (datetime.utcnow() - timedelta(days=days)).isoformat()
    rows = conn.execute(
        "SELECT currency, category, SUM(amount_cents) AS total_cents, COUNT(*) AS n "
        "FROM expenses WHERE occurred_at >= ? GROUP BY currency, category ORDER BY total_cents DESC",
        (since,),
    ).fetchall()
    conn.close()
    by_currency: dict[str, dict[str, Any]] = {}
    for r in rows:
        cur = r["currency"]
        cat = r["category"] or "uncategorized"
        by_currency.setdefault(cur, {"total_cents": 0, "by_category": []})
        by_currency[cur]["total_cents"] += int(r["total_cents"] or 0)
        by_currency[cur]["by_category"].append({"category": cat, "total_cents": int(r["total_cents"] or 0), "count": int(r["n"] or 0)})
    return {"days": days, "since": since, "by_currency": by_currency}


# ---- Daily-life: routine checklist ----
def routine_item_add(name: str) -> dict[str, Any]:
    conn = _connect()
    rid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    conn.execute("INSERT INTO routine_items (id, name, created_at, archived) VALUES (?, ?, ?, 0)", (rid, name.strip()[:120], now))
    conn.commit()
    row = conn.execute("SELECT * FROM routine_items WHERE id = ?", (rid,)).fetchone()
    conn.close()
    return {"id": row["id"], "name": row["name"], "archived": bool(row["archived"]), "created_at": row["created_at"]}


def routine_items(include_archived: bool = False) -> list[dict[str, Any]]:
    conn = _connect()
    if include_archived:
        rows = conn.execute("SELECT * FROM routine_items ORDER BY created_at ASC").fetchall()
    else:
        rows = conn.execute("SELECT * FROM routine_items WHERE archived = 0 ORDER BY created_at ASC").fetchall()
    conn.close()
    return [{"id": r["id"], "name": r["name"], "archived": bool(r["archived"]), "created_at": r["created_at"]} for r in rows]


def routine_toggle(item_id: str, date_iso: str, done: bool) -> dict[str, Any]:
    conn = _connect()
    lid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    d = (date_iso or "").strip()[:10] or datetime.utcnow().strftime("%Y-%m-%d")
    conn.execute(
        "INSERT INTO routine_logs (id, item_id, date_iso, done, created_at) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(item_id, date_iso) DO UPDATE SET done = ?",
        (lid, item_id, d, 1 if done else 0, now, 1 if done else 0),
    )
    conn.commit()
    row = conn.execute("SELECT item_id, date_iso, done FROM routine_logs WHERE item_id = ? AND date_iso = ?", (item_id, d)).fetchone()
    conn.close()
    return {"item_id": row["item_id"], "date_iso": row["date_iso"], "done": bool(row["done"])}


def routine_status(date_iso: str) -> dict[str, bool]:
    conn = _connect()
    d = (date_iso or "").strip()[:10] or datetime.utcnow().strftime("%Y-%m-%d")
    rows = conn.execute("SELECT item_id, done FROM routine_logs WHERE date_iso = ?", (d,)).fetchall()
    conn.close()
    return {r["item_id"]: bool(r["done"]) for r in rows}


def routine_archive(item_id: str, archived: bool) -> dict[str, Any] | None:
    conn = _connect()
    conn.execute("UPDATE routine_items SET archived = ? WHERE id = ?", (1 if archived else 0, item_id))
    conn.commit()
    row = conn.execute("SELECT * FROM routine_items WHERE id = ?", (item_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return {"id": row["id"], "name": row["name"], "archived": bool(row["archived"]), "created_at": row["created_at"]}


# ---- Daily-life: important dates ----
def important_date_add(label: str, date_iso: str, kind: str = "birthday") -> dict[str, Any]:
    conn = _connect()
    did = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    k = (kind or "birthday").strip().lower()
    if k not in ("birthday", "anniversary", "other"):
        k = "other"
    d = (date_iso or "").strip()[:10]
    conn.execute(
        "INSERT INTO important_dates (id, label, date_iso, kind, created_at, archived) VALUES (?, ?, ?, ?, ?, 0)",
        (did, label.strip()[:120], d, k, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM important_dates WHERE id = ?", (did,)).fetchone()
    conn.close()
    return {"id": row["id"], "label": row["label"], "date_iso": row["date_iso"], "kind": row["kind"], "archived": bool(row["archived"]), "created_at": row["created_at"]}


def important_dates(include_archived: bool = False) -> list[dict[str, Any]]:
    conn = _connect()
    if include_archived:
        rows = conn.execute("SELECT * FROM important_dates ORDER BY date_iso ASC").fetchall()
    else:
        rows = conn.execute("SELECT * FROM important_dates WHERE archived = 0 ORDER BY date_iso ASC").fetchall()
    conn.close()
    return [{"id": r["id"], "label": r["label"], "date_iso": r["date_iso"], "kind": r["kind"], "archived": bool(r["archived"]), "created_at": r["created_at"]} for r in rows]


def important_date_archive(date_id: str, archived: bool) -> dict[str, Any] | None:
    conn = _connect()
    conn.execute("UPDATE important_dates SET archived = ? WHERE id = ?", (1 if archived else 0, date_id))
    conn.commit()
    row = conn.execute("SELECT * FROM important_dates WHERE id = ?", (date_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return {"id": row["id"], "label": row["label"], "date_iso": row["date_iso"], "kind": row["kind"], "archived": bool(row["archived"]), "created_at": row["created_at"]}


# ---- Daily-life: medications ----
def medication_add(name: str, dosage: str, times: list[str]) -> dict[str, Any]:
    conn = _connect()
    mid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    # keep only HH:MM times
    clean_times = []
    for t in times or []:
        ts = str(t or "").strip()
        if re.match(r"^\\d{2}:\\d{2}$", ts):
            clean_times.append(ts)
    if not clean_times:
        clean_times = ["08:00"]
    conn.execute(
        "INSERT INTO medications (id, name, dosage, times_json, created_at, active) VALUES (?, ?, ?, ?, ?, 1)",
        (mid, name.strip()[:120], (dosage or "").strip()[:80], json.dumps(clean_times), now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM medications WHERE id = ?", (mid,)).fetchone()
    conn.close()
    return {"id": row["id"], "name": row["name"], "dosage": row["dosage"] or "", "times": json.loads(row["times_json"] or "[]"), "active": bool(row["active"]), "created_at": row["created_at"]}


def medications(active_only: bool = True) -> list[dict[str, Any]]:
    conn = _connect()
    if active_only:
        rows = conn.execute("SELECT * FROM medications WHERE active = 1 ORDER BY created_at DESC").fetchall()
    else:
        rows = conn.execute("SELECT * FROM medications ORDER BY created_at DESC").fetchall()
    conn.close()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "name": r["name"],
                "dosage": r["dosage"] or "",
                "times": json.loads(r["times_json"] or "[]"),
                "active": bool(r["active"]),
                "created_at": r["created_at"],
            }
        )
    return out


def medication_set_active(medication_id: str, active: bool) -> dict[str, Any] | None:
    conn = _connect()
    conn.execute("UPDATE medications SET active = ? WHERE id = ?", (1 if active else 0, medication_id))
    conn.commit()
    row = conn.execute("SELECT * FROM medications WHERE id = ?", (medication_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return {"id": row["id"], "name": row["name"], "dosage": row["dosage"] or "", "times": json.loads(row["times_json"] or "[]"), "active": bool(row["active"]), "created_at": row["created_at"]}


def medication_log_taken(medication_id: str, taken_at: str | None = None) -> dict[str, Any]:
    conn = _connect()
    lid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    ta = (taken_at or now).strip()
    conn.execute(
        "INSERT INTO medication_logs (id, medication_id, taken_at, created_at) VALUES (?, ?, ?, ?)",
        (lid, medication_id, ta, now),
    )
    conn.commit()
    conn.close()
    return {"id": lid, "medication_id": medication_id, "taken_at": ta}


def medication_recent_logs(limit: int = 20) -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute("SELECT * FROM medication_logs ORDER BY taken_at DESC LIMIT ?", (max(1, min(limit, 200)),)).fetchall()
    conn.close()
    return [{"id": r["id"], "medication_id": r["medication_id"], "taken_at": r["taken_at"]} for r in rows]


# ---- Daily-life: water ----
def water_get(date_iso: str) -> dict[str, Any]:
    conn = _connect()
    d = (date_iso or "").strip()[:10] or datetime.utcnow().strftime("%Y-%m-%d")
    row = conn.execute("SELECT * FROM water_logs WHERE date_iso = ?", (d,)).fetchone()
    conn.close()
    if not row:
        return {"date_iso": d, "count": 0, "updated_at": None}
    return {"date_iso": row["date_iso"], "count": int(row["count"]), "updated_at": row["updated_at"]}


def water_set(date_iso: str, count: int) -> dict[str, Any]:
    conn = _connect()
    d = (date_iso or "").strip()[:10] or datetime.utcnow().strftime("%Y-%m-%d")
    now = datetime.utcnow().isoformat()
    c = max(0, min(int(count), 200))
    conn.execute(
        "INSERT INTO water_logs (date_iso, count, updated_at) VALUES (?, ?, ?) ON CONFLICT(date_iso) DO UPDATE SET count = ?, updated_at = ?",
        (d, c, now, c, now),
    )
    conn.commit()
    conn.close()
    return {"date_iso": d, "count": c, "updated_at": now}


# ─── Workspace (Team / Phase 3) ───────────────────────────────────────────────

def workspace_create(name: str, owner_clerk_id: str) -> dict[str, Any]:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-") or "workspace"
    # Ensure slug uniqueness by appending a short suffix
    conn = _connect()
    cur = conn.cursor()
    base_slug = slug
    i = 0
    while cur.execute("SELECT 1 FROM workspaces WHERE slug = ?", (slug,)).fetchone():
        i += 1
        slug = f"{base_slug}-{i}"
    now = datetime.utcnow().isoformat()
    ws_id = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO workspaces (id, name, slug, owner_clerk_id, plan, created_at, updated_at) VALUES (?, ?, ?, ?, 'team', ?, ?)",
        (ws_id, name.strip(), slug, owner_clerk_id, now, now),
    )
    # Add owner as member
    cur.execute(
        "INSERT INTO workspace_members (id, workspace_id, clerk_user_id, email, role, invited_at, joined_at) VALUES (?, ?, ?, '', 'owner', ?, ?)",
        (str(uuid.uuid4()), ws_id, owner_clerk_id, now, now),
    )
    conn.commit()
    conn.close()
    return {"id": ws_id, "name": name.strip(), "slug": slug, "owner_clerk_id": owner_clerk_id, "plan": "team", "created_at": now}


def workspace_get(ws_id: str) -> dict[str, Any] | None:
    conn = _connect()
    row = conn.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return dict(row)


def workspace_list_for_user(clerk_user_id: str) -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute(
        """
        SELECT w.*, wm.role as member_role FROM workspaces w
        JOIN workspace_members wm ON wm.workspace_id = w.id
        WHERE wm.clerk_user_id = ?
        ORDER BY w.created_at DESC
        """,
        (clerk_user_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def workspace_members_list(ws_id: str) -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY joined_at",
        (ws_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def workspace_member_role(ws_id: str, clerk_user_id: str) -> str | None:
    conn = _connect()
    row = conn.execute(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND clerk_user_id = ?",
        (ws_id, clerk_user_id),
    ).fetchone()
    conn.close()
    return row["role"] if row else None


def workspace_invite_create(ws_id: str, email: str, role: str, invited_by: str) -> dict[str, Any]:
    import secrets
    token = secrets.token_urlsafe(24)
    now = datetime.utcnow().isoformat()
    expires = (datetime.utcnow().replace(hour=0, minute=0, second=0) + timedelta(days=7)).isoformat()
    inv_id = str(uuid.uuid4())
    conn = _connect()
    conn.execute(
        "INSERT OR REPLACE INTO workspace_invites (id, workspace_id, email, role, token, invited_by_clerk_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (inv_id, ws_id, email.strip().lower(), role, token, invited_by, now, expires),
    )
    conn.commit()
    conn.close()
    return {"id": inv_id, "workspace_id": ws_id, "email": email, "role": role, "token": token, "expires_at": expires}


def workspace_invite_accept(token: str, clerk_user_id: str, email: str) -> dict[str, Any] | None:
    conn = _connect()
    inv = conn.execute(
        "SELECT * FROM workspace_invites WHERE token = ? AND accepted = 0",
        (token,),
    ).fetchone()
    if not inv:
        conn.close()
        return None
    # Enforce expiry: reject tokens past their expires_at
    expires_at_str = inv.get("expires_at") or ""
    if expires_at_str:
        try:
            from datetime import timezone
            expires_at = datetime.fromisoformat(expires_at_str).replace(tzinfo=timezone.utc)
            if datetime.now(tz=timezone.utc) > expires_at:
                conn.close()
                return None  # Treat expired as not found
        except Exception:
            pass  # If parsing fails, allow through (benefit of the doubt)
    now = datetime.utcnow().isoformat()
    conn.execute(
        "INSERT OR IGNORE INTO workspace_members (id, workspace_id, clerk_user_id, email, role, invited_at, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), inv["workspace_id"], clerk_user_id, email, inv["role"], inv["created_at"], now),
    )
    conn.execute("UPDATE workspace_invites SET accepted = 1 WHERE token = ?", (token,))
    conn.commit()
    result = dict(inv)
    conn.close()
    return result


def workspace_template_create(ws_id: str, name: str, prompt: str, description: str, tags: list[str], category: str, creator_id: str) -> dict[str, Any]:
    now = datetime.utcnow().isoformat()
    t_id = str(uuid.uuid4())
    conn = _connect()
    conn.execute(
        "INSERT INTO workspace_templates (id, workspace_id, name, prompt, description, tags, category, created_by_clerk_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (t_id, ws_id, name, prompt, description, json.dumps(tags), category, creator_id, now, now),
    )
    conn.commit()
    conn.close()
    return {"id": t_id, "workspace_id": ws_id, "name": name, "prompt": prompt, "description": description, "tags": tags, "category": category, "created_at": now}


def workspace_templates_list(ws_id: str) -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM workspace_templates WHERE workspace_id = ? ORDER BY created_at DESC",
        (ws_id,),
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["tags"] = json.loads(d.get("tags") or "[]")
        result.append(d)
    return result


def workspace_template_delete(t_id: str, ws_id: str) -> bool:
    conn = _connect()
    cur = conn.execute("DELETE FROM workspace_templates WHERE id = ? AND workspace_id = ?", (t_id, ws_id))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


# ── User Memory ────────────────────────────────────────────────────────────────

def memory_list() -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM user_memory ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def memory_upsert(key: str, value: str, category: str = "general", source: str = "manual") -> dict[str, Any]:
    conn = _connect()
    mid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    conn.execute(
        """
        INSERT INTO user_memory (id, category, key, value, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?, category = ?, source = ?, updated_at = ?
        """,
        (mid, category, key, value, source, now, now, value, category, source, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM user_memory WHERE key = ?", (key,)).fetchone()
    conn.close()
    return dict(row)


def memory_delete(key: str) -> bool:
    conn = _connect()
    cur = conn.execute("DELETE FROM user_memory WHERE key = ?", (key,))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


def memory_get_all_for_prompt() -> str:
    """Return a compact string of all memories for injection into the system prompt."""
    rows = memory_list()
    if not rows:
        return ""
    lines = [f"- [{r['category']}] {r['key']}: {r['value']}" for r in rows]
    return "Known facts about the user:\n" + "\n".join(lines)


# ── Pending memories (auto-extracted, awaiting user approval) ─────────────────

def pending_memory_add(key: str, value: str, category: str = "general") -> None:
    """Queue an AI-extracted memory fact for user review before committing it."""
    conn = _connect()
    mid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with _DB_WRITE_LOCK:
        conn.execute(
            """
            INSERT OR IGNORE INTO pending_memories (id, category, key, value, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (mid, category, key, value, now),
        )
        conn.commit()
    conn.close()


def pending_memory_list() -> list[dict[str, Any]]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM pending_memories ORDER BY created_at DESC LIMIT 30"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def pending_memory_approve(pid: str) -> bool:
    """Approve a pending memory — moves it to user_memory."""
    conn = _connect()
    row = conn.execute("SELECT * FROM pending_memories WHERE id = ?", (pid,)).fetchone()
    if not row:
        conn.close()
        return False
    with _DB_WRITE_LOCK:
        memory_upsert(row["key"], row["value"], category=row["category"], source="auto")
        conn.execute("DELETE FROM pending_memories WHERE id = ?", (pid,))
        conn.commit()
    conn.close()
    return True


def pending_memory_dismiss(pid: str) -> bool:
    """Dismiss a pending memory without saving it."""
    conn = _connect()
    with _DB_WRITE_LOCK:
        cur = conn.execute("DELETE FROM pending_memories WHERE id = ?", (pid,))
        conn.commit()
    conn.close()
    return cur.rowcount > 0


def pending_memory_purge_old(days: int = 3) -> None:
    """Remove pending memories older than `days` days."""
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
    conn = _connect()
    with _DB_WRITE_LOCK:
        conn.execute("DELETE FROM pending_memories WHERE created_at < ?", (cutoff,))
        conn.commit()
    conn.close()


# ── OAuth Tokens ───────────────────────────────────────────────────────────────

def oauth_token_get(provider: str) -> dict[str, Any] | None:
    conn = _connect()
    row = conn.execute("SELECT * FROM oauth_tokens WHERE provider = ?", (provider,)).fetchone()
    conn.close()
    return dict(row) if row else None


def oauth_token_save(provider: str, access_token: str, refresh_token: str = "",
                     expires_at: float = 0.0, scope: str = "") -> None:
    conn = _connect()
    now = datetime.utcnow().isoformat()
    conn.execute(
        """
        INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
            access_token = ?, refresh_token = ?, expires_at = ?, scope = ?, updated_at = ?
        """,
        (provider, access_token, refresh_token, expires_at, scope, now,
         access_token, refresh_token, expires_at, scope, now),
    )
    conn.commit()
    conn.close()


def oauth_token_delete(provider: str) -> None:
    conn = _connect()
    conn.execute("DELETE FROM oauth_tokens WHERE provider = ?", (provider,))
    conn.commit()
    conn.close()


# ── App Config ────────────────────────────────────────────────────────────────

def app_config_get(key: str) -> str | None:
    conn = _connect()
    row = conn.execute("SELECT value FROM app_config WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else None


def app_config_set(key: str, value: str) -> None:
    conn = _connect()
    now = datetime.utcnow().isoformat()
    conn.execute(
        "INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?",
        (key, value, now, value, now),
    )
    conn.commit()
    conn.close()


def app_config_delete(key: str) -> None:
    conn = _connect()
    conn.execute("DELETE FROM app_config WHERE key = ?", (key,))
    conn.commit()
    conn.close()
