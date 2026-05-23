import React from "react";
import { View, TouchableOpacity, Text, StyleSheet } from "react-native";
import type { ScanMode } from "@/hooks/useMultiCardScan";
import { useColors } from "@/hooks/useColors";

interface Props {
  value: ScanMode;
  onChange: (mode: ScanMode) => void;
}

const OPTIONS: { key: ScanMode; label: string }[] = [
  { key: "ocr", label: "OCR" },
  { key: "image", label: "Image AI" },
  { key: "combined", label: "Combined" },
];

export function ScanModeToggle({ value, onChange }: Props) {
  const C = useColors();
  return (
    <View style={[styles.container, { backgroundColor: C.bg }]}>
      {OPTIONS.map((o) => (
        <TouchableOpacity
          key={o.key}
          style={[styles.btn, value === o.key && { backgroundColor: C.accent }]}
          onPress={() => onChange(o.key)}
          activeOpacity={0.75}
        >
          <Text style={[styles.label, { color: C.textMuted }, value === o.key && styles.activeLabel]}>
            {o.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: "row", borderRadius: 10, padding: 3, gap: 3 },
  btn: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
  label: { fontSize: 12, fontWeight: "600" },
  activeLabel: { color: "#fff" },
});
