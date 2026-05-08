import React from "react";
import { View, TouchableOpacity, Text, StyleSheet } from "react-native";
import { COLORS, LANGUAGES, type Language } from "@/constants";

interface Props {
  value: Language;
  onChange: (lang: Language) => void;
}

export function LanguageToggle({ value, onChange }: Props) {
  return (
    <View style={styles.container}>
      {LANGUAGES.map((lang) => (
        <TouchableOpacity
          key={lang.key}
          style={[styles.btn, value === lang.key && styles.active]}
          onPress={() => onChange(lang.key)}
          activeOpacity={0.75}
        >
          <Text style={styles.flag}>{lang.flag}</Text>
          <Text style={[styles.label, value === lang.key && styles.activeLabel]}>{lang.label}</Text>
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 7,
    borderRadius: 8,
    gap: 5,
  },
  active: { backgroundColor: COLORS.accent },
  flag: { fontSize: 14 },
  label: { color: COLORS.textMuted, fontSize: 13, fontWeight: "500" },
  activeLabel: { color: "#fff" },
});
