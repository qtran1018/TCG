"""
Japanese card image lookup.

Primary source: TCGCollector.com scrape (backend/app/data/tcgcollector_ja.json)
  Format: list of {name_en, set_name, card_number, set_total, image_url, card_id}
  Covers: all Japanese sets from 1996 → present (~27k cards)

Fallback: pokemon-card.com scrape (backend/app/data/ja_images.json)
  Format: {kana_name: [{pg, image_url, card_order}]}
  Covers: Scarlet & Violet era only (~6.8k entries)

Lookup inputs (from Japanese card OCR):
  kana_name  — longest katakana sequence from OCR (e.g. "スイクン")
  card_number — numerator from OCR card number (e.g. "172" from "172/742"), optional
  set_total   — denominator from OCR card number (e.g. 742), optional

Lookup strategy:
  1. Translate kana_name → English name via kana_to_english mapping
  2. Find TCGCollector entries where name_en matches (case-insensitive)
  3. If set_total provided: prefer entries whose set_total matches
  4. If card_number also provided: further filter to matching card_number
  5. Fallback to pokemon-card.com data (kana_name + set_total match)
  6. Final fallback: first TCGCollector entry for the name (newest to oldest)
"""

import json
import logging
import re
from pathlib import Path

from app.data.pokemon_names import kana_to_english

log = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).parent.parent / "data"

# --- TCGCollector index ---
# name_en_lower → list of entries sorted newest-first (approximated by reverse insertion)
_tcg_by_name: dict[str, list[dict]] | None = None

# --- pokemon-card.com fallback data ---
_pc_sets: dict[str, dict] | None = None
_pc_images: dict[str, list] | None = None
_pc_total_to_pgs: dict[int, list[str]] | None = None

_loaded = False


def _normalize_name(name: str) -> str:
    """Lowercase, collapse whitespace, strip punctuation for fuzzy match."""
    name = name.lower().strip()
    # Remove trailing form suffixes that don't appear in OCR translations
    # e.g. "erika's bulbasaur" → we only have "bulbasaur" from kana
    return name


def _load() -> None:
    global _tcg_by_name, _pc_sets, _pc_images, _pc_total_to_pgs, _loaded

    # Load TCGCollector data
    tcg_path = _DATA_DIR / "tcgcollector_ja.json"
    if tcg_path.exists():
        entries: list[dict] = json.loads(tcg_path.read_text(encoding="utf-8"))
        _tcg_by_name = {}
        for entry in reversed(entries):  # reversed → newest page first
            key = (entry.get("name_en") or "").lower().strip()
            if key:
                _tcg_by_name.setdefault(key, []).append(entry)
        log.info(
            "Loaded TCGCollector data: %d entries, %d unique EN names",
            len(entries),
            len(_tcg_by_name),
        )
    else:
        _tcg_by_name = {}
        log.warning(
            "TCGCollector data not found at %s — run scripts/scrape_tcgcollector.py",
            tcg_path,
        )

    # Load pokemon-card.com fallback data
    sets_path = _DATA_DIR / "ja_sets.json"
    imgs_path = _DATA_DIR / "ja_images.json"
    if sets_path.exists() and imgs_path.exists():
        _pc_sets = json.loads(sets_path.read_text(encoding="utf-8"))
        _pc_images = json.loads(imgs_path.read_text(encoding="utf-8"))
        _pc_total_to_pgs = {}
        for pg, info in _pc_sets.items():
            t = info.get("total", 0)
            if t > 0:
                _pc_total_to_pgs.setdefault(t, []).append(pg)
        log.info(
            "Loaded pokemon-card.com fallback: %d sets, %d kana names",
            len(_pc_sets),
            len(_pc_images),
        )
    else:
        _pc_sets = {}
        _pc_images = {}
        _pc_total_to_pgs = {}

    _loaded = True


def _ensure_loaded() -> None:
    if not _loaded:
        _load()


# ─────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────

