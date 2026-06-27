"""
Code analysis service — combines fast regex heuristics with LLM deep analysis.

Heuristics run first (instant, no API cost) to catch obvious issues.
The LLM then reviews the code for logic errors, security issues, and best-practice violations.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ai_engine import _chat_completion, _extract_first_json_object

_MAX_CODE_CHARS = 6000  # cap to avoid blowing token budgets

_HEURISTIC_RULES: list[tuple[re.Pattern[str], str, str, str]] = [
    # (pattern, severity, type, message)
    (re.compile(r".{141,}"), "low", "style", "Line exceeds 140 characters."),
    (re.compile(r"\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b"), "medium", "maintenance", "Unresolved TODO/FIXME/HACK marker."),
    (re.compile(r'(?i)\bpassword\s*=\s*["\'][^"\']{3,}'), "high", "security", "Possible hardcoded password detected."),
    (re.compile(r'(?i)\bsecret\s*=\s*["\'][^"\']{8,}'), "high", "security", "Possible hardcoded secret detected."),
    (re.compile(r'(?i)\bapi[_\-]?key\s*=\s*["\'][^"\']{8,}'), "high", "security", "Possible hardcoded API key detected."),
    (re.compile(r"\beval\s*\("), "high", "security", "Unsafe eval() call — consider safer alternatives."),
    (re.compile(r"except\s*:\s*$|except\s+Exception\s*:\s*$", re.MULTILINE), "medium", "error-handling", "Bare except clause swallows all errors — catch specific exceptions."),
    (re.compile(r"\bprint\s*\("), "low", "debug", "Debug print() left in code."),
    (re.compile(r"\bconsole\.(log|debug|warn)\s*\("), "low", "debug", "Debug console.log left in code."),
    (re.compile(r"[A-Za-z0-9/+]{40,}={0,2}"), "medium", "security", "Long base64-looking string — may be an embedded secret."),
]

_ANALYSIS_SYSTEM = """You are a senior code reviewer. Analyze the provided code and return a JSON object with this exact shape:
{
  "issues": [
    {"line": <int or null>, "severity": "high|medium|low", "type": "<category>", "message": "<clear description>"}
  ],
  "summary_text": "<2-3 sentence overall assessment>"
}

Rules:
- severity "high": security vulnerabilities, crashes, data loss risks
- severity "medium": logic bugs, missing error handling, bad practices
- severity "low": style, readability, minor inefficiencies
- type values: "security", "bug", "logic", "error-handling", "performance", "style", "maintainability"
- Be specific: mention variable names, line numbers when visible, concrete fixes
- Return ONLY the JSON object — no markdown, no explanation outside the JSON
- If the code looks clean, return an empty issues array with a positive summary_text
"""


def analyze_code(content: str, language: str = "unknown") -> dict[str, Any]:
    """
    Analyze code for issues.
    Phase 1: fast heuristic pass (regex).
    Phase 2: LLM deep analysis of the full snippet.
    Results are merged and de-duplicated.
    """
    code = (content or "").strip()
    lang = (language or "unknown").strip()

    # ── Phase 1: regex heuristics ─────────────────────────────────────────────
    heuristic_issues: list[dict[str, Any]] = []
    lines = code.splitlines()
    for idx, line in enumerate(lines, start=1):
        for pattern, severity, issue_type, message in _HEURISTIC_RULES:
            if pattern.search(line):
                heuristic_issues.append({
                    "line": idx,
                    "severity": severity,
                    "type": issue_type,
                    "message": message,
                })
                break  # One issue per line per pass to avoid noise

    # ── Phase 2: LLM deep analysis ────────────────────────────────────────────
    llm_issues: list[dict[str, Any]] = []
    summary_text = ""
    code_excerpt = code[:_MAX_CODE_CHARS]
    try:
        raw = _chat_completion(
            [{"role": "user", "content": f"Language: {lang}\n\n```{lang}\n{code_excerpt}\n```\n\nAnalyze this code."}],
            system=_ANALYSIS_SYSTEM,
            max_tokens=900,
            temperature=0.1,
        )
        data = _extract_first_json_object(raw)
        if isinstance(data.get("issues"), list):
            for item in data["issues"]:
                if not isinstance(item, dict):
                    continue
                llm_issues.append({
                    "line": item.get("line") if isinstance(item.get("line"), int) else None,
                    "severity": str(item.get("severity") or "low"),
                    "type": str(item.get("type") or "general"),
                    "message": str(item.get("message") or "")[:300],
                })
        summary_text = str(data.get("summary_text") or "")[:500]
    except Exception:
        summary_text = "LLM analysis unavailable — showing heuristic results only."

    # ── Merge: LLM issues take precedence; heuristic fills gaps ──────────────
    # Deduplicate by (line, type) — prefer LLM version
    llm_keys = {(i.get("line"), i.get("type")) for i in llm_issues}
    merged = llm_issues[:]
    for h in heuristic_issues:
        key = (h.get("line"), h.get("type"))
        if key not in llm_keys:
            merged.append(h)

    merged.sort(
        key=lambda i: ({"high": 0, "medium": 1, "low": 2}.get(i.get("severity", "low"), 2), i.get("line") or 9999)
    )

    return {
        "language": lang,
        "summary": {
            "issue_count": len(merged),
            "high": sum(1 for i in merged if i.get("severity") == "high"),
            "medium": sum(1 for i in merged if i.get("severity") == "medium"),
            "low": sum(1 for i in merged if i.get("severity") == "low"),
        },
        "summary_text": summary_text,
        "issues": merged[:40],  # cap display at 40
    }
