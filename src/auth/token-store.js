// Przechowywanie tokenu pCloud: localStorage (szybki odczyt) + mirror w IDB store `sources`
// (SW nie widzi localStorage — mirror jest konieczny dla Background Sync / flush-ratings).
// Bilet 03, spec §3a + §7.

import { get, put, STORES } from "../store/db.js";

/** Klucz localStorage — jeden na całą apkę (single-source MVP). */
const LS_TOKEN_KEY = "rate-wave.pcloud.token";
const LS_HOSTNAME_KEY = "rate-wave.pcloud.hostname";
const LS_LOCATIONID_KEY = "rate-wave.pcloud.locationid";

/** Klucz w store IDB `sources` — singleton 'pcloud'. */
export const PCLOUD_SOURCE_KEY = "pcloud";

/** Zwraca referencję do localStorage (injectable dla testów, z fallback na globalThis). */
function _ls(ref) {
  return (
    ref ??
    globalThis.localStorage ?? {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    }
  );
}

/**
 * Zapisuje token + hostname + locationid do localStorage i IDB (mirror).
 * Pola opcjonalne (folderId/folderName — bilet #17) zapisywane w IDB, jeśli podane.
 * @param {{ db: IDBDatabase, token: string, hostname: string, locationid: number, folderId?: string, folderName?: string | null, localStorage?: Storage }} params
 */
export async function saveToken({
  db,
  token,
  hostname,
  locationid,
  folderId,
  folderName,
  localStorage: ls,
}) {
  const storage = _ls(ls);
  storage.setItem(LS_TOKEN_KEY, token);
  storage.setItem(LS_HOSTNAME_KEY, hostname);
  storage.setItem(LS_LOCATIONID_KEY, String(locationid));
  await put(db, STORES.SOURCES, PCLOUD_SOURCE_KEY, {
    token,
    hostname,
    locationid,
    ...(folderId !== undefined ? { folderId } : {}),
    ...(folderName !== undefined ? { folderName } : {}),
  });
}

/**
 * Czyta token z localStorage (synchroniczne — używane przed otwarciem IDB).
 * Zwraca `{ token, hostname, locationid }` lub `null` gdy brak tokenu.
 * @param {Storage} [ls] — injectable dla testów
 */
export function loadTokenFromLS(ls) {
  const storage = _ls(ls);
  const token = storage.getItem(LS_TOKEN_KEY);
  if (!token) return null;
  return {
    token,
    hostname: storage.getItem(LS_HOSTNAME_KEY) ?? "api.pcloud.com",
    locationid: Number(storage.getItem(LS_LOCATIONID_KEY)) || 1,
  };
}

/**
 * Czyta token z IDB (asynchroniczne — używane przez SW / gdy db jest otwarte).
 * Zwraca `{ token, hostname, locationid }` lub `null` gdy brak.
 */
export async function loadTokenFromDB(db) {
  const row = /** @type {any} */ (await get(db, STORES.SOURCES, PCLOUD_SOURCE_KEY));
  if (!row || !row.token) return null;
  return {
    token: row.token,
    hostname: row.hostname ?? "api.pcloud.com",
    locationid: row.locationid ?? 1,
    folderId: row.folderId ?? null,
    folderName: row.folderName ?? null,
  };
}

/**
 * Usuwa token z localStorage i IDB (ciche czyszczenie po nieudanej walidacji userinfo).
 * @param {{ db: IDBDatabase, localStorage?: Storage }} params
 */
export async function clearToken({ db, localStorage: ls } = {}) {
  const storage = _ls(ls);
  storage.removeItem(LS_TOKEN_KEY);
  storage.removeItem(LS_HOSTNAME_KEY);
  storage.removeItem(LS_LOCATIONID_KEY);
  const existing = await get(db, STORES.SOURCES, PCLOUD_SOURCE_KEY);
  if (existing) {
    delete existing.token;
    delete existing.hostname;
    delete existing.locationid;
    await put(db, STORES.SOURCES, PCLOUD_SOURCE_KEY, existing);
  }
}

/**
 * Zwraca bazowy URL API pCloud (EU vs US), z fallbackiem na `api.pcloud.com`.
 * @param {{ hostname?: string, localStorage?: Storage }} [opts]
 * @returns {string}
 */
export function apiBaseUrl({ hostname, localStorage: ls } = {}) {
  const h = hostname || _ls(ls).getItem(LS_HOSTNAME_KEY) || "api.pcloud.com";
  return `https://${h}`;
}

// Eksport kluczy LS dla testów
export { LS_TOKEN_KEY, LS_HOSTNAME_KEY, LS_LOCATIONID_KEY };
