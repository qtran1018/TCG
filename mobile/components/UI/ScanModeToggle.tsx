import React from "react";
import { View, TouchableOpacity, Text, StyleSheet } from "react-native";
import { COLORS } from "@/constants";
import type { ScanMode } from "@/hooks/useMultiCardScan";

interface Props {
  value: ScanMode;
  onChange: (mode: ScanMode) => void;
}

const OPTIONS: { key: ScanMode; label: string }[] = [
  { key: "ocr", label: "OCR Text" },
  { key: "image", label: "Image AI" },
  { key: "combined", label: "Combined" },
];

export function ScanModeToggle({ value, onChange }: Props) {
  return (
    <View style={styles.container}>
      {OPTIONS.map((o) => (
        <TouchableOpacity
          key={o.key}
          style={[styles.btn, value === o.key && styles.active]}
          onPress={() => onChange(o.key)}
          activeOpacity={0.75}
        >
          <Text style={[styles.label, value === o.key && styles.activeLabel]}>{o.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    backgroundColor: COLORS.surface,
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  btn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 8,
    borderRadius: 8,
  },
  active: { backgroundColor: COLORS.accent },
  label: { color: COLORS.textMuted, fontSize: 13, fontWeight: "600" },
  activeLabel: { color: "#fff" },
});
