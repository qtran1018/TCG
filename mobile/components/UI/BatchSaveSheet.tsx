import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Animated,
  Keyboard,
  Modal,
  ScrollView,
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
  cards: SavedCard[];
  game: Game;
  onClose: () => void;
}

export function BatchSaveSheet({ isOpen, cards, game, onClose }: Props) {
  const C = useColors();
  const slideAnim = useRef(new Animated.Value(500)).current;
  const [kbHeight, setKbHeight] = useState(0);
  const [visible, setVisible] = useState(false);
  const [showNewList, setShowNewList] = useState(false);
  const [newListName, setNewListName] = useState("");

  const { save: saveCard } = useSavedCardsStore();
  const {
    ensureDefault,
    getByGame,
    create: createCollection,
    addCard,
    removeCard: removeFromCollection,
  } = useCollectionsStore();

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

  // Save all cards to default collection on open
  useEffect(() => {
    if (!isOpen || cards.length === 0) return;
    const def = ensureDefault(game);
    cards.forEach((card) => {
      saveCard(card);
      addCard(def.id, card.id);
    });
    setShowNewList(false);
    setNewListName("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, game]);

  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) =>
      setKbHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const collections = getByGame(game);

  // A non-default collection is "checked" only when ALL cards are in it
  const allIn = useCallback(
    (colId: string) => {
      const col = collections.find((c) => c.id === colId);
      if (!col) return false;
      return cards.every((card) => col.cardIds.includes(card.id));
    },
    [collections, cards],
  );

  const toggle = useCallback(
    (colId: string) => {
      const col = collections.find((c) => c.id === colId);
      if (!col || col.isDefault) return;
      if (allIn(colId)) {
        cards.forEach((card) => removeFromCollection(colId, card.id));
      } else {
        cards.forEach((card) => addCard(colId, card.id));
      }
    },
    [collections, cards, allIn, addCard, removeFromCollection],
  );

  const handleCreateList = useCallback(() => {
    const name = newListName.trim();
    if (!name) return;
    const col = createCollection(name, game);
    cards.forEach((card) => addCard(col.id, card.id));
    setNewListName("");
    setShowNewList(false);
    Keyboard.dismiss();
  }, [newListName, game, cards, createCollection, addCard]);

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
            {
              backgroundColor: C.surface,
              marginBottom: kbHeight,
              transform: [{ translateY: slideAnim }],
            },
          ]}
        >
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: C.border }]} />
          </View>

          <View style={[styles.header, { borderBottomColor: C.border }]}>
            <Text style={[styles.title, { color: C.text }]}>
              Save {cards.length} card{cards.length !== 1 ? "s" : ""} to...
            </Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 10, bottom: 10, left: 12, right: 8 }}
            >
              <Ionicons name="close" size={22} color={C.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView bounces={false}>
            {collections.map((col) => {
              const checked = col.isDefault || allIn(col.id);
              return (
                <View key={col.id} style={[styles.row, { borderBottomColor: C.border }]}>
                  <TouchableOpacity
                    onPress={() => toggle(col.id)}
                    activeOpacity={col.isDefault ? 1 : 0.65}
                    style={styles.rowInner}
                  >
                    <View style={styles.rowLeft}>
                      <Text style={[styles.rowName, { color: C.text }]}>{col.name}</Text>
                      {col.isDefault && (
                        <Text style={[styles.defaultLabel, { color: C.textMuted }]}>
                          default
                        </Text>
                      )}
                    </View>
                    {checked ? (
                      <Ionicons name="checkmark-circle" size={22} color={C.accent} />
                    ) : (
                      <Ionicons name="ellipse-outline" size={22} color={C.textMuted} />
                    )}
                  </TouchableOpacity>
                </View>
              );
            })}

            {showNewList ? (
              <View style={[styles.newListRow, { borderTopColor: C.border }]}>
                <TextInput
                  style={[
                    styles.newListInput,
                    { color: C.text, borderColor: C.border, backgroundColor: C.bg },
                  ]}
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
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 36,
    overflow: "hidden",
    maxHeight: "70%",
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
  createBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8 },
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
});
