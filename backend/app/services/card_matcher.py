import hashlib
import json
import logging
import re
from pathlib import Path
from sqlalchemy import select, func, case
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.card import Card
from app.scrapers.pricecharting import PricechartingScraper
from app.scrapers.pokemon_tcg_api import PokemonTCGApiScraper
from app.scrapers.onepiece_api import OnePieceScraper
from app.services.cache import search_cache, price_cache
from app.config import get_settings
from app.data.pokemon_names import kana_to_english, KANA_TO_EN

_SET_PRINTED_TOTALS: dict[str, int] = {}
_lookup_path = Path(__file__).parent.parent / "data" / "set_printed_totals.json"
if _lookup_path.exists():
    _SET_PRINTED_TOTALS = json.loads(_lookup_path.read_text())

logger = logging.getLogger(__name__)
settings = get_settings()

POKEMON_SET_NUM_RE = re.compile(r"(\d{1,3})\s*/\s*(\d{1,3})")
ONEPIECE_CARD_NUM_RE = re.compile(r"(OP\d{2}-\d{3}|ST\d{2}-\d{3}|P-\d{3})", re.I)
HP_RE = re.compile(r"\bHP\s*(\d+)\b", re.I)
# Attack body text first words — if the line after a candidate name starts with
# one of these, the candidate is an attack name, not the card name.
_ATTACK_BODY_RE = re.compile(
    r"^(put|this\s+attack|your\s+opponent|you\s+may|flip|discard|search|draw|"
    r"choose|look\s+at|if\s+your|once\s+during|during\s+your|when\s+you|"
    r"attach|move|switch|return|heal|remove|each\s+of|both\s+player|"
    r"the\s+defending|does\s+\d+\s+damage)",
    re.I,
)

# Normalized English Pokémon base names for candidate validation.
# "Mr. Mime" → "mr mime", "Farfetch'd" → "farfetchd", etc.
def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()

_EN_POKEMON_NAMES_NORM: frozenset[str] = frozenset(_norm(n) for n in KANA_TO_EN.values())


def _contains_pokemon_name(text: str) -> bool:
    """Return True if text contains a known Pokémon base name as a whole token or bigram."""
    tokens = _norm(text).split()
    for i, tok in enumerate(tokens):
        if tok in _EN_POKEMON_NAMES_NORM:
            return True
        if i + 1 < len(tokens) and f"{tok} {tokens[i + 1]}" in _EN_POKEMON_NAMES_NORM:
            return True
    return False


# Terms that are never the card name.
# `.{0,2}as[in][cgsq]\w*` catches BASIC and its OCR misreads: any 0–2-char prefix
# (B→O/D/G/3/8/日/dropped) followed by ASIC/ASIG/ASIQ/ASNC/ASNG etc.
# Covers BASIC, OASIC, DASIC, GASIC, 3ASIC, 8ASIC, ASIC, ASIG, ASNG, etc.
_POKEMON_NON_NAME_RE = re.compile(
    r"^(.{0,2}as[in][cgsq]\w*|stage\s*[12]|mega|"
    r"weakness|resistance|retreat|damage|ability|trainer|item|"
    r"stadium|supporter|energy|water|fire|grass|lightning|psychic|"
    r"fighting|darkness|metal|fairy|colorless|dragon|"
    r"pok[eé]mon|nintendo|game\s*freak|creatures|illus\.?|no\.|"
    r"copyright|overrun|aurora|beam|hp)$",
    re.I,
)


