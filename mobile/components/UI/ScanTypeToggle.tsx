import React from "react";
import { View, TouchableOpacity, Text, StyleSheet } from "react-native";
import { COLORS, SCAN_TYPES, type ScanType } from "@/constants";

interface Props {
  value: ScanType;
  onChange: (type: ScanType) => void;
}

export function ScanTypeToggle({ value, onChange }: Props) {
  return (
    <View style={styles.container}>
      {SCAN_TYPES.map((t) => (
        <TouchableOpacity
          key={t.key}
          style={[styles.btn, value === t.key && styles.active]}
          onPress={() => onChange(t.key)}
          activeOpacity={0.75}
        >
          <Text style={[styles.label, value === t.key && styles.activeLabel]}>{t.label}</Text>
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
  active: { backgroundColor: COLORS.warning },
  label: { color: COLORS.textMuted, fontSize: 13, fontWeight: "600" },
  activeLabel: { color: "#000" },
});
