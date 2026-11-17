// Kontroler zapisu oceny (bilet #8): optimistic UI, serializowany upload,
// aktualizacja cache `tracks` (Fingerprint) + wycofanie przy błędzie.
// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB, get, put, STORES } from "../store/db.js";
import { createRatingController } from "./rating-controller.js";

const WMP_OWNER = "Windows Media Player 9 Series";
const SOURCE = "pcloud";

/** @type {IDBDatabase} */
let db;

/** @param {string} s */
function latin1(s) {
  return [...s].map((c) => c.charCodeAt(0));
}

/** @param {number} stars */
function starsToByte(stars) {
  return { 1: 1, 2: 64, 3: 128, 4: 196, 5: 255 }[stars];
}

/** Minimalny MP3 z ID3v2.3 i jedną ramką WMP POPM — wejście „z chmury”. */
function mp3WithRating(stars) {
  const owner = latin1(WMP_OWNER + "\0");
  const body = [...owner, starsToByte(stars)];
  const size = body.length;
  const macro = [
    0x50,
    0x4f,
    0x50,
    0x4d,
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    0,
    0,
  ];
  const frames = [...macro, ...body];
  const padding = Array.from({ length: 32 }, () => 0);
  const tagBody = [...frames, ...padding];
  const n = tagBody.length;
  const header = [
    0x49,
    0x44,
    0x33,
    3,
    0,
    0,
    (n >>> 21) & 0x7f,
    (n >>> 14) & 0x7f,
    (n >>> 7) & 0x7f,
    n & 0x7f,
  ];
  const audio = [0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4];
  return new Uint8Array([...header, ...tagBody, ...audio]);
}

