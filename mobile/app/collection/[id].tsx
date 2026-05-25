import React, { useMemo, useRef, useState } from "react";
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  Image, Alert, useWindowDimensions, TextInput, Keyboard,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useSavedCardsStore, type SavedCard } from "@/store/savedCardsStore";
import { useCollectionsStore } from "@/store/collectionsStore";

type ViewMode = "list" | "grid";

const GRID_COLS = 2;
const GRID_GAP = 10;
const GRID_PADDING = 16;
const CARD_ASPECT = 512 / 367;

export default function CollectionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const C = useColors();
  const { width } = useWindowDimensions();
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");
  const renameInputRef = useRef<TextInput>(null);

  const { cards: savedCards, remove: removeSaved } = useSavedCardsStore();
  const { collections, removeCard, removeCardFromAll, deleteCollection, rename } =
    useCollectionsStore();

  const collection = collections.find((c) => c.id === id);

  const cards = useMemo(
    () =>
      (collection?.cardIds ?? [])
        .map((cid) => savedCards.find((c) => c.id === cid))
        .filter((c): c is SavedCard => c !== undefined),
    [collection?.cardIds, savedCards],
  );

  const cellWidth =
    (width - GRID_PADDING * 2 - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
  const cellHeight = cellWidth * CARD_ASPECT;

  const handleViewCard = (card: SavedCard) => {
    router.push({
      pathname: "/card/[id]",
      params: { id: String(card.id), language: card.language },
    });
  };

  const handleRemoveCard = (cardId: number) => {
    if (!collection) return;
    if (collection.isDefault) {
      Alert.alert("Remove from saved?", "This will remove the card from all lists.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            removeSaved(cardId);
            removeCardFromAll(cardId);
          },
        },
      ]);
    } else {
      removeCard(id, cardId);
    }
  };

  const startRename = () => {
    if (!collection) return;
    setRenameText(collection.name);
    setIsRenaming(true);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  };

  const submitRename = () => {
    const name = renameText.trim();
    if (name && collection) rename(id, name);
    setIsRenaming(false);
    Keyboard.dismiss();
  };

  const cancelRename = () => {
    setIsRenaming(false);
    Keyboard.dismiss();
  };

  const handleDeleteCollection = () => {
    if (!collection) return;
    Alert.alert(
      `Delete "${collection.name}"?`,
      "Cards will remain in your other lists.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete List",
          style: "destructive",
          onPress: () => {
            deleteCollection(id);
            router.back();
          },
        },
      ],
    );
  };

  const headerTitle = () =>
    isRenaming ? (
      <View style={styles.renameTitleRow}>
        <TextInput
          ref={renameInputRef}
          style={[styles.renameTitleInput, { color: C.text, borderColor: C.accent }]}
          value={renameText}
          onChangeText={setRenameText}
          returnKeyType="done"
          onSubmitEditing={submitRename}
          selectTextOnFocus
          autoFocus
        />
        <TouchableOpacity onPress={submitRename} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
          <Ionicons name="checkmark" size={22} color={C.accent} />
        </TouchableOpacity>
        <TouchableOpacity onPress={cancelRename} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
          <Ionicons name="close" size={22} color={C.textMuted} />
        </TouchableOpacity>
      </View>
    ) : null;

  const headerRight = () => (
    <View style={styles.headerRight}>
      {!isRenaming && (
        <>
          <TouchableOpacity
            onPress={() => setViewMode("list")}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <Ionicons
              name="list-outline"
              size={20}
              color={viewMode === "list" ? C.accent : C.textMuted}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setViewMode("grid")}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <Ionicons
              name="grid-outline"
              size={20}
              color={viewMode === "grid" ? C.accent : C.textMuted}
            />
          </TouchableOpacity>
          {collection && !collection.isDefault && (
            <>
              <TouchableOpacity
                onPress={startRename}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Ionicons name="pencil-outline" size={19} color={C.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleDeleteCollection}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Ionicons name="trash-outline" size={19} color={C.error} />
              </TouchableOpacity>
            </>
          )}
        </>
      )}
    </View>
  );

  if (!collection) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["bottom"]}>
        <Stack.Screen options={{ title: "Collection" }} />
        <View style={styles.centered}>
          <Text style={[styles.errorText, { color: C.error }]}>Collection not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: isRenaming ? "" : collection.name,
          headerTitle: isRenaming ? headerTitle : undefined,
          headerRight,
        }}
      />

      {cards.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="bookmark-outline" size={40} color={C.border} />
          <Text style={[styles.emptyText, { color: C.textMuted }]}>No cards in this list.</Text>
        </View>
      ) : viewMode === "list" ? (
        <FlatList
          key="list"
          data={cards}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          renderItem={({ item }) => (
            <ListRow
              card={item}
              isDefault={collection.isDefault}
              onView={handleViewCard}
              onRemove={handleRemoveCard}
            />
          )}
        />
      ) : (
        <FlatList
          key="grid"
          data={cards}
          keyExtractor={(item) => String(item.id)}
          numColumns={GRID_COLS}
          contentContainerStyle={styles.gridContent}
          columnWrapperStyle={{ gap: GRID_GAP, marginBottom: GRID_GAP }}
          renderItem={({ item }) => (
            <GridCell
              card={item}
              cellWidth={cellWidth}
              cellHeight={cellHeight}
              onView={handleViewCard}
              onRemove={handleRemoveCard}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function ListRow({
  card,
  isDefault,
  onView,
  onRemove,
}: {
  card: SavedCard;
  isDefault: boolean;
  onView: (c: SavedCard) => void;
  onRemove: (id: number) => void;
}) {
  const C = useColors();
  return (
    <TouchableOpacity
      onPress={() => onView(card)}
      activeOpacity={0.8}
      style={[styles.listRow, { backgroundColor: C.surface, borderColor: C.border }]}
    >
      {card.image_url ? (
        <Image source={{ uri: card.image_url }} style={styles.listThumb} resizeMode="contain" />
      ) : (
        <View style={[styles.listThumb, styles.thumbPlaceholder, { backgroundColor: C.border }]}>
          <Text style={[styles.placeholderText, { color: C.textMuted }]}>?</Text>
        </View>
      )}
      <View style={styles.listInfo}>
        <Text style={[styles.listName, { color: C.text }]} numberOfLines={1}>
          {card.name}
        </Text>
        <Text style={[styles.listSet, { color: C.textMuted }]} numberOfLines={1}>
          {card.set_name}
        </Text>
        <View style={styles.listBadges}>
          {card.card_number ? (
            <Text style={[styles.badge, { color: C.textMuted, backgroundColor: C.bg }]}>
              #{card.card_number}
            </Text>
          ) : null}
          <Text
            style={[
              styles.badge,
              { backgroundColor: C.bg },
              card.game === "pokemon"
                ? { color: C.pokemon }
                : { color: C.onepiece },
            ]}
          >
            {card.game === "pokemon" ? "Pokémon" : "One Piece"}
          </Text>
        </View>
      </View>
      <TouchableOpacity
        onPress={() => onRemove(card.id)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={styles.deleteBtn}
      >
        <Ionicons
          name={isDefault ? "trash-outline" : "remove-circle-outline"}
          size={18}
          color={C.textMuted}
        />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

function GridCell({
  card,
  cellWidth,
  cellHeight,
  onView,
  onRemove,
}: {
  card: SavedCard;
  cellWidth: number;
  cellHeight: number;
  onView: (c: SavedCard) => void;
  onRemove: (id: number) => void;
}) {
  const C = useColors();
  return (
    <View style={[styles.gridCell, { width: cellWidth }]}>
      <TouchableOpacity onPress={() => onView(card)} activeOpacity={0.85}>
        {card.image_url ? (
          <Image
            source={{ uri: card.image_url }}
            style={[styles.gridImage, { width: cellWidth, height: cellHeight }]}
            resizeMode="contain"
          />
        ) : (
          <View
            style={[
              styles.thumbPlaceholder,
              { width: cellWidth, height: cellHeight, borderRadius: 8, backgroundColor: C.border },
            ]}
          >
            <Text style={[styles.placeholderText, { color: C.textMuted }]}>?</Text>
          </View>
        )}
        <Text style={[styles.gridName, { color: C.text }]} numberOfLines={2}>
          {card.name}
        </Text>
        <Text style={[styles.gridSet, { color: C.textMuted }]} numberOfLines={1}>
          {card.set_name}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.gridDelete}
        onPress={() => onRemove(card.id)}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      >
        <Ionicons name="close-circle" size={20} color={C.error} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  errorText: { fontSize: 15 },
  emptyText: { fontSize: 14 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 16, marginRight: 4 },
  renameTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  renameTitleInput: {
    borderBottomWidth: 1.5,
    fontSize: 17,
    fontWeight: "600",
    minWidth: 120,
    maxWidth: 200,
    paddingVertical: 2,
    paddingHorizontal: 2,
  },

  listContent: { paddingHorizontal: GRID_PADDING, paddingVertical: 12, paddingBottom: 40 },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    gap: 10,
  },
  listThumb: { width: 44, height: 62, borderRadius: 4 },
  thumbPlaceholder: { alignItems: "center", justifyContent: "center" },
  placeholderText: { fontSize: 18 },
  listInfo: { flex: 1, gap: 3 },
  listName: { fontSize: 14, fontWeight: "600" },
  listSet: { fontSize: 11 },
  listBadges: { flexDirection: "row", gap: 5, flexWrap: "wrap", marginTop: 2 },
  badge: {
    fontSize: 10,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  deleteBtn: { padding: 4 },

  gridContent: { padding: GRID_PADDING, paddingBottom: 40 },
  gridCell: { position: "relative" },
  gridImage: { borderRadius: 8 },
  gridName: { fontSize: 12, fontWeight: "600", marginTop: 5, lineHeight: 15 },
  gridSet: { fontSize: 10, marginTop: 2 },
  gridDelete: {
    position: "absolute",
    top: 4,
    right: 4,
    backgroundColor: "rgba(15,15,20,0.7)",
    borderRadius: 10,
  },
});
