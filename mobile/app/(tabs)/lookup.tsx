import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Image,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { api, CardOut } from "@/services/api";
import { useScanStore } from "@/store/scanStore";
import { useColors } from "@/hooks/useColors";
import type { Language } from "@/constants";

export default function LookupScreen() {
  const router = useRouter();
  const C = useColors();
  const { game } = useScanStore();
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState<Language>("en");
  const [results, setResults] = useState<CardOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(
    async (q: string, lang: Language) => {
      if (q.trim().length < 2) {
        setResults([]);
        setSearched(false);
        setSearchError(null);
        return;
      }
      setLoading(true);
      setSearchError(null);
      try {
        const data = await api.searchCards(q.trim(), lang, game);
        setResults(data);
        setSearched(true);
      } catch (e) {
        console.warn("[lookup] search failed:", e);
        setSearchError("Search failed — check your connection");
        setResults([]);
        setSearched(true);
      } finally {
        setLoading(false);
      }
    },
    [game],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query, language), 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, language, doSearch]);

  const onSelect = (card: CardOut) => {
    router.push({
      pathname: "/card/[id]",
      params: { id: card.id, language },
    });
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: C.bg }]} edges={["bottom"]}>
      <View style={[styles.searchRow, { backgroundColor: C.surface, borderColor: C.border }]}>
        <Ionicons name="search-outline" size={18} color={C.textMuted} />
        <TextInput
          style={[styles.input, { color: C.text }]}
          placeholder="Card name..."
          placeholderTextColor={C.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={18} color={C.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <View style={[styles.toggle, { backgroundColor: C.surface, borderColor: C.border }]}>
        {(["en", "ja"] as Language[]).map((lang) => (
          <TouchableOpacity
            key={lang}
            onPress={() => setLanguage(lang)}
            style={[
              styles.toggleBtn,
              language === lang && { backgroundColor: C.accent },
            ]}
          >
            <Text
              style={[
                styles.toggleText,
                { color: language === lang ? "#fff" : C.textMuted },
              ]}
            >
              {lang === "en" ? "English" : "Japanese"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {searchError && (
        <Text style={[styles.errorBanner, { color: C.error, backgroundColor: "rgba(224,80,80,0.12)", borderColor: "rgba(224,80,80,0.3)" }]}>
          {searchError}
        </Text>
      )}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={C.accent} />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => String(item.id)}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={results.length === 0 ? styles.emptyContainer : styles.list}
          ListEmptyComponent={
            searched && query.trim().length >= 2 && !searchError ? (
              <Text style={[styles.emptyText, { color: C.textMuted }]}>No cards found</Text>
            ) : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => onSelect(item)}
              style={[styles.row, { backgroundColor: C.surface, borderColor: C.border }]}
              activeOpacity={0.7}
            >
              {item.image_url ? (
                <Image source={{ uri: item.image_url }} style={styles.thumb} resizeMode="contain" />
              ) : (
                <View style={[styles.thumbPlaceholder, { backgroundColor: C.border }]} />
              )}
              <View style={styles.meta}>
                <Text style={[styles.cardName, { color: C.text }]} numberOfLines={1}>
                  {language === "ja" && item.name_ja ? item.name_ja : item.name}
                </Text>
                {item.set_name ? (
                  <Text style={[styles.sub, { color: C.textMuted }]} numberOfLines={1}>
                    {item.set_name}
                  </Text>
                ) : null}
                {item.card_number ? (
                  <Text style={[styles.sub, { color: C.textMuted }]}>
                    #{item.card_number}
                  </Text>
                ) : null}
              </View>
              <Ionicons name="chevron-forward" size={16} color={C.textMuted} />
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
  },
  input: { flex: 1, fontSize: 16 },
  toggle: {
    flexDirection: "row",
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
    overflow: "hidden",
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
  },
  toggleText: { fontSize: 13, fontWeight: "600" },
  list: { paddingHorizontal: 12, paddingBottom: 20 },
  emptyContainer: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 60 },
  emptyText: { fontSize: 15 },
  errorBanner: {
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 13,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
    padding: 10,
    gap: 10,
  },
  thumb: { width: 48, height: 68, borderRadius: 4 },
  thumbPlaceholder: { width: 48, height: 68, borderRadius: 4 },
  meta: { flex: 1 },
  cardName: { fontSize: 15, fontWeight: "600" },
  sub: { fontSize: 12, marginTop: 2 },
});
