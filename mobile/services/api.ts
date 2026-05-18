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

export interface ScanStreamResult {
  crop_index: number;
  candidates: CardOut[];
  query_used: string;
  match_source: "ocr" | "image" | "both" | "none";
}

export interface ScanOcrHint {
  raw_text?: string;
  language: string;
  game: string;
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

  async getCard(cardId: number, scanType: ScanType, language?: string): Promise<CardWithPrice> {
    const { data } = await client.get<CardWithPrice>(`/cards/${cardId}`, {
      params: { scan_type: scanType, ...(language && { language }) },
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
    }, { timeout: 60000 });
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

  async batchMatchByImage(crops: string[]): Promise<BatchSearchResult> {
    const { data } = await client.post<BatchSearchResult>("/match-image", { crops });
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
    crops: string[],
    ocrHints: ScanOcrHint[],
    scanMode: string,
    onResult: (item: ScanStreamResult) => void,
    signal?: AbortSignal,
  ): Promise<void> {
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
        resolve();
      };

      xhr.onerror = () => reject(new Error("Scan stream request failed"));
      xhr.ontimeout = () => reject(new Error("Scan stream timed out"));
      xhr.onabort = () => resolve(); // treat abort as clean finish

      xhr.send(JSON.stringify({
        crops,
        ocr_hints: ocrHints,
        scan_mode: scanMode,
      }));
    });
  },
};
