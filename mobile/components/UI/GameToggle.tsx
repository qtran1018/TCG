import React from "react";
import { View, TouchableOpacity, Text, StyleSheet } from "react-native";
import { COLORS, GAMES, type Game } from "@/constants";

interface Props {
  value: Game;
  onChange: (game: Game) => void;
}

export function GameToggle({ value, onChange }: Props) {
  return (
    <View style={styles.container}>
      {GAMES.map((g) => (
        <TouchableOpacity
          key={g.key}
          style={[
            styles.btn,
            value === g.key && (g.key === "pokemon" ? styles.activePokemon : styles.activeOP),
          ]}
          onPress={() => onChange(g.key)}
          activeOpacity={0.75}
        >
          <Text style={[styles.label, value === g.key && styles.activeLabel]}>{g.label}</Text>
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
  activePokemon: { backgroundColor: COLORS.pokemon },
  activeOP: { backgroundColor: COLORS.onepiece },
  label: { color: COLORS.textMuted, fontSize: 13, fontWeight: "600" },
  activeLabel: { color: "#000" },
});
