"""
Populate cards.name_ja with katakana names for Pokémon cards.

Source: backend/app/data/pokemon_names_ja.json  [{ndex, english, kana}]

Matching rules (strict):
  1. Exact name match only (case-insensitive)
  2. Name starts with the base Pokémon name + known card suffix
     (VMAX, VSTAR, V, ex, GX, EX, V-UNION, BREAK) — covers "Charizard VMAX", "Arcanine BREAK"
  3. Excludes Tag Team cards (name contains " & ")
  4. Excludes regional/special forms from the base pass — handled separately below

Regional forms (pass 2, programmatic):
  Alolan   → アローラ + base kana   e.g. "Alolan Vulpix"  → アローラロコン
  Galarian  → ガラル + base kana    e.g. "Galarian Rapidash" → ガラルギャロップ
  Hisuian   → ヒスイ + base kana    e.g. "Hisuian Zoroark"  → ヒスイゾロアーク
  Paldean   → パルデア + base kana   e.g. "Paldean Clodsire" → パルデアヌメルゴン

Mega forms (pass 3):
  "M {name}-EX" → M + base kana    e.g. "M Charizard-EX"  → Mリザードン

Radiant Pokémon (pass 4):
  "Radiant {name}" → かがやく + base kana  e.g. "Radiant Charizard" → かがやくリザードン

Origin Forme (pass 5):
  "Origin Forme {name} V/VSTAR" → オリジンフォルム + base kana  e.g. → オリジンフォルムディアルガ

Standalone Trainers (pass 6):
  Exact name match for gym leaders, rivals, professors, etc.
  e.g. "Cynthia" → シロナ, "Professor Oak" → オーキド博士

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
SUFFIX_PATTERN = r"^{name}(\s+(VMAX|VSTAR|V-UNION|ex|V|BREAK)|-GX|-EX)?$"


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

        # ── Pass 3: Mega (M prefix) forms ─────────────────────────────────────
        # "M Charizard-EX" → Mリザードン  (M prefix stays as-is in JP TCG)
        mega_total = 0
        for base_en, base_kana in en_to_kana.items():
            result = await conn.execute(
                text("""
                    UPDATE cards
                    SET name_ja = :kana
                    WHERE game = 'pokemon'
                      AND name_ja IS NULL
                      AND name = :en_name
                """),
                {"kana": f"M{base_kana}", "en_name": f"M {base_en}-EX"},
            )
            if result.rowcount > 0:
                mega_total += result.rowcount
                log.info("  M %-22s -> %-20s  (%d rows)", base_en, f"M{base_kana}", result.rowcount)

        log.info("Pass 3 (Mega) complete: %d rows updated", mega_total)
        updated_total += mega_total

        # ── Pass 4: Radiant Pokémon ───────────────────────────────────────────
        # "Radiant Charizard" → かがやくリザードン  (かがやく = radiant/shining in JP TCG)
        radiant_total = 0
        for base_en, base_kana in en_to_kana.items():
            result = await conn.execute(
                text("""
                    UPDATE cards
                    SET name_ja = :kana
                    WHERE game = 'pokemon'
                      AND name_ja IS NULL
                      AND name = :en_name
                """),
                {"kana": f"かがやく{base_kana}", "en_name": f"Radiant {base_en}"},
            )
            if result.rowcount > 0:
                radiant_total += result.rowcount
                log.info("  Radiant %-20s -> %-20s  (%d rows)", base_en, f"かがやく{base_kana}", result.rowcount)

        log.info("Pass 4 (Radiant) complete: %d rows updated", radiant_total)
        updated_total += radiant_total

        # ── Pass 5: Origin Forme (Dialga, Palkia) ────────────────────────────
        # "Origin Forme Dialga VSTAR" → オリジンフォルムディアルガ
        origin_names = ["Dialga", "Palkia"]
        origin_total = 0
        for base_en in origin_names:
            base_kana = en_to_kana.get(base_en)
            if not base_kana:
                continue
            for suffix in ["V", "VSTAR"]:
                result = await conn.execute(
                    text("""
                        UPDATE cards
                        SET name_ja = :kana
                        WHERE game = 'pokemon'
                          AND name_ja IS NULL
                          AND name = :en_name
                    """),
                    {
                        "kana": f"オリジンフォルム{base_kana}",
                        "en_name": f"Origin Forme {base_en} {suffix}",
                    },
                )
                if result.rowcount > 0:
                    origin_total += result.rowcount
                    log.info("  Origin Forme %-15s -> %-25s  (%d rows)", f"{base_en} {suffix}", f"オリジンフォルム{base_kana}", result.rowcount)

        log.info("Pass 5 (Origin Forme) complete: %d rows updated", origin_total)
        updated_total += origin_total

        # ── Pass 6: Standalone Trainer cards ─────────────────────────────────
        # Exact name match only — covers gym leaders, rivals, professors, etc.
        TRAINER_NAMES: dict[str, str] = {
            # Kanto
            "Brock": "タケシ", "Misty": "カスミ", "Lt. Surge": "マチス",
            "Erika": "エリカ", "Koga": "キョウ", "Janine": "アンズ",
            "Sabrina": "ナツメ", "Blaine": "カツラ", "Giovanni": "サカキ",
            "Bill": "マサキ", "Copycat": "イミテ", "AZ": "AZ",
            # Johto
            "Falkner": "ハヤト", "Whitney": "アカネ", "Morty": "マツバ",
            "Jasmine": "ミカン", "Will": "イツキ", "Karen": "カリン",
            "Lance": "ワタル", "Bruno": "シバ", "Agatha": "キクコ",
            # Hoenn
            "Roxanne": "ツツジ", "Brawly": "トウキ", "Flannery": "アスナ",
            "Norman": "センリ", "Winona": "ナギ", "Wallace": "ミクリ",
            "Steven": "ダイゴ", "Archie": "アオギリ", "Maxie": "マツブサ",
            # Sinnoh
            "Roark": "ヒョウタ", "Gardenia": "ナタネ", "Fantina": "メリッサ",
            "Candice": "スズナ", "Volkner": "デンジ", "Lucian": "ゴヨウ",
            "Cynthia": "シロナ", "Dawn": "ヒカリ", "Lucas": "コウキ",
            # Unova
            "Cheren": "チェレン", "Elesa": "カミツレ", "Clay": "ヤーコン",
            "Skyla": "フウロ", "Shauntal": "シキミ", "Grimsley": "ギーマ",
            "Caitlin": "カトレア", "N": "N", "Ghetsis": "ゲーチス",
            "Bianca": "ベル", "Cilan": "デント", "Iris": "アイリス",
            "Roxie": "ホミカ", "Hugh": "ヒュウ", "Colress": "アクロマ",
            "Looker": "ハンサム",
            # Kalos
            "Grant": "ザクロ", "Korrina": "コルニ", "Clemont": "シトロン",
            "Olympia": "パキラ", "Siebold": "ズミ", "Drasna": "ドラセナ",
            "Diantha": "カルネ", "Lysandre": "フラダリ", "Shauna": "サナ",
            "Tierno": "ティエルノ", "Trevor": "トロバ",
            # Alola
            "Ilima": "イリマ", "Lana": "スイレン", "Kiawe": "カキ",
            "Mallow": "マオ", "Sophocles": "マーマネ", "Acerola": "アセロラ",
            "Hapu": "ハプウ", "Hala": "ハラ", "Olivia": "ライチ",
            "Nanu": "ナギサ", "Lusamine": "ルザミーネ", "Gladion": "グラジオ",
            "Lillie": "リーリエ", "Hau": "ハウ",
            # Galar
            "Milo": "ヤロー", "Nessa": "ルリナ", "Kabu": "カブ",
            "Bea": "サイトウ", "Allister": "オニオン", "Opal": "ポプラ",
            "Gordie": "マクワ", "Melony": "メロン", "Piers": "ネズ",
            "Raihan": "キバナ", "Oleana": "オリーヴ", "Marnie": "マリィ",
            "Hop": "ホップ", "Sonia": "ソニア", "Leon": "ダンデ", "Rose": "ローズ",
            # Paldea
            "Katy": "ブジン", "Brassius": "コルサ", "Iono": "ナンジャモ",
            "Kofu": "ハイダイ", "Larry": "カエデ", "Ryme": "リップ",
            "Tulip": "ポピー", "Grusha": "グルーシャ", "Nemona": "ネモ",
            "Penny": "ペニー", "Arven": "ペパー", "Geeta": "グエナ",
            "Amarys": "アマリス", "Lacey": "ラクウス", "Drayton": "ドレイトン",
            "Kieran": "キアン",
            # Legends: Arceus
            "Adaman": "アダマン", "Irida": "イリダ", "Arezu": "アレズ",
            "Volo": "ヴォロ", "Cogita": "コギト",
            # Professors
            "Professor Oak": "オーキド博士", "Professor Elm": "ウツギ博士",
            "Professor Birch": "ボーチ博士", "Professor Rowan": "ナナカマド博士",
            "Professor Juniper": "アララギ博士", "Professor Sycamore": "プラタナ博士",
            "Professor Kukui": "ククイ博士", "Professor Burnet": "バーネット博士",
            "Professor Magnolia": "マグノリア博士", "Professor Willow": "ウィロー博士",
        }
        trainer_total = 0
        for en_name, ja_name in TRAINER_NAMES.items():
            result = await conn.execute(
                text("""
                    UPDATE cards
                    SET name_ja = :kana
                    WHERE game = 'pokemon'
                      AND name_ja IS NULL
                      AND name = :en_name
                """),
                {"kana": ja_name, "en_name": en_name},
            )
            if result.rowcount > 0:
                trainer_total += result.rowcount
                log.info("  %-25s -> %-20s  (%d rows)", en_name, ja_name, result.rowcount)

        log.info("Pass 6 (Trainers) complete: %d rows updated", trainer_total)
        updated_total += trainer_total

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
