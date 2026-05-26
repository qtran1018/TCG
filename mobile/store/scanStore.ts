import { create } from "zustand";
import type { Game, ScanType } from "@/constants";
import type { CardOut } from "@/services/api";
import type { BatchPriceCard, DetectedCard, MultiScanResult, ScanTiming } from "@/types/scan";

interface ScanState {
  game: Game;
  scanType: ScanType;
  psaCertInput: string;

  // Multi-scan state — updated progressively as cards stream in
  multiScanResult: MultiScanResult | null;
  multiScanLoading: boolean;
  multiScanTotalRegions: number;
  multiScanError: string | null;

  // Speed test timing data from the last scan (null when speed test is off)
  scanTiming: ScanTiming | null;

  // Cards selected for batch price lookup (with optional JP metadata)
  batchPriceCards: BatchPriceCard[];
  // Number of duplicate card IDs removed when a live scan session ended
  liveSessionDuplicatesRemoved: number;

  setGame: (game: Game) => void;
  setScanType: (scanType: ScanType) => void;
  setPsaCertInput: (cert: string) => void;
  setMultiScanResult: (result: MultiScanResult | null) => void;
  setScanTiming: (timing: ScanTiming | null) => void;
  setBatchPriceCards: (cards: BatchPriceCard[], duplicatesRemoved?: number) => void;

  // Progressive multi-scan actions
  clearMultiScan: () => void;
  setMultiScanLoading: (loading: boolean, totalRegions?: number) => void;
  setMultiScanError: (error: string | null) => void;
  appendMultiScanCard: (card: DetectedCard) => void;

  reset: () => void;
}

export const useScanStore = create<ScanState>((set) => ({
  game: "pokemon",
  scanType: "raw",
  psaCertInput: "",
  multiScanResult: null,
  multiScanLoading: false,
  multiScanTotalRegions: 0,
  multiScanError: null,
  scanTiming: null,
  batchPriceCards: [],
  liveSessionDuplicatesRemoved: 0,

  setGame: (game) => set({ game }),
  setScanType: (scanType) => set({ scanType }),
  setPsaCertInput: (psaCertInput) => set({ psaCertInput }),
  setMultiScanResult: (multiScanResult) => set({ multiScanResult, multiScanLoading: false }),
  setScanTiming: (scanTiming) => set({ scanTiming }),
  setBatchPriceCards: (batchPriceCards, duplicatesRemoved = 0) =>
    set({ batchPriceCards, liveSessionDuplicatesRemoved: duplicatesRemoved }),

  clearMultiScan: () => set({
    multiScanResult: null,
    multiScanLoading: false,
    multiScanTotalRegions: 0,
    multiScanError: null,
    scanTiming: null,
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
      scanTiming: null,
      batchPriceCards: [],
      liveSessionDuplicatesRemoved: 0,
    }),
}));
