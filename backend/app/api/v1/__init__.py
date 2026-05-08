from fastapi import APIRouter
from app.api.v1 import search, cards, psa

router = APIRouter(prefix="/v1")
router.include_router(search.router)
router.include_router(cards.router)
router.include_router(psa.router)
