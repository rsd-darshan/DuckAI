from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import math
import re
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote
from zoneinfo import ZoneInfo

import qrcode

from ai_engine import chat as ai_chat
from type_text import paste_text_production, type_text as do_type_text


TOOL_CATALOG: list[dict[str, str]] = [
    {"id": "quick_translation", "label": "Quick Translation", "section": "Quick & Lightweight"},
    {"id": "quick_grammar_fix", "label": "Quick Grammar Check & Fix", "section": "Quick & Lightweight"},
    {"id": "quick_paraphrase", "label": "Quick Paraphrase & Rewriting", "section": "Quick & Lightweight"},
    {"id": "quick_summarize", "label": "Quick Summarize", "section": "Quick & Lightweight"},
    {"id": "quick_explain_eli5", "label": "Quick Explain (ELI5)", "section": "Quick & Lightweight"},
    {"id": "quick_todo_extraction", "label": "Quick Todo Extraction", "section": "Quick & Lightweight"},
    {"id": "quick_question_answerer", "label": "Quick Question Answerer", "section": "Quick & Lightweight"},
    {"id": "quick_sentiment_analysis", "label": "Quick Sentiment Analysis", "section": "Quick & Lightweight"},
    {"id": "quick_code_snippet_explainer", "label": "Quick Code Snippet Explainer", "section": "Quick & Lightweight"},
    {"id": "quick_timezone_converter", "label": "Quick Time Zone Converter", "section": "Quick & Lightweight"},
    {"id": "quick_email_draft", "label": "Quick Email Draft", "section": "Copywriting"},
    {"id": "quick_slack_message", "label": "Quick Slack Message", "section": "Copywriting"},
    {"id": "quick_meeting_notes_template", "label": "Quick Meeting Notes Template", "section": "Copywriting"},
    {"id": "quick_social_post", "label": "Quick Social Media Post", "section": "Copywriting"},
    {"id": "quick_product_description", "label": "Quick Product Description", "section": "Copywriting"},
    {"id": "quick_code_review_inline", "label": "Quick Code Review (Inline)", "section": "Code Helpers"},
    {"id": "quick_variable_name", "label": "Quick Variable Name Suggestion", "section": "Code Helpers"},
    {"id": "quick_test_case_generator", "label": "Quick Test Case Generator", "section": "Code Helpers"},
    {"id": "quick_regex_explainer", "label": "Quick Regex Explainer", "section": "Code Helpers"},
    {"id": "quick_sql_formatter", "label": "Quick SQL Formatter & Explainer", "section": "Code Helpers"},
    {"id": "quick_unit_converter", "label": "Quick Unit Converter", "section": "Data & Numbers"},
    {"id": "quick_json_formatter", "label": "Quick JSON Formatter", "section": "Data & Numbers"},
    {"id": "quick_csv_stats", "label": "Quick CSV Viewer & Stats", "section": "Data & Numbers"},
    {"id": "quick_math_calculator", "label": "Quick Math Calculator", "section": "Data & Numbers"},
    {"id": "quick_price_calculator", "label": "Quick Price/Cost Calculator", "section": "Data & Numbers"},
    {"id": "quick_task_creator", "label": "Quick Task/Todo Creator", "section": "Productivity"},
    {"id": "quick_note_taking", "label": "Quick Note-Taking", "section": "Productivity"},
    {"id": "quick_link_saver", "label": "Quick Link Saver", "section": "Productivity"},
    {"id": "quick_reminder", "label": "Quick Reminder", "section": "Productivity"},
    {"id": "quick_explain_visible_error", "label": "Explain error on screen (OCR)", "section": "Code Helpers"},
    {"id": "quick_compare_texts", "label": "Compare two texts (use --- between)", "section": "Communication"},
    {"id": "quick_form_fill_hints", "label": "Form field suggestions (screen + goal)", "section": "Productivity"},
    {"id": "quick_mailto_compose", "label": "mailto: link from draft", "section": "Communication"},
    {"id": "quick_focus_timer", "label": "Quick Focus Timer", "section": "Productivity"},
    {"id": "quick_definition", "label": "Quick Definition / Thesaurus", "section": "Learning"},
    {"id": "quick_fact_checker", "label": "Quick Fact-Checker", "section": "Learning"},
    {"id": "quick_historical_context", "label": "Quick Historical Context", "section": "Learning"},
    {"id": "quick_code_pattern_library", "label": "Quick Code Pattern Library", "section": "Learning"},
    {"id": "quick_email_reply", "label": "Quick Email Reply Suggestion", "section": "Communication"},
    {"id": "quick_deescalation", "label": "Quick Conflict De-escalation", "section": "Communication"},
    {"id": "quick_presentation_outline", "label": "Quick Presentation Outline", "section": "Communication"},
    {"id": "quick_faq_generator", "label": "Quick FAQ Generator", "section": "Communication"},
    {"id": "quick_comparison_tool", "label": "Quick Comparison Tool", "section": "Communication"},
    {"id": "quick_text_converter", "label": "Quick Text Formatting Converter", "section": "Formatting"},
    {"id": "quick_csv_excel_helper", "label": "Quick CSV/Excel Helper", "section": "Formatting"},
    {"id": "quick_password_generator", "label": "Quick Password Generator", "section": "Formatting"},
    {"id": "quick_uuid_hash_generator", "label": "Quick UUID/Hash Generator", "section": "Formatting"},
    {"id": "quick_template_generator", "label": "Quick Template Generator", "section": "Formatting"},
    {"id": "quick_poll_creator", "label": "Quick Poll Creator", "section": "Feedback"},
    {"id": "quick_team_sentiment", "label": "Quick Sentiment Check (Team)", "section": "Feedback"},
    {"id": "quick_feedback_response", "label": "Quick Feedback Response Generator", "section": "Feedback"},
    {"id": "quick_clipboard_history", "label": "Quick Clipboard History", "section": "Micro-Automation"},
    {"id": "quick_smart_paste", "label": "Smart paste (focused field, clipboard-safe)", "section": "Micro-Automation"},
    {"id": "quick_link_shortener", "label": "Quick Link Shortener", "section": "Micro-Automation"},
    {"id": "quick_duplicate_finder", "label": "Quick Duplicate Finder", "section": "Micro-Automation"},
    {"id": "quick_sort_filter", "label": "Quick Sort & Filter", "section": "Micro-Automation"},
    {"id": "quick_web_search", "label": "Quick Web Search", "section": "Browser & Web"},
    {"id": "quick_qr_generator", "label": "Quick QR Code Generator", "section": "Browser & Web"},
    {"id": "quick_website_text_extractor", "label": "Quick Website Text Extractor", "section": "Browser & Web"},
    {"id": "quick_settings_panel", "label": "Quick Settings Panel", "section": "Settings"},
    {"id": "quick_keyboard_shortcuts", "label": "Quick Keyboard Shortcut Panel", "section": "Settings"},
    {"id": "quick_help_tooltips", "label": "Quick Help & Tooltips", "section": "Settings"},
    {"id": "quick_daily_standup", "label": "Quick Daily Standup Generator", "section": "Personal Productivity"},
    {"id": "quick_weekly_summary", "label": "Quick Weekly Summary", "section": "Personal Productivity"},
]