def _find_pokemon_name(lines: list[str]) -> str | None:
    """Return the Pokémon name, anchored to the HP line.

    The card name sits on the same row as HP (or 1-2 lines before it).
    Attack names appear well after the HP line, so we stop searching there.
    """
    # Find the HP line — name must appear at or before it.
    hp_idx = next((i for i, l in enumerate(lines) if HP_RE.search(l)), None)
    # When HP is found, cap search at that line (name is always above/on it).
    # When HP is absent (misread or OCR ordering differs), search all lines —
    # attack-name guards below still reject flavour text and move names.
    end = min(hp_idx + 1, 6) if hp_idx is not None else len(lines)

    for i, line in enumerate(lines[:end]):
        # Strip an inline HP value ("Lotad HP 40" → "Lotad")
        clean = HP_RE.sub("", line).strip()
        if not clean:
            continue
        # Strip leading non-name tokens ("BASIC Lotad" → "Lotad")
        words = clean.split()
        while words and _POKEMON_NON_NAME_RE.match(words[0]):
            words = words[1:]
        clean = " ".join(words)
        if len(clean) < 3:
            continue
        words = clean.split()
        if not 1 <= len(words) <= 3:
            continue
        if any(c.isdigit() for c in clean):
            continue
        # Allow possessive apostrophe ("Misty's Staryu") — strip 's before punct check.
        clean_for_punct = re.sub(r"(?<=\w)'s\b", "", clean)
        if re.search(r"[.,!?;:()/\\']", clean_for_punct):
            continue
        if not clean[0].isupper():
            continue
        if clean.replace(" ", "").isupper() and len(clean) > 3:
            continue
        if any(_POKEMON_NON_NAME_RE.match(w) for w in words):
            continue
        # If the very next line is attack body text, this candidate is an attack
        # name leaking from an adjacent card's crop — skip it.
        if hp_idx is None and i + 1 < len(lines):
            if _ATTACK_BODY_RE.match(lines[i + 1].strip()):
                continue
        # Reject candidates that don't contain a known Pokémon base name.
        # Trainer/Supporter/Item cards fall through here — handled separately later.
        if not _contains_pokemon_name(clean):
            continue
        return clean
    return None


_TRAINER_TYPE_RE = re.compile(r"^(Trainer|Supporter|Item|Tool|Technical\s+Machine)$", re.I)


def _find_trainer_name(lines: list[str]) -> str | None:
    """Return the Trainer/Supporter/Item/Tool card name by locating the type keyword.

    Trainer cards have a standalone type line (e.g. "Supporter") with the card name
    1–2 lines above it.  Parenthetical subtitles (e.g. "(Professor Magnolia)") are
    stripped before validation.
    """
    for i, line in enumerate(lines):
        if not _TRAINER_TYPE_RE.match(line.strip()):
            continue
        # Check up to 2 lines above the type keyword for the name.
        for j in range(max(0, i - 2), i):
            candidate = lines[j].strip()
            # Strip parenthetical subtitle: "Boss's Orders (Ghetsis)" → "Boss's Orders"
            candidate = re.sub(r"\s*\([^)]*\)\s*$", "", candidate).strip()
            if not candidate or len(candidate) < 3:
                continue
            words = candidate.split()
            if len(words) > 5:
                continue
            if any(c.isdigit() for c in candidate):
                continue
            if not candidate[0].isupper():
                continue
            if candidate.replace(" ", "").isupper() and len(candidate) > 3:
                continue
            # Allow possessive apostrophe ("Professor's Research") — strip before punct check.
            clean_for_punct = re.sub(r"(?<=\w)'s\b", "", candidate)
            if re.search(r"[.,!?;:()/\\']", clean_for_punct):
                continue
            return candidate
    return None


# Japanese equivalents of BASIC / Stage 1 / Stage 2 that appear on card art
_JA_NON_NAME = frozenset(["たね", "1進化", "2進化", "ステージ1", "ステージ2"])

# JP trainer type keywords that appear as standalone lines on the card.
_JA_TRAINER_TYPE_RE = re.compile(r"^(グッズ|サポート|スタジアム|ポケモンのどうぐ)$")


