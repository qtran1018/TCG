import base64
import logging

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# TCG portrait card W/H ≈ 0.716. Allow ±25% for camera angle / slight tilt.
_ASPECT_MIN = 0.50
_ASPECT_MAX = 0.95
_MIN_AREA_FRAC = 0.010  # card must cover ≥1% of image area
_MAX_AREA_FRAC = 0.90        # reject detections that fill nearly the whole frame
_MAX_CARD_AREA_FRAC = 0.12   # single card should cover ≤12% of image; larger = merged multi-card


def detect_card_rectangles(
    image_base64: str,
    max_cards: int = 10,
) -> tuple[list[dict], int, int]:
    """
    Returns (boxes, image_width, image_height).
    boxes is a list of {left, top, width, height} dicts in image-pixel coordinates,
    sorted left→right within rows, then top→bottom.
    """
    img_bytes = base64.b64decode(image_base64)
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    h, w = img.shape[:2]
    total_area = w * h

    # CLAHE boosts local contrast before thresholding — helps holo/foil cards
    # whose reflective surface creates uneven brightness that breaks border detection.
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
    # Close small gaps in card border lines — keep kernel small to avoid bridging
    # the gap between adjacent cards (which would merge their contours).
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=1)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    logger.info("detect: image=%dx%d contours=%d", w, h, len(contours))

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
            # For non-4/5-sided contours, require high solidity (must look like a filled rect)
            if len(approx) not in (4, 5):
                solidity = area / (rw * rh)
                if solidity < 0.75:
                    logger.info("  skip low-solidity: box=(%d,%d,%d,%d) aspect=%.2f solidity=%.2f", rx, ry, rw, rh, aspect, solidity)
                    continue
            logger.info("  accept: box=(%d,%d,%d,%d) aspect=%.2f area_frac=%.3f", rx, ry, rw, rh, aspect, area_frac)
            raw_boxes.append({"left": rx, "top": ry, "width": rw, "height": rh, "_area": rw * rh})
        else:
            # Contour failed aspect ratio OR is too large to be a single card — try split/extend.
            logger.info("  split: box=(%d,%d,%d,%d) aspect=%.2f area_frac=%.3f", rx, ry, rw, rh, aspect, area_frac)
            split = _try_split_box(rx, ry, rw, rh, total_area, w, h)
            raw_boxes.extend(split)

    boxes = _nms(raw_boxes, iou_threshold=0.5)
    logger.info("detect: raw_boxes=%d after_nms=%d", len(raw_boxes), len(boxes))

    # Sort: left→right within row bands, then top→bottom
    row_h = max(1, int(h * 0.25))
    boxes.sort(key=lambda b: (b["top"] // row_h, b["left"]))

    return (
        [{"left": b["left"], "top": b["top"], "width": b["width"], "height": b["height"]}
         for b in boxes[:max_cards]],
        w,
        h,
    )


def _try_split_box(
    rx: int, ry: int, rw: int, rh: int,
    total_area: int, img_w: int, img_h: int,
    depth: int = 0,
) -> list[dict]:
    """Recover card-sized regions from a bounding box that failed the aspect ratio filter.

    Two cases:
    - Too wide (aspect > _ASPECT_MAX) AND wider than a single card → two cards merged side-by-side → split at midpoint.
    - Too wide AND card-sized width → card border was only partially detected (bottom cut off) → extend height.
    - Too tall (aspect < _ASPECT_MIN) → two cards merged vertically → split at midpoint.
    """
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

    # A single card occupies roughly 15–40% of the image width.
    single_card_max_w = img_w * 0.40

    if aspect > _ASPECT_MAX:
        if rw <= single_card_max_w:
            # Card-sized width but box is too short — partial border detection.
            # Extend height to match the expected portrait card ratio.
            expected_h = min(int(rw / 0.71), img_h - ry)
            if expected_h > rh:
                return _try_split_box(rx, ry, rw, expected_h, total_area, img_w, img_h, depth + 1)
            return []
        else:
            # Wider than a single card — two (or more) cards side by side, split at midpoint.
            half = rw // 2
            results = _try_split_box(rx, ry, half, rh, total_area, img_w, img_h, depth + 1)
            results += _try_split_box(rx + half, ry, rw - half, rh, total_area, img_w, img_h, depth + 1)
            return results
    else:
        # Too tall — cards stacked vertically, split at midpoint.
        half = rh // 2
        results = _try_split_box(rx, ry, rw, half, total_area, img_w, img_h, depth + 1)
        results += _try_split_box(rx, ry + half, rw, rh - half, total_area, img_w, img_h, depth + 1)
        return results


def _nms(boxes: list[dict], iou_threshold: float) -> list[dict]:
    """Keep the larger box when two boxes overlap heavily or one contains the other."""
    boxes = sorted(boxes, key=lambda b: -b["_area"])
    kept: list[dict] = []
    for box in boxes:
        if all(_iou(box, k) < iou_threshold and _containment(box, k) < 0.7 for k in kept):
            kept.append(box)
    return kept


def _containment(small: dict, large: dict) -> float:
    """Fraction of `small` that is covered by `large`."""
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
