import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    default_web_search_limit: int
    clipboard_monitor_enabled: bool
    rag_chunk_size: int
    rag_top_k: int
    enable_browser_bridge: bool
    enable_vscode_bridge: bool
    slack_bot_token: str
    slack_default_channel: str
    github_token: str
    github_api_base: str
    calendar_api_base: str
    calendar_token: str
    calendar_id: str
    calendar_client_id: str
    calendar_client_secret: str
    calendar_redirect_uri: str
    calendar_auth_uri: str
    calendar_token_uri: str
    analytics_retention_days: int
    plugins_dir: str


def _to_bool(raw: str | None, default: bool) -> bool:
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def load_settings() -> Settings:
    return Settings(
        default_web_search_limit=int(os.getenv("DEFAULT_WEB_SEARCH_LIMIT", "3")),
        clipboard_monitor_enabled=_to_bool(os.getenv("CLIPBOARD_MONITOR_ENABLED"), True),
        rag_chunk_size=int(os.getenv("RAG_CHUNK_SIZE", "700")),
        rag_top_k=int(os.getenv("RAG_TOP_K", "4")),
        enable_browser_bridge=_to_bool(os.getenv("ENABLE_BROWSER_BRIDGE"), False),
        enable_vscode_bridge=_to_bool(os.getenv("ENABLE_VSCODE_BRIDGE"), False),
        slack_bot_token=os.getenv("SLACK_BOT_TOKEN", "").strip(),
        slack_default_channel=os.getenv("SLACK_DEFAULT_CHANNEL", "").strip(),
        github_token=os.getenv("GITHUB_TOKEN", "").strip(),
        github_api_base=os.getenv("GITHUB_API_BASE", "https://api.github.com").rstrip("/"),
        calendar_api_base=os.getenv("CALENDAR_API_BASE", "https://www.googleapis.com/calendar/v3").rstrip("/"),
        calendar_token=os.getenv("CALENDAR_TOKEN", "").strip(),
        calendar_id=os.getenv("CALENDAR_ID", "primary").strip(),
        calendar_client_id=os.getenv("CALENDAR_CLIENT_ID", "").strip(),
        calendar_client_secret=os.getenv("CALENDAR_CLIENT_SECRET", "").strip(),
        calendar_redirect_uri=os.getenv("CALENDAR_REDIRECT_URI", "http://127.0.0.1:8000/api/integrations/calendar/oauth/callback").strip(),
        calendar_auth_uri=os.getenv("CALENDAR_AUTH_URI", "https://accounts.google.com/o/oauth2/v2/auth").strip(),
        calendar_token_uri=os.getenv("CALENDAR_TOKEN_URI", "https://oauth2.googleapis.com/token").strip(),
        analytics_retention_days=int(os.getenv("ANALYTICS_RETENTION_DAYS", "30")),
        plugins_dir=os.getenv("PLUGINS_DIR", "plugins").strip(),
    )
