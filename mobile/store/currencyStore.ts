import { create } from "zustand";
import { api } from "@/services/api";

export type Currency = "USD" | "JPY";

interface CurrencyState {
  currency: Currency;
  jpyRate: number | null;
  rateDate: string | null;
  fetching: boolean;
  setCurrency: (c: Currency) => void;
  fetchRate: () => Promise<void>;
}

export const useCurrencyStore = create<CurrencyState>((set, get) => ({
  currency: "USD",
  jpyRate: null,
  rateDate: null,
  fetching: false,

  setCurrency: (currency) => {
    set({ currency });
    // Fetch rate on first switch to JPY if not already loaded
    if (currency === "JPY" && get().jpyRate === null && !get().fetching) {
      get().fetchRate();
    }
  },

  fetchRate: async () => {
    if (get().fetching) return;
    set({ fetching: true });
    try {
      const { rate, date } = await api.getExchangeRate();
      set({ jpyRate: rate, rateDate: date, fetching: false });
    } catch (e) {
      console.warn("[currencyStore] failed to fetch exchange rate:", e);
      set({ fetching: false });
    }
  },
}));
