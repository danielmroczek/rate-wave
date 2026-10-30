// Testy schematu bazy `rate-wave` v1 (bilet 01, spec §4a) — fake-indexeddb (Node).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  openDB,
  get,
  put,
  del,
  getAllKeys,
  getAllValues,
  putMany,
  clearStore,
  saveSession,
  loadSession,
  saveSetting,
  deleteNamedDB,
  resetAllData,
  DB_NAME,
  DB_VERSION,
  ALL_STORES,
  STORES,
} from "./db.js";

/** @type {IDBFactory} */
let factory;
/** @type {any} */
let localStorage;
/** @type {IDBDatabase | undefined} */
let db;

function makeEnv() {
  const idb = /** @type {any} */ (new IDBFactory());
  const storage = new Map();
  const localStorage = /** @type {any} */ ({
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
    get _size() {
      return storage.size;
    },
  });
  return { idb, localStorage };
}

beforeEach(() => {
  ({ idb: factory, localStorage } = makeEnv());
});

afterEach(async () => {
  if (db) {
    db.close();
    db = undefined;
  }
});

describe("openDB / schemat v1", () => {
  it("tworzy bazę `rate-wave` w wersji 1 z 6 store'ami", async () => {
    db = await openDB(factory);
    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(DB_VERSION);
    expect(db.objectStoreNames.length).toBe(6);
    for (const store of ALL_STORES) {
      expect(db.objectStoreNames.contains(store)).toBe(true);
    }
  });

  it("store'y mają klucze out-of-line (keyPath null — jawne klucze przy put)", async () => {
    db = await openDB(factory);
    for (const store of ALL_STORES) {
      expect(db.transaction(store).objectStore(store).keyPath).toBeNull();
    }
  });

  it("jest idempotentne — drugie otwarcie nie zmienia wersji ani store'ów", async () => {
    db = await openDB(factory);
    const again = await openDB(factory);
    expect(again.version).toBe(DB_VERSION);
    expect(again.objectStoreNames.length).toBe(6);
    again.close();
  });
});

describe("prymitywy get/put/delete", () => {
  beforeEach(async () => {
    db = await openDB(factory);
  });

  it("put + get działa dla klucza string (settings)", async () => {
    await put(db, STORES.SETTINGS, "sort", { mode: "name", dir: "asc" });
    expect(await get(db, STORES.SETTINGS, "sort")).toEqual({ mode: "name", dir: "asc" });
  });

  it("put + get działa dla klucza złożonego `pcloud|<fileid>` (tracks)", async () => {
    const key = "pcloud|123456";
    const record = {
      fingerprint: { size: 1024, modified: 1_767_139_200 },
      rating: 3,
      lastPlayed: 1_767_139_500,
    };
    await put(db, STORES.TRACKS, key, record);
    expect(await get(db, STORES.TRACKS, key)).toEqual(record);
  });

  it("get nieistniejącego klucza → undefined", async () => {
    expect(await get(db, STORES.TRACKS, "pcloud|brak")).toBeUndefined();
  });

  it("del usuwa rekord", async () => {
    await put(db, STORES.TRACKS, "local|a/b.mp3", { rating: 5 });
    await del(db, STORES.TRACKS, "local|a/b.mp3");
    expect(await get(db, STORES.TRACKS, "local|a/b.mp3")).toBeUndefined();
  });

  it("getAllKeys / getAllValues", async () => {
    await put(db, STORES.PENDING_RATINGS, "pcloud|1", { action: "set", ratingByte: 255 });
    await put(db, STORES.PENDING_RATINGS, "pcloud|2", { action: "remove", ratingByte: 0 });
    expect((await getAllKeys(db, STORES.PENDING_RATINGS)).sort()).toEqual(["pcloud|1", "pcloud|2"]);
    expect((await getAllValues(db, STORES.PENDING_RATINGS)).length).toBe(2);
  });
});

