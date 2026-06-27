from __future__ import annotations

import re
import time
from urllib.parse import urlencode
from typing import Any

import httpx

from ai_engine import chat as ai_chat
from config import Settings
from database import get_settings, set_setting


def _require_token(token: str, name: str) -> None:
    if not token.strip():
        raise ValueError(f"{name} is not configured")


def slack_list_channels(settings: Settings) -> list[dict[str, Any]]:
    _require_token(settings.slack_bot_token, "SLACK_BOT_TOKEN")
    with httpx.Client(timeout=20.0) as client:
        r = client.get(
            "https://slack.com/api/conversations.list",
            headers={"Authorization": f"Bearer {settings.slack_bot_token}"},
            params={"exclude_archived": "true", "limit": 100},
        )
        r.raise_for_status()
        data = r.json()
    if not data.get("ok"):
        raise ValueError(data.get("error") or "Slack API error")
    return data.get("channels") or []


def slack_send_message(settings: Settings, text: str, channel: str | None = None) -> dict[str, Any]:
    _require_token(settings.slack_bot_token, "SLACK_BOT_TOKEN")
    target = (channel or settings.slack_default_channel).strip()
    if not target:
        raise ValueError("Slack channel is required")
    with httpx.Client(timeout=20.0) as client:
        r = client.post(
            "https://slack.com/api/chat.postMessage",
            headers={"Authorization": f"Bearer {settings.slack_bot_token}"},
            json={"channel": target, "text": text},
        )
        r.raise_for_status()
        data = r.json()
    if not data.get("ok"):
        raise ValueError(data.get("error") or "Slack API error")
    return data


def _extract_pr(repo_or_url: str, pr_number: int | None) -> tuple[str, int]:
    value = repo_or_url.strip()
    if value.startswith("http"):
        m = re.search(r"github\.com/([^/]+/[^/]+)/pull/(\d+)", value)
        if not m:
            raise ValueError("Invalid GitHub PR URL")
        return (m.group(1), int(m.group(2)))
    if pr_number is None:
        raise ValueError("pr_number is required when repo is provided")
    return (value, int(pr_number))


def github_pr_review(settings: Settings, repo_or_url: str, pr_number: int | None = None) -> dict[str, Any]:
    _require_token(settings.github_token, "GITHUB_TOKEN")
    repo, pr = _extract_pr(repo_or_url, pr_number)
    headers = {
        "Authorization": f"Bearer {settings.github_token}",
        "Accept": "application/vnd.github+json",
    }
    with httpx.Client(timeout=30.0) as client:
        pr_res = client.get(f"{settings.github_api_base}/repos/{repo}/pulls/{pr}", headers=headers)
        pr_res.raise_for_status()
        files_res = client.get(f"{settings.github_api_base}/repos/{repo}/pulls/{pr}/files", headers=headers)
        files_res.raise_for_status()
        comments_res = client.get(f"{settings.github_api_base}/repos/{repo}/issues/{pr}/comments", headers=headers)
        comments_res.raise_for_status()
    pr_data = pr_res.json()
    files = files_res.json() or []
    comments = comments_res.json() or []
    prompt = (
        f"PR title: {pr_data.get('title','')}\n"
        f"PR body: {pr_data.get('body','')}\n"
        f"Changed files: {[(f.get('filename'), f.get('status'), f.get('changes')) for f in files[:20]]}\n"
        f"Recent comments: {[c.get('body','') for c in comments[:10]]}\n"
        "Return concise PR review with: risks, regressions, missing tests, and suggestions."
    )
    review = ai_chat([{"role": "user", "content": prompt}], context={})
    return {
        "repo": repo,
        "pr_number": pr,
        "title": pr_data.get("title", ""),
        "url": pr_data.get("html_url", ""),
        "file_count": len(files),
        "comment_count": len(comments),
        "review": review,
    }


def calendar_list_events(settings: Settings, max_results: int = 20) -> list[dict[str, Any]]:
    access_token = _calendar_access_token(settings)
    with httpx.Client(timeout=20.0) as client:
        r = client.get(
            f"{settings.calendar_api_base}/calendars/{settings.calendar_id}/events",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"maxResults": max(1, min(max_results, 100)), "singleEvents": "true", "orderBy": "startTime"},
        )
        r.raise_for_status()
        data = r.json()
    return data.get("items") or []


