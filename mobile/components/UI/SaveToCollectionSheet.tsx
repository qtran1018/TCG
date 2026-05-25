import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useCollectionsStore } from "@/store/collectionsStore";
import { useSavedCardsStore, type SavedCard } from "@/store/savedCardsStore";
import { useColors } from "@/hooks/useColors";
import type { Game } from "@/constants";

interface Props {
  isOpen: boolean;
  cardId: number;
  cardData: SavedCard;
  game: Game;
  onClose: () => void;
}

export function SaveToCollectionSheet({ isOpen, cardId, cardData, game, onClose }: Props) {
  const C = useColors();
  const slideAnim = useRef(new Animated.Value(500)).current;
  const [visible, setVisible] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [showNewList, setShowNewList] = useState(false);
  const [newListName, setNewListName] = useState("");

  const { save: saveCard, remove: removeCard, isSaved } = useSavedCardsStore();
  const {
    ensureDefault,
    getByGame,
    create: createCollection,
    addCard,
    removeCard: removeFromCollection,
    removeCardFromAll,
    getCardCollectionIds,
  } = useCollectionsStore();

  const alreadySaved = isSaved(cardId);

  // Mount/unmount modal around animation
  useEffect(() => {
    if (isOpen) {
      setVisible(true);
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 60,
        friction: 11,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: 500,
        duration: 220,
        useNativeDriver: true,
      }).start(() => setVisible(false));
    }
  }, [isOpen, slideAnim]);

  // Refresh checked state whenever the sheet opens
  useEffect(() => {
    if (!isOpen) return;
    const def = ensureDefault(game);
    if (alreadySaved) {
      const ids = getCardCollectionIds(cardId, game);
      setCheckedIds(new Set(ids.length > 0 ? ids : [def.id]));
    } else {
      setCheckedIds(new Set([def.id]));
    }
    setShowNewList(false);
    setNewListName("");
  }, [isOpen, game, cardId, alreadySaved]);

  const collections = getByGame(game);

  const toggle = useCallback((colId: string, isDefault: boolean) => {
    if (isDefault) return;
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId);
      else next.add(colId);
      return next;
    });
  }, []);

  const handleDone = useCallback(() => {
    const def = ensureDefault(game);

    // Add to master saved store if not already there
    if (!alreadySaved) {
      saveCard(cardData);
    }

    // Default collection is always included
    addCard(def.id, cardId);

    // Sync custom collections: add newly checked, remove newly unchecked
    for (const col of collections) {
      if (col.isDefault) continue;
      if (checkedIds.has(col.id)) {
        addCard(col.id, cardId);
      } else {
        removeFromCollection(col.id, cardId);
      }
    }

    onClose();
  }, [game, alreadySaved, cardData, cardId, collections, checkedIds, ensureDefault, saveCard, addCard, removeFromCollection, onClose]);

  const handleRemove = useCallback(() => {
    removeCard(cardId);
    removeCardFromAll(cardId);
    onClose();
  }, [cardId, removeCard, removeCardFromAll, onClose]);

  const handleCreateList = useCallback(() => {
    const name = newListName.trim();
    if (!name) return;
    const col = createCollection(name, game);
    setCheckedIds((prev) => new Set([...prev, col.id]));
    setNewListName("");
    setShowNewList(false);
    Keyboard.dismiss();
  }, [newListName, game, createCollection]);

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Backdrop */}
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>

        {/* Sheet */}
        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: C.surface, transform: [{ translateY: slideAnim }] },
          ]}
        >
          {/* Handle */}
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: C.border }]} />
          </View>

          {/* Header */}
          <View style={[styles.header, { borderBottomColor: C.border }]}>
            <Text style={[styles.title, { color: C.text }]}>
              {alreadySaved ? "Saved to..." : "Save to..."}
            </Text>
            <TouchableOpacity
              onPress={handleDone}
              hitSlop={{ top: 10, bottom: 10, left: 12, right: 8 }}
            >
              <Text style={[styles.doneText, { color: C.accent }]}>Done</Text>
            </TouchableOpacity>
          </View>

          {/* Collections */}
          {collections.map((col) => {
            const checked = col.isDefault || checkedIds.has(col.id);
            return (
              <TouchableOpacity
                key={col.id}
                onPress={() => toggle(col.id, col.isDefault)}
                style={[styles.row, { borderBottomColor: C.border }]}
                activeOpacity={col.isDefault ? 1 : 0.65}
              >
                <View style={styles.rowLeft}>
                  <Text style={[styles.rowName, { color: C.text }]}>{col.name}</Text>
                  {col.isDefault && (
                    <Text style={[styles.defaultLabel, { color: C.textMuted }]}>default</Text>
                  )}
                </View>
                {checked ? (
                  <Ionicons name="checkmark-circle" size={22} color={C.accent} />
                ) : (
                  <Ionicons name="ellipse-outline" size={22} color={C.textMuted} />
                )}
              </TouchableOpacity>
            );
          })}

          {/* New list */}
          {showNewList ? (
            <View style={[styles.newListRow, { borderTopColor: C.border }]}>
              <TextInput
                style={[styles.newListInput, { color: C.text, borderColor: C.border, backgroundColor: C.bg }]}
                placeholder="List name..."
                placeholderTextColor={C.textMuted}
                value={newListName}
                onChangeText={setNewListName}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleCreateList}
              />
              <TouchableOpacity
                onPress={handleCreateList}
                style={[styles.createBtn, { backgroundColor: C.accent }]}
              >
                <Text style={styles.createBtnText}>Create</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => setShowNewList(true)}
              style={[styles.newListBtn, { borderTopColor: C.border }]}
            >
              <Ionicons name="add-circle-outline" size={20} color={C.accent} />
              <Text style={[styles.newListBtnText, { color: C.accent }]}>New list</Text>
            </TouchableOpacity>
          )}

          {/* Remove — only visible when already saved */}
          {alreadySaved && (
            <TouchableOpacity
              onPress={handleRemove}
              style={[styles.removeBtn, { borderTopColor: C.border }]}
            >
              <Text style={[styles.removeBtnText, { color: C.error }]}>Remove from saved</Text>
            </TouchableOpacity>
          )}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 36,
    overflow: "hidden",
  },
  handleWrap: { alignItems: "center", paddingTop: 10, paddingBottom: 4 },
  handle: { width: 36, height: 4, borderRadius: 2 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 16, fontWeight: "700" },
  doneText: { fontSize: 15, fontWeight: "700" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: { flex: 1, gap: 2 },
  rowName: { fontSize: 15 },
  defaultLabel: { fontSize: 11 },
  newListRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  newListInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  createBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
  },
  createBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  newListBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  newListBtnText: { fontSize: 15, fontWeight: "600" },
  removeBtn: {
    alignItems: "center",
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  removeBtnText: { fontSize: 15, fontWeight: "600" },
});
