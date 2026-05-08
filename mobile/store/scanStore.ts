import { create } from "zustand";
import type { Game, Language, ScanType } from "@/constants";
import type { CardOut, SearchResult } from "@/services/api";
import type { MultiScanResult } from "@/hooks/useMultiCardScan";

interface ScanState {
  game: Game;
  language: Language;
  scanType: ScanType;
  psaCertInput: string;

  lastOcrText: string;
  lastSearchResult: SearchResult | null;
  selectedCard: CardOut | null;
  multiScanResult: MultiScanResult | null;

  setGame: (game: Game) => void;
  setLanguage: (language: Language) => void;
  setScanType: (scanType: ScanType) => void;
  setPsaCertInput: (cert: string) => void;
  setLastOcrText: (text: string) => void;
  setLastSearchResult: (result: SearchResult | null) => void;
  setSelectedCard: (card: CardOut | null) => void;
  setMultiScanResult: (result: MultiScanResult | null) => void;
  reset: () => void;
}

export const useScanStore = create<ScanState>((set) => ({
  game: "pokemon",
  language: "en",
  scanType: "raw",
  psaCertInput: "",
  lastOcrText: "",
  lastSearchResult: null,
  selectedCard: null,
  multiScanResult: null,

  setGame: (game) => set({ game }),
  setLanguage: (language) => set({ language }),
  setScanType: (scanType) => set({ scanType }),
  setPsaCertInput: (psaCertInput) => set({ psaCertInput }),
  setLastOcrText: (lastOcrText) => set({ lastOcrText }),
  setLastSearchResult: (lastSearchResult) => set({ lastSearchResult }),
  setSelectedCard: (selectedCard) => set({ selectedCard }),
  setMultiScanResult: (multiScanResult) => set({ multiScanResult }),
  reset: () =>
    set({
      lastOcrText: "",
      lastSearchResult: null,
      selectedCard: null,
      psaCertInput: "",
      multiScanResult: null,
    }),
}));
