import logging
from itertools import count

from fastapi import APIRouter, HTTPException

from app.schemas.card import BoundingBox, DetectRequest, DetectResult
from app.services.card_detector import detect_card_rectangles

router = APIRouter(prefix="/detect", tags=["detect"])
logger = logging.getLogger(__name__)
_scan_counter = count(1)


@router.post("", response_model=DetectResult)
async def detect_cards(req: DetectRequest):
    scan_id = next(_scan_counter)
    logger.info("=" * 60)
    logger.info("SCAN #%d", scan_id)
    logger.info("=" * 60)
    try:
        boxes, img_w, img_h = detect_card_rectangles(req.image_base64, req.max_cards)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Detection failed: {e}")
    return DetectResult(
        boxes=[BoundingBox(**b) for b in boxes],
        image_width=img_w,
        image_height=img_h,
    )
