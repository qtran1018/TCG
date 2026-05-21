# TODO

## Priority 1 — OCR / Search improvements

### Fix owner-prefix cards (Misty's Staryu, Brock's Onix, Sabrina's Gastly, etc.)

**File:** `backend/app/services/card_matcher.py:97`

The apostrophe in possessive names causes the entire candidate line to be rejected:

```python
if re.search(r"[.,!?;:()/\\']", clean):
    continue
```

**Fix:** Strip the possessive before the punctuation check, or remove `'` from the reject set. The `_contains_pokemon_name` gate at the end still blocks attack text (e.g. "it's", "don't") since those don't contain a Pokémon name.

```python
# Option A — strip possessive apostrophe before check
clean_for_punct = re.sub(r"(?<=\w)'s\b", "", clean)
if re.search(r"[.,!?;:()/\\']", clean_for_punct):
    continue
```

---

### Trainer / Supporter / Item / Tool / Technical Machine card support

**Priority:** Supporter → Item → Tool → Technical Machine

Currently `_find_pokemon_name` returns `None` for all non-Pokémon cards — 0 candidates returned.

#### Mobile — `mobile/utils/cardConfidence.ts`

- Add trainer detection branch **before** existing Pokémon scoring
- If OCR text contains a standalone line matching `Supporter | Item | Tool | Technical Machine | Trainer` → return `isCard: true` immediately, bypass HP/keyword scoring
- These keywords are TCG-exclusive; false positives are essentially impossible

#### Backend — `backend/app/services/card_matcher.pyの`

- Add `_find_trainer_name(lines)` alongside `_find_pokemon_name`:
  - Scan for a line matching `^(Trainer|Supporter|Item|Tool|Technical\s+Machine)$` (case-insensitive)
  - Name = 1–2 lines immediately above the type keyword
  - Strip parenthetical subtitles (e.g. `"Professor's Research (Professor Magnolia)"` → `"Professor's Research"`)
  - Validate: title-case, ≤5 words, no digits, not all-caps
- Update `_extract_hints` to try `_find_pokemon_name` first, fall back to `_find_trainer_name`
- Pass a flag so the `_contains_pokemon_name` gate is skipped for trainer results

**Note:** PriceCharting URL construction is unchanged — `build_game_url` slug pattern works for trainer cards.

---

### Tighten card number spatial filter

**File:** `mobile/hooks/useMultiCardScan.ts` — `augmentWithNumberRegion`

Current threshold `cropH * 0.78` covers the bottom 22% — too broad, picks up flavor text.

**Fix:** Tighten to bottom 8%, check both corners separately:

```typescript
// Left corner (most sets)
const leftBlocks = allBlocks.filter(b => {
  const cy = b.frame.top + (b.frame.height ?? 0) / 2;
  const cx = b.frame.left + (b.frame.width ?? 0) / 2;
  return cy >= cropY + cropH * 0.92 && cy <= cropY + cropH
      && cx >= cropX && cx <= cropX + cropW * 0.35;
});
// Right corner (some sets)
const rightBlocks = allBlocks.filter(b => {
  const cy = b.frame.top + (b.frame.height ?? 0) / 2;
  const cx = b.frame.left + (b.frame.width ?? 0) / 2;
  return cy >= cropY + cropH * 0.92 && cy <= cropY + cropH
      && cx >= cropX + cropW * 0.65 && cx <= cropX + cropW;
});
// Prefer whichever matches \d+/\d+
```

---

## Priority 2 — OCR region cropping

### Fixed proportional name region crop

**File:** `mobile/hooks/useMultiCardScan.ts`

Currently OCR runs on the full card crop — attack text, flavor text, and adjacent card bleed all pollute the name extraction input.

**Decision:** Use fixed proportional crops (not a trained region detector). TCG cards follow a rigid 63×88mm standard; hardcoded proportions give ~95% of the benefit at zero training cost. A trained detector only adds value for non-standard formats (jumbo promos, mini cards) which are not a current use case.

**What to implement:** Before sending crop text to `_find_pokemon_name`, sub-crop the image to the name region:

```
Name region:   y = 0%–18%, x = 5%–95%
```

Run OCR on this sub-crop and use it as the primary text for name extraction. The full crop OCR is still used for the card number augmentation step.

---

## Known Limitations (no fix planned)

| Issue                                    | Notes                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Older JP sets price 404 on PriceCharting | Pre-2003 JP sets use Pokédex number not set position (e.g. Gastly #92 not #49). Would need a lookup table or scrape-based URL discovery.  |
| JP Abra (kana-heavy cards) not detected  | OCR confidence < 3 + image sim < 0.50 floor → 0 candidates. Fundamental limitation — scan separately with better conditions.             |
| Holofoil image AI unreliable             | Reflective surfaces produce visual appearances impossible to synthesize. CLIP fine-tuning didn't close this gap. Use OCR or Combined mode. |
| On-device YOLO (TFLite) not available    | `card_detector.tflite` export was attempted but not completed. Stub in place in `yoloDetector.ts`.                                     |
