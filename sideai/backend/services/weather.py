"""Simple weather for daily brief (no API key). Uses wttr.in."""

from __future__ import annotations

from typing import Any

import httpx


def get_weather(city: str = "") -> dict[str, Any]:
    """Fetch current weather. city empty = use IP location."""
    try:
        loc = city.strip() or ""
        url = "https://wttr.in/" + (loc if loc else ":")
        # Request JSON; 1 day to keep payload small
        r = httpx.get(
            f"{url}?format=j1",
            timeout=8.0,
            headers={"User-Agent": "SideAI/1.0"},
        )
        r.raise_for_status()
        data = r.json()
        current = (data.get("current_condition") or [{}])[0]
        return {
            "temp_C": current.get("temp_C"),
            "temp_F": current.get("temp_F"),
            "desc": (current.get("weatherDesc") or [{}])[0].get("value", ""),
            "humidity": current.get("humidity"),
            "location": (data.get("nearest_area") or [{}])[0].get("areaName", [{}])[0].get("value", loc or "Current location"),
        }
    except Exception:
        return {"temp_C": None, "temp_F": None, "desc": "", "humidity": None, "location": "", "error": "Weather unavailable"}
