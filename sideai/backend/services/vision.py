from __future__ import annotations

from base64 import b64decode
from io import BytesIO
from typing import Any

from PIL import Image, ImageChops, ImageStat

from screen_capture import extract_visible_text


def _decode_image(image_base64: str) -> Image.Image:
    return Image.open(BytesIO(b64decode(image_base64))).convert("RGB")


def analyze_image(image_base64: str) -> dict[str, Any]:
    img = _decode_image(image_base64)
    text, confidence = extract_visible_text(img)
    width, height = img.size
    return {
        "width": width,
        "height": height,
        "ocr_text": text[:5000],
        "ocr_confidence": confidence,
    }


def extract_image_text(image_base64: str) -> dict[str, Any]:
    img = _decode_image(image_base64)
    text, confidence = extract_visible_text(img)
    return {"text": text, "confidence": confidence}


def compare_images(first_base64: str, second_base64: str) -> dict[str, Any]:
    img1 = _decode_image(first_base64)
    img2 = _decode_image(second_base64).resize(img1.size)
    diff = ImageChops.difference(img1, img2)
    stat = ImageStat.Stat(diff)
    mean_delta = sum(stat.mean) / len(stat.mean)
    similarity = max(0.0, 1.0 - (mean_delta / 255.0))
    return {"similarity": round(similarity, 4), "mean_delta": round(mean_delta, 4)}
