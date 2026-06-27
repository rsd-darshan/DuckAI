from __future__ import annotations

from fastapi import APIRouter, HTTPException

from models.schemas import AnnotationOverlayRequest
from services.annotation import overlay_annotations

router = APIRouter()


@router.post("/api/annotation/overlay")
def api_annotation_overlay(req: AnnotationOverlayRequest) -> dict[str, str]:
    if not req.image_base64.strip():
        raise HTTPException(status_code=400, detail="image_base64 required")
    image_base64 = overlay_annotations(
        req.image_base64,
        [
            {
                "points": [{"x": p.x, "y": p.y} for p in stroke.points],
                "color": stroke.color,
                "width": stroke.width,
            }
            for stroke in req.strokes
        ],
    )
    return {"image_base64": image_base64}
