import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Animated,
  Keyboard,
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
  const [kbHeight, setKbHeight] = useState(0);
  const [visible, setVisible] = useState(false);
  const [showNewList, setShowNewList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  const { save: saveCard, remove: removeCard, isSaved } = useSavedCardsStore();
  const {
    ensureDefault,
    getByGame,
    create: createCollection,
    rename: renameCollection,
    addCard,
    removeCard: removeFromCollection,
    removeCardFromAll,
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

  // Save to default immediately when sheet opens for a new card
  useEffect(() => {
    if (!isOpen) return;
    const def = ensureDefault(game);
    if (!alreadySaved) {
      saveCard(cardData);
      addCard(def.id, cardId);
    }
    setShowNewList(false);
    setNewListName("");
    setRenamingId(null);
    setRenameText("");
  }, [isOpen, game, cardId, alreadySaved]);

  // Shift the sheet above the keyboard
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      setKbHeight(e.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setKbHeight(0);
    });
    return () => { show.remove(); hide.remove(); };
  }, []);

  const collections = getByGame(game);

  const toggle = useCallback((colId: string) => {
    const def = ensureDefault(game);
    const col = collections.find((c) => c.id === colId);
    if (!col || col.isDefault) return;

    const inCollection = col.cardIds.includes(cardId);
    if (inCollection) {
      removeFromCollection(colId, cardId);
    } else {
      addCard(def.id, cardId);
      addCard(colId, cardId);
    }
  }, [game, cardId, collections, ensureDefault, addCard, removeFromCollection]);

  const handleRemove = useCallback(() => {
    removeCard(cardId);
    removeCardFromAll(cardId);
    onClose();
  }, [cardId, removeCard, removeCardFromAll, onClose]);

  const handleCreateList = useCallback(() => {
    const name = newListName.trim();
    if (!name) return;
    const def = ensureDefault(game);
    const col = createCollection(name, game);
    // Immediately add the card to the new list
    addCard(def.id, cardId);
    addCard(col.id, cardId);
    setNewListName("");
    setShowNewList(false);
    Keyboard.dismiss();
  }, [newListName, game, cardId, ensureDefault, createCollection, addCard]);

  const handleRenameSubmit = useCallback(() => {
    const name = renameText.trim();
    if (name && renamingId) {
      renameCollection(renamingId, name);
    }
    setRenamingId(null);
    setRenameText("");
    Keyboard.dismiss();
  }, [renamingId, renameText, renameCollection]);

  const startRename = useCallback((colId: string, currentName: string) => {
    setRenamingId(colId);
    setRenameText(currentName);
    setShowNewList(false);
  }, []);

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>

        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: C.surface, marginBottom: kbHeight, transform: [{ translateY: slideAnim }] },
          ]}
        >
          {/* Handle */}
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: C.border }]} />
          </View>

          {/* Header */}
          <View style={[styles.header, { borderBottomColor: C.border }]}>
            <Text style={[styles.title, { color: C.text }]}>Save to...</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 12, right: 8 }}>
              <Ionicons name="close" size={22} color={C.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Collections */}
          {collections.map((col) => {
            const inCollection = col.isDefault || col.cardIds.includes(cardId);
            const isRenaming = renamingId === col.id;

            return (
              <View key={col.id} style={[styles.row, { borderBottomColor: C.border }]}>
                {isRenaming ? (
                  <View style={styles.renameRow}>
                    <TextInput
                      style={[styles.renameInput, { color: C.text, borderColor: C.accent, backgroundColor: C.bg }]}
                      value={renameText}
                      onChangeText={setRenameText}
                      autoFocus
                      returnKeyType="done"
                      onSubmitEditing={handleRenameSubmit}
                      selectTextOnFocus
                    />
                    <TouchableOpacity onPress={handleRenameSubmit} style={[styles.renameConfirm, { backgroundColor: C.accent }]}>
                      <Text style={styles.renameConfirmText}>Save</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => { setRenamingId(null); Keyboard.dismiss(); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Ionicons name="close-circle" size={20} color={C.textMuted} />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    onPress={() => toggle(col.id)}
                    activeOpacity={col.isDefault ? 1 : 0.65}
                    style={styles.rowInner}
                  >
                    <View style={styles.rowLeft}>
                      <Text style={[styles.rowName, { color: C.text }]}>{col.name}</Text>
                      {col.isDefault && (
                        <Text style={[styles.defaultLabel, { color: C.textMuted }]}>default</Text>
                      )}
                    </View>
                    <View style={styles.rowActions}>
                      {!col.isDefault && (
                        <TouchableOpacity
                          onPress={() => startRename(col.id, col.name)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={styles.editBtn}
                        >
                          <Ionicons name="pencil-outline" size={16} color={C.textMuted} />
                        </TouchableOpacity>
                      )}
                      {inCollection ? (
                        <Ionicons name="checkmark-circle" size={22} color={C.accent} />
                      ) : (
                        <Ionicons name="ellipse-outline" size={22} color={C.textMuted} />
                      )}
                    </View>
                  </TouchableOpacity>
                )}
              </View>
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
              <TouchableOpacity onPress={handleCreateList} style={[styles.createBtn, { backgroundColor: C.accent }]}>
                <Text style={styles.createBtnText}>Create</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => { setShowNewList(true); setRenamingId(null); }}
              style={[styles.newListBtn, { borderTopColor: C.border }]}
            >
              <Ionicons name="add-circle-outline" size={20} color={C.accent} />
              <Text style={[styles.newListBtnText, { color: C.accent }]}>New list</Text>
            </TouchableOpacity>
          )}

          {/* Remove */}
          <TouchableOpacity
            onPress={handleRemove}
            style={[styles.removeBtn, { borderTopColor: C.border }]}
          >
            <Text style={[styles.removeBtnText, { color: C.error }]}>Remove from saved</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
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
  row: { borderBottomWidth: StyleSheet.hairlineWidth },
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  rowLeft: { flex: 1, gap: 2 },
  rowName: { fontSize: 15 },
  defaultLabel: { fontSize: 11 },
  rowActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  editBtn: { padding: 2 },
  renameRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  renameInput: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    fontSize: 15,
  },
  renameConfirm: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  renameConfirmText: { color: "#fff", fontWeight: "700", fontSize: 14 },
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
