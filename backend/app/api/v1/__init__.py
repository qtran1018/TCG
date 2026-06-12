from fastapi import APIRouter
from app.api.v1 import cards, psa, detect, scan, currency, assets

router = APIRouter(prefix="/v1")
router.include_router(cards.router)
router.include_router(psa.router)
router.include_router(detect.router)
router.include_router(scan.router)
router.include_router(currency.router)
router.include_router(assets.router)
