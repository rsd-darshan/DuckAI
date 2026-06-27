from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query

from config import Settings
from database import (
    analytics_log_event,
    analytics_summary,
    create_focus_timer,
    create_notification,
    daily_note_get,
    daily_note_upsert,
    finish_focus_timer,
    latest_focus_timer,
    list_notifications,
    reminder_due_soon,
    reminder_mark_notified,
    reminder_list as db_reminder_list,
    update_notification,
)
from models.schemas import (
    AnalyticsEventRequest,
    CalendarCreateEventRequest,
    CalendarOAuthExchangeRequest,
    DailyNoteUpsertRequest,
    FocusStartRequest,
    GitHubPRReviewRequest,
    NotificationCreateRequest,
    NotificationUpdateRequest,
    QuickToolRunRequest,
    SlackSendRequest,
)
from services.external_integrations import (
    calendar_create_event,
    calendar_exchange_auth_code,
    calendar_list_events,
    calendar_oauth_authorize_url,
    calendar_refresh_access_token,
    github_pr_review,
    slack_list_channels,
    slack_send_message,
)
from services.quick_tools import list_tools, run_tool
from services.weather import get_weather


def create_everything_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    # ── Reminder notification tick (called by Electron periodically) ───────────
    @router.post("/api/daily-life/tick")
    def api_daily_life_tick(window_sec: int = Query(default=300)):
        import time
        now_ts = int(time.time())
        due = reminder_due_soon(now_ts, within_sec=window_sec, limit=25)
        created = 0
        for r in due:
            try:
                title = str(r.get("title") or "Reminder").strip() or "Reminder"
                body = (r.get("due") or "").strip() or "Due now — open DuckAI to mark done."
                create_notification(title=title, body=body, level="info")
                reminder_mark_notified(str(r.get("id") or ""))
                created += 1
            except Exception:
                pass
        return {"ok": True, "created": created}

    # ── Quick tools (AI templates) ─────────────────────────────────────────────
    @router.get("/api/quick-tools/list")
    def api_quick_tools_list():
        return {"items": list_tools()}

    @router.post("/api/quick-tools/run")
    def api_quick_tool_run(req: QuickToolRunRequest):
        try:
            out = run_tool(req.tool_id, req.text, req.options, req.context)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        analytics_log_event("quick_tool_run", req.tool_id, {"ok": True})
        return out

    # ── Slack integration ──────────────────────────────────────────────────────
    @router.get("/api/integrations/slack/channels")
    def api_slack_channels():
        try:
            channels = slack_list_channels(settings)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        analytics_log_event("integration_slack_channels")
        return {"items": channels}

    @router.post("/api/integrations/slack/send")
    def api_slack_send(req: SlackSendRequest):
        try:
            out = slack_send_message(settings, req.text, req.channel or None)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        analytics_log_event("integration_slack_send")
        return out

    # ── GitHub integration ─────────────────────────────────────────────────────
    @router.post("/api/integrations/github/pr-review")
    def api_github_pr_review(req: GitHubPRReviewRequest):
        try:
            out = github_pr_review(settings, req.repo_or_url, req.pr_number)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        analytics_log_event("integration_github_pr_review")
        return out

    # ── Calendar integration ───────────────────────────────────────────────────
    @router.get("/api/integrations/calendar/events")
    def api_calendar_events(max_results: int = Query(default=20)):
        try:
            items = calendar_list_events(settings, max_results=max_results)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        analytics_log_event("integration_calendar_list")
        return {"items": items}

    @router.get("/api/integrations/calendar/oauth/url")
    def api_calendar_oauth_url(state: str = Query(default="duckai")):
        try:
            url = calendar_oauth_authorize_url(settings, state=state)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"url": url}

    @router.post("/api/integrations/calendar/oauth/exchange")
    def api_calendar_oauth_exchange(req: CalendarOAuthExchangeRequest):
        try:
            token_data = calendar_exchange_auth_code(settings, req.code)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"ok": True, "token_type": token_data.get("token_type", "Bearer"), "expires_in": token_data.get("expires_in")}

    @router.post("/api/integrations/calendar/oauth/refresh")
    def api_calendar_oauth_refresh():
        try:
            token_data = calendar_refresh_access_token(settings)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"ok": True, "token_type": token_data.get("token_type", "Bearer"), "expires_in": token_data.get("expires_in")}

    @router.get("/api/integrations/calendar/oauth/callback")
    def api_calendar_oauth_callback(code: str = Query(default=""), state: str = Query(default="")):
        if not code.strip():
            raise HTTPException(status_code=400, detail="Missing code")
        try:
            calendar_exchange_auth_code(settings, code.strip())
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"ok": True, "state": state, "message": "Calendar authorization complete. You can return to DuckAI."}

    @router.post("/api/integrations/calendar/events")
    def api_calendar_create(req: CalendarCreateEventRequest):
        try:
            item = calendar_create_event(
                settings, req.summary, req.start_iso, req.end_iso,
                req.description, req.timezone, req.attendee_emails,
            )
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        analytics_log_event("integration_calendar_create")
        return item

    # ── Analytics ──────────────────────────────────────────────────────────────
    @router.post("/api/analytics/events")
    def api_analytics_log(req: AnalyticsEventRequest):
        return analytics_log_event(req.event_type, req.tool_id, req.payload)

    @router.get("/api/analytics/summary")
    def api_analytics_summary(limit: int = Query(default=20)):
        return analytics_summary(limit=limit)

    # ── Notifications ──────────────────────────────────────────────────────────
    @router.get("/api/notifications")
    def api_notifications(include_dismissed: bool = Query(default=False)):
        return {"items": list_notifications(include_dismissed=include_dismissed)}

    @router.post("/api/notifications")
    def api_create_notification(req: NotificationCreateRequest):
        return create_notification(req.title, req.body, req.level)

    @router.post("/api/notifications/{notification_id}")
    def api_update_notification(notification_id: str, req: NotificationUpdateRequest):
        item = update_notification(notification_id, req.read, req.dismissed)
        if not item:
            raise HTTPException(status_code=404, detail="Notification not found")
        return item

    # ── Focus timer ────────────────────────────────────────────────────────────
    @router.post("/api/focus/start")
    def api_focus_start(req: FocusStartRequest):
        return create_focus_timer(req.duration_minutes)

    @router.post("/api/focus/{timer_id}/complete")
    def api_focus_complete(timer_id: str):
        item = finish_focus_timer(timer_id)
        if not item:
            raise HTTPException(status_code=404, detail="Timer not found")
        return item

    @router.get("/api/focus/latest")
    def api_focus_latest():
        return {"item": latest_focus_timer()}

    # ── Daily brief (calendar + reminders + weather) ───────────────────────────
    @router.get("/api/daily-brief")
    def api_daily_brief(city: str = Query(default="")):
        today = datetime.utcnow().strftime("%Y-%m-%d")
        calendar_today = []
        try:
            all_events = calendar_list_events(settings, max_results=50)
            for ev in all_events or []:
                start = (ev.get("start") or {})
                dt = start.get("dateTime") or start.get("date") or ""
                if dt.startswith(today):
                    calendar_today.append(ev)
        except Exception:
            pass
        reminders = db_reminder_list(include_done=False)
        weather = get_weather(city)
        return {"date": today, "calendar_today": calendar_today, "reminders": reminders, "weather": weather}

    @router.get("/api/weather")
    def api_weather(city: str = Query(default="")):
        return get_weather(city)

    # ── Daily note ─────────────────────────────────────────────────────────────
    @router.get("/api/daily-note")
    def api_daily_note_get(date_iso: str = Query(default="")):
        d = date_iso.strip() or datetime.utcnow().strftime("%Y-%m-%d")
        note = daily_note_get(d)
        return {
            "date_iso": d,
            "content": note["content"] if note else "",
            "updated_at": note["updated_at"] if note else None,
        }

    @router.put("/api/daily-note")
    def api_daily_note_upsert(req: DailyNoteUpsertRequest):
        return daily_note_upsert(req.date_iso, req.content)

    return router