describe("putMany — atomowy zapis w jednej transakcji", () => {
  beforeEach(async () => {
    db = await openDB(factory);
  });

  it("zapisuje do wielu store'ów naraz", async () => {
    await putMany(db, [
      { store: STORES.SOURCES, key: "pcloud", value: { token: "tok" } },
      { store: STORES.LIBRARY, key: "pcloud", value: { fileCount: 3635 } },
      {
        store: STORES.SESSION,
        key: "current",
        value: { source: "pcloud", trackKey: "pcloud|1", positionSec: 10 },
      },
    ]);
    expect(await get(db, STORES.SOURCES, "pcloud")).toEqual({ token: "tok" });
    expect(await get(db, STORES.LIBRARY, "pcloud")).toEqual({ fileCount: 3635 });
    expect((await loadSession(db)).trackKey).toBe("pcloud|1");
  });
});

describe("sesja i ustawienia", () => {
  beforeEach(async () => {
    db = await openDB(factory);
  });

  it("saveSession/loadSession — pełny powrót (spec §4b)", async () => {
    expect(await loadSession(db)).toBeUndefined();
    await saveSession(db, { source: "pcloud", trackKey: "pcloud|42", positionSec: 133.5 });
    const s = await loadSession(db);
    expect(s).toEqual({ source: "pcloud", trackKey: "pcloud|42", positionSec: 133.5 });
  });

  it("LWW: ostatni zapis sesji wygrywa", async () => {
    await saveSession(db, { source: "pcloud", trackKey: "pcloud|1", positionSec: 1 });
    await saveSession(db, { source: "pcloud", trackKey: "pcloud|2", positionSec: 2 });
    expect((await loadSession(db)).trackKey).toBe("pcloud|2");
  });

  it("saveSetting — settings per urządzenie", async () => {
    await saveSetting(db, "preamp", -3.5);
    expect(await get(db, STORES.SETTINGS, "preamp")).toBe(-3.5);
  });
});

describe('reset danych („wyczyść wszystkie dane", spec §4b)', () => {
  it("deleteNamedDB usuwa bazę", async () => {
    db = await openDB(factory);
    db.close();
    db = undefined;
    await deleteNamedDB(factory, DB_NAME);
    await expect(openDB(factory)).resolves.toBeInstanceOf(Object);
  });

  it("resetAllData usuwa bazę + czyści localStorage", async () => {
    // Wypełniamy stan.
    db = await openDB(factory);
    await putMany(db, [
      { store: STORES.SOURCES, key: "pcloud", value: { token: "S3CRE7" } },
      { store: STORES.TRACKS, key: "pcloud|1", value: { rating: 4 } },
    ]);
    db.close();
    db = undefined;
    localStorage.setItem("rate-wave.pcloud.token", "S3CRE7");
    localStorage.setItem("cokolwiek", "x");
    expect(localStorage._size).toBe(2);

    await resetAllData({ indexedDB: factory, localStorage });

    expect(localStorage._size).toBe(0);
    // Baza odtwarza się pusta.
    const fresh = await openDB(factory);
    expect((await getAllKeys(fresh, STORES.TRACKS)).length).toBe(0);
    expect((await getAllKeys(fresh, STORES.SOURCES)).length).toBe(0);
    fresh.close();
  });

  it("resetAllData działa nawet gdy localStorage jest pusty i baza nie istnieje", async () => {
    await expect(resetAllData({ indexedDB: factory, localStorage })).resolves.toBeUndefined();
  });
});

describe("clearStore", () => {
  it("czyści pojedynczy store, zostawiając pozostałe", async () => {
    db = await openDB(factory);
    await put(db, STORES.TRACKS, "pcloud|1", { rating: 1 });
    await put(db, STORES.SESSION, "current", {
      source: "pcloud",
      trackKey: "pcloud|1",
      positionSec: 0,
    });
    await clearStore(db, STORES.TRACKS);
    expect((await getAllKeys(db, STORES.TRACKS)).length).toBe(0);
    expect(await loadSession(db)).toBeTruthy();
  });
});
