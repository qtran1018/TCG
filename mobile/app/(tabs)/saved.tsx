import React from "react";
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  Image, Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useSavedCardsStore } from "@/store/savedCardsStore";
import { useCollectionsStore, type Collection } from "@/store/collectionsStore";

const CELL = 38;
const GAP = 2;
const GRID_SIZE = CELL * 2 + GAP;

export default function SavedScreen() {
  const router = useRouter();
  const C = useColors();
  const { cards: savedCards } = useSavedCardsStore();
  const { collections, deleteCollection } = useCollectionsStore();

  const activeCollections = collections.filter((c) => c.cardIds.length > 0);

  const getPreviewUrls = (col: Collection): (string | null)[] =>
    col.cardIds.slice(0, 4).map(
      (id) => savedCards.find((c) => c.id === id)?.image_url ?? null,
    );

  const handleLongPress = (col: Collection) => {
    if (col.isDefault) return;
    Alert.alert(
      `Delete "${col.name}"?`,
      "Cards will remain in your other lists.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete List",
          style: "destructive",
          onPress: () => deleteCollection(col.id),
        },
      ],
    );
  };

  if (activeCollections.length === 0) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["bottom"]}>
        <View style={styles.empty}>
          <Ionicons name="bookmark-outline" size={48} color={C.border} />
          <Text style={[styles.emptyTitle, { color: C.text }]}>No saved cards yet</Text>
          <Text style={[styles.emptyHint, { color: C.textMuted }]}>
            Tap the star on any card to save it here.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["bottom"]}>
      <FlatList
        data={activeCollections}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: C.border }]} />}
        renderItem={({ item }) => (
          <CollectionRow
            collection={item}
            previewUrls={getPreviewUrls(item)}
            onPress={() =>
              router.push({
                pathname: "/collection/[id]",
                params: { id: item.id },
              })
            }
            onLongPress={() => handleLongPress(item)}
          />
        )}
      />
    </SafeAreaView>
  );
}

function CollectionRow({
  collection,
  previewUrls,
  onPress,
  onLongPress,
}: {
  collection: Collection;
  previewUrls: (string | null)[];
  onPress: () => void;
  onLongPress: () => void;
}) {
  const C = useColors();
  const cells = [0, 1, 2, 3];

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
      style={[styles.row, { backgroundColor: C.bg }]}
    >
      {/* 2×2 thumbnail grid */}
      <View style={[styles.previewGrid, { backgroundColor: C.border }]}>
        <View style={styles.previewRow}>
          {cells.slice(0, 2).map((i) =>
            previewUrls[i] ? (
              <Image
                key={i}
                source={{ uri: previewUrls[i]! }}
                style={[styles.previewCell, { backgroundColor: C.surface }]}
                resizeMode="cover"
              />
            ) : (
              <View key={i} style={[styles.previewCell, { backgroundColor: C.surface }]} />
            ),
          )}
        </View>
        <View style={[styles.previewRow, { marginTop: GAP }]}>
          {cells.slice(2, 4).map((i) =>
            previewUrls[i] ? (
              <Image
                key={i}
                source={{ uri: previewUrls[i]! }}
                style={[styles.previewCell, { backgroundColor: C.surface }]}
                resizeMode="cover"
              />
            ) : (
              <View key={i} style={[styles.previewCell, { backgroundColor: C.surface }]} />
            ),
          )}
        </View>
      </View>

      {/* Info */}
      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: C.text }]} numberOfLines={1}>
            {collection.name}
          </Text>
          {collection.isDefault && (
            <View style={[styles.defaultBadge, { backgroundColor: C.accentDim }]}>
              <Text style={[styles.defaultBadgeText, { color: C.accent }]}>default</Text>
            </View>
          )}
        </View>
        <Text style={[styles.count, { color: C.textMuted }]}>
          {collection.cardIds.length} card{collection.cardIds.length !== 1 ? "s" : ""}
        </Text>
        {!collection.isDefault && (
          <Text style={[styles.hint, { color: C.textMuted }]}>Long press to delete</Text>
        )}
      </View>

      <Ionicons name="chevron-forward" size={18} color={C.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  list: { paddingVertical: 8 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: GRID_SIZE + 16 + 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  previewGrid: {
    width: GRID_SIZE,
    height: GRID_SIZE,
    borderRadius: 8,
    overflow: "hidden",
  },
  previewRow: { flexDirection: "row", gap: GAP },
  previewCell: { width: CELL, height: CELL },
  info: { flex: 1, gap: 3 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: { fontSize: 15, fontWeight: "700", flexShrink: 1 },
  defaultBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  defaultBadgeText: { fontSize: 10, fontWeight: "700" },
  count: { fontSize: 13 },
  hint: { fontSize: 11 },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyTitle: { fontSize: 18, fontWeight: "700" },
  emptyHint: { fontSize: 14, textAlign: "center", lineHeight: 20 },
});
