// Baza `rate-wave` v1, zgodnie z docs/spec.md §4a (bilety 07, 15).
//
// Store'y (keyPath null → jawne klucze, out-of-line):
//  settings         string klucz, wartość = JSON (per urządzenie)
//  sources          'pcloud' | 'local' — token mirror, folderid, hostname/locationid, handle FSA
//  library          source-id — listing per Źródło + Fingerprint
//  tracks           'pcloud|<fileid>' / 'local|<relpath>' — fingerprint, rating, gain, peaks, lastPlayed
//  pending-ratings  klucz jak tracks — kolejka ocen offline { fingerprint, ratingByte, action, createdAt }
//  session          singleton 'current' — { source, trackKey, positionSec }
//
// "Przycisk wyczyść wszystkie dane" = deleteDB() + localStorage.clear() (spec §4b [bilet 07]).

export const DB_NAME = "rate-wave";
export const DB_VERSION = 1;

export const STORES = /** @type {const} */ ({
  SETTINGS: "settings",
  SOURCES: "sources",
  LIBRARY: "library",
  TRACKS: "tracks",
  PENDING_RATINGS: "pending-ratings",
  SESSION: "session",
});

export const ALL_STORES = /** @type {const} */ ([
  STORES.SETTINGS,
  STORES.SOURCES,
  STORES.LIBRARY,
  STORES.TRACKS,
  STORES.PENDING_RATINGS,
  STORES.SESSION,
]);

export const SESSION_KEY = "current";

/**
 * Otwiera bazę lub tworzy ją z pełnym schematem v1 (onupgradeneeded idempotentny).
 * @param {IDBFactory} idbFactory np. window.indexedDB (w testach: fake-indexeddb)
 * @returns {Promise<IDBDatabase>} połączenie (caller odpowiada za close())
 */
export function openDB(idbFactory = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const req = idbFactory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const store of ALL_STORES) {
        if (!req.result.objectStoreNames.contains(store)) {
          req.result.createObjectStore(store);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("openDB failed"));
    req.onblocked = () => reject(new Error("openDB blocked by another connection"));
  });
}

/* ── prymitywy get/put/delete ─────────────────────────────── */

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

/**
 * @template T
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBValidKey | undefined} key
 * @returns {Promise<T | undefined>}
 */
export function get(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("get failed"));
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @param {any} value
 */
export function put(db, storeName, key, value) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readwrite").objectStore(storeName).put(value, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("put failed"));
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBValidKey} key
 */
export function del(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readwrite").objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("delete failed"));
  });
}

/**
 * Wszystkie value'y ze store'a.
 * @template T
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<T[]>}
 */
export function getAllValues(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    req.onsuccess = () => resolve(/** @type {T[]} */ (req.result));
    req.onerror = () => reject(req.error ?? new Error("getAll failed"));
  });
}

/**
 * Wszystkie klucze (bez wartości — tanio przy liczeniu 3635 tracków).
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<IDBValidKey[]>}
 */
export function getAllKeys(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("getAllKeys failed"));
  });
}

/**
 * Zapisuje kilka par w JEDNEJ transakcji (atomowo).
 * @param {IDBDatabase} db
 * @param {Array<{store: string, key: IDBValidKey, value: any}>} entries
 */
export function putMany(db, entries) {
  const tx = db.transaction(
    entries.map((e) => e.store),
    "readwrite",
  );
  for (const { store, key, value } of entries) {
    tx.objectStore(store).put(value, key);
  }
  return txDone(tx);
}

/**
 * Czyści jeden store.
 * @param {IDBDatabase} db
 * @param {string} storeName
 */
export function clearStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readwrite").objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("clear failed"));
  });
}

/* ── sesja (Pełny powrót, spec §4a/§4b) ───────────────────── */

/**
 * Zapisuje pozycję sesji (LWW — wywołanie throttle'owane po stronie playera).
 * @param {IDBDatabase} db
 * @param {{ source: string, trackKey: string, positionSec: number }} state
 */
export function saveSession(db, state) {
  return put(db, STORES.SESSION, SESSION_KEY, state);
}

/**
 * @typedef {{ source: string, trackKey: string, positionSec: number }} SessionState
 */

/**
 * Odczyt sesji; undefined gdy brak zapisu.
 * @param {IDBDatabase} db
 * @returns {Promise<SessionState | undefined>}
 */
export function loadSession(db) {
  return get(db, STORES.SESSION, SESSION_KEY);
}

/**
 * Ustawienia per urządzenie (settings store, wartość = JSON).
 * @param {IDBDatabase} db
 * @param {string} key
 * @param {any} value
 */
export function saveSetting(db, key, value) {
  return put(db, STORES.SETTINGS, key, value);
}

/* ── reset danych (bilet 01 / spec §4b) ───────────────────── */

/**
 * Usuwa bazę IndexedDB o podanej nazwie (wrapper dla testowalności).
 * @param {IDBFactory} idbFactory
 * @param {string} name
 */
export function deleteNamedDB(idbFactory, name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = idbFactory.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("deleteDatabase failed"));
    // onblocked: inna karta trzyma połączenie — zamykam lokalne i to koniec naszej odpowiedzialności;
    // caller (resetAllData) zamknął swoje połączenia przed wywołaniem.
    req.onblocked = () => resolve();
  });
}

/**
 * Enumeruje nazwy istniejących baz (tam, gdzie API dostępne — Chrome: tak).
 * @param {IDBFactory} idbFactory
 * @returns {Promise<string[]>}
 */
export async function listDBNames(idbFactory = globalThis.indexedDB) {
  return new Promise((resolve) => {
    if (typeof (/** @type {any} */ (idbFactory).databases) !== "function") {
      resolve([]);
      return;
    }
    // Chrome zwraca [] natychmiast po deleteDatabase; krótkie okno może jeszcze zawierać wpis.
    /** @type {any} */ (idbFactory)
      .databases()
      .then((dbs) => resolve(dbs.map((d) => d.name)))
      .catch(() => resolve([]));
  });
}

/**
 * Usuwa bazy IndexedDB aplikacji + całe localStorage.
 * @param {{ indexedDB?: IDBFactory, localStorage?: Storage }} options
 *   default: globalThis (w testach przekazujemy fake-indexeddb + localStorage stub).
 */
export async function resetAllData({
  indexedDB = globalThis.indexedDB,
  localStorage = globalThis.localStorage,
} = {}) {
  // 1. deleteDB na znaną bazę…
  await deleteNamedDB(indexedDB, DB_NAME);
  // 2. …plus porządki: nazwy z prefiksem bieżącej wersji, gdyby powstały przy migracjach —
  //    aktualnie tylko jedna baza (`rate-wave`), ale lista nic nie kosztuje.
  const names = await listDBNames(indexedDB);
  for (const name of names) {
    if (name && name.startsWith(DB_NAME)) {
      if (name !== DB_NAME) await deleteNamedDB(indexedDB, name);
    }
  }
  // 3. localStorage.clear() — w tym token pCloud (mirror w IDB ginie z bazą).
  if (localStorage && typeof localStorage.clear === "function") {
    localStorage.clear();
  }
}
