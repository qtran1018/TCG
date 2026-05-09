import axios from "axios";
import { API_BASE_URL } from "@/constants";
import type { Game, Language, ScanType } from "@/constants";

const client = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

export interface CardOut {
  id: number;
  game: string;
  language: string;
  name: string;
  name_ja?: string;
  set_name?: string;
  set_code?: string;
  card_number?: string;
  rarity?: string;
  image_url?: string;
  image_url_hi?: string;
  pricecharting_url?: string;
  phash?: string;
  external_id?: string;
  created_at: string;
}

export interface SaleRecord {
  date: string;
  title: string;
  price: number | null;
}

export interface PricePoint {
  date: string;  // "YYYY-MM"
  price: number;
}

export interface PriceOut {
  pricecharting_id: string;
  scan_type: string;
  price_loose?: number;
  price_cib?: number;
  price_graded_7?: number;
  price_graded_8?: number;
  price_graded_9?: number;
  price_graded_10?: number;
  currency: string;
  fetched_at: string;
  recent_sales?: SaleRecord[];
  price_history_ungraded?: PricePoint[];
  price_history_graded?: PricePoint[];
}

export interface SearchResult {
  candidates: CardOut[];
  query_used: string;
}

export interface BatchSearchItem {
  candidates: CardOut[];
  query_used: string;
}

export interface BatchSearchResult {
  results: BatchSearchItem[];
}

export interface CardWithPrice {
  card: CardOut;
  price?: PriceOut;
}

export interface PSACertResult {
  cert_number: string;
  grade?: string;
  card_name?: string;
  set_name?: string;
  year?: string;
  population?: number;
  card?: CardOut;
  price?: PriceOut;
}

export interface DetectBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DetectResult {
  boxes: DetectBox[];
  image_width: number;
  image_height: number;
}

export interface HistoryEntry {
  id: number;
  game: string;
  scan_type: string;
  language: string;
  resolved_card_name?: string;
  price_loose?: number;
  price_graded_10?: number;
  scanned_at: string;
}

export const api = {
  async searchCards(
    ocrText: string,
    game: Game,
    scanType: ScanType,
    language: Language,
  ): Promise<SearchResult> {
    const { data } = await client.post<SearchResult>("/search", {
      ocr_text: ocrText,
      game,
      scan_type: scanType,
      language,
    });
    return data;
  },

  async getCard(cardId: number, scanType: ScanType): Promise<CardWithPrice> {
    const { data } = await client.get<CardWithPrice>(`/cards/${cardId}`, {
      params: { scan_type: scanType },
    });
    return data;
  },

  async lookupPSACert(certNumber: string, game: Game): Promise<PSACertResult> {
    const { data } = await client.post<PSACertResult>("/psa/cert", {
      cert_number: certNumber,
      game,
    });
    return data;
  },

  async saveHistory(entry: {
    card_id?: number;
    game: Game;
    scan_type: ScanType;
    language: Language;
    ocr_text?: string;
    psa_cert?: string;
    resolved_card_name?: string;
    price_loose?: number;
    price_graded_10?: number;
  }): Promise<{ id: number }> {
    const { data } = await client.post<{ id: number }>("/cards/history", null, {
      params: entry,
    });
    return data;
  },

  async batchSearch(
    queries: Array<{ ocr_text: string; game: string; language: string }>,
    scan_type: string,
  ): Promise<BatchSearchResult> {
    const { data } = await client.post<BatchSearchResult>("/search/batch", {
      queries,
      scan_type,
    });
    return data;
  },

  async detectCards(imageBase64: string, maxCards = 10): Promise<DetectResult> {
    const { data } = await client.post<DetectResult>("/detect", {
      image_base64: imageBase64,
      max_cards: maxCards,
    });
    return data;
  },

  async getHistory(limit = 50, offset = 0): Promise<HistoryEntry[]> {
    const { data } = await client.get<HistoryEntry[]>("/cards/history/list", {
      params: { limit, offset },
    });
    return data;
  },
};
