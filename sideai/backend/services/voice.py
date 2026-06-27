from __future__ import annotations

from typing import Any


def transcribe_audio_stub(audio_base64: str, language: str = "en") -> dict[str, Any]:
    # Foundation endpoint: returns metadata and placeholder transcript contract.
    size = len(audio_base64 or "")
    return {
        "text": "",
        "language": language,
        "provider": "stub",
        "note": "No speech model configured yet. Wire Whisper/OpenAI as next step.",
        "input_size": size,
    }