def _find_jp_trainer_name(lines: list[str]) -> str | None:
    """Return the JP trainer/supporter/stadium card name.

    Mirrors EN _find_trainer_name: finds the standalone type keyword, then
    looks 1–2 lines above for the card name.  Strips JP parenthetical subtitles
    (「ボスの司令（ゲーチス）」→「ボスの司令」).
    """
    for i, line in enumerate(lines):
        if not _JA_TRAINER_TYPE_RE.match(line.strip()):
            continue
        for j in range(max(0, i - 2), i):
            candidate = lines[j].strip()
            # Strip JP parenthetical subtitle: full-width parens
            candidate = re.sub(r"\s*（[^）]*）\s*$", "", candidate).strip()
            # Also strip half-width parens used by some OCR outputs
            candidate = re.sub(r"\s*\([^)]*\)\s*$", "", candidate).strip()
            if not candidate or len(candidate) < 1:
                continue
            if _JA_TRAINER_TYPE_RE.match(candidate):
                continue
            # Must contain at least one kana or kanji character
            if not re.search(r"[ぁ-ゖ゠-ヿ一-鿿]", candidate):
                continue
            return candidate
    return None


def _find_kana_name(lines: list[str]) -> str | None:
    """Return the kana Pokémon name from OCR lines by lookup against the known kana dict."""
    # Exact line match first
    for line in lines:
        clean = line.strip()
        if clean in _JA_NON_NAME:
            continue
        if clean in KANA_TO_EN:
            return clean
    # Substring match — name may be embedded in a longer OCR line
    for line in lines:
        clean = line.strip()
        if clean in _JA_NON_NAME:
            continue
        for kana in KANA_TO_EN:
            if kana in clean:
                return kana
    return None


def extract_card_hints(ocr_text: str, game: str, language: str) -> dict:
    hints: dict = {"raw_text": ocr_text}
    lines = [l.strip() for l in ocr_text.split("\n") if l.strip()]

    if game == "pokemon":
        # Normalize common OCR digit substitutions before extracting card number.
        # 'o'/'O' before digits → '0' (e.g. "o24/131" → "024/131")
        # 'l'/'I' before digits → '1' (e.g. "l31" → "131")
        normalized = re.sub(r'(?<!\w)[oO](?=\d)', '0', ocr_text)
        normalized = re.sub(r'(?<!\w)[lI](?=\d)', '1', normalized)
        m = POKEMON_SET_NUM_RE.search(normalized)
        if m:
            hints["card_number"] = m.group(1).lstrip("0") or "0"
            hints["set_total"] = m.group(2).lstrip("0") or "0"
        hp = HP_RE.search(ocr_text)
        if hp:
            hints["hp"] = hp.group(1)
        if language == "ja":
            kana = _find_kana_name(lines)
            if kana:
                hints["kana_name"] = kana  # raw kana for name_ja exact match
                english = kana_to_english(kana)
                if english:
                    hints["probable_name"] = english
            else:
                ja_trainer = _find_jp_trainer_name(lines)
                if ja_trainer:
                    hints["ja_trainer_name"] = ja_trainer
        else:
            name = _find_pokemon_name(lines[:4])
            if not name:
                name = _find_trainer_name(lines)
            if name:
                hints["probable_name"] = name

    elif game == "onepiece":
        m = ONEPIECE_CARD_NUM_RE.search(ocr_text)
        if m:
            hints["card_number"] = m.group(1).upper()
        if lines:
            hints["probable_name"] = lines[0]

    return hints


def build_search_query(hints: dict, game: str, language: str) -> str:
    """Returns a human-readable label for the query (used in API response only)."""
    if "probable_name" in hints:
        name = hints["probable_name"]
        if "card_number" in hints:
            return f"{name} #{hints['card_number']}"
        return name
    if "ja_trainer_name" in hints:
        name = hints["ja_trainer_name"]
        if "card_number" in hints:
            return f"{name} #{hints['card_number']}"
        return name
    return "(unknown)"


