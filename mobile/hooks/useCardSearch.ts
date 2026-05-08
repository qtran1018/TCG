import { useState, useCallback } from "react";
import { api, SearchResult, PSACertResult } from "@/services/api";
import type { Game, Language, ScanType } from "@/constants";

interface UseCardSearchReturn {
  searchByOCR: (
    ocrText: string,
    game: Game,
    scanType: ScanType,
    language: Language,
  ) => Promise<SearchResult | null>;
  searchByCert: (cert: string, game: Game) => Promise<PSACertResult | null>;
  isSearching: boolean;
  error: string | null;
}

export function useCardSearch(): UseCardSearchReturn {
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchByOCR = useCallback(
    async (
      ocrText: string,
      game: Game,
      scanType: ScanType,
      language: Language,
    ): Promise<SearchResult | null> => {
      if (!ocrText.trim()) return null;
      setIsSearching(true);
      setError(null);
      try {
        return await api.searchCards(ocrText, game, scanType, language);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Search failed";
        setError(msg);
        return null;
      } finally {
        setIsSearching(false);
      }
    },
    [],
  );

  const searchByCert = useCallback(async (cert: string, game: Game): Promise<PSACertResult | null> => {
    if (!cert.trim()) return null;
    setIsSearching(true);
    setError(null);
    try {
      return await api.lookupPSACert(cert, game);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "PSA lookup failed";
      setError(msg);
      return null;
    } finally {
      setIsSearching(false);
    }
  }, []);

  return { searchByOCR, searchByCert, isSearching, error };
}
