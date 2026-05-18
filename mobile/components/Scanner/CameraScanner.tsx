import React, { useRef, useState, useCallback } from "react";
import { StyleSheet, View, TouchableOpacity, Text, ActivityIndicator, Alert } from "react-native";
import { CameraView, CameraType, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { ScanOverlay } from "./ScanOverlay";
import { COLORS } from "@/constants";
import type { Language } from "@/constants";

interface Props {
  language: Language;
  onCapture: (uri: string) => void;
  isProcessing: boolean;
  showOverlay?: boolean;
}

export function CameraScanner({ language, onCapture, isProcessing, showOverlay = true }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || isProcessing) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.92,
        base64: false,
        skipProcessing: false,
      });
      if (photo?.uri) {
        onCapture(photo.uri);
      }
    } catch {
      Alert.alert("Error", "Failed to capture image. Please try again.");
    }
  }, [isProcessing, onCapture]);

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.permContainer}>
        <Text style={styles.permText}>Camera permission is required to scan cards.</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
      {showOverlay && <ScanOverlay />}
      <View style={styles.footer}>
        <Text style={styles.hint}>
          {showOverlay
            ? (language === "ja" ? "カードをフレームに合わせる" : "Align card within the frame")
            : (language === "ja" ? "カードを撮影する" : "Capture all cards in frame")}
        </Text>
        <TouchableOpacity
          style={[styles.shutterBtn, isProcessing && styles.shutterDisabled]}
          onPress={handleCapture}
          activeOpacity={0.75}
          disabled={isProcessing}
        >
          {isProcessing ? (
            <ActivityIndicator color={COLORS.text} size="small" />
          ) : (
            <View style={styles.shutterInner} />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  permContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 16,
  },
  permText: { color: COLORS.textMuted, textAlign: "center", fontSize: 15 },
  permBtn: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  permBtnText: { color: "#fff", fontWeight: "600" },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 48,
    alignItems: "center",
    gap: 20,
  },
  hint: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    letterSpacing: 0.3,
  },
  shutterBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderWidth: 3,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterDisabled: { opacity: 0.5 },
  shutterInner: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#fff",
  },
});
