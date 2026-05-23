import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Game } from "@/constants";

export interface SavedCard {
  id: number;
  name: string;
  set_name: string;
  card_number: string;
  image_url: string | null;
  language: string;
  game: Game;
  savedAt: string;
}

interface SavedCardsState {
  cards: SavedCard[];
  save: (card: SavedCard) => void;
  remove: (id: number) => void;
  isSaved: (id: number) => boolean;
  clearAll: () => void;
}

export const useSavedCardsStore = create<SavedCardsState>()(
  persist(
    (set, get) => ({
      cards: [],
      save: (card) =>
        set((s) => ({
          cards: s.cards.some((c) => c.id === card.id)
            ? s.cards
            : [card, ...s.cards],
        })),
      remove: (id) => set((s) => ({ cards: s.cards.filter((c) => c.id !== id) })),
      isSaved: (id) => get().cards.some((c) => c.id === id),
      clearAll: () => set({ cards: [] }),
    }),
    {
      name: "tcg:saved-cards",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
