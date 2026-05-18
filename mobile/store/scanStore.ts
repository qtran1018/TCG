import { create } from "zustand";
import type { Game, Language, ScanType } from "@/constants";
import type { CardOut, SearchResult } from "@/services/api";
import type { DetectedCard, MultiScanResult } from "@/types/scan";

interface ScanState {
  game: Game;
  language: Language;
  scanType: ScanType;
  psaCertInput: string;

  lastOcrText: string;
  lastSearchResult: SearchResult | null;
  selectedCard: CardOut | null;

  // Multi-scan state — updated progressively as cards stream in
  multiScanResult: MultiScanResult | null;
  multiScanLoading: boolean;
  multiScanTotalRegions: number;
  multiScanError: string | null;

  setGame: (game: Game) => void;
  setLanguage: (language: Language) => void;
  setScanType: (scanType: ScanType) => void;
  setPsaCertInput: (cert: string) => void;
  setLastOcrText: (text: string) => void;
  setLastSearchResult: (result: SearchResult | null) => void;
  setSelectedCard: (card: CardOut | null) => void;
  setMultiScanResult: (result: MultiScanResult | null) => void;

  // Progressive multi-scan actions
  clearMultiScan: () => void;
  setMultiScanLoading: (loading: boolean, totalRegions?: number) => void;
  setMultiScanError: (error: string | null) => void;
  appendMultiScanCard: (card: DetectedCard) => void;

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
  multiScanLoading: false,
  multiScanTotalRegions: 0,
  multiScanError: null,

  setGame: (game) => set({ game }),
  setLanguage: (language) => set({ language }),
  setScanType: (scanType) => set({ scanType }),
  setPsaCertInput: (psaCertInput) => set({ psaCertInput }),
  setLastOcrText: (lastOcrText) => set({ lastOcrText }),
  setLastSearchResult: (lastSearchResult) => set({ lastSearchResult }),
  setSelectedCard: (selectedCard) => set({ selectedCard }),
  setMultiScanResult: (multiScanResult) => set({ multiScanResult, multiScanLoading: false }),

  clearMultiScan: () => set({
    multiScanResult: null,
    multiScanLoading: false,
    multiScanTotalRegions: 0,
    multiScanError: null,
  }),

  setMultiScanLoading: (loading, totalRegions) => set((s) => ({
    multiScanLoading: loading,
    ...(totalRegions !== undefined ? { multiScanTotalRegions: totalRegions } : {}),
    ...(loading ? { multiScanError: null } : {}),
  })),

  setMultiScanError: (error) => set({ multiScanError: error, multiScanLoading: false }),

  appendMultiScanCard: (card) => set((s) => {
    const existing = s.multiScanResult;
    if (existing) {
      return {
        multiScanResult: {
          ...existing,
          cards: [...existing.cards, card],
          totalConfident: existing.totalConfident + 1,
        },
      };
    }
    return {
      multiScanResult: {
        cards: [card],
        totalRegionsFound: s.multiScanTotalRegions,
        totalConfident: 1,
      },
    };
  }),

  reset: () =>
    set({
      lastOcrText: "",
      lastSearchResult: null,
      selectedCard: null,
      psaCertInput: "",
      multiScanResult: null,
      multiScanLoading: false,
      multiScanTotalRegions: 0,
      multiScanError: null,
    }),
}));
