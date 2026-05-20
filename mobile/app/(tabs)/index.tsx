import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, KeyboardAvoidingView, Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraScanner } from "@/components/Scanner/CameraScanner";
import { GameToggle } from "@/components/UI/GameToggle";
import { ScanTypeToggle } from "@/components/UI/ScanTypeToggle";
import { ScanModeToggle } from "@/components/UI/ScanModeToggle";
import type { ScanMode } from "@/hooks/useMultiCardScan";
import { useCardSearch } from "@/hooks/useCardSearch";
import { useMultiCardScan } from "@/hooks/useMultiCardScan";
import { useScanStore } from "@/store/scanStore";
import { COLORS } from "@/constants";

type Mode = "multi-camera" | "settings";

export default function ScanScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("settings");
  const [certInput, setCertInput] = useState("");
  const [scanMode, setScanMode] = useState<ScanMode>("ocr");

  const { game, scanType, setGame, setScanType, clearMultiScan, setMultiScanLoading } =
    useScanStore();

  const { searchByCert, isSearching } = useCardSearch();
  const { scan: multiScan, isProcessing: isMultiProcessing, progress: multiProgress, error: multiError } = useMultiCardScan();

  const isLoading = isSearching || isMultiProcessing;

  const handleMultiCapture = useCallback(
    async (uri: string) => {
      clearMultiScan();
      // Mark loading before navigating so the results screen never sees the
      // empty state while the scan is in progress.
      setMultiScanLoading(true);
      setMode("settings");
      router.push("/multi-results");
      await multiScan(uri, game, scanMode);
    },
    [multiScan, game, scanMode, clearMultiScan, setMultiScanLoading, router],
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
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {mode === "multi-camera" ? (
        <View style={styles.cameraContainer}>
          <CameraScanner onCapture={handleMultiCapture} isProcessing={isLoading} />
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
            <Text style={styles.title}>TCG Scanner</Text>

            <Section label="Game">
              <GameToggle value={game} onChange={setGame} />
            </Section>

            <Section label="Scan Type">
              <ScanTypeToggle value={scanType} onChange={setScanType} />
            </Section>

            <Section label="Recognition Mode">
              <ScanModeToggle value={scanMode} onChange={setScanMode} />
            </Section>

            {scanType === "psa" ? (
              <Section label="PSA Cert Number">
                <View style={styles.certRow}>
                  <TextInput
                    style={styles.certInput}
                    value={certInput}
                    onChangeText={setCertInput}
                    placeholder="e.g. 12345678"
                    placeholderTextColor={COLORS.textMuted}
                    keyboardType="number-pad"
                    returnKeyType="search"
                    onSubmitEditing={handlePSALookup}
                  />
                  <TouchableOpacity
                    style={[styles.lookupBtn, isLoading && styles.btnDisabled]}
                    onPress={handlePSALookup}
                    disabled={isLoading}
                  >
                    <Text style={styles.lookupBtnText}>{isLoading ? "..." : "Look Up"}</Text>
                  </TouchableOpacity>
                </View>
              </Section>
            ) : (
              <TouchableOpacity
                style={[styles.scanBtn, isLoading && styles.btnDisabled]}
                onPress={() => setMode("multi-camera")}
                disabled={isLoading}
                activeOpacity={0.8}
              >
                <Text style={styles.scanBtnText}>📷  Scan Cards</Text>
              </TouchableOpacity>
            )}

            {isLoading && (
              <Text style={styles.loadingText}>
                {isMultiProcessing ? multiProgress || "Processing..." : "Searching database..."}
              </Text>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
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
  content: { padding: 20, gap: 6, paddingBottom: 40 },
  title: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: "800",
    marginBottom: 8,
    letterSpacing: -0.5,
  },
  section: { gap: 8, marginTop: 16 },
  sectionLabel: { color: COLORS.textMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.8, textTransform: "uppercase" },
  certRow: { flexDirection: "row", gap: 10 },
  certInput: {
    flex: 1,
    backgroundColor: COLORS.surface,
    color: COLORS.text,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  lookupBtn: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 18,
    borderRadius: 10,
    justifyContent: "center",
  },
  lookupBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  scanBtn: {
    backgroundColor: COLORS.accent,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    marginTop: 24,
  },
  scanBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  btnDisabled: { opacity: 0.5 },
  loadingText: { color: COLORS.textMuted, textAlign: "center", marginTop: 16, fontSize: 14 },
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