/** Bajt oceny WMP z bufora (null = brak ramki) — niezależny reader do asercji uploadu. */
function wmpByte(bytes) {
  const size =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  let p = 10;
  while (p + 10 <= 10 + size) {
    const id = String.fromCharCode(...bytes.subarray(p, p + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len =
      ((bytes[p + 4] << 24) | (bytes[p + 5] << 16) | (bytes[p + 6] << 8) | bytes[p + 7]) >>> 0;
    if (id === "POPM") {
      const body = bytes.subarray(p + 10, p + 10 + len);
      const z = body.indexOf(0);
      const owner = String.fromCharCode(...body.subarray(0, z));
      if (/windows media player/i.test(owner)) return body[z + 1];
    }
    p += 10 + len;
  }
  return null;
}

function makeTrack(overrides = {}) {
  return {
    key: "pcloud|7",
    fileid: 7,
    name: "a.mp3",
    folderid: "100",
    size: 100,
    modified: 10,
    fingerprint: { size: 100, modified: 10 },
    ...overrides,
  };
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  db = await openDB();
});

function makeController({
  track = makeTrack(),
  ratings,
  fetchBytes = async () => mp3WithRating(3),
  statFile = async () => ({ parentfolderid: "100" }),
  upload = async ({ bytes }) => ({
    fileid: track.fileid,
    name: track.name,
    size: bytes.length,
    modified: 20,
  }),
  onChange,
  now = () => 1234,
} = {}) {
  const cache = /** @type {Map<string, any>} */ (
    ratings ??
    new Map([
      [
        track.key,
        { fingerprint: track.fingerprint, rating: 3, ratingSource: "WMP", tagsReadAt: 1 },
      ],
    ])
  );
  const changes = [];
  const controller = createRatingController({
    db,
    token: "tok",
    hostname: "eapi.pcloud.com",
    tracks: [track],
    ratings: cache,
    onChange: (key, state) => {
      changes.push({ key, ...state });
      onChange?.(key, state);
    },
    fetchBytes,
    statFile,
    upload,
    now,
  });
  return { controller, ratings: cache, changes, track };
}

describe("optimistic UI", () => {
  it("rate() ustawia gwiazdki w mapie i woła onChange synchronicznie, zanim ruszy fetch", async () => {
    let fetchCalls = 0;
    const { controller, ratings, changes } = makeController({
      fetchBytes: async () => {
        fetchCalls++;
        return mp3WithRating(3);
      },
    });
    controller.rate(makeTrack(), 5);
    expect(ratings.get("pcloud|7").rating).toBe(5);
    expect(changes[0]).toMatchObject({ key: "pcloud|7", rating: 5, pending: true });
    expect(fetchCalls).toBe(0); // optymistyczny stan przed jakąkolwiek pracą w tle
    await controller.whenIdle();
    expect(changes.at(-1)).toMatchObject({ rating: 5, pending: false });
  });

  it("0/null = usunięcie oceny (ramka WMP znika z uploadu)", async () => {
    const uploaded = [];
    const { controller, track } = makeController({
      upload: async ({ bytes }) => {
        uploaded.push(wmpByte(bytes));
        return { fileid: track.fileid, name: track.name, size: bytes.length, modified: 20 };
      },
    });
    controller.rate(track, null);
    await controller.whenIdle();
    expect(uploaded).toEqual([null]);
    const rec = await get(db, STORES.TRACKS, track.key);
    expect(rec.rating).toBe(null);
  });
});

describe("sukces — cache `tracks` i Fingerprint", () => {
  it("zapisuje nowy Fingerprint, ocenę i tagsReadAt (bez ponownego odczytu tagu)", async () => {
    const { controller, track, ratings } = makeController();
    controller.rate(track, 4);
    await controller.whenIdle();

    const rec = await get(db, STORES.TRACKS, track.key);
    expect(rec.rating).toBe(4);
    expect(rec.ratingSource).toBe("WMP");
    expect(rec.tagsReadAt).toBe(1234);
    expect(rec.fingerprint).toEqual({ size: rec.fingerprint.size, modified: 20 });
    expect(rec.fingerprint.size).toBeGreaterThan(0);
    expect(ratings.get(track.key)).toEqual(rec);
    expect(track.fingerprint).toEqual(rec.fingerprint); // obiekt biblioteki też świeży
  });

  it("zachowuje lastPlayed i RG (spec §4a: unieważniamy tylko pola tagowe)", async () => {
    const track = makeTrack();
    await put(db, STORES.TRACKS, track.key, {
      fingerprint: track.fingerprint,
      rating: 3,
      ratingSource: "WMP",
      tagsReadAt: 1,
      lastPlayed: 999,
      rgGainDb: -5,
    });
    const { controller } = makeController({ track });
    controller.rate(track, 5);
    await controller.whenIdle();
    const rec = await get(db, STORES.TRACKS, track.key);
    expect(rec.lastPlayed).toBe(999);
    expect(rec.rgGainDb).toBe(-5);
  });

  it("stary cache bez folderid → stat?fileid i upload do parentfolderid", async () => {
    const track = makeTrack({ folderid: null });
    let statCalls = 0;
    let uploadedFolder = null;
    const { controller } = makeController({
      track,
      statFile: async ({ fileid }) => {
        statCalls++;
        expect(fileid).toBe(7);
        return { parentfolderid: 321 };
      },
      upload: async ({ folderId, bytes }) => {
        uploadedFolder = folderId;
        return { fileid: track.fileid, name: track.name, size: bytes.length, modified: 20 };
      },
    });
    controller.rate(track, 4);
    await controller.whenIdle();
    expect(statCalls).toBe(1);
    expect(uploadedFolder).toBe("321");
    expect(track.folderid).toBe("321");
  });

  it("aktualizuje cache biblioteki (`library.tracks`), więc restart nie widzi starego Fingerprintu", async () => {
    const track = makeTrack();
    await put(db, STORES.LIBRARY, SOURCE, {
      fingerprint: { size: 1, modified: 1 },
      tracks: [track],
      roczniki: [],
    });
    const { controller } = makeController({ track });
    controller.rate(track, 2);
    await controller.whenIdle();
    const lib = await get(db, STORES.LIBRARY, SOURCE);
    expect(lib.tracks[0].fingerprint.modified).toBe(20);
    expect(lib.tracks[0].fingerprint.size).toBeGreaterThan(0);
  });
});

describe("serializacja uploadów", () => {
  it("kolejność kliknięć = kolejność uploadów; nigdy dwa równolegle", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const uploaded = [];
    const { controller, track } = makeController({
      upload: async ({ bytes }) => {
        uploaded.push(wmpByte(bytes));
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight--;
        return { fileid: track.fileid, name: track.name, size: bytes.length, modified: 20 };
      },
    });
    controller.rate(track, 3);
    controller.rate(track, 5);
    controller.rate(track, 2);
    await controller.whenIdle();
    expect(uploaded).toEqual([128, 255, 64]);
    expect(maxInflight).toBe(1);
  });

  it("dwa kontrolery (np. po przebudowie roota) też nie uploadują równolegle", async () => {
    const t1 = makeTrack();
    const t2 = makeTrack({ key: "pcloud|8", fileid: 8, name: "b.mp3" });
    let inflight = 0;
    let maxInflight = 0;
    const order = [];
    const upload = async ({ filename, bytes }) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      order.push(filename);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return {
        fileid: filename === "a.mp3" ? 7 : 8,
        name: filename,
        size: bytes.length,
        modified: 20,
      };
    };
    const make = (track) =>
      createRatingController({
        db,
        token: "tok",
        hostname: "eapi.pcloud.com",
        tracks: [track],
        ratings: new Map([[track.key, { fingerprint: track.fingerprint, rating: null }]]),
        onChange: () => {},
        fetchBytes: async () => mp3WithRating(3),
        statFile: async () => ({ parentfolderid: "1" }),
        upload,
        now: () => 1,
      });
    const one = make(t1);
    const two = make(t2);
    one.rate(t1, 3);
    two.rate(t2, 4);
    await Promise.all([one.whenIdle(), two.whenIdle()]);
    expect(maxInflight).toBe(1);
    expect(order).toEqual(["a.mp3", "b.mp3"]);
  });
});

