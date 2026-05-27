import asyncio
import logging

from fastapi import APIRouter, HTTPException

from app.schemas.card import BoundingBox, DetectRequest, DetectResult
from app.services.card_detector import detect_card_rectangles

router = APIRouter(prefix="/detect", tags=["detect"])
logger = logging.getLogger(__name__)


@router.post("", response_model=DetectResult)
async def detect_cards(req: DetectRequest):
    try:
        # Run YOLO + image decode off the event loop — both are CPU-bound.
        boxes, img_w, img_h = await asyncio.to_thread(
            detect_card_rectangles, req.image_base64, req.max_cards,
        )
    except Exception:
        logger.exception("detect_cards failed")
        raise HTTPException(status_code=500, detail="Detection failed")
    return DetectResult(
        boxes=[BoundingBox(**b) for b in boxes],
        image_width=img_w,
        image_height=img_h,
    )