class CardMatcherService:

    def __init__(self):
        self.pc_scraper = PricechartingScraper()
        self.pokemon_api = PokemonTCGApiScraper()
        self.op_scraper = OnePieceScraper()

    async def close(self) -> None:
        """Close all underlying HTTP clients. Called from app lifespan shutdown."""
        await self.pokemon_api.close()
        await self.op_scraper.close()

    async def search_cards(
        self,
        ocr_text: str,
        game: str,
        language: str,
        db: AsyncSession,
        image_phash: str | None = None,  # reserved for future re-enable
    ) -> tuple[list[Card], str]:
        hints = extract_card_hints(ocr_text, game, language)
        query = build_search_query(hints, game, language)
        name_for_api = hints.get("probable_name")
        logger.info("OCR hints: %s | query: %s", hints, query)

        query_hash = hashlib.md5(query.encode()).hexdigest()
        cache_key = f"{game}:{language}:{query_hash}"
        cached = await search_cache.get(cache_key)
        if cached:
            logger.info("Cache hit for search: %s", cache_key)
            card_ids = cached.get("ids", [])
            if card_ids:
                result = await db.execute(select(Card).where(Card.id.in_(card_ids)))
                by_id = {c.id: c for c in result.scalars().all()}
                # Preserve cached ranking order rather than DB row order.
                ordered = [by_id[i] for i in card_ids if i in by_id]
                return ordered, query

        db_cards = await self._search_db(hints, game, language, db)

        # JP trainer/supporter/stadium: if OCR found a JP name but no kana→EN translation,
        # fall back to name_ja substring search.
        if not db_cards and hints.get("ja_trainer_name") and language == "ja":
            db_cards = await self._search_db_ja_trainer(hints, game, db)

        # Skip external API for Japanese: pokemontcg.io has no Japanese card data.
        # _search_db already searches the English cards with the kana→EN translated name.
        #
        # Also call the external API when the DB has results but none match the OCR'd
        # card number — e.g. DB has Abra 036 ×3 but OCR says 63, meaning Abra 063
        # was never fetched and won't appear as a swap candidate without an API call.
        card_num_hint = hints.get("card_number", "")
        db_has_num_match = any(
            card_num_hint and card_num_hint in (c.card_number or "")
            for c in db_cards
        ) if card_num_hint else True
        if name_for_api and (len(db_cards) < 3 or not db_has_num_match) and language != "ja":
            api_cards = await self._search_external(name_for_api, game, language, db, hints)
            existing_ids = {c.id for c in db_cards}
            for ac in api_cards:
                if ac.id not in existing_ids:
                    db_cards.append(ac)
                    existing_ids.add(ac.id)

        db_cards = self._dedupe_and_rank(db_cards, hints)
        await search_cache.set(cache_key, ttl=3600, value={"ids": [c.id for c in db_cards[:20]]})
        return db_cards[:10], query

    def _dedupe_and_rank(self, cards: list[Card], hints: dict) -> list[Card]:
        seen: set[str] = set()
        unique: list[Card] = []
        for c in cards:
            key = f"{c.name}|{c.set_code or ''}|{c.card_number or ''}"
            if key not in seen:
                seen.add(key)
                unique.append(c)

        card_num = hints.get("card_number", "")
        set_total = hints.get("set_total", "")

        # Build set of set_codes whose printedTotal matches the scanned card's set_total.
        # Used to disambiguate cards that share a name and number across multiple sets.
        matching_set_codes: set[str] = set()
        if set_total and _SET_PRINTED_TOTALS:
            try:
                total_int = int(set_total)
                matching_set_codes = {
                    code for code, pt in _SET_PRINTED_TOTALS.items() if pt == total_int
                }
            except ValueError:
                logger.debug("Non-numeric set_total from OCR: %r — skipping printed_total ranking", set_total)

        def rank(c: Card) -> tuple:
            # Primary: set_total match.
            # EN cards: compare against set_printed_totals.json (keyed by set_code).
            # JP cards: compare directly against card.set_total stored on the record.
            if set_total:
                try:
                    total_int = int(set_total)
                    if c.language == "ja":
                        set_match = 0 if c.set_total == total_int else 1
                    else:
                        set_match = 0 if (c.set_code and c.set_code in matching_set_codes) else 1
                except ValueError:
                    set_match = 1
            else:
                set_match = 1
            # Secondary: exact card number match, then prefix, then rest
            if card_num:
                num = (c.card_number or "").lstrip("0").split("/")[0]
                hint = card_num.lstrip("0")
                if num == hint:
                    num_rank = 0
                elif num.startswith(hint):
                    num_rank = 1
                else:
                    num_rank = 2
            else:
                num_rank = 0
            # Tertiary: deprioritize McDonald's promo sets (uncommon, frequently outranked by real sets)
            mcd_penalty = 1 if (c.set_code or "").startswith("mcd") else 0
            return (set_match, num_rank, mcd_penalty)

        unique.sort(key=rank)
        return unique

    async def _search_db(self, hints: dict, game: str, language: str, db: AsyncSession) -> list[Card]:
        name = hints.get("probable_name", "")
        card_number = hints.get("card_number", "")

        # JP Pokemon scans now search language='ja' records directly.
        # JP cards store the English name in `name` (from TCGCollector name_en),
        # so kana→EN translation from card_matcher still produces the right search term.
        base = select(Card).where(Card.game == game, Card.language == language)

        # Number-only search (without a name) is disabled — too many false matches across sets.
        if not name:
            return []

        # ── Standard name search (ilike) ───────────────────────────────────────
        # Priority 0: exact name match ("Gastly" == "Gastly")
        # Priority 1: partial match ("Gastly" in "Sabrina's Gastly")
        # This prevents partial-match cards from outranking exact-match cards.
        exact_match = Card.name.ilike(name)
        name_match = Card.name.ilike(f"%{name}%")
        name_priority = case((exact_match, 0), else_=1).label("name_priority")

        if card_number:
            num_match = Card.card_number.ilike(f"%{card_number}%")
            # Name is required; number only re-ranks within name matches. Previously
            # this used `WHERE name_match OR num_match` which let unrelated cards
            # (any card whose number contained the digits) outrank actual name
            # matches — e.g. JP Clauncher #3 surfaced Charizard #3 because no EN
            # Clauncher has number 3 and the number-only branch ranked higher.
            num_priority = case((num_match, 0), else_=1).label("num_priority")
            stmt = (
                base.add_columns(name_priority, num_priority)
                .where(name_match)
                .order_by(name_priority, num_priority)
                .limit(10)
            )
            rows = (await db.execute(stmt)).all()
            if rows:
                return [r[0] for r in rows]
        else:
            # When no card number is available, boost cards whose set_total matches
            # the denominator from OCR (e.g. set_total=165 for Pokémon Card 151).
            # Without this, ORDER BY id returns oldest cards first, burying newer sets.
            set_total = hints.get("set_total")
            if set_total:
                st_match = case((Card.set_total == set_total, 0), else_=1).label("st_priority")
                stmt = (
                    base.add_columns(name_priority, st_match)
                    .where(name_match)
                    .order_by(name_priority, st_match, Card.id.desc())
                    .limit(10)
                )
                rows = (await db.execute(stmt)).all()
                if rows:
                    return [r[0] for r in rows]
            result = await db.execute(
                base.where(name_match).add_columns(name_priority)
                .order_by(name_priority, Card.id.desc()).limit(10)
            )
            results = [r[0] for r in result.all()]
            if results:
                return results

        # Fuzzy fallback for OCR misreads (e.g. "Lotacl" → Lotad, "Sulcune" → Suicune).
        fuzzy = await db.execute(
            base.where(func.similarity(Card.name, name) > 0.35)
            .order_by(func.similarity(Card.name, name).desc())
            .limit(10)
        )
        return list(fuzzy.scalars().all())

    async def _search_db_ja_trainer(self, hints: dict, game: str, db: AsyncSession) -> list[Card]:
        """Search JP cards by name_ja for trainer/supporter/stadium cards whose JP name
        cannot be translated to English via the kana→EN dictionary."""
        ja_name = hints.get("ja_trainer_name", "")
        card_number = hints.get("card_number", "")
        if not ja_name:
            return []
        base = select(Card).where(Card.game == game, Card.language == "ja", Card.name_ja.isnot(None))
        name_ja_match = Card.name_ja.ilike(f"%{ja_name}%")
        if card_number:
            num_match = Card.card_number.ilike(f"%{card_number}%")
            num_priority = case((num_match, 0), else_=1).label("num_priority")
            stmt = (
                base.add_columns(num_priority)
                .where(name_ja_match)
                .order_by(num_priority, Card.id.desc())
                .limit(10)
            )
            rows = (await db.execute(stmt)).all()
            return [r[0] for r in rows]
        result = await db.execute(base.where(name_ja_match).order_by(Card.id.desc()).limit(10))
        return list(result.scalars().all())

    async def _search_external(self, query: str, game: str, language: str, db: AsyncSession, hints: dict | None = None) -> list[Card]:
        cards: list[Card] = []
        if game == "pokemon":
            api_results = await self.pokemon_api.search(query, language)
            for r in api_results[:10]:
                card = await self._upsert_pokemon_card(r, language, db)
                if card:
                    cards.append(card)
        elif game == "onepiece":
            api_results = await self.op_scraper.search(query, language)
            for r in api_results[:10]:
                card = await self._upsert_op_card(r, language, db)
                if card:
                    cards.append(card)
        return cards

    async def _upsert_pokemon_card(self, api_card, language: str, db: AsyncSession) -> Card | None:
        stmt = select(Card).where(Card.external_id == api_card.id)
        result = await db.execute(stmt)
        existing = result.scalars().first()
        if existing:
            return existing

        card = Card(
            game="pokemon",
            language=language,
            name=api_card.name,
            set_name=api_card.set_name,
            set_code=api_card.set_code,
            card_number=api_card.number,
            rarity=api_card.rarity,
            image_url=api_card.image_url,
            image_url_hi=api_card.image_url_hi,
            phash=None,
            external_id=api_card.id,
        )
        db.add(card)
        await db.flush()
        return card

    async def _upsert_op_card(self, api_card, language: str, db: AsyncSession) -> Card | None:
        stmt = select(Card).where(Card.external_id == api_card.id, Card.game == "onepiece")
        result = await db.execute(stmt)
        existing = result.scalars().first()
        if existing:
            return existing

        card = Card(
            game="onepiece",
            language=language,
            name=api_card.name,
            name_ja=api_card.name_ja,
            set_name=api_card.set_name,
            set_code=api_card.set_code,
            card_number=api_card.card_number,
            rarity=api_card.rarity,
            image_url=api_card.image_url,
            phash=None,
            external_id=api_card.id,
        )
        db.add(card)
        await db.flush()
        return card

    def _build_pc_url(
        self,
        card: Card,
        language_override: str | None,
        ja_card_number: str | None = None,
        variant: str = "normal",
    ) -> str | None:
        """Build PriceCharting URL for the given card, language, and variant.

        Never modifies the card object — duplicate rows in DB could trigger
        unique constraint violations if we write back. For language_override="ja",
        always rebuild with Japanese prefix since the stored URL (if any) is for
        the English version.

        ja_card_number: the OCR-read card number from the physical Japanese card
        (e.g. "56"). The English DB record may have a different number ("57"),
        so the Japanese URL must use the OCR number to reach the correct PC page.
        """
        if language_override == "ja" and card.set_name:
            # JP-first-class DB records (v11+): card.card_number IS the authoritative
            # JP number — don't let an OCR misread override it.
            # EN records scanned as JP: ja_card_number carries the JP number that the
            # EN DB entry doesn't have, so the OCR value is needed there.
            if card.language == "ja":
                number = card.card_number
            else:
                number = ja_card_number or card.card_number
            if not number:
                return None
            return self.pc_scraper.build_game_url(
                card.name, card.set_name, number, card.game, "ja", variant
            )
        # Non-normal variants always rebuild — stored URL is always normal variant.
        if variant != "normal" and card.set_name and card.card_number:
            return self.pc_scraper.build_game_url(
                card.name, card.set_name, card.card_number, card.game, card.language, variant
            )
        pc_url = card.pricecharting_url
        if pc_url is None and card.set_name and card.card_number:
            return self.pc_scraper.build_game_url(
                card.name, card.set_name, card.card_number, card.game, card.language
            )
        return pc_url

    @staticmethod
    def _price_cache_key(pc_url: str, scan_type: str, price_language: str) -> tuple[str, str]:
        """Returns (pc_id, cache_key). Cache key includes scan_type and language
        so same-number cards from different sets don't collide
        (e.g. gastly-36 in Fossil vs Team Rocket; or EN vs JA Suicune)."""
        parts = pc_url.rstrip("/").split("/")
        pc_id = "_".join(parts[-2:]) if len(parts) >= 2 else parts[-1]
        return pc_id, f"{pc_id}:{scan_type}:{price_language}"

    @staticmethod
    def _serialize_prices(prices, pc_id: str, pc_url: str, scan_type: str) -> dict:
        return {
            "pricecharting_id": pc_id,
            "pricecharting_url": pc_url,
            "scan_type": scan_type,
            "price_loose": prices.loose,
            "price_cib": prices.cib,
            "price_graded_7": prices.graded_7,
            "price_graded_8": prices.graded_8,
            "price_graded_9": prices.graded_9,
            "price_graded_10": prices.graded_10,
            "currency": "USD",
            "recent_sales": [
                {"date": s.date, "title": s.title, "price": s.price, "url": s.url}
                for s in prices.recent_sales
            ],
            "price_history_ungraded": [
                {"date": p.date, "price": p.price}
                for p in prices.price_history_ungraded
            ],
            "price_history_graded": [
                {"date": p.date, "price": p.price}
                for p in prices.price_history_graded
            ],
        }

    _NEGATIVE_TTL = 3600  # 1h — PriceCharting 404s rarely change, but keep short enough to recover from temporary scrape failures

    async def get_prices(
        self,
        card: Card,
        scan_type: str,
        language_override: str | None = None,
        ja_card_number: str | None = None,
        force_refresh: bool = False,
        variant: str = "normal",
    ) -> dict | None:
        if not card.name:
            return None

        pc_url = self._build_pc_url(card, language_override, ja_card_number, variant)
        if not pc_url:
            return None

        price_language = language_override or card.language
        pc_id, cache_key = self._price_cache_key(pc_url, scan_type, price_language)

        if not force_refresh:
            cached = await price_cache.get(cache_key)
            if cached is not None:
                if isinstance(cached, dict) and cached.get("__not_found__"):
                    return None
                return cached

        prices = await self.pc_scraper.get_prices(pc_url, recent_sales_limit=100)
        if self._is_empty_prices(prices):
            # Negative result — card not listed on PriceCharting (404 or empty page).
            # Cache so we don't repeatedly hammer the scraper for the same miss.
            logger.info("PriceCharting returned no data for %s — caching negative result", pc_url)
            await price_cache.set(cache_key, ttl=self._NEGATIVE_TTL, value={"__not_found__": True})
            return None

        price_dict = self._serialize_prices(prices, pc_id, pc_url, scan_type)
        await price_cache.set(cache_key, ttl=settings.scrape_cache_ttl_prices, value=price_dict)
        return price_dict

    @staticmethod
    def _is_empty_prices(prices) -> bool:
        """True when the scraper found none of the price signals we expect — i.e. the
        page is a 404 / not-catalogued placeholder rather than a real product page."""
        return (
            prices.loose is None
            and prices.cib is None
            and prices.graded_7 is None
            and prices.graded_8 is None
            and prices.graded_9 is None
            and prices.graded_10 is None
            and not prices.recent_sales
            and not prices.price_history_ungraded
            and not prices.price_history_graded
        )
