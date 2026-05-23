import React from "react";
import { View, TouchableOpacity, Text, StyleSheet } from "react-native";
import { SCAN_TYPES, type ScanType } from "@/constants";
import { useColors } from "@/hooks/useColors";

interface Props {
  value: ScanType;
  onChange: (type: ScanType) => void;
}

export function ScanTypeToggle({ value, onChange }: Props) {
  const C = useColors();
  return (
    <View style={[styles.container, { backgroundColor: C.bg }]}>
      {SCAN_TYPES.map((t) => (
        <TouchableOpacity
          key={t.key}
          style={[styles.btn, value === t.key && { backgroundColor: C.warning }]}
          onPress={() => onChange(t.key)}
          activeOpacity={0.75}
        >
          <Text style={[styles.label, { color: C.textMuted }, value === t.key && styles.activeLabel]}>
            {t.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: "row", borderRadius: 10, padding: 3, gap: 3 },
  btn: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
  label: { fontSize: 13, fontWeight: "600" },
  activeLabel: { color: "#000" },
});
