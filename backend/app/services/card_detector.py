import base64
import logging
import os
from pathlib import Path

import cv2
import numpy as np
import torch

logger = logging.getLogger(__name__)

_USE_HALF = torch.cuda.is_available()

# Path to fine-tuned YOLO weights. Override with YOLO_MODEL_PATH env var.
_MODEL_PATH = Path(os.getenv("YOLO_MODEL_PATH", "models/card_detector.pt"))

# Loaded lazily on first detect call.
_yolo_model = None

# Reject boxes smaller than 1% of the image area (false positives on noise).
_MIN_AREA_FRAC = 0.010


def preload() -> None:
    """Eagerly load the YOLO model at startup so the first /detect call is fast."""
    _get_yolo_model()


def _get_yolo_model():
    global _yolo_model
    if _yolo_model is not None:
        return _yolo_model
    if not _MODEL_PATH.exists():
        logger.error("YOLO model missing at %s — detection will return no boxes", _MODEL_PATH)
        return None
    try:
        from ultralytics import YOLO
        _yolo_model = YOLO(str(_MODEL_PATH))
        logger.info("Loaded YOLO model from %s", _MODEL_PATH)
    except Exception:
        logger.exception("Failed to load YOLO model")
        _yolo_model = None
    return _yolo_model


def detect_card_rectangles(
    image_base64: str,
    max_cards: int = 10,
) -> tuple[list[dict], int, int]:
    """
    Returns (boxes, image_width, image_height).
    boxes is a list of {left, top, width, height} dicts in image-pixel coordinates,
    sorted left→right within rows, then top→bottom.

    Requires the fine-tuned YOLO model at models/card_detector.pt. If absent,
    returns an empty box list (mobile falls back to OCR clustering).
    """
    img_bytes = base64.b64decode(image_base64)
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    h, w = img.shape[:2]

    model = _get_yolo_model()
    if model is None:
        return [], w, h

    total_area = w * h
    # half=True on CUDA: ~1.5× faster with no accuracy regression at this model size.
    results = model(img, conf=0.25, iou=0.45, verbose=False, half=_USE_HALF)
    boxes: list[dict] = []
    for result in results:
        for box in result.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            bw, bh = int(x2 - x1), int(y2 - y1)
            area_frac = (bw * bh) / total_area
            if area_frac < _MIN_AREA_FRAC:
                continue
            boxes.append({"left": int(x1), "top": int(y1), "width": bw, "height": bh})

    logger.info("YOLO detect: image=%dx%d boxes=%d", w, h, len(boxes))
    boxes = _sort_boxes(boxes, h)
    return boxes[:max_cards], w, h


def _sort_boxes(boxes: list[dict], img_h: int) -> list[dict]:
    row_h = max(1, int(img_h * 0.25))
    return sorted(boxes, key=lambda b: (b["top"] // row_h, b["left"]))
