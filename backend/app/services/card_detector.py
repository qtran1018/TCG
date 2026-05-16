import base64
import logging
import os
from pathlib import Path

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Path to fine-tuned YOLO weights. Override with YOLO_MODEL_PATH env var.
# Drop your trained card_detector.pt here when ready.
_MODEL_PATH = Path(os.getenv("YOLO_MODEL_PATH", "models/card_detector.pt"))

# Loaded lazily on first detect call — None until model file exists.
_yolo_model = None

# TCG portrait card W/H ≈ 0.716. Allow ±25% for camera angle / slight tilt.
_ASPECT_MIN = 0.50
_ASPECT_MAX = 0.95
_MIN_AREA_FRAC = 0.010
_MAX_AREA_FRAC = 0.90
_MAX_CARD_AREA_FRAC = 0.12


def _get_yolo_model():
    global _yolo_model
    if _yolo_model is not None:
        return _yolo_model
    if not _MODEL_PATH.exists():
        return None
    try:
        from ultralytics import YOLO
        _yolo_model = YOLO(str(_MODEL_PATH))
        logger.info("Loaded YOLO model from %s", _MODEL_PATH)
    except Exception:
        logger.exception("Failed to load YOLO model — falling back to OpenCV")
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

    Uses YOLO when models/card_detector.pt exists, OpenCV contour detection otherwise.
    """
    model = _get_yolo_model()
    if model is not None:
        return _detect_yolo(image_base64, model, max_cards)
    logger.info("No YOLO model found at %s — using OpenCV fallback", _MODEL_PATH)
    return _detect_opencv(image_base64, max_cards)


# ---------------------------------------------------------------------------
# YOLO detection
# ---------------------------------------------------------------------------

def _detect_yolo(
    image_base64: str,
    model,
    max_cards: int,
) -> tuple[list[dict], int, int]:
    img_bytes = base64.b64decode(image_base64)
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    h, w = img.shape[:2]

    results = model(img, conf=0.25, iou=0.45, verbose=False)
    boxes: list[dict] = []
    for result in results:
        for box in result.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            bw, bh = int(x2 - x1), int(y2 - y1)
            conf = float(box.conf[0])
            logger.info(
                "YOLO box: (%d,%d,%d,%d) conf=%.2f",
                int(x1), int(y1), bw, bh, conf,
            )
            boxes.append({"left": int(x1), "top": int(y1), "width": bw, "height": bh})

    logger.info("YOLO detect: image=%dx%d boxes=%d", w, h, len(boxes))
    boxes = _sort_boxes(boxes, h)
    return boxes[:max_cards], w, h


# ---------------------------------------------------------------------------
# OpenCV contour detection (fallback until fine-tuned model is available)
# ---------------------------------------------------------------------------

def _detect_opencv(
    image_base64: str,
    max_cards: int,
) -> tuple[list[dict], int, int]:
    img_bytes = base64.b64decode(image_base64)
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    h, w = img.shape[:2]
    total_area = w * h

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)
    thresh = cv2.adaptiveThreshold(
        blurred, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        blockSize=21,
        C=4,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=1)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    logger.info("OpenCV detect: image=%dx%d contours=%d", w, h, len(contours))

    raw_boxes: list[dict] = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        area_frac = area / total_area
        if area_frac < _MIN_AREA_FRAC or area_frac > _MAX_AREA_FRAC:
            continue

        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        rx, ry, rw, rh = cv2.boundingRect(approx)

        if rh == 0:
            continue
        aspect = rw / rh

        if _ASPECT_MIN <= aspect <= _ASPECT_MAX and area_frac <= _MAX_CARD_AREA_FRAC:
            if len(approx) not in (4, 5):
                solidity = area / (rw * rh)
                if solidity < 0.75:
                    continue
            logger.info("  accept: box=(%d,%d,%d,%d) aspect=%.2f area_frac=%.3f", rx, ry, rw, rh, aspect, area_frac)
            raw_boxes.append({"left": rx, "top": ry, "width": rw, "height": rh, "_area": rw * rh})
        else:
            split = _try_split_box(rx, ry, rw, rh, total_area, w, h)
            raw_boxes.extend(split)

    boxes = _nms(raw_boxes, iou_threshold=0.5)
    logger.info("OpenCV detect: raw_boxes=%d after_nms=%d", len(raw_boxes), len(boxes))

    clean = [{"left": b["left"], "top": b["top"], "width": b["width"], "height": b["height"]}
             for b in boxes]
    clean = _sort_boxes(clean, h)
    return clean[:max_cards], w, h


def _sort_boxes(boxes: list[dict], img_h: int) -> list[dict]:
    row_h = max(1, int(img_h * 0.25))
    return sorted(boxes, key=lambda b: (b["top"] // row_h, b["left"]))


def _try_split_box(
    rx: int, ry: int, rw: int, rh: int,
    total_area: int, img_w: int, img_h: int,
    depth: int = 0,
) -> list[dict]:
    if depth >= 3:
        return []
    if rh == 0:
        return []
    aspect = rw / rh

    if _ASPECT_MIN <= aspect <= _ASPECT_MAX:
        area_frac = (rw * rh) / total_area
        if area_frac >= _MIN_AREA_FRAC:
            return [{"left": rx, "top": ry, "width": rw, "height": rh, "_area": rw * rh}]
        return []

    if (rw * rh) / total_area < _MIN_AREA_FRAC:
        return []

    single_card_max_w = img_w * 0.40

    if aspect > _ASPECT_MAX:
        if rw <= single_card_max_w:
            expected_h = min(int(rw / 0.71), img_h - ry)
            if expected_h > rh:
                return _try_split_box(rx, ry, rw, expected_h, total_area, img_w, img_h, depth + 1)
            return []
        else:
            half = rw // 2
            results = _try_split_box(rx, ry, half, rh, total_area, img_w, img_h, depth + 1)
            results += _try_split_box(rx + half, ry, rw - half, rh, total_area, img_w, img_h, depth + 1)
            return results
    else:
        half = rh // 2
        results = _try_split_box(rx, ry, rw, half, total_area, img_w, img_h, depth + 1)
        results += _try_split_box(rx, ry + half, rw, rh - half, total_area, img_w, img_h, depth + 1)
        return results


def _nms(boxes: list[dict], iou_threshold: float) -> list[dict]:
    boxes = sorted(boxes, key=lambda b: -b["_area"])
    kept: list[dict] = []
    for box in boxes:
        if all(_iou(box, k) < iou_threshold and _containment(box, k) < 0.7 for k in kept):
            kept.append(box)
    return kept


def _containment(small: dict, large: dict) -> float:
    ax1, ay1 = small["left"], small["top"]
    ax2, ay2 = ax1 + small["width"], ay1 + small["height"]
    bx1, by1 = large["left"], large["top"]
    bx2, by2 = bx1 + large["width"], by1 + large["height"]
    ix = max(0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    area = small["width"] * small["height"]
    return inter / area if area > 0 else 0.0


def _iou(a: dict, b: dict) -> float:
    ax1, ay1 = a["left"], a["top"]
    ax2, ay2 = ax1 + a["width"], ay1 + a["height"]
    bx1, by1 = b["left"], b["top"]
    bx2, by2 = bx1 + b["width"], by1 + b["height"]
    ix = max(0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0
