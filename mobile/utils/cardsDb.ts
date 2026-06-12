import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CardOut } from '@/services/api';
import type { VectorSearchResult } from './vectorSearch';

const DB_NAME = 'cards.db';
const DB_DIR = `${FileSystem.documentDirectory ?? ''}SQLite/`;
const DB_PATH = DB_DIR + DB_NAME;
const HOT_PATH = `${FileSystem.documentDirectory ?? ''}tcg_assets/${DB_NAME}`;
const DB_HASH_KEY = 'tcg:cardsDbHash';

let _db: SQLite.SQLiteDatabase | null = null;
let _initPromise: Promise<SQLite.SQLiteDatabase | null> | null = null;

type DbRow = {
  id: number;
  game: string;
  language: string;
  name: string;
  name_ja: string | null;
  set_name: string | null;
  set_code: string | null;
  card_number: string | null;
  rarity: string | null;
  image_url: string | null;
  image_url_hi: string | null;
  pricecharting_url: string | null;
  phash: string | null;
};

function rowToCard(row: DbRow): CardOut {
  return {
    id: row.id,
    game: row.game,
    language: row.language,
    name: row.name,
    name_ja: row.name_ja ?? undefined,
    set_name: row.set_name ?? undefined,
    set_code: row.set_code ?? undefined,
    card_number: row.card_number ?? undefined,
    rarity: row.rarity ?? undefined,
    image_url: row.image_url ?? undefined,
    image_url_hi: row.image_url_hi ?? undefined,
    pricecharting_url: row.pricecharting_url ?? undefined,
    phash: row.phash ?? undefined,
    created_at: '',
  };
}

async function getSourceInfo(): Promise<{ path: string; hash: string }> {
  const hotInfo = await FileSystem.getInfoAsync(HOT_PATH);
  if (hotInfo.exists) {
    return {
      path: HOT_PATH,
      hash: `hot:${(hotInfo as FileSystem.FileInfo & { modificationTime?: number }).modificationTime ?? 0}`,
    };
  }
  const asset = Asset.fromModule(require('../assets/data/cards.db'));
  await asset.downloadAsync();
  return { path: asset.localUri!, hash: `bundle:${asset.hash ?? 'v1'}` };
}

async function doInit(): Promise<SQLite.SQLiteDatabase | null> {
  try {
    const { path: src, hash } = await getSourceInfo();
    const storedHash = await AsyncStorage.getItem(DB_HASH_KEY);
    const dbInfo = await FileSystem.getInfoAsync(DB_PATH);

    if (!dbInfo.exists || storedHash !== hash) {
      await FileSystem.makeDirectoryAsync(DB_DIR, { intermediates: true });
      await FileSystem.copyAsync({ from: src, to: DB_PATH });
      await AsyncStorage.setItem(DB_HASH_KEY, hash);
      console.log(`[CardsDB] copied cards.db hash=${hash}`);
    }

    const db = SQLite.openDatabaseSync(DB_NAME);
    _db = db;
    console.log('[CardsDB] ready');
    return db;
  } catch (e) {
    console.error('[CardsDB] init failed:', e);
    return null;
  }
}

export async function initCardsDb(): Promise<void> {
  if (!_initPromise) _initPromise = doInit();
  await _initPromise;
}

export async function getCardsDb(): Promise<SQLite.SQLiteDatabase | null> {
  if (_db) return _db;
  if (!_initPromise) _initPromise = doInit();
  return _initPromise;
}

/**
 * Fetch card metadata for vector search results, preserving similarity order.
 * McDonald's set penalty applied: mcd* set_code cards pushed to back, matching scan.py.
 */
export async function queryCardsByIds(
  results: VectorSearchResult[],
): Promise<CardOut[]> {
  if (!results.length) return [];
  const db = await getCardsDb();
  if (!db) return [];

  const ids = results.map(r => r.cardId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = (db.getAllSync(
    `SELECT * FROM cards WHERE id IN (${placeholders})`,
    ids,
  )) as DbRow[];

  const byId = new Map(rows.map(r => [r.id, r]));
  const ordered = ids
    .map(id => byId.get(id))
    .filter((r): r is DbRow => r !== undefined)
    .map(rowToCard);

  const nonMcd = ordered.filter(c => !(c.set_code ?? '').startsWith('mcd'));
  const mcd    = ordered.filter(c =>  (c.set_code ?? '').startsWith('mcd'));
  return [...nonMcd, ...mcd];
}

/**
 * FTS5 name search for combined-mode OCR hint.
 * Extracts name tokens from raw OCR text and matches against cards_fts.
 */
export async function searchCardsByName(
  rawText: string,
  language: string,
): Promise<CardOut[]> {
  const db = await getCardsDb();
  if (!db) return [];

  // First line only; strip card number patterns and trailing digits
  const name = rawText
    .split('\n')[0]
    .replace(/\d+\/\d+/g, '')
    .replace(/\s+\d+\s*$/, '')
    .trim();
  if (name.length < 2) return [];

  // Wrap each token in double-quotes for exact FTS5 phrase matching.
  // Avoids syntax errors from OCR artifacts (special chars, slashes).
  const tokens = name.split(/\s+/).filter(Boolean);
  const ftsQuery = tokens.map(t => `"${t.replace(/"/g, '')}"`).join(' ');

  try {
    const rows = (db.getAllSync(
      `SELECT c.* FROM cards_fts f
       JOIN cards c ON c.id = f.rowid
       WHERE cards_fts MATCH ? AND c.language = ?
       ORDER BY rank LIMIT 10`,
      [ftsQuery, language],
    )) as DbRow[];
    return rows.map(rowToCard);
  } catch {
    // FTS5 MATCH throws on malformed queries — degrade gracefully
    return [];
  }
}