def list_tools() -> list[dict[str, str]]:
    return TOOL_CATALOG


def _ask_ai(instruction: str, content: str, context: dict | None = None) -> str:
    return ai_chat([{"role": "user", "content": f"{instruction}\n\nInput:\n{content}"}], context=context or {})


def _safe_eval(expr: str) -> float:
    if not re.fullmatch(r"[0-9\.\+\-\*\/\(\) %]+", expr.strip()):
        raise ValueError("Unsupported math expression")
    return float(eval(expr, {"__builtins__": {}}, {}))


def _convert_unit(value: float, from_unit: str, to_unit: str) -> float:
    length = {"m": 1.0, "cm": 0.01, "km": 1000.0, "ft": 0.3048, "in": 0.0254}
    weight = {"kg": 1.0, "g": 0.001, "lb": 0.45359237}
    if from_unit in length and to_unit in length:
        return value * length[from_unit] / length[to_unit]
    if from_unit in weight and to_unit in weight:
        return value * weight[from_unit] / weight[to_unit]
    raise ValueError("Unsupported conversion")


def run_tool(tool_id: str, text: str, options: dict | None = None, context: dict | None = None) -> dict:
    options = options or {}
    raw = text or ""
    tid = tool_id.strip().lower()

    ai_map = {
        "quick_translation": "Translate the input to the target language. Keep concise.",
        "quick_grammar_fix": "Fix grammar and clarity while preserving meaning.",
        "quick_paraphrase": "Paraphrase this text in 2 concise variants.",
        "quick_summarize": "Summarize in short bullet points.",
        "quick_explain_eli5": "Explain like I'm 5 in simple language.",
        "quick_question_answerer": "Answer directly with a concise explanation.",
        "quick_sentiment_analysis": "Return sentiment (positive/neutral/negative) and short reasoning.",
        "quick_code_snippet_explainer": "Explain this code snippet in simple terms.",
        "quick_email_draft": "Draft a professional email.",
        "quick_slack_message": "Draft a clear Slack message.",
        "quick_meeting_notes_template": "Generate a structured meeting notes template with sections.",
        "quick_social_post": "Draft a social media post with concise style.",
        "quick_product_description": "Write a concise product description.",
        "quick_code_review_inline": "Review this code and provide inline issues and suggestions.",
        "quick_variable_name": "Suggest 10 clear variable names.",
        "quick_test_case_generator": "Generate practical test cases from this spec/code.",
        "quick_regex_explainer": "Explain this regex and give examples.",
        "quick_sql_formatter": "Format this SQL and explain what it does.",
        "quick_note_taking": "Convert this into structured notes.",
        "quick_definition": "Give definition, synonyms, and a short example.",
        "quick_fact_checker": "State likely true/false/uncertain and explain what to verify.",
        "quick_historical_context": "Provide historical context in concise bullets.",
        "quick_code_pattern_library": "Suggest relevant code patterns and when to use them.",
        "quick_email_reply": "You are drafting a professional email reply.\n\nINPUT:\nA full email thread excerpt (the user's email and/or the other person's message) is provided below.\n\nREQUIREMENTS (very important):\n- Use ONLY information present in the input. Do NOT guess names, dates, locations, account numbers, or commitments.\n- Address any questions or requests explicitly in the reply.\n- If the input lacks critical details, include 1-3 concise clarification questions instead of hallucinating.\n- Keep tone: professional, polite, and aligned with the original message (if formal is implied, stay formal).\n- Output format: return ONLY the email body (no subject line, no markdown), with:\n  1) a short greeting line (e.g., \"Hi <Name>,\" or \"Hello,\" if name unknown)\n  2) 2-5 short paragraphs\n  3) a closing line (e.g., \"Best regards,\" / \"Sincerely,\")\n  4) If sender name is unknown, end with \"<Your Name>\" placeholder.\n- Do not include any explanations, bullets, or meta commentary.\n\nNow write the email reply.",
        "quick_deescalation": "Rewrite this message in de-escalated tone.",
        "quick_presentation_outline": "Generate a presentation outline.",
        "quick_faq_generator": "Generate FAQ items with answers.",
        "quick_comparison_tool": "Compare options in a pros/cons table-like bullets.",
        "quick_template_generator": "Generate a reusable template from this intent.",
        "quick_poll_creator": "Create a short poll with options.",
        "quick_team_sentiment": "Analyze team sentiment and suggest action.",
        "quick_feedback_response": "Generate a constructive feedback response.",
        "quick_website_text_extractor": "Extract key text highlights from the input content.",
        "quick_help_tooltips": "Generate concise help/tooltips for this feature.",
        "quick_daily_standup": "Generate daily standup format (yesterday/today/blockers).",
        "quick_weekly_summary": "Generate a concise weekly summary.",
    }
    if tid == "quick_form_fill_hints":
        vis = str((context or {}).get("visible_text") or "")[:10000]
        notes = raw.strip() or "Suggest values for visible form fields."
        instr = (
            "Help the user fill a form using OCR context. Suggest concise values per field; "
            "mark uncertain items; never invent government IDs, card numbers, passwords, or secrets."
        )
        payload = f"{instr}\n\nUser notes:\n{notes}\n\n--- Visible screen text (OCR) ---\n{vis}"
        return {"tool_id": tid, "result": _ask_ai("You are a careful assistant.", payload, context or {})}

    if tid in ai_map:
        return {"tool_id": tid, "result": _ask_ai(ai_map[tid], raw, context)}

    if tid == "quick_explain_visible_error":
        vis = str((context or {}).get("visible_text") or "")[:12000]
        goal = raw.strip() or "Explain any error, warning, or stack trace visible in the text. Suggest concrete fixes."
        payload = f"{goal}\n\n--- Visible screen text (OCR, noisy) ---\n{vis}"
        return {"tool_id": tid, "result": _ask_ai("You are a careful debugging assistant.", payload, context or {})}

    if tid == "quick_compare_texts":
        parts = re.split(r"\n-{3,}\n", raw, maxsplit=1)
        if len(parts) < 2:
            return {
                "tool_id": tid,
                "error": "Provide two blocks separated by a line containing only --- (three or more dashes).",
            }
        a, b = parts[0].strip(), parts[1].strip()
        body = f"A:\n{a[:6000]}\n\nB:\n{b[:6000]}"
        return {
            "tool_id": tid,
            "result": _ask_ai(
                "Compare A vs B: key differences, risks, and a short recommendation (bullets).",
                body,
                context or {},
            ),
        }

    if tid == "quick_mailto_compose":
        subj, body_lines = "", []
        for ln in raw.splitlines():
            ls = ln.strip()
            if ls.lower().startswith("subject:"):
                subj = ls.split(":", 1)[1].strip()
            elif ls.lower().startswith("body:"):
                body_lines.append(ls.split(":", 1)[1].strip())
            else:
                body_lines.append(ln)
        body = "\n".join(body_lines).strip()
        to = str((context or {}).get("mailto_to") or options.get("to") or "").strip()
        link = f"mailto:{quote(to)}" if to else "mailto:"
        q = []
        if subj:
            q.append(f"subject={quote(subj)}")
        if body:
            q.append(f"body={quote(body)}")
        if q:
            link += "?" + "&".join(q)
        return {"tool_id": tid, "result": link, "meta": {"hint": "Paste into browser address bar or assign to an anchor href."}}

    if tid == "quick_todo_extraction":
        lines = [ln.strip("-• ").strip() for ln in re.split(r"[\n.;]", raw) if ln.strip()]
        tasks = [ln for ln in lines if re.search(r"\b(todo|must|need|follow up|action)\b", ln, re.IGNORECASE)]
        return {"tool_id": tid, "result": tasks[:20]}

    if tid == "quick_timezone_converter":
        from_tz = str(options.get("from_tz") or "UTC")
        to_tz = str(options.get("to_tz") or "Asia/Kathmandu")
        dt_str = str(options.get("datetime") or datetime.now(timezone.utc).isoformat())
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        converted = dt.astimezone(ZoneInfo(to_tz))
        return {"tool_id": tid, "result": converted.isoformat(), "meta": {"from_tz": from_tz, "to_tz": to_tz}}

    if tid == "quick_unit_converter":
        value = float(options.get("value") or 0)
        from_unit = str(options.get("from") or "m")
        to_unit = str(options.get("to") or "ft")
        out = _convert_unit(value, from_unit, to_unit)
        return {"tool_id": tid, "result": f"{out:.6g}", "meta": {"from": from_unit, "to": to_unit}}

    if tid == "quick_json_formatter":
        parsed = json.loads(raw)
        return {"tool_id": tid, "result": json.dumps(parsed, indent=2, ensure_ascii=False)}

    if tid == "quick_csv_stats":
        reader = csv.DictReader(io.StringIO(raw))
        rows = list(reader)
        columns = reader.fieldnames or []
        return {"tool_id": tid, "result": {"rows": len(rows), "columns": columns}}

    if tid == "quick_math_calculator":
        return {"tool_id": tid, "result": _safe_eval(raw)}

    if tid == "quick_price_calculator":
        qty = float(options.get("quantity") or 1)
        unit_price = float(options.get("unit_price") or 0)
        tax_percent = float(options.get("tax_percent") or 0)
        subtotal = qty * unit_price
        tax = subtotal * (tax_percent / 100.0)
        total = subtotal + tax
        return {"tool_id": tid, "result": {"subtotal": subtotal, "tax": tax, "total": total}}

    if tid == "quick_task_creator":
        return {"tool_id": tid, "result": {"title": raw.strip()[:140], "created": True}}

    if tid == "quick_link_saver":
        url = str(options.get("url") or raw).strip()
        return {"tool_id": tid, "result": {"url": url, "saved": True}}

    if tid == "quick_reminder":
        minutes = int(options.get("minutes") or 30)
        due = datetime.utcnow() + timedelta(minutes=max(1, minutes))
        return {"tool_id": tid, "result": {"title": raw.strip()[:140], "due_at": due.isoformat()}}

    if tid == "quick_focus_timer":
        minutes = int(options.get("minutes") or 25)
        return {"tool_id": tid, "result": {"duration_minutes": minutes, "status": "running"}}

    if tid == "quick_text_converter":
        mode = str(options.get("mode") or "upper").lower()
        if mode == "upper":
            out = raw.upper()
        elif mode == "lower":
            out = raw.lower()
        elif mode == "title":
            out = raw.title()
        else:
            out = raw
        return {"tool_id": tid, "result": out}

    if tid == "quick_csv_excel_helper":
        lines = [ln for ln in raw.splitlines() if ln.strip()]
        return {"tool_id": tid, "result": {"non_empty_lines": len(lines), "preview": lines[:5]}}

    if tid == "quick_password_generator":
        length = int(options.get("length") or 16)
        chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*"
        seed = hashlib.sha256(str(datetime.utcnow().timestamp()).encode("utf-8")).hexdigest()
        out = "".join(chars[int(seed[i % len(seed)], 16) % len(chars)] for i in range(max(8, min(length, 64))))
        return {"tool_id": tid, "result": out}

    if tid == "quick_uuid_hash_generator":
        value = raw or str(uuid.uuid4())
        return {"tool_id": tid, "result": {"uuid": str(uuid.uuid4()), "sha256": hashlib.sha256(value.encode("utf-8")).hexdigest()}}

    if tid == "quick_clipboard_history":
        return {"tool_id": tid, "result": "Use clipboard history panel for latest copied items."}

    if tid == "quick_link_shortener":
        long_url = str(options.get("url") or raw).strip()
        short = f"side.ai/{hashlib.md5(long_url.encode('utf-8')).hexdigest()[:8]}"
        return {"tool_id": tid, "result": {"long_url": long_url, "short_url": short}}

    if tid == "quick_duplicate_finder":
        items = [ln.strip() for ln in raw.splitlines() if ln.strip()]
        seen: set[str] = set()
        dup: list[str] = []
        for item in items:
            if item in seen and item not in dup:
                dup.append(item)
            seen.add(item)
        return {"tool_id": tid, "result": dup}

    if tid == "quick_sort_filter":
        items = [ln.strip() for ln in raw.splitlines() if ln.strip()]
        mode = str(options.get("mode") or "asc")
        key = str(options.get("contains") or "")
        filtered = [i for i in items if key.lower() in i.lower()] if key else items
        filtered.sort(reverse=(mode == "desc"))
        return {"tool_id": tid, "result": filtered}

    if tid == "quick_web_search":
        return {"tool_id": tid, "result": f"Use search endpoint with query: {raw}"}

    if tid == "quick_qr_generator":
        img = qrcode.make(raw or "https://example.com")
        bio = io.BytesIO()
        img.save(bio, format="PNG")
        return {"tool_id": tid, "result_base64": base64.b64encode(bio.getvalue()).decode("utf-8")}

    if tid == "quick_settings_panel":
        return {"tool_id": tid, "result": "Open Settings tab to manage width, opacity, theme, sidebar, and hotkeys."}

    if tid == "quick_keyboard_shortcuts":
        return {
            "tool_id": tid,
            "result": [
                "Cmd/Ctrl+Shift+A: Focus SideAI panel",
                "Configured template hotkeys: run mapped prompt",
                "Enter in input: Send message",
            ],
        }

    if tid == "quick_smart_paste":
        payload = raw.strip()
        if not payload:
            return {"tool_id": tid, "error": "Provide the text to paste into the focused field."}
        try:
            meta = paste_text_production(
                payload[:32000],
                restore_clipboard=True,
                paste_retries=3,
                clipboard_settle_ms=110,
                inter_paste_ms=95,
            )
            return {"tool_id": tid, "result": meta}
        except Exception as e:
            return {"tool_id": tid, "error": str(e)[:800]}

    return {"tool_id": tid, "result": _ask_ai("Complete this quick task in concise output.", raw, context)}
