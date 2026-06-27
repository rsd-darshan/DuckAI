from __future__ import annotations

from base64 import b64decode, b64encode
from io import BytesIO
from typing import Any

from PIL import Image, ImageDraw


def overlay_annotations(image_base64: str, strokes: list[dict[str, Any]]) -> str:
    image = Image.open(BytesIO(b64decode(image_base64))).convert("RGBA")
    draw = ImageDraw.Draw(image)
    for stroke in strokes or []:
        points = stroke.get("points") or []
        color = stroke.get("color") or "#ef4444"
        width = int(stroke.get("width") or 3)
        if len(points) >= 2:
            path = [(float(p.get("x", 0)), float(p.get("y", 0))) for p in points]
            draw.line(path, fill=color, width=max(1, width), joint="curve")
    out = BytesIO()
    image.save(out, format="PNG")
    return b64encode(out.getvalue()).decode("utf-8")