def find_ja_image(
    kana_name: str,
    set_total: int | None = None,
    card_number: str | None = None,
) -> str | None:
    """
    Return the best Japanese card image URL for a kana-name OCR result.

    kana_name   — katakana string from OCR (e.g. "スイクン")
    set_total   — set denominator from OCR (e.g. 742 from "172/742"), used for disambiguation
    card_number — card number numerator from OCR (e.g. "172"), used for disambiguation
    """
    _ensure_loaded()
    if not kana_name:
        return None

    # Translate kana → English name
    name_en = kana_to_english(kana_name)
    if not name_en:
        return None

    name_key = name_en.lower().strip()

    # ── TCGCollector lookup ──────────────────────────────────────────────────
    if _tcg_by_name:
        candidates = _tcg_by_name.get(name_key, [])

        if candidates:
            # 1. Prefer entries where both set_total and card_number match
            if set_total and card_number:
                cn_norm = str(int(card_number)) if card_number.isdigit() else card_number
                exact = [
                    c for c in candidates
                    if c.get("set_total") == set_total and c.get("card_number") == cn_norm
                ]
                if exact:
                    return exact[0]["image_url"]

            # 2. Prefer entries where set_total matches
            if set_total:
                by_total = [c for c in candidates if c.get("set_total") == set_total]
                if by_total:
                    # If card_number available, further filter
                    if card_number:
                        cn_norm = str(int(card_number)) if card_number.isdigit() else card_number
                        by_num = [c for c in by_total if c.get("card_number") == cn_norm]
                        if by_num:
                            return by_num[0]["image_url"]
                    return by_total[0]["image_url"]

            # 3. Prefer entries where card_number matches (any set)
            if card_number:
                cn_norm = str(int(card_number)) if card_number.isdigit() else card_number
                by_num = [c for c in candidates if c.get("card_number") == cn_norm]
                if by_num:
                    return by_num[0]["image_url"]

            # 4. Return first entry (scrape order: newest page first → most recent set)
            return candidates[0]["image_url"]

    # ── pokemon-card.com fallback (SV era) ──────────────────────────────────
    if _pc_images:
        pc_candidates = _pc_images.get(kana_name, [])
        if pc_candidates:
            if set_total and set_total > 0 and _pc_total_to_pgs:
                matching_pgs = set(_pc_total_to_pgs.get(set_total, []))
                if matching_pgs:
                    filtered = [c for c in pc_candidates if c["pg"] in matching_pgs]
                    if filtered:
                        return min(filtered, key=lambda c: c["card_order"])["image_url"]
            return pc_candidates[0]["image_url"]

    return None


def find_ja_image_by_name_en(
    name_en: str,
    set_total: int | None = None,
    card_number: str | None = None,
    strict: bool = False,
) -> str | None:
    """
    Like find_ja_image but takes an English name directly (skips kana translation).
    Used when kana_name is unavailable (e.g. navigating from history).

    strict=True: if set_total/card_number are provided but no entry matches,
    return None instead of falling back to first-by-name. Use for swap-candidate
    lookups where the wrong art is worse than the EN art.
    """
    _ensure_loaded()
    if not name_en:
        return None

    name_key = name_en.lower().strip()

    if _tcg_by_name:
        candidates = _tcg_by_name.get(name_key, [])
        if candidates:
            if set_total and card_number:
                cn_norm = str(int(card_number)) if card_number.isdigit() else card_number
                exact = [
                    c for c in candidates
                    if c.get("set_total") == set_total and c.get("card_number") == cn_norm
                ]
                if exact:
                    return exact[0]["image_url"]

            if set_total:
                by_total = [c for c in candidates if c.get("set_total") == set_total]
                if by_total:
                    if card_number:
                        cn_norm = str(int(card_number)) if card_number.isdigit() else card_number
                        by_num = [c for c in by_total if c.get("card_number") == cn_norm]
                        if by_num:
                            return by_num[0]["image_url"]
                    return by_total[0]["image_url"]

            if card_number:
                cn_norm = str(int(card_number)) if card_number.isdigit() else card_number
                by_num = [c for c in candidates if c.get("card_number") == cn_norm]
                if by_num:
                    return by_num[0]["image_url"]

            if strict and (set_total or card_number):
                return None

            return candidates[0]["image_url"]

    return None


def find_all_ja_images(kana_name: str) -> list[str]:
    """Return all known Japanese image URLs for a kana name, newest set first."""
    _ensure_loaded()
    if not kana_name:
        return []

    name_en = kana_to_english(kana_name)
    results: list[str] = []

    if name_en and _tcg_by_name:
        results = [c["image_url"] for c in _tcg_by_name.get(name_en.lower().strip(), [])]

    if not results and _pc_images:
        results = [c["image_url"] for c in _pc_images.get(kana_name, [])]

    return results
