from fastapi import APIRouter
from app.api.v1 import search, cards, psa, detect

router = APIRouter(prefix="/v1")
router.include_router(search.router)
router.include_router(cards.router)
router.include_router(psa.router)
router.include_router(detect.router)
