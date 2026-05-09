import json
from pathlib import Path

_DATA_DIR = Path(__file__).parent

# Kana → English, e.g. "フシギダネ" → "Bulbasaur"
# Loaded once at import time (~1028 entries, negligible memory).
with open(_DATA_DIR / "pokemon_kana_to_en.json", encoding="utf-8") as _f:
    KANA_TO_EN: dict[str, str] = json.load(_f)


def kana_to_english(kana: str) -> str | None:
    """Return the English name for a kana Pokemon name, or None if not found."""
    return KANA_TO_EN.get(kana)
