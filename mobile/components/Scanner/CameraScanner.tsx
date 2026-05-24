import React, { useRef, useCallback } from "react";
import { StyleSheet, View, TouchableOpacity, Text, ActivityIndicator, Alert } from "react-native";
import { Camera, useCameraDevice, useCameraPermission } from "react-native-vision-camera";
import * as Haptics from "expo-haptics";
import { COLORS } from "@/constants";

interface Props {
  onCapture: (uri: string) => void;
  isProcessing: boolean;
}

export function CameraScanner({ onCapture, isProcessing }: Props) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice("back");
  const cameraRef = useRef<Camera>(null);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || isProcessing) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const photo = await cameraRef.current.takePhoto({ qualityPrioritization: "quality" });
      onCapture("file://" + photo.path);
    } catch {
      Alert.alert("Error", "Failed to capture image. Please try again.");
    }
  }, [isProcessing, onCapture]);

  if (!hasPermission) {
    return (
      <View style={styles.permContainer}>
        <Text style={styles.permText}>Camera permission is required to scan cards.</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
      />
      <View style={styles.footer}>
        <Text style={styles.hint}>Capture all cards in frame</Text>
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
