// Testy cache biblioteki (bilet 04): store `library` (listing + Fingerprint),
// store `tracks` (Fingerprint + placeholder oceny) — fake-indexeddb (Node).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB, get, del, put, getAllKeys, STORES } from "../store/db.js";
import {
  saveLibrary,
  loadLibrary,
  deleteLibrary,
  saveTracks,
  clearTracks,
} from "./library-cache.js";
import { loadLibraryOrFetch, loadRatings, makeCounter } from "./library-controller.js";
import { buildLibrary } from "./listing.js";

/** @type {IDBFactory} */
let factory;
/** @type {IDBDatabase | undefined} */
let db;

const LIBRARY = buildLibrary({
  metadata: {
    isfolder: true,
    contents: [
      {
        name: "2017",
        isfolder: true,
        contents: [
          { fileid: 1, name: "a.mp3", size: 1000, modified: 1700000000 },
          { fileid: 2, name: "b.mp3", size: 2000, modified: 1700000100 },
        ],
      },
      { name: "2018", isfolder: true, contents: [] },
      {
        name: "warped",
        isfolder: true,
        contents: [{ fileid: 5, name: "x.mp3", size: 9, modified: 1 }],
      },
    ],
  },
});

function fakeApi(calls) {
  return async (opts) => {
    calls.push(opts);
    return {
      result: 0,
      metadata: {
        isfolder: true,
        contents: [
          {
            name: "2017",
            isfolder: true,
            contents: [{ fileid: 1, name: "a.mp3", size: 1000, modified: 1700000000 }],
          },
        ],
      },
    };
  };
}

beforeEach(async () => {
  factory = new IDBFactory();
  db = await openDB(/** @type {any} */ (factory));
});

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("library-cache", () => {
  it("roundtrip: save + load `library` pod kluczem 'pcloud'", async () => {
    await saveLibrary(db, LIBRARY);
    const loaded = await loadLibrary(db);
    expect(loaded?.tracks.length).toBe(LIBRARY.tracks.length);
    expect(loaded?.fingerprint).toEqual(LIBRARY.fingerprint);
  });

  it("load zwraca undefined gdy brak cache", async () => {
    expect(await loadLibrary(db)).toBeUndefined();
  });

  it("deleteLibrary usuwa wpis", async () => {
    await saveLibrary(db, LIBRARY);
    await deleteLibrary(db);
    expect(await get(db, STORES.LIBRARY, "pcloud")).toBeUndefined();
  });

  it("saveTracks: rekordy z Fingerprintem + rating placeholder, klucz 'pcloud|<id>'", async () => {
    await saveTracks(db, LIBRARY.tracks);
    const rec = await get(db, STORES.TRACKS, "pcloud|1");
    expect(rec).toEqual({ fingerprint: { size: 1000, modified: 1700000000 }, rating: null });
    expect((await getAllKeys(db, STORES.TRACKS)).length).toBe(2);
  });

  it("clearTracks wymazuje store tracks", async () => {
    await saveTracks(db, LIBRARY.tracks);
    await clearTracks(db);
    expect((await getAllKeys(db, STORES.TRACKS)).length).toBe(0);
  });

  it("saveTracks po rebuildzie zachowuje rating i lastPlayed (spec §4a: przeżywają unieważnienie)", async () => {
    await saveTracks(db, LIBRARY.tracks);
    const rec = await get(db, STORES.TRACKS, "pcloud|1");
    rec.rating = 160;
    rec.lastPlayed = 1234567890;
    const { put } = await import("../store/db.js");
    await put(db, STORES.TRACKS, "pcloud|1", rec);
    // Rebuild (ten sam listing, bez zmian Fingerprintu): łączenie, nie nadpisywanie.
    await saveTracks(db, LIBRARY.tracks);
    const after = await get(db, STORES.TRACKS, "pcloud|1");
    expect(after.rating).toBe(160);
    expect(after.lastPlayed).toBe(1234567890);
    expect(after.fingerprint).toEqual({ size: 1000, modified: 1700000000 });
    // Utwór, który nie dostał oceny/lastPlayed, ma dalej rating placeholder null.
    const other = await get(db, STORES.TRACKS, "pcloud|2");
    expect(other.rating).toBeNull();
  });

  it("rebuild atomowy: rating tylko przy zgodnym Fingerprintzie, lastPlayed zawsze, usunięty znika (spec §4a/4b)", async () => {
    const { put } = await import("../store/db.js");
    await saveTracks(db, LIBRARY.tracks);
    const rec = await get(db, STORES.TRACKS, "pcloud|1");
    rec.rating = 160;
    rec.lastPlayed = 1234567890;
    await put(db, STORES.TRACKS, "pcloud|1", rec);
    const rec2 = await get(db, STORES.TRACKS, "pcloud|2");
    rec2.rating = 196;
    rec2.lastPlayed = 42;
    await put(db, STORES.TRACKS, "pcloud|2", rec2);

    // Nowy listing: pcloud|1 bez zmian, pcloud|2 zmieniony tag (inny Fingerprint),
    // pcloud|3 nowy, pcloud|5 (warped/x.mp3) usunięty ze Źródła.
    await saveTracks(db, [
      { key: "pcloud|1", name: "a.mp3", fingerprint: { size: 1000, modified: 1700000000 } },
      { key: "pcloud|2", name: "b.mp3", fingerprint: { size: 2222, modified: 1800000000 } },
      { key: "pcloud|3", name: "c.mp3", fingerprint: { size: 10, modified: 2 } },
    ]);

    const t1 = await get(db, STORES.TRACKS, "pcloud|1");
    expect(t1.rating).toBe(160); // zgodny Fingerprint → cache ocen dalej ważny
    expect(t1.lastPlayed).toBe(1234567890);

    const t2 = await get(db, STORES.TRACKS, "pcloud|2");
    expect(t2.rating).toBeNull(); // rozbieżność → pola tagowe czyszczone (§4b)…
    expect(t2.lastPlayed).toBe(42); // …ale lastPlayed zostaje

    const t3 = await get(db, STORES.TRACKS, "pcloud|3");
    expect(t3).toEqual({ fingerprint: { size: 10, modified: 2 }, rating: null });

    expect(await get(db, STORES.TRACKS, "pcloud|5")).toBeUndefined();
  });

  it("del na tracks działa (podstaw walidacji per-odczyt)", async () => {
    await saveTracks(db, LIBRARY.tracks);
    await del(db, STORES.TRACKS, "pcloud|1");
    expect(await get(db, STORES.TRACKS, "pcloud|1")).toBeUndefined();
  });
});

