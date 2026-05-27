import React, { useState, useCallback } from "react";
import { useFocusEffect } from "expo-router";
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, KeyboardAvoidingView, Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { CameraScanner } from "@/components/Scanner/CameraScanner";
import { ScanTypeToggle } from "@/components/UI/ScanTypeToggle";
import { ScanModeToggle } from "@/components/UI/ScanModeToggle";
import type { ScanMode } from "@/hooks/useMultiCardScan";
import { useCardSearch } from "@/hooks/useCardSearch";
import { useMultiCardScan } from "@/hooks/useMultiCardScan";
import { useScanStore } from "@/store/scanStore";
import { useColors } from "@/hooks/useColors";

type Mode = "multi-camera" | "settings";

export default function ScanScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("settings");
  const [certInput, setCertInput] = useState("");
  const [scanMode, setScanMode] = useState<ScanMode>("ocr");
  const [speedTestMode, setSpeedTestMode] = useState(false);

  const { game, scanType, setScanType, clearMultiScan, setMultiScanLoading } =
    useScanStore();
  const C = useColors();

  const { searchByCert, isSearching } = useCardSearch();
  const { scan: multiScan, isProcessing: isMultiProcessing, progress: multiProgress } = useMultiCardScan();

  const isLoading = isSearching || isMultiProcessing;

  const [isFocused, setIsFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );

  const gameLabel = game === "pokemon" ? "Pokémon" : "One Piece";
  const gameColor = game === "pokemon" ? C.pokemon : C.onepiece;

  const handleMultiCapture = useCallback(
    async (uri: string) => {
      clearMultiScan();
      setMultiScanLoading(true);
      setMode("settings");
      router.push("/multi-results");
      await multiScan(uri, game, scanMode, speedTestMode);
    },
    [multiScan, game, scanMode, speedTestMode, clearMultiScan, setMultiScanLoading, router],
  );

  const handlePSALookup = useCallback(async () => {
    if (!certInput.trim()) {
      Alert.alert("Enter Cert Number", "Please enter a PSA cert number.");
      return;
    }
    const result = await searchByCert(certInput.trim(), game);
    if (!result) {
      Alert.alert("Not Found", "Could not find cert data. Verify the cert number.");
      return;
    }
    if (result.card) {
      router.push({ pathname: "/card/[id]", params: { id: String(result.card.id), psaGrade: result.grade ?? "" } });
    } else {
      Alert.alert("Card Not Matched", `Found cert for "${result.card_name ?? "unknown"}" but couldn't match to our database.`);
    }
  }, [certInput, searchByCert, game, router]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["top"]}>
      {mode === "multi-camera" ? (
        <View style={styles.cameraContainer}>
          <CameraScanner onCapture={handleMultiCapture} isProcessing={isLoading} isActive={isFocused} />
          <TouchableOpacity style={styles.backBtn} onPress={() => setMode("settings")}>
            <Text style={styles.backBtnText}>✕  Close Camera</Text>
          </TouchableOpacity>
          {isMultiProcessing && (
            <View style={styles.multiProgressBanner}>
              <Text style={styles.multiProgressText}>{multiProgress || "Processing..."}</Text>
            </View>
          )}
        </View>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
          >
            {/* Game title */}
            <View style={styles.titleRow}>
              <Text style={[styles.gameTitle, { color: gameColor }]}>{gameLabel}</Text>
              <View style={[styles.gameTitleAccent, { backgroundColor: gameColor }]} />
            </View>
            <Text style={[styles.subtitle, { color: C.textMuted }]}>Card Scanner &amp; Price Tracker</Text>

            {/* Settings card */}
            <View style={[styles.settingsCard, { backgroundColor: C.surface, borderColor: C.border }]}>
              <SettingRow label="Scan Type" colors={C}>
                <ScanTypeToggle value={scanType} onChange={setScanType} />
              </SettingRow>

              <View style={[styles.settingDivider, { backgroundColor: C.border }]} />

              <SettingRow label="Recognition Mode" colors={C}>
                <ScanModeToggle value={scanMode} onChange={setScanMode} />
              </SettingRow>

              <View style={[styles.settingDivider, { backgroundColor: C.border }]} />

              <SettingRow label="Speed Test" colors={C}>
                <TouchableOpacity
                  style={[
                    styles.speedTestPill,
                    { borderColor: C.border },
                    speedTestMode && { borderColor: C.accent, backgroundColor: `${C.accent}18` },
                  ]}
                  onPress={() => setSpeedTestMode((v) => !v)}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name="flash-outline"
                    size={13}
                    color={speedTestMode ? C.accent : C.textMuted}
                  />
                  <Text style={[
                    styles.speedTestPillText,
                    { color: C.textMuted },
                    speedTestMode && { color: C.accent },
                  ]}>
                    {speedTestMode ? "ON" : "OFF"}
                  </Text>
                </TouchableOpacity>
              </SettingRow>
              {speedTestMode && (
                <Text style={[styles.speedTestHint, { color: C.textMuted }]}>
                  Times scan pipeline only — skips price fetch on card detail
                </Text>
              )}
            </View>

            {/* PSA cert input or hero scan button */}
            {scanType === "psa" ? (
              <View style={[styles.psaCard, { backgroundColor: C.surface, borderColor: C.border }]}>
                <Text style={[styles.psaLabel, { color: C.textMuted }]}>PSA Cert Number</Text>
                <View style={styles.certRow}>
                  <TextInput
                    style={[styles.certInput, { backgroundColor: C.bg, color: C.text, borderColor: C.border }]}
                    value={certInput}
                    onChangeText={setCertInput}
                    placeholder="e.g. 12345678"
                    placeholderTextColor={C.textMuted}
                    keyboardType="number-pad"
                    returnKeyType="search"
                    onSubmitEditing={handlePSALookup}
                  />
                  <TouchableOpacity
                    style={[styles.lookupBtn, { backgroundColor: C.accent }, isLoading && styles.btnDisabled]}
                    onPress={handlePSALookup}
                    disabled={isLoading}
                  >
                    <Text style={styles.lookupBtnText}>{isLoading ? "..." : "Look Up"}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.heroScanBtn, { borderColor: `${gameColor}40` }, isLoading && styles.btnDisabled]}
                onPress={() => setMode("multi-camera")}
                disabled={isLoading}
                activeOpacity={0.85}
              >
                <View style={[styles.heroIconWrap, { backgroundColor: `${gameColor}22` }]}>
                  <Ionicons name="camera" size={36} color={gameColor} />
                </View>
                <Text style={[styles.heroScanLabel, { color: C.text }]}>Scan Cards</Text>
                <Text style={[styles.heroScanSub, { color: C.textMuted }]}>Point camera at your cards</Text>
              </TouchableOpacity>
            )}

            {isLoading && (
              <Text style={[styles.loadingText, { color: C.textMuted }]}>
                {isMultiProcessing ? multiProgress || "Processing..." : "Searching database..."}
              </Text>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function SettingRow({
  label, children, colors,
}: {
  label: string;
  children: React.ReactNode;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.settingRow}>
      <Text style={[styles.settingLabel, { color: colors.textMuted }]}>{label}</Text>
      <View style={styles.settingControl}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  cameraContainer: { flex: 1 },
  backBtn: {
    position: "absolute",
    top: 12,
    left: 16,
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  backBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  scroll: { flex: 1 },
  content: { padding: 24, paddingBottom: 48, gap: 16 },

  titleRow: { flexDirection: "row", alignItems: "flex-end", gap: 10, marginBottom: 2 },
  gameTitle: {
    fontSize: 44,
    fontWeight: "900",
    letterSpacing: -1.5,
    lineHeight: 48,
  },
  gameTitleAccent: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginBottom: 10,
  },
  subtitle: { fontSize: 13, fontWeight: "500", marginBottom: 8 },

  settingsCard: {
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 4,
    paddingHorizontal: 16,
    overflow: "hidden",
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 13,
    gap: 12,
  },
  settingLabel: {
    fontSize: 13,
    fontWeight: "600",
    width: 120,
    flexShrink: 0,
  },
  settingControl: { flex: 1, alignItems: "flex-end" },
  settingDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: -16 },

  speedTestPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  speedTestPillText: { fontSize: 12, fontWeight: "700" },
  speedTestHint: { fontSize: 11, paddingBottom: 10, marginTop: -4, fontStyle: "italic" },

  psaCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  psaLabel: { fontSize: 12, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase" },
  certRow: { flexDirection: "row", gap: 10 },
  certInput: {
    flex: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
  },
  lookupBtn: {
    paddingHorizontal: 18,
    borderRadius: 10,
    justifyContent: "center",
  },
  lookupBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  heroScanBtn: {
    borderRadius: 20,
    borderWidth: 2,
    paddingVertical: 28,
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  heroIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  heroScanLabel: { fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  heroScanSub: { fontSize: 13, fontWeight: "500" },

  btnDisabled: { opacity: 0.5 },
  loadingText: { textAlign: "center", marginTop: 8, fontSize: 14 },

  multiProgressBanner: {
    position: "absolute",
    bottom: 120,
    left: 24,
    right: 24,
    backgroundColor: "rgba(0,0,0,0.75)",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  multiProgressText: { color: "#fff", fontSize: 14, fontWeight: "600" },
});
