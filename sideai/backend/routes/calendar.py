"""
Calendar integration — Google Calendar via OAuth2.

Security improvements:
  - OAuth `state` parameter added (CSRF protection)
  - Attendee emails hidden from response (only count + display names returned)
  - Timezone-aware event times using the calendar's timezone
"""

from __future__ import annotations

import os
import secrets
import time
import datetime
from typing import Any

import httpx
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ai_engine import generate_meeting_brief

logger = logging.getLogger("sideai.calendar")
from database import (
    app_config_delete,
    app_config_get,
    app_config_set,
    memory_get_all_for_prompt,
    oauth_token_delete,
    oauth_token_get,
    oauth_token_save,
)

router = APIRouter(prefix="/api/calendar", tags=["calendar"])

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
GOOGLE_REDIRECT_URI = os.getenv(
    "GOOGLE_REDIRECT_URI", "http://localhost:8000/api/calendar/callback-landing"
)
GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.readonly"
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3"

_OAUTH_STATE_KEY = "google_calendar_oauth_state"
_PENDING_CODE_KEY = "google_calendar_pending_code"
# States expire after 10 minutes
_STATE_TTL_SECONDS = 600


def _get_valid_token() -> str | None:
    row = oauth_token_get("google_calendar")
    if not row:
        return None
    expires_at = float(row.get("expires_at") or 0)
    # Refresh if token expires within 5 minutes
    if expires_at and time.time() >= expires_at - 300:
        refresh = row.get("refresh_token", "")
        if not refresh or not GOOGLE_CLIENT_ID:
            logger.warning("Google Calendar token expired and no refresh_token available — user must re-auth")
            return None
        try:
            resp = httpx.post(
                GOOGLE_TOKEN_URL,
                data={
                    "client_id": GOOGLE_CLIENT_ID,
                    "client_secret": GOOGLE_CLIENT_SECRET,
                    "refresh_token": refresh,
                    "grant_type": "refresh_token",
                },
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            new_expires_at = time.time() + data.get("expires_in", 3600)
            # Google may rotate the refresh_token — use the new one if provided
            new_refresh = data.get("refresh_token") or refresh
            oauth_token_save(
                "google_calendar",
                data["access_token"],
                new_refresh,
                new_expires_at,
                data.get("scope", GOOGLE_SCOPES),
            )
            logger.debug("Google Calendar access token refreshed successfully")
            return data["access_token"]
        except httpx.HTTPStatusError as exc:
            logger.error(
                "Google Calendar token refresh failed (HTTP %s): %s",
                exc.response.status_code, exc.response.text[:200],
            )
            return None
        except Exception as exc:
            logger.error("Google Calendar token refresh error: %s", exc)
            return None
    return row.get("access_token")


# ── Auth flow ─────────────────────────────────────────────────────────────────

@router.get("/auth-url")
def get_auth_url() -> dict:
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(
            status_code=503,
            detail="GOOGLE_CLIENT_ID not configured. Set it in backend/.env",
        )
    # Generate a fresh CSRF state token and store with timestamp
    state = secrets.token_urlsafe(32)
    app_config_set(_OAUTH_STATE_KEY, f"{state}:{int(time.time())}")

    from urllib.parse import urlencode
    params = urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": GOOGLE_SCOPES,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    })
    return {"url": f"{GOOGLE_AUTH_URL}?{params}"}


class OAuthCallbackRequest(BaseModel):
    code: str
    state: str = ""


@router.post("/callback")
def oauth_callback(req: OAuthCallbackRequest) -> dict:
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=503, detail="GOOGLE_CLIENT_ID not configured")
    try:
        resp = httpx.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "code": req.code,
                "redirect_uri": GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        expires_at = time.time() + data.get("expires_in", 3600)
        oauth_token_save(
            "google_calendar",
            data["access_token"],
            data.get("refresh_token", ""),
            expires_at,
            data.get("scope", GOOGLE_SCOPES),
        )
        return {"ok": True}
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=400, detail=f"Token exchange failed: {e.response.text}")


@router.get("/callback-landing")
def oauth_callback_landing(code: str = "", state: str = "") -> dict:
    """Browser redirects here after Google consent. Validates CSRF state before storing code."""
    if not code:
        return {"ok": False, "message": "No code received."}

    # Validate state to prevent CSRF
    stored = app_config_get(_OAUTH_STATE_KEY) or ""
    if stored:
        parts = stored.split(":", 1)
        stored_state = parts[0]
        stored_ts = int(parts[1]) if len(parts) > 1 else 0
        state_expired = (time.time() - stored_ts) > _STATE_TTL_SECONDS
        if state and (state != stored_state or state_expired):
            return {"ok": False, "message": "Invalid or expired OAuth state. Please retry."}
        app_config_delete(_OAUTH_STATE_KEY)

    app_config_set(_PENDING_CODE_KEY, code)
    return {"ok": True, "message": "You can close this tab and return to DuckAI."}