describe("awaria — UI nie kłamie", () => {
  it("błąd fetchu wycofuje optimistic do potwierdzonej oceny i nie rusza cache", async () => {
    const track = makeTrack();
    await put(db, STORES.TRACKS, track.key, {
      fingerprint: track.fingerprint,
      rating: 3,
      tagsReadAt: 1,
    });
    const { controller, ratings, changes } = makeController({
      track,
      fetchBytes: async () => {
        throw new Error("pcloud_link_unavailable");
      },
    });
    controller.rate(track, 5);
    expect(ratings.get(track.key).rating).toBe(5);
    await controller.whenIdle();
    expect(ratings.get(track.key).rating).toBe(3);
    expect(changes.at(-1)).toMatchObject({ rating: 3, pending: false });
    expect(changes.at(-1).error).toBeTruthy();
    const rec = await get(db, STORES.TRACKS, track.key);
    expect(rec.rating).toBe(3);
    expect(rec.fingerprint).toEqual(track.fingerprint);
  });

  it("fileid po overwrite inny niż oczekiwany → błąd (klucz cache by się rozjechał)", async () => {
    const track = makeTrack();
    await put(db, STORES.TRACKS, track.key, {
      fingerprint: track.fingerprint,
      rating: 3,
      tagsReadAt: 1,
    });
    const { controller, ratings, changes } = makeController({
      track,
      upload: async ({ bytes }) => ({
        fileid: 999,
        name: track.name,
        size: bytes.length,
        modified: 20,
      }),
    });
    controller.rate(track, 4);
    await controller.whenIdle();
    expect(ratings.get(track.key).rating).toBe(3);
    expect(changes.at(-1).error?.message).toMatch(/fileid/);
    const rec = await get(db, STORES.TRACKS, track.key);
    expect(rec.rating).toBe(3);
  });

  it("pierwszy klik się udaje, drugi pada → rollback do potwierdzonej (4★)", async () => {
    const track = makeTrack();
    let call = 0;
    const { controller, ratings } = makeController({
      track,
      upload: async ({ bytes }) => {
        call++;
        if (call === 2) throw new Error("upload failed");
        return { fileid: track.fileid, name: track.name, size: bytes.length, modified: 20 };
      },
    });
    controller.rate(track, 4);
    await controller.whenIdle();
    controller.rate(track, 5);
    await controller.whenIdle();
    expect(ratings.get(track.key).rating).toBe(4);
  });

  it("późniejszy klik nie jest nadpisany przez wynik starszego uploadu", async () => {
    const track = makeTrack();
    /** @type {any} */
    let resolveFirst;
    let call = 0;
    const { controller, ratings, changes } = makeController({
      track,
      upload: async ({ bytes }) => {
        call++;
        if (call === 1) await new Promise((r) => (resolveFirst = r));
        return { fileid: track.fileid, name: track.name, size: bytes.length, modified: 20 };
      },
    });
    controller.rate(track, 3);
    await new Promise((r) => setTimeout(r, 0)); // pierwszy upload wisi
    controller.rate(track, 5);
    expect(ratings.get(track.key).rating).toBe(5);
    resolveFirst();
    await new Promise((r) => setTimeout(r, 0));
    expect(ratings.get(track.key).rating).toBe(5); // UI wciąż pokazuje najnowszy wybór
    expect(changes.some((c) => c.rating === 3 && c.pending === false)).toBe(false);
    await controller.whenIdle();
    expect(ratings.get(track.key).rating).toBe(5);
    expect((await get(db, STORES.TRACKS, track.key)).rating).toBe(5);
  });
});
