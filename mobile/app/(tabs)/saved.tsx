import React, { useState } from "react";
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, Image,
  useWindowDimensions, Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, GAMES, type Game } from "@/constants";
import { useSavedCardsStore, type SavedCard } from "@/store/savedCardsStore";

type GameFilter = Game | "all";
type ViewMode = "list" | "grid";

const CARD_ASPECT = 512 / 367;
const GRID_COLS = 2;
const GRID_GAP = 10;
const GRID_PADDING = 16;

export default function SavedScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { cards, remove, clearAll } = useSavedCardsStore();
  const [gameFilter, setGameFilter] = useState<GameFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  const cellWidth = (width - GRID_PADDING * 2 - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
  const cellHeight = cellWidth * CARD_ASPECT;

  const filtered =
    gameFilter === "all" ? cards : cards.filter((c) => c.game === gameFilter);

  const handleViewCard = (card: SavedCard) => {
    router.push({
      pathname: "/card/[id]",
      params: { id: String(card.id), language: card.language },
    });
  };

  const handleRemove = (id: number) => remove(id);

  const handleClearAll = () => {
    Alert.alert(
      "Clear All Saved Cards",
      "Remove all saved cards? This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear All", style: "destructive", onPress: clearAll },
      ],
    );
  };

  if (cards.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["bottom"]}>
        <View style={styles.empty}>
          <Ionicons name="bookmark-outline" size={48} color={COLORS.border} />
          <Text style={styles.emptyTitle}>No saved cards yet</Text>
          <Text style={styles.emptyHint}>
            After scanning, tap the bookmark icon on any card to save it here.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      {/* Filter + view mode row */}
      <View style={styles.controls}>
        <View style={styles.filterRow}>
          <FilterPill label="All" value="all" current={gameFilter} onPress={setGameFilter} />
          {GAMES.map((g) => (
            <FilterPill key={g.key} label={g.label} value={g.key} current={gameFilter} onPress={setGameFilter} />
          ))}
        </View>
        <View style={styles.viewToggle}>
          <TouchableOpacity onPress={() => setViewMode("list")} style={styles.viewBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
            <Ionicons name="list-outline" size={20} color={viewMode === "list" ? COLORS.accent : COLORS.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setViewMode("grid")} style={styles.viewBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
            <Ionicons name="grid-outline" size={20} color={viewMode === "grid" ? COLORS.accent : COLORS.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Count + clear */}
      <View style={styles.countRow}>
        <Text style={styles.countText}>
          {filtered.length} card{filtered.length !== 1 ? "s" : ""}
          {gameFilter !== "all" ? ` · ${GAMES.find((g) => g.key === gameFilter)?.label}` : ""}
        </Text>
        {cards.length > 0 && (
          <TouchableOpacity onPress={handleClearAll}>
            <Text style={styles.clearAllText}>Clear all</Text>
          </TouchableOpacity>
        )}
      </View>

      {viewMode === "list" ? (
        <FlatList
          key="list"
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <ListRow card={item} onView={handleViewCard} onRemove={handleRemove} />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      ) : (
        <FlatList
          key="grid"
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          numColumns={GRID_COLS}
          contentContainerStyle={styles.gridContent}
          columnWrapperStyle={styles.gridRow}
          renderItem={({ item }) => (
            <GridCell
              card={item}
              cellWidth={cellWidth}
              cellHeight={cellHeight}
              onView={handleViewCard}
              onRemove={handleRemove}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function FilterPill({
  label, value, current, onPress,
}: {
  label: string;
  value: GameFilter;
  current: GameFilter;
  onPress: (v: GameFilter) => void;
}) {
  const isActive = value === current;
  return (
    <TouchableOpacity
      style={[styles.pill, isActive && styles.pillActive]}
      onPress={() => onPress(value)}
      activeOpacity={0.7}
    >
      <Text style={[styles.pillText, isActive && styles.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ListRow({
  card, onView, onRemove,
}: {
  card: SavedCard;
  onView: (c: SavedCard) => void;
  onRemove: (id: number) => void;
}) {
  return (
    <TouchableOpacity style={styles.listRow} onPress={() => onView(card)} activeOpacity={0.8}>
      {card.image_url ? (
        <Image source={{ uri: card.image_url }} style={styles.listThumb} resizeMode="contain" />
      ) : (
        <View style={[styles.listThumb, styles.thumbPlaceholder]}>
          <Text style={styles.placeholderText}>?</Text>
        </View>
      )}
      <View style={styles.listInfo}>
        <Text style={styles.listName} numberOfLines={1}>{card.name}</Text>
        <Text style={styles.listSet} numberOfLines={1}>{card.set_name}</Text>
        <View style={styles.listBadges}>
          <Text style={styles.badge}>{card.language === "ja" ? "🇯🇵" : "🇺🇸"}</Text>
          {card.card_number ? <Text style={styles.badge}>#{card.card_number}</Text> : null}
          <Text style={[styles.badge, card.game === "pokemon" ? styles.badgePokemon : styles.badgeOP]}>
            {card.game === "pokemon" ? "Pokémon" : "One Piece"}
          </Text>
        </View>
      </View>
      <TouchableOpacity
        onPress={() => onRemove(card.id)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={styles.deleteBtn}
      >
        <Ionicons name="trash-outline" size={18} color={COLORS.textMuted} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

function GridCell({
  card, cellWidth, cellHeight, onView, onRemove,
}: {
  card: SavedCard;
  cellWidth: number;
  cellHeight: number;
  onView: (c: SavedCard) => void;
  onRemove: (id: number) => void;
}) {
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
          <View style={[styles.thumbPlaceholder, { width: cellWidth, height: cellHeight, borderRadius: 8 }]}>
            <Text style={styles.placeholderText}>?</Text>
          </View>
        )}
        <Text style={styles.gridName} numberOfLines={2}>{card.name}</Text>
        <Text style={styles.gridSet} numberOfLines={1}>{card.set_name}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.gridDelete}
        onPress={() => onRemove(card.id)}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      >
        <Ionicons name="close-circle" size={20} color={COLORS.error} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },

  controls: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: GRID_PADDING,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 10,
  },
  filterRow: { flex: 1, flexDirection: "row", gap: 6, flexWrap: "wrap" },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  pillActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  pillText: { color: COLORS.textMuted, fontSize: 12, fontWeight: "600" },
  pillTextActive: { color: "#fff" },

  viewToggle: { flexDirection: "row", gap: 4 },
  viewBtn: { padding: 4 },

  countRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: GRID_PADDING,
    paddingBottom: 8,
  },
  countText: { color: COLORS.textMuted, fontSize: 12 },
  clearAllText: { color: COLORS.error, fontSize: 12, fontWeight: "600" },

  // List mode
  listContent: { paddingHorizontal: GRID_PADDING, paddingBottom: 40 },
  separator: { height: 8 },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 10,
  },
  listThumb: { width: 44, height: 62, borderRadius: 4 },
  thumbPlaceholder: {
    backgroundColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderText: { color: COLORS.textMuted, fontSize: 18 },
  listInfo: { flex: 1, gap: 3 },
  listName: { color: COLORS.text, fontSize: 14, fontWeight: "600" },
  listSet: { color: COLORS.textMuted, fontSize: 11 },
  listBadges: { flexDirection: "row", gap: 5, flexWrap: "wrap", marginTop: 2 },
  badge: {
    color: COLORS.textMuted,
    fontSize: 10,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgePokemon: { color: COLORS.pokemon },
  badgeOP: { color: COLORS.onepiece },
  deleteBtn: { padding: 4 },

  // Grid mode
  gridContent: { padding: GRID_PADDING, paddingBottom: 40 },
  gridRow: { gap: GRID_GAP, marginBottom: GRID_GAP },
  gridCell: { position: "relative" },
  gridImage: { borderRadius: 8 },
  gridName: { color: COLORS.text, fontSize: 12, fontWeight: "600", marginTop: 5, lineHeight: 15 },
  gridSet: { color: COLORS.textMuted, fontSize: 10, marginTop: 2 },
  gridDelete: {
    position: "absolute",
    top: 4,
    right: 4,
    backgroundColor: "rgba(15,15,20,0.7)",
    borderRadius: 10,
  },

  // Empty
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 40 },
  emptyTitle: { color: COLORS.text, fontSize: 18, fontWeight: "700" },
  emptyHint: { color: COLORS.textMuted, fontSize: 14, textAlign: "center", lineHeight: 20 },
});
