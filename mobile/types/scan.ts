import type { CardOut } from "@/services/api";

export interface DetectedCard {
  regionIndex: number;
  ocrText: string;
  searchResult: { candidates: CardOut[]; query_used: string };
  matchSource?: "ocr" | "image" | "both" | "image:low";
}

export interface MultiScanResult {
  cards: DetectedCard[];
  totalRegionsFound: number;
  totalConfident: number;
}
