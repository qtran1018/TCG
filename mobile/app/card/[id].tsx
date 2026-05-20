import React, { useEffect, useState } from "react";
import {
  View, Text, ScrollView, StyleSheet, Image,
  ActivityIndicator, TouchableOpacity, Linking,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { PriceDisplay } from "@/components/Card/PriceDisplay";
import { api, CardWithPrice } from "@/services/api";
import { useScanStore } from "@/store/scanStore";
import { COLORS } from "@/constants";

export default function CardDetailScreen() {
  const { id, psaGrade, language: routeLanguage, card_number } = useLocalSearchParams<{
    id: string; psaGrade?: string; language?: string; card_number?: string;
  }>();
  const { scanType } = useScanStore();
  const [data, setData] = useState<CardWithPrice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setIsLoading(true);
    api
      .getCard(
        Number(id),
        scanType,
        routeLanguage,
        card_number,
      )
      .then(setData)
      .catch((e) => setError(e?.message ?? "Failed to load card"))
      .finally(() => setIsLoading(false));
  }, [id, scanType]);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={COLORS.accent} size="large" />
        <Text style={styles.loadingText}>Fetching prices...</Text>
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error ?? "Card not found"}</Text>
      </View>
    );
  }

  const { card, price } = data;
  const pcUrl = price?.pricecharting_url ?? card.pricecharting_url;
  const displayName = card.language === "ja" && card.name_ja ? card.name_ja : card.name;
  const displayImageUrl = card.image_url_hi ?? card.image_url;
  const displayCardNumber = card.card_number;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        {displayImageUrl ? (
          <Image
            source={{ uri: displayImageUrl }}
            style={styles.cardImage}
            resizeMode="contain"
          />
        ) : null}

        <View style={styles.nameRow}>
          <Text style={styles.cardName}>{displayName}</Text>
          {psaGrade ? (
            <View style={styles.gradeBadge}>
              <Text style={styles.gradeBadgeText}>PSA {psaGrade}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.metaGrid}>
          <MetaItem label="Set" value={card.set_name} />
          <MetaItem label="Number" value={displayCardNumber} />
          <MetaItem label="Rarity" value={card.rarity} />
          <MetaItem label="Game" value={card.game === "pokemon" ? "Pokémon" : "One Piece"} />
          {card.name_ja && card.language === "en" && (
            <MetaItem label="JP Name" value={card.name_ja} />
          )}
        </View>

        {price ? (
          <PriceDisplay price={price} scanType={scanType} />
        ) : (
          <View style={styles.noPriceBox}>
            <Text style={styles.noPriceText}>No pricing data available yet.</Text>
          </View>
        )}

        {pcUrl && (
          <TouchableOpacity
            style={styles.pcLink}
            onPress={() => Linking.openURL(pcUrl)}
          >
            <Text style={styles.pcLinkText}>View on PriceCharting →</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function MetaItem({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={styles.metaItem}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg, gap: 12 },
  loadingText: { color: COLORS.textMuted, fontSize: 14 },
  errorText: { color: COLORS.error, fontSize: 15 },
  cardImage: {
    width: "100%",
    height: 320,
    borderRadius: 12,
    backgroundColor: COLORS.surface,
  },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  cardName: { color: COLORS.text, fontSize: 22, fontWeight: "800", flex: 1, lineHeight: 28 },
  gradeBadge: {
    backgroundColor: COLORS.warning,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  gradeBadgeText: { color: "#000", fontWeight: "800", fontSize: 13 },
  metaGrid: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  metaItem: { flexDirection: "row", justifyContent: "space-between" },
  metaLabel: { color: COLORS.textMuted, fontSize: 13 },
  metaValue: { color: COLORS.text, fontSize: 13, fontWeight: "600", maxWidth: "60%", textAlign: "right" },
  noPriceBox: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 20,
    alignItems: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  noPriceText: { color: COLORS.textMuted, fontSize: 14 },
  pcLink: { alignItems: "center", paddingVertical: 12 },
  pcLinkText: { color: COLORS.accent, fontSize: 14, fontWeight: "600" },
});