def calendar_create_event(
    settings: Settings,
    summary: str,
    start_iso: str,
    end_iso: str,
    description: str = "",
    timezone: str = "UTC",
    attendee_emails: list[str] | None = None,
) -> dict[str, Any]:
    access_token = _calendar_access_token(settings)
    attendees = [e.strip() for e in (attendee_emails or []) if e and isinstance(e, str) and "@" in str(e).strip()]
    payload = {
        "summary": summary.strip(),
        "description": description,
        "start": {"dateTime": start_iso, "timeZone": timezone},
        "end": {"dateTime": end_iso, "timeZone": timezone},
    }
    if attendees:
        payload["attendees"] = [{"email": e} for e in attendees]
    params = {}
    if attendees:
        params["sendUpdates"] = "all"  # Google sends invite/confirmation emails to attendees (and organizer)
    with httpx.Client(timeout=20.0) as client:
        r = client.post(
            f"{settings.calendar_api_base}/calendars/{settings.calendar_id}/events",
            headers={"Authorization": f"Bearer {access_token}"},
            params=params or None,
            json=payload,
        )
        r.raise_for_status()
        data = r.json()
    return data


def calendar_oauth_authorize_url(settings: Settings, state: str = "sideai") -> str:
    _require_token(settings.calendar_client_id, "CALENDAR_CLIENT_ID")
    params = {
        "client_id": settings.calendar_client_id,
        "redirect_uri": settings.calendar_redirect_uri,
        "response_type": "code",
        "scope": "https://www.googleapis.com/auth/calendar",
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    return f"{settings.calendar_auth_uri}?{urlencode(params)}"


def calendar_exchange_auth_code(settings: Settings, code: str) -> dict[str, Any]:
    _require_token(settings.calendar_client_id, "CALENDAR_CLIENT_ID")
    _require_token(settings.calendar_client_secret, "CALENDAR_CLIENT_SECRET")
    with httpx.Client(timeout=20.0) as client:
        r = client.post(
            settings.calendar_token_uri,
            data={
                "code": code.strip(),
                "client_id": settings.calendar_client_id,
                "client_secret": settings.calendar_client_secret,
                "redirect_uri": settings.calendar_redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        r.raise_for_status()
        token_data = r.json()
    _persist_calendar_tokens(token_data)
    return token_data


def calendar_refresh_access_token(settings: Settings) -> dict[str, Any]:
    _require_token(settings.calendar_client_id, "CALENDAR_CLIENT_ID")
    _require_token(settings.calendar_client_secret, "CALENDAR_CLIENT_SECRET")
    refresh_token = _stored_calendar_refresh_token() or ""
    _require_token(refresh_token, "CALENDAR_REFRESH_TOKEN")
    with httpx.Client(timeout=20.0) as client:
        r = client.post(
            settings.calendar_token_uri,
            data={
                "client_id": settings.calendar_client_id,
                "client_secret": settings.calendar_client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )
        r.raise_for_status()
        token_data = r.json()
    token_data["refresh_token"] = refresh_token
    _persist_calendar_tokens(token_data)
    return token_data


def _stored_calendar_refresh_token() -> str:
    settings = get_settings()
    from_db = str(settings.get("calendar_refresh_token", {}).get("value", "")).strip()
    return from_db


def _stored_calendar_access_token() -> str:
    settings = get_settings()
    return str(settings.get("calendar_access_token", {}).get("value", "")).strip()


def _stored_calendar_expiry() -> int:
    settings = get_settings()
    raw = str(settings.get("calendar_access_token_expires_at", {}).get("value", "0")).strip()
    try:
        return int(raw or "0")
    except Exception:
        return 0


def _persist_calendar_tokens(token_data: dict[str, Any]) -> None:
    access_token = str(token_data.get("access_token") or "").strip()
    refresh_token = str(token_data.get("refresh_token") or "").strip()
    expires_in = int(token_data.get("expires_in") or 3600)
    expires_at = int(time.time()) + max(60, expires_in - 30)
    if access_token:
        set_setting("calendar_access_token", access_token, "string")
        set_setting("calendar_access_token_expires_at", str(expires_at), "number")
    if refresh_token:
        set_setting("calendar_refresh_token", refresh_token, "string")


def _calendar_access_token(settings: Settings) -> str:
    env_token = settings.calendar_token.strip()
    if env_token:
        return env_token
    db_token = _stored_calendar_access_token()
    expiry = _stored_calendar_expiry()
    if db_token and expiry > int(time.time()) + 15:
        return db_token
    refreshed = calendar_refresh_access_token(settings)
    token = str(refreshed.get("access_token") or "").strip()
    _require_token(token, "CALENDAR access token")
    return token
