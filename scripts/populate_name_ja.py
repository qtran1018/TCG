"""
Populate cards.name_ja with katakana names for Pokémon cards.

Source: backend/app/data/pokemon_names_ja.json  [{ndex, english, kana}]

Matching rules (strict):
  1. Exact name match only (case-insensitive)
  2. Name starts with the base Pokémon name + known card suffix
     (VMAX, VSTAR, V, ex, GX, EX, V-UNION) — covers "Charizard VMAX", "Charizard-GX"
  3. Excludes Tag Team cards (name contains " & ")
  4. Excludes regional forms from the base pass — handled separately below

Regional forms (second pass, programmatic):
  Alolan   → アローラ + base kana   e.g. "Alolan Vulpix"  → アローラロコン
  Galarian  → ガラル + base kana    e.g. "Galarian Rapidash" → ガラルギャロップ
  Hisuian   → ヒスイ + base kana    e.g. "Hisuian Zoroark"  → ヒスイゾロアーク
  Paldean   → パルデア + base kana   e.g. "Paldean Clodsire" → パルデアヌメルゴン

Run inside the backend container:
  docker exec tcg_backend sh -c "python /scripts/populate_name_ja.py"
"""

import asyncio
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, "/app")

from sqlalchemy import text
from app.database import engine

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATA_PATH = Path("/app/app/data/pokemon_names_ja.json")

REGIONAL_PREFIXES = [
    ("Alolan",   "アローラ"),
    ("Galarian",  "ガラル"),
    ("Hisuian",  "ヒスイ"),
    ("Paldean",  "パルデア"),
]

# Recognized card variant suffixes after the base Pokémon name.
# The regex matches: base_name + optional_suffix (end of string).
# NOT matched: "Raichu & Alolan Raichu-GX" (Tag Team — excluded by the & filter)
SUFFIX_PATTERN = r"^{name}(\s+(VMAX|VSTAR|V-UNION|ex|V)|-GX|-EX)?$"


async def main() -> None:
    entries: list[dict] = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    log.info("Loaded %d base entries from pokemon_names_ja.json", len(entries))

    # Build en→kana lookup for regional form generation
    en_to_kana: dict[str, str] = {e["english"]: e["kana"] for e in entries}

    async with engine.begin() as conn:
        # ── Clear existing name_ja for Pokemon cards ─────────────────────────
        cleared = await conn.execute(text(
            "UPDATE cards SET name_ja = NULL WHERE game = 'pokemon'"
        ))
        log.info("Cleared name_ja on %d pokemon cards", cleared.rowcount)

        updated_total = 0

        # ── Pass 1: base Pokémon names + their card variants ─────────────────
        for entry in entries:
            english = entry["english"]
            kana = entry["kana"]
            pattern = SUFFIX_PATTERN.format(name=english.replace(".", r"\."))

            result = await conn.execute(
                text("""
                    UPDATE cards
                    SET name_ja = :kana
                    WHERE game = 'pokemon'
                      AND name_ja IS NULL
                      AND name NOT LIKE '% & %'
                      AND name ~* :pattern
                """),
                {"kana": kana, "pattern": pattern},
            )
            if result.rowcount > 0:
                updated_total += result.rowcount
                log.info("%-25s -> %-15s  (%d rows)", english, kana, result.rowcount)

        log.info("Pass 1 complete: %d rows updated", updated_total)

        # ── Pass 2: regional forms ────────────────────────────────────────────
        regional_total = 0
        for prefix_en, prefix_kana in REGIONAL_PREFIXES:
            for base_en, base_kana in en_to_kana.items():
                regional_en = f"{prefix_en} {base_en}"
                regional_kana = f"{prefix_kana}{base_kana}"
                pattern = SUFFIX_PATTERN.format(
                    name=regional_en.replace(".", r"\.")
                )

                result = await conn.execute(
                    text("""
                        UPDATE cards
                        SET name_ja = :kana
                        WHERE game = 'pokemon'
                          AND name_ja IS NULL
                          AND name NOT LIKE '% & %'
                          AND name ~* :pattern
                    """),
                    {"kana": regional_kana, "pattern": pattern},
                )
                if result.rowcount > 0:
                    regional_total += result.rowcount
                    log.info(
                        "  %-30s -> %-20s  (%d rows)",
                        regional_en, regional_kana, result.rowcount,
                    )

        log.info("Pass 2 (regional) complete: %d rows updated", regional_total)
        updated_total += regional_total

        # ── Summary ───────────────────────────────────────────────────────────
        row = await conn.execute(text(
            "SELECT COUNT(*) FROM cards WHERE game='pokemon' AND name_ja IS NOT NULL"
        ))
        populated = row.scalar()

        row2 = await conn.execute(text(
            "SELECT COUNT(*) FROM cards WHERE game='pokemon' AND name_ja IS NULL"
        ))
        nulls = row2.scalar()

        log.info("Done. Total rows updated: %d", updated_total)
        log.info("name_ja populated: %d  |  still null: %d", populated, nulls)

        # Sample of remaining nulls (expected: trainers, tag teams, gym leader cards)
        sample = await conn.execute(text(
            "SELECT name FROM cards WHERE game='pokemon' AND name_ja IS NULL ORDER BY name LIMIT 30"
        ))
        log.info("Sample nulls: %s", [r[0] for r in sample])

        # Sanity-check: make sure Tag Teams were NOT filled
        tag_teams_filled = await conn.execute(text(
            "SELECT name, name_ja FROM cards WHERE game='pokemon' AND name LIKE '% & %' AND name_ja IS NOT NULL LIMIT 5"
        ))
        rows = tag_teams_filled.all()
        if rows:
            log.warning("Tag Team cards incorrectly filled: %s", rows)
        else:
            log.info("Sanity check passed: no Tag Team cards have name_ja set")


asyncio.run(main())
