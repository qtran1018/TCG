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
  url?: string;
}

export interface PricePoint {
  date: string;  // "YYYY-MM"
  price: number;
}

export interface PriceOut {
  pricecharting_id: string;
  pricecharting_url?: string;
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

export interface CardWithPrice {
  card: CardOut;
  price?: PriceOut;
}

export interface BatchPricesItem {
  card_id: number;
  card?: CardOut;
  price?: PriceOut;
  error?: string | null;
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

export interface ScanStreamResult {
  crop_index: number;
  candidates: CardOut[];
  query_used: string;
  match_source: "ocr" | "image" | "both" | "none";
  partial?: boolean;
  partial_reason?: string | null;
}

export interface ScanOcrHint {
  raw_text?: string;
  language: string;
  game: string;
}

export interface ExchangeRate {
  base: string;
  quote: string;
  rate: number;
  date: string;
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
  async getCard(
    cardId: number,
    scanType: ScanType,
    language?: string,
    cardNumber?: string,
    forceRefresh?: boolean,
    skipPrice?: boolean,
  ): Promise<CardWithPrice> {
    const { data } = await client.get<CardWithPrice>(`/cards/${cardId}`, {
      params: {
        scan_type: scanType,
        ...(language && { language }),
        ...(cardNumber && { card_number: cardNumber }),
        ...(forceRefresh && { force_refresh: true }),
        ...(skipPrice && { skip_price: true }),
      },
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
    const { data } = await client.post<{ id: number }>("/cards/history", entry);
    return data;
  },

  async batchPrices(
    cardIds: number[],
    scanType: ScanType,
    jaCardNumbers?: Record<number, string>,
  ): Promise<BatchPricesItem[]> {
    // Batch price fetches serialize through the scraper rate limiter on backend
    // (~3s per uncached card). 20 cards × 3s = 60s worst case; override the
    // default 30s axios timeout to allow a full cold-cache batch to complete.
    const { data } = await client.post<{ items: BatchPricesItem[] }>("/cards/prices", {
      card_ids: cardIds,
      scan_type: scanType,
      ...(jaCardNumbers && Object.keys(jaCardNumbers).length > 0 && { ja_card_numbers: jaCardNumbers }),
    }, { timeout: 90000 });
    return data.items;
  },

  async detectCards(imageBase64: string, maxCards = 10): Promise<DetectResult> {
    const { data } = await client.post<DetectResult>("/detect", {
      image_base64: imageBase64,
      max_cards: maxCards,
    });
    return data;
  },

  async getHistory(limit = 50, offset = 0, beforeId?: number): Promise<HistoryEntry[]> {
    const { data } = await client.get<HistoryEntry[]>("/cards/history/list", {
      params: {
        limit,
        ...(beforeId != null ? { before_id: beforeId } : { offset }),
      },
    });
    return data;
  },

  async getExchangeRate(): Promise<ExchangeRate> {
    const { data } = await client.get<ExchangeRate>("/currency/rates");
    return data;
  },

  /**
   * Combined card identification endpoint. Streams NDJSON results — one JSON object per crop
   * as it completes. Replaces separate /match-image + /search/batch calls.
   *
   * Uses XHR onprogress to parse partial NDJSON as it arrives, calling onResult for each
   * complete line so the UI can update progressively.
   */
  scanStream(
    payload:
      | { crops: string[]; image?: undefined; boxes?: undefined }
      | { image: string; boxes: { left: number; top: number; width: number; height: number }[]; crops?: undefined },
    ocrHints: ScanOcrHint[],
    scanMode: string,
    onResult: (item: ScanStreamResult) => void,
    signal?: AbortSignal,
  ): Promise<{ aborted: boolean }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE_URL}/scan`);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.timeout = 90000;

      if (signal) {
        signal.addEventListener("abort", () => xhr.abort());
      }

      let processedLen = 0;
      let lineBuffer = "";

      const flush = (text: string) => {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lineBuffer + lines[i];
          lineBuffer = "";
          if (!line.trim()) continue;
          try { onResult(JSON.parse(line) as ScanStreamResult); } catch { /* ignore bad lines */ }
        }
        lineBuffer = lines[lines.length - 1];
      };

      xhr.onprogress = () => {
        const chunk = xhr.responseText.slice(processedLen);
        processedLen = xhr.responseText.length;
        if (chunk) flush(chunk);
      };

      xhr.onload = () => {
        // Flush any remaining buffer after stream ends
        if (lineBuffer.trim()) {
          try { onResult(JSON.parse(lineBuffer) as ScanStreamResult); } catch { /* ignore */ }
        }
        resolve({ aborted: false });
      };

      xhr.onerror = () => reject(new Error("Scan stream request failed"));
      xhr.ontimeout = () => reject(new Error("Scan stream timed out"));
      // Resolve with aborted=true so callers can distinguish "user/unmount
      // cancelled" from "stream finished normally".
      xhr.onabort = () => resolve({ aborted: true });

      xhr.send(JSON.stringify({
        ...payload,
        ocr_hints: ocrHints,
        scan_mode: scanMode,
      }));
    });
  },
};
