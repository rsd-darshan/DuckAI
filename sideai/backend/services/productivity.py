import re
from typing import Any

APP_MODES: dict[str, dict[str, Any]] = {
    "vs-code": {
        "mode": "code-copilot",
        "system_prompt": "You are an expert code assistant. Focus on performance, bugs, style, and testing.",
        "suggested_templates": ["code_review", "debug_error"],
    },
    "gmail": {
        "mode": "email",
        "system_prompt": "Help with email composition: tone, clarity, and professionalism.",
        "suggested_templates": ["email_draft", "email_reply"],
    },
    "figma": {
        "mode": "design",
        "system_prompt": "Provide design feedback: hierarchy, alignment, and accessibility.",
        "suggested_templates": ["brainstorm"],
    },
    "browser": {
        "mode": "research",
        "system_prompt": "Help analyze web content and summarize key points.",
        "suggested_templates": ["brainstorm"],
    },
}


def resolve_app_mode(active_app: str) -> dict[str, Any]:
    key = (active_app or "").strip().lower()
    if "code" in key:
        return APP_MODES["vs-code"]
    if key in ("mail", "apple mail", "thunderbird", "superhuman") or (
        "outlook" in key and "visual studio" not in key
    ):
        return APP_MODES["gmail"]
    if "figma" in key:
        return APP_MODES["figma"]
    return APP_MODES["browser"]


def analyze_clipboard_content(content: str) -> dict[str, Any]:
    text = (content or "").strip()
    if not text:
        return {"type": "empty", "suggestion": "Clipboard is empty."}
    is_url = bool(re.match(r"^https?://", text.lower()))
    is_error = bool(re.search(r"(error|exception|traceback|failed)", text, re.IGNORECASE))
    is_code = bool(re.search(r"(def |class |function |\{|\};|=>|import )", text))
    ctype = "text"
    if is_url:
        ctype = "url"
        suggestion = "URL detected. You can ask SideAI to summarize this page."
    elif is_error:
        ctype = "error"
        suggestion = "Error text detected. Ask SideAI to debug this error."
    elif is_code:
        ctype = "code"
        suggestion = "Code snippet detected. Ask SideAI for review or refactor."
    else:
        suggestion = "Text detected. Ask SideAI to summarize or rewrite."
    return {"type": ctype, "suggestion": suggestion, "length": len(text)}
