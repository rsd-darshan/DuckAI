import re
from datetime import datetime, timedelta


def _normalize_time(hour: int, minute: int, ampm: str | None) -> tuple[int, int]:
    if ampm:
        ap = ampm.lower()
        if ap == "pm" and hour < 12:
            hour += 12
        if ap == "am" and hour == 12:
            hour = 0
    return (max(0, min(hour, 23)), max(0, min(minute, 59)))


def parse_due_string(raw: str | None) -> tuple[str | None, int | None]:
    if not raw:
        return (None, None)
    text = raw.strip()
    if not text:
        return (None, None)
    # HTML datetime-local: "2026-03-22T15:30" (naive local time)
    iso_local = text.strip().replace(" ", "")
    if "T" in iso_local and re.match(r"^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}", iso_local):
        try:
            due_dt = datetime.fromisoformat(iso_local)
            return (due_dt.strftime("%Y-%m-%d %H:%M"), int(due_dt.timestamp()))
        except ValueError:
            pass
    now = datetime.now()
    lower = text.lower()

    rel = re.search(r"\bin\s+(\d+)\s*(minute|minutes|hour|hours|day|days)\b", lower)
    if rel:
        amount = int(rel.group(1))
        unit = rel.group(2)
        if "minute" in unit:
            due_dt = now + timedelta(minutes=amount)
        elif "hour" in unit:
            due_dt = now + timedelta(hours=amount)
        else:
            due_dt = now + timedelta(days=amount)
        return (due_dt.strftime("%Y-%m-%d %H:%M"), int(due_dt.timestamp()))

    td = re.search(
        r"\b(today|tomorrow)\b(?:\s+at\s+|\s+)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?",
        lower,
    )
    if td:
        base = now if td.group(1) == "today" else now + timedelta(days=1)
        hour = 18
        minute = 0
        if td.group(2):
            parsed_hour = int(td.group(2))
            parsed_min = int(td.group(3) or "0")
            hour, minute = _normalize_time(parsed_hour, parsed_min, td.group(4))
        due_dt = base.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return (due_dt.strftime("%Y-%m-%d %H:%M"), int(due_dt.timestamp()))

    iso = re.search(r"\b(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?\b", text)
    if iso:
        year = int(iso.group(1))
        month = int(iso.group(2))
        day = int(iso.group(3))
        hour = int(iso.group(4) or "18")
        minute = int(iso.group(5) or "0")
        try:
            due_dt = datetime(year, month, day, hour, minute)
            return (due_dt.strftime("%Y-%m-%d %H:%M"), int(due_dt.timestamp()))
        except Exception:
            return (text[:40], None)

    m = re.search(r"\b(?:by|due|before)\s+([a-zA-Z0-9 ,:-]{3,40})", text, re.IGNORECASE)
    if m:
        return (m.group(1).strip(), None)
    return (text[:40], None)
