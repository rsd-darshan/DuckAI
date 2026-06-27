from typing import Any

from pydantic import BaseModel, Field


class AnnotationStrokePoint(BaseModel):
    x: float
    y: float


class AnnotationStroke(BaseModel):
    points: list[AnnotationStrokePoint]
    color: str = "#ef4444"
    width: int = 3


class AnnotationOverlayRequest(BaseModel):
    image_base64: str
    strokes: list[AnnotationStroke]


class KBDocumentIngestRequest(BaseModel):
    title: str = Field(..., max_length=500)
    content: str = Field(..., max_length=200_000)
    source: str = Field(default="", max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=20)


class KBQueryRequest(BaseModel):
    query: str = Field(..., max_length=2000)
    top_k: int | None = Field(default=None, ge=1, le=20)


class VisionAnalyzeRequest(BaseModel):
    image_base64: str


class VisionCompareRequest(BaseModel):
    first_image_base64: str
    second_image_base64: str


class VoiceTranscribeRequest(BaseModel):
    audio_base64: str
    language: str = Field(default="en", max_length=10)



class CodeAnalyzeRequest(BaseModel):
    content: str = Field(..., max_length=100_000)
    language: str = Field(default="unknown", max_length=50)


class BrowserBridgeSyncRequest(BaseModel):
    tab_id: str
    url: str = ""
    title: str = ""
    text: str = ""


class VSCodeBridgeSyncRequest(BaseModel):
    workspace: str = ""
    active_file: str = ""
    selection: str = ""



class QuickToolRunRequest(BaseModel):
    tool_id: str
    text: str = ""
    options: dict[str, Any] = {}
    context: dict[str, Any] = {}


class SlackSendRequest(BaseModel):
    text: str
    channel: str = ""


class GitHubPRReviewRequest(BaseModel):
    repo_or_url: str
    pr_number: int | None = None


class CalendarCreateEventRequest(BaseModel):
    summary: str
    start_iso: str
    end_iso: str
    description: str = ""
    timezone: str = "UTC"
    attendee_emails: list[str] = []  # Google sends invite/confirmation emails when sendUpdates is used


class CalendarOAuthExchangeRequest(BaseModel):
    code: str


class AnalyticsEventRequest(BaseModel):
    event_type: str
    tool_id: str = ""
    payload: dict[str, Any] = {}


class NotificationCreateRequest(BaseModel):
    title: str
    body: str = ""
    level: str = "info"


class NotificationUpdateRequest(BaseModel):
    read: bool | None = None
    dismissed: bool | None = None



class FocusStartRequest(BaseModel):
    duration_minutes: int = 25



class DailyNoteUpsertRequest(BaseModel):
    date_iso: str  # YYYY-MM-DD
    content: str


class PluginCreateRequest(BaseModel):
    name: str
    version: str = "0.1.0"
    manifest: dict[str, Any] = {}
    permissions: list[str] = []


class PluginEnabledRequest(BaseModel):
    enabled: bool


