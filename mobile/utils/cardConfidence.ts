// Heuristic confidence check — determines if OCR text looks like a TCG card.
// Returns a score (0–10) and a human-readable reason when it fails.

const CARD_NUMBER_POKEMON = /\b\d{1,3}\s*\/\s*\d{2,3}\b/;
const CARD_NUMBER_ONEPIECE = /\b(OP|ST|P)-?\d{2}-?\d{3}\b/i;
const HP_RE = /\bHP\s*\d+|\d+\s*HP\b/i;
const KEYWORD_RE = /\b(weakness|resistance|retreat|basic|stage\s*[12]|trainer|supporter|stadium|item|energy)\b/i;
const COPYRIGHT_RE = /©|\bpokémon\b|\bnintendo\b|\bgame\s*freak\b|\bcreatures\b|\bbandai\b/i;
const NAME_LINE_RE = /^[A-Z][a-zA-Z\s\-'.]{1,30}$/;
// Katakana (U+30A0–U+30FF) — Japanese Pokémon names are written in katakana
const KATAKANA_RUN_RE = /[゠-ヿ]{3,}/;
// Japanese trainer/keyword markers — 弱点 weakness, 抵抗力 resistance, にげる/逃げる retreat,
// 特性 ability, ワザ move, グッズ item, サポート supporter, スタジアム stadium, たね basic
const JA_KEYWORD_RE = /弱点|抵抗力|にげる|逃げる|特性|ワザ|グッズ|サポート|スタジアム|たね|進化/;

export interface ConfidenceResult {
  score: number;       // 0–10
  isCard: boolean;     // true if score >= THRESHOLD
  reason: string | null; // set when isCard is false
}

const THRESHOLD = 3;

export function assessCardConfidence(
  text: string,
  blockCount: number,
  game: "pokemon" | "onepiece",
  language: "en" | "ja" = "en",
): ConfidenceResult {
  let score = 0;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Strong signals
  if (game === "pokemon" && CARD_NUMBER_POKEMON.test(text)) score += 3;
  if (game === "onepiece" && CARD_NUMBER_ONEPIECE.test(text)) score += 3;
  if (game === "pokemon" && HP_RE.test(text)) score += 2;

  // Supporting signals — keywords differ by language
  if (language === "ja") {
    const jaMatches = (text.match(new RegExp(JA_KEYWORD_RE.source, "g")) ?? []).length;
    score += Math.min(jaMatches, 2);
    // A katakana run anywhere in the top lines is a strong "this is a JP card" signal
    if (lines.slice(0, 6).some((l) => KATAKANA_RUN_RE.test(l))) score += 2;
  } else {
    const keywordMatches = (text.match(new RegExp(KEYWORD_RE.source, "gi")) ?? []).length;
    score += Math.min(keywordMatches, 2);
    // A probable name: title-case line near the top with no digits
    if (lines.slice(0, 5).some((l) => NAME_LINE_RE.test(l) && !/\d/.test(l))) score += 1;
  }
  if (COPYRIGHT_RE.test(text)) score += 1;

  // Too many OCR blocks suggests a cluttered scene, not a single card
  if (blockCount > 20) score -= 1;

  score = Math.max(0, Math.min(10, score));
  const isCard = score >= THRESHOLD;

  let reason: string | null = null;
  if (!isCard) {
    if (lines.length < 3) {
      reason = "Too little text detected. Make sure the card fills the frame.";
    } else if (blockCount > 20) {
      reason = "Too many text regions detected. Try scanning one card at a time.";
    } else {
      reason = "This doesn't look like a TCG card. Try repositioning or improving lighting.";
    }
  }

  return { score, isCard, reason };
}
