from __future__ import annotations

from fastapi import APIRouter, HTTPException

from config import Settings
from models.schemas import (
    CodeAnalyzeRequest,
    KBDocumentIngestRequest,
    KBQueryRequest,
    VisionAnalyzeRequest,
    VisionCompareRequest,
    VoiceTranscribeRequest,
)
from services.code_analysis import analyze_code
from services.rag import ingest_document, list_documents, synthesize_with_sources
from services.vision import analyze_image, compare_images, extract_image_text
from services.voice import transcribe_audio_stub

router = APIRouter()


def create_phase3_router(settings: Settings) -> APIRouter:
    scoped = APIRouter()
    scoped.include_router(router)

    @scoped.post("/api/kb/documents")
    def api_kb_ingest(req: KBDocumentIngestRequest):
        if not req.title.strip() or not req.content.strip():
            raise HTTPException(status_code=400, detail="title and content required")
        return ingest_document(req.title, req.content, req.source, req.tags)

    @scoped.get("/api/kb/documents")
    def api_kb_list():
        return {"items": list_documents()}

    @scoped.post("/api/kb/query")
    def api_kb_query(req: KBQueryRequest):
        top_k = req.top_k or settings.rag_top_k
        return synthesize_with_sources(req.query, top_k=top_k, chunk_size=settings.rag_chunk_size)

    @scoped.post("/api/vision/analyze")
    def api_vision_analyze(req: VisionAnalyzeRequest):
        return analyze_image(req.image_base64)

    @scoped.post("/api/vision/extract")
    def api_vision_extract(req: VisionAnalyzeRequest):
        return extract_image_text(req.image_base64)

    @scoped.post("/api/vision/compare")
    def api_vision_compare(req: VisionCompareRequest):
        return compare_images(req.first_image_base64, req.second_image_base64)

    @scoped.post("/api/voice/transcribe")
    def api_voice_transcribe(req: VoiceTranscribeRequest):
        return transcribe_audio_stub(req.audio_base64, req.language)

    @scoped.post("/api/code/analyze")
    def api_code_analyze(req: CodeAnalyzeRequest):
        return analyze_code(req.content, req.language)

    return scoped
