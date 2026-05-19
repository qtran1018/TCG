import { useState, useCallback } from "react";
import { api, PSACertResult } from "@/services/api";
import type { Game } from "@/constants";

interface UseCardSearchReturn {
  searchByCert: (cert: string, game: Game) => Promise<PSACertResult | null>;
  isSearching: boolean;
  error: string | null;
}

export function useCardSearch(): UseCardSearchReturn {
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return { searchByCert, isSearching, error };
}
