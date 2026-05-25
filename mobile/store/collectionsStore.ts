import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Game } from "@/constants";

export interface Collection {
  id: string;
  name: string;
  game: Game;
  isDefault: boolean;
  createdAt: string;
  cardIds: number[];
}

const DEFAULT_NAMES: Record<Game, string> = {
  pokemon: "Pokémon",
  onepiece: "One Piece",
};

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

interface CollectionsState {
  collections: Collection[];
  ensureDefault: (game: Game) => Collection;
  getByGame: (game: Game) => Collection[];
  getDefault: (game: Game) => Collection | undefined;
  create: (name: string, game: Game) => Collection;
  deleteCollection: (id: string) => void;
  addCard: (collectionId: string, cardId: number) => void;
  removeCard: (collectionId: string, cardId: number) => void;
  removeCardFromAll: (cardId: number) => void;
  isInCollection: (collectionId: string, cardId: number) => boolean;
  getCardCollectionIds: (cardId: number, game: Game) => string[];
}

export const useCollectionsStore = create<CollectionsState>()(
  persist(
    (set, get) => ({
      collections: [],

      ensureDefault: (game) => {
        const existing = get().collections.find(
          (c) => c.game === game && c.isDefault,
        );
        if (existing) return existing;
        const col: Collection = {
          id: genId(),
          name: DEFAULT_NAMES[game],
          game,
          isDefault: true,
          createdAt: new Date().toISOString(),
          cardIds: [],
        };
        set((s) => ({ collections: [col, ...s.collections] }));
        return col;
      },

      getByGame: (game) => get().collections.filter((c) => c.game === game),

      getDefault: (game) =>
        get().collections.find((c) => c.game === game && c.isDefault),

      create: (name, game) => {
        const col: Collection = {
          id: genId(),
          name,
          game,
          isDefault: false,
          createdAt: new Date().toISOString(),
          cardIds: [],
        };
        set((s) => ({ collections: [...s.collections, col] }));
        return col;
      },

      // Default collections cannot be deleted
      deleteCollection: (id) =>
        set((s) => ({
          collections: s.collections.filter((c) => c.id !== id || c.isDefault),
        })),

      addCard: (collectionId, cardId) =>
        set((s) => ({
          collections: s.collections.map((c) =>
            c.id !== collectionId || c.cardIds.includes(cardId)
              ? c
              : { ...c, cardIds: [cardId, ...c.cardIds] },
          ),
        })),

      removeCard: (collectionId, cardId) =>
        set((s) => ({
          collections: s.collections.map((c) =>
            c.id !== collectionId
              ? c
              : { ...c, cardIds: c.cardIds.filter((id) => id !== cardId) },
          ),
        })),

      removeCardFromAll: (cardId) =>
        set((s) => ({
          collections: s.collections.map((c) => ({
            ...c,
            cardIds: c.cardIds.filter((id) => id !== cardId),
          })),
        })),

      isInCollection: (collectionId, cardId) => {
        const col = get().collections.find((c) => c.id === collectionId);
        return col?.cardIds.includes(cardId) ?? false;
      },

      getCardCollectionIds: (cardId, game) =>
        get()
          .collections.filter(
            (c) => c.game === game && c.cardIds.includes(cardId),
          )
          .map((c) => c.id),
    }),
    {
      name: "tcg:collections",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
