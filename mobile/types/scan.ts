import type { CardOut } from "@/services/api";

export interface BatchPriceCard {
  card: CardOut;
  jaImageUrl?: string;
  jaCardNumber?: string;
}

export interface DetectedCard {
  regionIndex: number;
  ocrText: string;
  searchResult: { candidates: CardOut[]; query_used: string };
  matchSource?: "ocr" | "image" | "both" | "image:low";
  kanaName?: string;    // extracted kana name for Japanese scans; used for ja_image_url lookup
  setTotal?: number;    // denominator from OCR card number (e.g. 131 from "024/131")
  cardNumber?: string;  // numerator from OCR card number (e.g. "024" from "024/131")
  // Per-candidate JP image overlay (ja scans only), keyed by candidate id.
  // Backend looks these up for every candidate so swap renders the right JP art.
  jaImageUrls?: Record<number, string>;
}

export interface MultiScanResult {
  cards: DetectedCard[];
  totalRegionsFound: number;
  totalConfident: number;
}
