import React from "react";
import { View, Text, Image, TouchableOpacity, StyleSheet } from "react-native";
import { COLORS } from "@/constants";
import type { CardOut } from "@/services/api";

interface Props {
  card: CardOut;
  onPress: (card: CardOut) => void;
  selected?: boolean;
}

export function CardListItem({ card, onPress, selected }: Props) {
  const displayName = card.language === "ja" && card.name_ja ? card.name_ja : card.name;

  return (
    <TouchableOpacity
      style={[styles.container, selected && styles.selectedContainer]}
      onPress={() => onPress(card)}
      activeOpacity={0.75}
    >
      {card.image_url ? (
        <Image source={{ uri: card.image_url }} style={styles.image} resizeMode="contain" />
      ) : (
        <View style={styles.imagePlaceholder}>
          <Text style={styles.placeholderText}>?</Text>
        </View>
      )}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={2}>
          {displayName}
        </Text>
        {card.set_name && (
          <Text style={styles.setName} numberOfLines={1}>
            {card.set_name}
          </Text>
        )}
        <View style={styles.meta}>
          {card.card_number && (
            <Text style={styles.badge}>#{card.card_number}</Text>
          )}
          {card.rarity && (
            <Text style={styles.badge}>{card.rarity}</Text>
          )}
        </View>
      </View>
      {selected && <View style={styles.checkDot} />}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    gap: 12,
    borderWidth: 1.5,
    borderColor: COLORS.border,
  },
  selectedContainer: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentDim,
  },
  image: { width: 64, height: 90, borderRadius: 6 },
  imagePlaceholder: {
    width: 64,
    height: 90,
    borderRadius: 6,
    backgroundColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderText: { color: COLORS.textMuted, fontSize: 24 },
  info: { flex: 1, justifyContent: "center", gap: 4 },
  name: { color: COLORS.text, fontSize: 15, fontWeight: "600", lineHeight: 20 },
  setName: { color: COLORS.textMuted, fontSize: 12 },
  meta: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  badge: {
    color: COLORS.accent,
    fontSize: 11,
    backgroundColor: "rgba(108,99,255,0.15)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  checkDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.accent,
    alignSelf: "center",
  },
});
