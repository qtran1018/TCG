import { create } from "zustand";
import type { Game, Language, ScanType } from "@/constants";
import type { CardOut } from "@/services/api";
import type { DetectedCard, MultiScanResult } from "@/types/scan";

interface ScanState {
  game: Game;
  language: Language;
  scanType: ScanType;
  psaCertInput: string;

  // Multi-scan state — updated progressively as cards stream in
  multiScanResult: MultiScanResult | null;
  multiScanLoading: boolean;
  multiScanTotalRegions: number;
  multiScanError: string | null;

  // Cards selected for batch price lookup
  batchPriceCards: CardOut[];

  setGame: (game: Game) => void;
  setLanguage: (language: Language) => void;
  setScanType: (scanType: ScanType) => void;
  setPsaCertInput: (cert: string) => void;
  setMultiScanResult: (result: MultiScanResult | null) => void;
  setBatchPriceCards: (cards: CardOut[]) => void;

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
  multiScanResult: null,
  multiScanLoading: false,
  multiScanTotalRegions: 0,
  multiScanError: null,
  batchPriceCards: [],

  setGame: (game) => set({ game }),
  setLanguage: (language) => set({ language }),
  setScanType: (scanType) => set({ scanType }),
  setPsaCertInput: (psaCertInput) => set({ psaCertInput }),
  setMultiScanResult: (multiScanResult) => set({ multiScanResult, multiScanLoading: false }),
  setBatchPriceCards: (batchPriceCards) => set({ batchPriceCards }),

  clearMultiScan: () => set({
    multiScanResult: null,
    multiScanLoading: false,
    multiScanTotalRegions: 0,
    multiScanError: null,
  }),

  setMultiScanLoading: (loading, totalRegions) => set(() => ({
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
      psaCertInput: "",
      multiScanResult: null,
      multiScanLoading: false,
      multiScanTotalRegions: 0,
      multiScanError: null,
      batchPriceCards: [],
    }),
}));
