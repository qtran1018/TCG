import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, ScrollView, StyleSheet, Image,
  ActivityIndicator, TouchableOpacity, Linking,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { PriceDisplay } from "@/components/Card/PriceDisplay";
import { SaveToCollectionSheet } from "@/components/UI/SaveToCollectionSheet";
import { api, CardWithPrice } from "@/services/api";
import { useScanStore } from "@/store/scanStore";
import { useSavedCardsStore } from "@/store/savedCardsStore";
import type { Game, Language } from "@/constants";
import { COLORS } from "@/constants";

const EN_VARIANTS = [
  { key: "normal", label: "Normal" },
  { key: "1st_edition", label: "1st Edition" },
  { key: "shadowless", label: "Shadowless" },
  { key: "poke_ball", label: "Poké Ball" },
];
const JP_VARIANTS = [
  { key: "normal", label: "Normal" },
  { key: "poke_ball", label: "Poké Ball" },
  { key: "master_ball", label: "Master Ball" },
];

export default function CardDetailScreen() {
  const { id, psaGrade, language: routeLanguage, card_number, speedTest } = useLocalSearchParams<{
    id: string; psaGrade?: string; language?: string; card_number?: string; speedTest?: string;
  }>();
  const isSpeedTest = speedTest === "1";
  const { scanType } = useScanStore();
  const { isSaved } = useSavedCardsStore();
  const [data, setData] = useState<CardWithPrice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailMs, setDetailMs] = useState<number | null>(null);
  const [selectedVariant, setSelectedVariant] = useState("normal");
  const [saveSheetOpen, setSaveSheetOpen] = useState(false);

  const cardSaved = data ? isSaved(data.card.id) : false;

  const openSaveSheet = useCallback(() => {
    if (!data) return;
    setSaveSheetOpen(true);
  }, [data]);

  const cardLanguage = data?.card.language ?? routeLanguage ?? "en";
  const variantOptions = cardLanguage === "ja" ? JP_VARIANTS : EN_VARIANTS;

  const loadCard = useCallback((refresh = false, variant = selectedVariant) => {
    if (!id) return;
    if (refresh) setIsRefreshing(true);
    else setIsLoading(true);
    setError(null);
    const t0 = isSpeedTest ? Date.now() : 0;
    api
      .getCard(Number(id), scanType, routeLanguage, card_number, refresh, isSpeedTest, variant)
      .then((result) => {
        if (isSpeedTest) setDetailMs(Date.now() - t0);
        setData(result);
        // Save to history only on the initial normal-variant load with a real price.
        // Refreshes, variant switches, and speed tests are excluded.
        if (!refresh && !isSpeedTest && variant === "normal" && result.price) {
          api.saveHistory({
            card_id: result.card.id,
            game: result.card.game as Game,
            scan_type: scanType,
            language: result.card.language as Language,
            resolved_card_name: result.card.name,
            price_loose: result.price.price_loose ?? undefined,
            price_graded_10: result.price.price_graded_10 ?? undefined,
            image_url: result.card.image_url ?? undefined,
            set_name: result.card.set_name ?? undefined,
            card_number: result.card.card_number ?? undefined,
          }).catch(() => {}); // fire-and-forget, don't surface history errors to user
        }
      })
      .catch((e) => setError(e?.message ?? "Failed to load card"))
      .finally(() => { setIsLoading(false); setIsRefreshing(false); });
  }, [id, scanType, routeLanguage, card_number, isSpeedTest, selectedVariant]);

  const handleVariantChange = useCallback((variant: string) => {
    setSelectedVariant(variant);
    loadCard(false, variant);
  }, [loadCard]);

  useEffect(() => { loadCard(); }, [loadCard]);

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
        <TouchableOpacity style={styles.retryBtn} onPress={() => loadCard()}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
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
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={styles.headerButtons}>
              <TouchableOpacity
                onPress={openSaveSheet}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[styles.headerSaveBtn, cardSaved && styles.headerSaveBtnActive]}>
                  {cardSaved ? "★" : "☆"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => loadCard(true)}
                disabled={isRefreshing}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                {isRefreshing
                  ? <ActivityIndicator size="small" color={COLORS.accent} />
                  : <Text style={styles.headerRefreshBtn}>↻</Text>
                }
              </TouchableOpacity>
            </View>
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {isSpeedTest && detailMs !== null && (
          <View style={styles.timingBanner}>
            <Text style={styles.timingBannerText}>
              ⚡ Card detail: {(detailMs / 1000).toFixed(2)}s (skip_price=true)
            </Text>
          </View>
        )}
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

        <View style={styles.variantRow}>
          {variantOptions.map((v) => (
            <TouchableOpacity
              key={v.key}
              style={[styles.variantPill, selectedVariant === v.key && styles.variantPillActive]}
              onPress={() => handleVariantChange(v.key)}
            >
              <Text style={[styles.variantPillText, selectedVariant === v.key && styles.variantPillTextActive]}>
                {v.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {price ? (
          <PriceDisplay price={price} scanType={scanType} variant={selectedVariant} />
        ) : (
          <View style={styles.noPriceBox}>
            {selectedVariant !== "normal" ? (
              <>
                <Text style={styles.noPriceText}>
                  Variant not found on PriceCharting.
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    const label = variantOptions.find((v) => v.key === selectedVariant)?.label ?? selectedVariant;
                    const q = encodeURIComponent(`${card.name} ${label}`);
                    Linking.openURL(`https://www.pricecharting.com/search-products?q=${q}&type=prices`);
                  }}
                >
                  <Text style={styles.pcLinkText}>Search on PriceCharting →</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.noPriceText}>No pricing data available.</Text>
                <TouchableOpacity
                  style={styles.retryBtn}
                  onPress={() => loadCard(true)}
                  disabled={isRefreshing}
                >
                  {isRefreshing
                    ? <ActivityIndicator size="small" color={COLORS.accent} />
                    : <Text style={styles.retryText}>Retry</Text>
                  }
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {pcUrl && (
          <TouchableOpacity
            style={styles.pcLink}
            onPress={() => { if (pcUrl.startsWith("https://") || pcUrl.startsWith("http://")) Linking.openURL(pcUrl); }}
          >
            <Text style={styles.pcLinkText}>View on PriceCharting →</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {data && (
        <SaveToCollectionSheet
          isOpen={saveSheetOpen}
          cardId={data.card.id}
          cardData={{
            id: data.card.id,
            name: data.card.name,
            set_name: data.card.set_name ?? "",
            card_number: data.card.card_number ?? "",
            image_url: data.card.image_url ?? null,
            language: data.card.language,
            game: data.card.game as Game,
            savedAt: new Date().toISOString(),
          }}
          game={data.card.game as Game}
          onClose={() => setSaveSheetOpen(false)}
        />
      )}
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
    gap: 12,
  },
  noPriceText: { color: COLORS.textMuted, fontSize: 14 },
  reloadBtn: { alignItems: "center", paddingVertical: 8 },
  reloadText: { color: COLORS.accent, fontSize: 13, fontWeight: "600" },
  headerButtons: { flexDirection: "row", alignItems: "center", gap: 14, marginRight: 4 },
  headerSaveBtn: { color: COLORS.textMuted, fontSize: 22, lineHeight: 26 },
  headerSaveBtnActive: { color: COLORS.warning },
  headerRefreshBtn: { color: COLORS.accent, fontSize: 18, fontWeight: "600" },
  retryBtn: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  pcLink: { alignItems: "center", paddingVertical: 12 },
  pcLinkText: { color: COLORS.accent, fontSize: 14, fontWeight: "600" },
  variantRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  variantPill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  variantPillActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  variantPillText: { color: COLORS.textMuted, fontSize: 13, fontWeight: "600" },
  variantPillTextActive: { color: "#fff" },
  timingBanner: {
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  timingBannerText: { color: "#FFD700", fontSize: 11, fontWeight: "600" },
});