describe("library-controller", () => {
  it("fallback: 1101 na pierwszym hoście → próba drugiego hosta + zapis do sources", async () => {
    const calls = [];
    const flakyApi = async (opts) => {
      calls.push(opts);
      if (opts.hostname === "api.pcloud.com") {
        const e = new Error("pCloud API error 1101: Invalid request");
        throw e;
      }
      return WATCHRESPONSE;
    };
    const WATCHRESPONSE = {
      result: 0,
      metadata: {
        isfolder: true,
        contents: [
          {
            name: "2017",
            isfolder: true,
            contents: [{ fileid: 1, name: "a.mp3", size: 1, modified: 2 }],
          },
        ],
      },
    };
    await put(db, STORES.SOURCES, "pcloud", {
      token: "tok",
      hostname: "api.pcloud.com",
      locationid: 1,
    });
    const { hostname, library } = await loadLibraryOrFetch({
      db,
      pcloudApi: flakyApi,
      token: "tok",
      hostname: "api.pcloud.com",
    });
    expect(hostname).toBe("eapi.pcloud.com");
    // 2 próby: spec na api (1101) → spec na eapi (OK)
    expect(calls.length).toBe(2);
    expect(calls[0].hostname).toBe("api.pcloud.com");
    expect(calls[1].hostname).toBe("eapi.pcloud.com");
    expect(calls[1].params).toEqual({ folderid: "0", recursive: "1", timeformat: "timestamp" });
    expect(library.tracks.length).toBe(1);
    // hostname naprawiony w sources — kolejne sesje nie powtarzają 1101
    expect(await get(db, STORES.SOURCES, "pcloud")).toMatchObject({ hostname: "eapi.pcloud.com" });
  });

  it("auth error (np. 2094) przerywa iterację — zero zapisów do cache", async () => {
    const calls = [];
    const authFail = async (opts) => {
      calls.push(opts);
      const e = new Error("pCloud API error 2094");
      e.isAuthError = true;
      throw e;
    };
    await expect(
      loadLibraryOrFetch({ db, pcloudApi: authFail, token: "t", hostname: "api.pcloud.com" }),
    ).rejects.toThrow("2094");
    expect(calls.length).toBe(1);
    expect((await getAllKeys(db, STORES.TRACKS)).length).toBe(0);
  });

  it("auth error tylko na drukim hoście → przechodzimy dalej, nie porzucamy strategii", async () => {
    // Realny scenariusz sesji: token EU ważny na eapi (userinfo OK), ale 2094 na api.
    // Root-recursive: 1101 na eapi → 2094 na api (auth error na DRUGIM hoście — to
    // rozjazd token↔host, nie zły token) → root-recursive kończy się niepowodzeniem
    // jako całość → root-per-folder na eapi ma się wykonać i zbudować bibliotekę.
    const calls = [];
    const api = async (opts) => {
      calls.push(opts);
      const p = opts.params;
      if (opts.hostname === "api.pcloud.com") {
        const e = new Error("pCloud API error 2094: Invalid 'access_token' provided.");
        e.isAuthError = true;
        throw e;
      }
      if (p.recursive === "1" && p.folderid === "0") {
        throw new Error("pCloud API error 1101: Invalid request");
      }
      if (p.folderid === "0") {
        return {
          result: 0,
          metadata: {
            isfolder: true,
            folderid: 0,
            contents: [
              { folderid: 100, name: "2017", isfolder: true },
              { fileid: 50, name: "root.mp3", size: 50, modified: 9, isfolder: false },
            ],
          },
        };
      }
      return {
        result: 0,
        metadata: {
          folderid: Number(p.folderid),
          isfolder: true,
          contents: [{ fileid: 1, name: "a.mp3", size: 10, modified: 1, isfolder: false }],
        },
      };
    };
    const { library } = await loadLibraryOrFetch({
      db,
      pcloudApi: api,
      token: "tok",
      hostname: "eapi.pcloud.com",
    });
    expect(calls.filter((c) => c.params.folderid === "100").length).toBeGreaterThan(0);
    expect(library.tracks.map((t) => t.name).sort()).toEqual(["a.mp3", "root.mp3"]);
  });

  it("licznik 'N pozycji … M bez oceny' zgodny z filtrem Rocznika", async () => {
    const { library } = await loadLibraryOrFetch({ db, pcloudApi: fakeApi([]) });
    const ratings = await loadRatings(db);

    const all = makeCounter({ library, rocznik: null, ratings });
    expect(all).toMatchObject({ total: 1, unrated: 1 });

    const r2017 = makeCounter({ library, rocznik: "2017", ratings });
    expect(r2017).toMatchObject({ total: 1, unrated: 1 });

    const r2018 = makeCounter({ library, rocznik: "2018", ratings });
    expect(r2018).toMatchObject({ total: 0, unrated: 0 });

    const missing = makeCounter({ library, rocznik: "2020", ratings });
    expect(missing.total).toBe(0);

    const empty = makeCounter({ library, rocznik: null, ratings });
    expect(empty.unrated).toBe(1);
    expect(empty.label).toBe("1 pozycji … 1 bez oceny");

    // po zapisaniu oceny unrated spada
    ratings.set("pcloud|1", { rating: 5 });
    expect(makeCounter({ library, rocznik: null, ratings }).unrated).toBe(0);
  });

  it("folderId ≠ 0 → recursive bezpośrednio na tym folderze (bez drabinki)", async () => {
    const calls = [];
    const api = async (opts) => {
      calls.push(opts);
      const p = opts.params;
      if (p.folderid === "100") {
        return {
          result: 0,
          metadata: {
            folderid: 100,
            isfolder: true,
            contents: [
              { folderid: 150, name: "2017", isfolder: true, contents: [] },
              { fileid: 1, name: "a.mp3", size: 10, modified: 1, isfolder: false },
            ],
          },
        };
      }
      throw new Error(`unexpected call folderid=${p.folderid} recursive=${p.recursive}`);
    };
    await put(db, STORES.SOURCES, "pcloud", {
      token: "tok",
      hostname: "eapi.pcloud.com",
      locationid: 1,
    });
    const { library, fromCache } = await loadLibraryOrFetch({
      db,
      pcloudApi: api,
      token: "tok",
      hostname: "eapi.pcloud.com",
      folderId: "100",
    });
    expect(fromCache).toBe(false);
    // dokładnie 1 call: listfolder folderid=100 recursive=1 — zero roota, zero drabinki
    expect(calls.length).toBe(1);
    expect(calls[0].params).toEqual({ folderid: "100", recursive: "1", timeformat: "timestamp" });
    expect(library.tracks.map((t) => t.name)).toEqual(["a.mp3"]);
    expect(library.roczniki.map((r) => r.name)).toEqual(["2017"]);
    // folderid utrwalony w sources dla kolejnych sesji
    expect(await get(db, STORES.SOURCES, "pcloud")).toMatchObject({ folderId: "100" });
  });

  it("kolejne wejście z tym samym folderId → cache", async () => {
    const api = async () => ({ result: 0, metadata: { isfolder: true, contents: [] } });
    await loadLibraryOrFetch({
      db,
      pcloudApi: api,
      token: "t",
      hostname: "eapi.pcloud.com",
      folderId: "7",
    });
    const calls = [];
    const fromCache = await loadLibraryOrFetch({
      db,
      pcloudApi: async (o) => (
        calls.push(o),
        { result: 0, metadata: { isfolder: true, contents: [] } }
      ),
      token: "t",
      hostname: "eapi.pcloud.com",
      folderId: "7",
    });
    expect(fromCache.fromCache).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("1101 na root recursive → listing roota + recursive per podfolder", async () => {
    const calls = [];
    const api = async (opts) => {
      calls.push(opts);
      const p = opts.params;
      if (p.recursive === "1" && p.folderid === "0") {
        throw new Error("pCloud API error 1101: Invalid request");
      }
      if (p.folderid === "0") {
        return {
          result: 0,
          metadata: {
            isfolder: true,
            folderid: 0,
            contents: [
              { folderid: 100, name: "2017", isfolder: true },
              { folderid: 200, name: "2018", isfolder: true },
              { fileid: 50, name: "root.mp3", size: 50, modified: 9, isfolder: false },
            ],
          },
        };
      }
      const sub =
        p.folderid === "100"
          ? [{ fileid: 1, name: "a.mp3", size: 10, modified: 1, isfolder: false }]
          : [{ fileid: 2, name: "b.mp3", size: 20, modified: 2, isfolder: false }];
      return {
        result: 0,
        metadata: { folderid: Number(p.folderid), isfolder: true, contents: sub },
      };
    };

    const { library } = await loadLibraryOrFetch({
      db,
      pcloudApi: api,
      token: "tok",
      hostname: "eapi.pcloud.com",
    });

    // 1101 na recursive roota (2× spec) → strategy fallback: listing roota + per-info
    expect(calls.filter((c) => c.params.folderid === "0").length).toBe(3);
    expect(calls.some((c) => c.params.folderid === "100" && c.params.recursive === "1")).toBe(true);
    expect(calls.some((c) => c.params.folderid === "200" && c.params.recursive === "1")).toBe(true);

    // pliki roota + pliki z roczników; rekordy w tracks
    expect(library.tracks.map((t) => t.name).sort()).toEqual(["a.mp3", "b.mp3", "root.mp3"]);
    expect(library.roczniki.map((r) => r.name).sort()).toEqual(["2017", "2018"]);
    expect((await getAllKeys(db, STORES.TRACKS)).length).toBe(3);
  });

  it("pierwsze uruchomienie: 1× listfolder recursive, cache w IDB", async () => {
    const calls = [];
    const { library, fromCache } = await loadLibraryOrFetch({
      db,
      pcloudApi: fakeApi(calls),
      token: "tok",
      hostname: "api.pcloud.com",
    });
    expect(fromCache).toBe(false);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({
      method: "listfolder",
      params: { folderid: "0", recursive: "1", timeformat: "timestamp" },
      token: "tok",
      hostname: "api.pcloud.com",
    });
    expect(library.tracks.length).toBe(1);
    expect(library.roczniki).toEqual([{ name: "2017", count: 1 }]);
    // cache zapisany (listing + tracks)
    expect((await getAllKeys(db, STORES.TRACKS)).length).toBe(1);
  });

  it("ponowne wejście: zero requestów listing (cache instant)", async () => {
    const calls = [];
    await loadLibraryOrFetch({ db, pcloudApi: fakeApi(calls) });
    expect(calls.length).toBe(1);
    const second = await loadLibraryOrFetch({ db, pcloudApi: fakeApi(calls) });
    expect(second.fromCache).toBe(true);
    expect(calls.length).toBe(1); // nadal 1 — odczyt z IDB
  });

  it("loadRatings: mapa trackKey → rekord", async () => {
    await loadLibraryOrFetch({ db, pcloudApi: fakeApi([]) });
    const ratings = await loadRatings(db);
    expect(ratings.get("pcloud|1")).toMatchObject({ rating: null });
  });

  it("licznik 'N pozycji … M bez oceny' zgodny z filtrem Rocznika", async () => {
    const { library } = await loadLibraryOrFetch({ db, pcloudApi: fakeApi([]) });
    const ratings = await loadRatings(db);

    const all = makeCounter({ library, rocznik: null, ratings });
    expect(all).toMatchObject({ total: 1, unrated: 1 });

    const r2017 = makeCounter({ library, rocznik: "2017", ratings });
    expect(r2017).toMatchObject({ total: 1, unrated: 1 });

    const r2018 = makeCounter({ library, rocznik: "2018", ratings });
    expect(r2018).toMatchObject({ total: 0, unrated: 0 });

    const missing = makeCounter({ library, rocznik: "2020", ratings });
    expect(missing.total).toBe(0);

    const empty = makeCounter({ library, rocznik: null, ratings });
    expect(empty.unrated).toBe(1);
    expect(empty.label).toBe("1 pozycji … 1 bez oceny");

    // po zapisaniu oceny unrated spada
    ratings.set("pcloud|1", { rating: 5 });
    expect(makeCounter({ library, rocznik: null, ratings }).unrated).toBe(0);
  });
});