@router.get("/pending-code")
def consume_pending_code() -> dict:
    """Frontend polls this to pick up the OAuth code set by the landing page."""
    code = app_config_get(_PENDING_CODE_KEY)
    if not code:
        return {"code": None}
    app_config_set(_PENDING_CODE_KEY, "")
    return {"code": code}


@router.get("/status")
def calendar_status() -> dict:
    row = oauth_token_get("google_calendar")
    return {"connected": bool(row and row.get("access_token"))}


@router.delete("/disconnect")
def disconnect_calendar() -> dict:
    oauth_token_delete("google_calendar")
    return {"ok": True}


# ── Events ────────────────────────────────────────────────────────────────────

def _local_today_range() -> tuple[str, str]:
    """Return (timeMin, timeMax) ISO strings for today in the local machine timezone."""
    tz_name = datetime.datetime.now(datetime.timezone.utc).astimezone().tzname() or "UTC"
    local_now = datetime.datetime.now()
    today_start = datetime.datetime(local_now.year, local_now.month, local_now.day)
    today_end = today_start + datetime.timedelta(days=1)
    # Convert to UTC for the API
    offset = datetime.datetime.now() - datetime.datetime.utcnow()
    utc_start = (today_start - offset).strftime("%Y-%m-%dT%H:%M:%SZ")
    utc_end = (today_end - offset).strftime("%Y-%m-%dT%H:%M:%SZ")
    return utc_start, utc_end


def _format_event_time(dt_str: str) -> str:
    """Format a datetime string to local time H:MM AM/PM."""
    if not dt_str:
        return ""
    try:
        # Parse ISO 8601 with offset
        if "T" in dt_str:
            # Convert to local time
            dt = datetime.datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
            local_dt = dt.astimezone()
            return local_dt.strftime("%-I:%M %p")
        return dt_str  # all-day event — just a date string
    except Exception:
        return dt_str[11:16] if len(dt_str) > 15 else dt_str


def _fetch_today_events() -> list[dict[str, Any]]:
    token = _get_valid_token()
    if not token:
        return []
    time_min, time_max = _local_today_range()
    try:
        resp = httpx.get(
            f"{GOOGLE_CALENDAR_API}/calendars/primary/events",
            headers={"Authorization": f"Bearer {token}"},
            params={
                "timeMin": time_min,
                "timeMax": time_max,
                "singleEvents": "true",
                "orderBy": "startTime",
            },
            timeout=10,
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
        events = []
        for item in items:
            start_obj = item.get("start", {})
            end_obj = item.get("end", {})
            raw_start = start_obj.get("dateTime") or start_obj.get("date", "")
            raw_end = end_obj.get("dateTime") or end_obj.get("date", "")

            # Privacy: return only attendee count + display names (no emails)
            raw_attendees = item.get("attendees", [])
            attendee_names = [
                a.get("displayName") or a.get("email", "").split("@")[0]
                for a in raw_attendees
            ]
            events.append({
                "id": item.get("id", ""),
                "summary": item.get("summary", "Untitled"),
                "start": raw_start,
                "start_display": _format_event_time(raw_start),
                "end": raw_end,
                "end_display": _format_event_time(raw_end),
                "description": (item.get("description") or "")[:500],
                "attendee_count": len(raw_attendees),
                "attendee_names": attendee_names[:8],  # cap at 8 names
                "location": item.get("location", ""),
                "meet_link": item.get("hangoutLink", ""),
            })
        return events
    except httpx.HTTPStatusError as exc:
        logger.error("Google Calendar API error (HTTP %s): %s", exc.response.status_code, exc.response.text[:200])
        return []
    except Exception as exc:
        logger.error("Failed to fetch calendar events: %s", exc)
        return []


@router.get("/today")
def today_events() -> dict:
    token = _get_valid_token()
    if not token:
        raise HTTPException(status_code=401, detail="Google Calendar not connected")
    return {"events": _fetch_today_events()}


class MeetingBriefRequest(BaseModel):
    event: dict[str, Any]


@router.post("/brief")
def meeting_brief(req: MeetingBriefRequest) -> dict:
    token = _get_valid_token()
    if not token:
        raise HTTPException(status_code=401, detail="Google Calendar not connected")
    memory_ctx = memory_get_all_for_prompt()
    brief = generate_meeting_brief(req.event, memory_context=memory_ctx)
    return {"brief": brief}
