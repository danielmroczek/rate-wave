// Kontroler zapisu oceny (bilety #8/#9): optimistic UI, serializowany upload,
// aktualizacja cache `tracks`, kolejka `pending-ratings` przy awarii sieci
// i flush wg createdAt + read-check Fingerprintu.
// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB, get, put, STORES } from "../store/db.js";
import { createRatingController } from "./rating-controller.js";
import { enqueuePendingRating, listPendingRatings } from "./pending-ratings.js";

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

/** Wartość TXXX `bpm` z bufora (null = brak ramki) — niezależny reader uploadu. */
function bpmValue(bytes) {
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
    if (id === "TXXX") {
      const body = bytes.subarray(p + 10, p + 10 + len);
      const z = body.indexOf(0, 1);
      const desc = String.fromCharCode(...body.subarray(1, z));
      if (desc.toLowerCase() === "bpm") {
        const end = body.indexOf(0, z + 1);
        const text = String.fromCharCode(...body.subarray(z + 1, end < 0 ? undefined : end));
        return Number(text);
      }
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
  onBpmChange,
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
  const bpmChanges = [];
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
    onBpmChange: (key, state) => {
      bpmChanges.push({ key, ...state });
      onBpmChange?.(key, state);
    },
    fetchBytes,
    statFile,
    upload,
    now,
  });
  return { controller, ratings: cache, changes, bpmChanges, track };
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
  it("trwały błąd (zły fileid) wycofuje optimistic do potwierdzonej oceny i nie rusza cache", async () => {
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

describe("pending-ratings — ocena nie ginie przy słabym łączu (bilet #9)", () => {
  const offline = () => Promise.reject(new TypeError("Failed to fetch"));

  it("błąd sieci → rekord w pending-ratings, gwiazdki zostają z ⏳ (bez rollbacku)", async () => {
    const track = makeTrack();
    await put(db, STORES.TRACKS, track.key, {
      fingerprint: track.fingerprint,
      rating: 3,
      tagsReadAt: 1,
    });
    const { controller, ratings, changes } = makeController({ track, fetchBytes: offline });
    controller.rate(track, 5);
    await controller.whenIdle();

    expect(ratings.get(track.key).rating).toBe(5);
    expect(changes.at(-1)).toMatchObject({ rating: 5, pending: true, queued: true });
    const queued = await listPendingRatings(db);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      key: track.key,
      fingerprint: track.fingerprint,
      ratingByte: 255,
      action: "set",
      createdAt: 1234,
    });
    // Cache ocen w IDB też niesie stan kolejki (§7) + pole `pendingUpload` (§4a).
    const cached = await get(db, STORES.TRACKS, track.key);
    expect(cached).toMatchObject({ rating: 5, pendingUpload: true });
  });

  it("klasyfikacja awarii: sieć, HTTP 5xx i sesja → kolejka; HTTP 4xx → rollback", async () => {
    const failure = (err) => async () => {
      throw err;
    };
    const cases = [
      { error: Object.assign(new Error("boom"), { isNetworkError: true }), queued: true },
      { error: Object.assign(new Error("pCloud upload HTTP 503"), { status: 503 }), queued: true },
      { error: Object.assign(new Error("pCloud upload HTTP 500"), { status: 500 }), queued: true },
      { error: Object.assign(new Error("pCloud upload HTTP 401"), { status: 401 }), queued: true },
      { error: Object.assign(new Error("pCloud upload HTTP 400"), { status: 400 }), queued: false },
    ];
    for (const { error, queued } of cases) {
      globalThis.indexedDB = new IDBFactory();
      db = await openDB();
      const track = makeTrack();
      const { controller } = makeController({ track, fetchBytes: failure(error) });
      controller.rate(track, 4);
      await controller.whenIdle();
      const records = await listPendingRatings(db);
      expect({ message: error.message, queued: records.length === 1 }).toEqual({
        message: error.message,
        queued,
      });
    }
  });

  it("kolejne kliknięcia tego samego Utworu → jeden rekord, ostatni wygrywa (LWW)", async () => {
    const track = makeTrack();
    let clock = 100;
    const { controller } = makeController({
      track,
      fetchBytes: offline,
      now: () => ++clock,
    });
    controller.rate(track, 1);
    await controller.whenIdle();
    controller.rate(track, 4);
    await controller.whenIdle();

    const queued = await listPendingRatings(db);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ ratingByte: 196, action: "set", createdAt: 102 });
  });

  it("usunięcie oceny offline → action: remove, ratingByte 0", async () => {
    const track = makeTrack();
    const { controller, ratings } = makeController({ track, fetchBytes: offline });
    controller.rate(track, null);
    await controller.whenIdle();
    expect(ratings.get(track.key).rating).toBe(null);
    const queued = await listPendingRatings(db);
    expect(queued[0]).toMatchObject({ action: "remove", ratingByte: 0 });
  });
});

describe("flush pending-ratings (bilet #9)", () => {
  /** Kontroler z dwoma Utworami i przełączaną siecią. */
  function makeMulti({ stat } = {}) {
    const SIZE = mp3WithRating(3).byteLength;
    const t1 = makeTrack({ size: SIZE, fingerprint: { size: SIZE, modified: 10 } });
    const t2 = makeTrack({
      key: "pcloud|8",
      fileid: 8,
      name: "b.mp3",
      size: SIZE,
      fingerprint: { size: SIZE, modified: 10 },
    });
    const uploads = [];
    const changes = [];
    /** @type {Set<string>} */
    const up = new Set();
    let clock = 100;
    const controller = createRatingController({
      db,
      token: "tok",
      hostname: "eapi.pcloud.com",
      tracks: [t1, t2],
      ratings: new Map([
        [t1.key, { fingerprint: t1.fingerprint, rating: 3, ratingSource: "WMP", tagsReadAt: 1 }],
        [t2.key, { fingerprint: t2.fingerprint, rating: 1, ratingSource: "WMP", tagsReadAt: 1 }],
      ]),
      onChange: (key, state) => changes.push({ key, ...state }),
      fetchBytes: async () => {
        if (!up.has("net") && !up.has("ready")) throw new TypeError("Failed to fetch");
        return mp3WithRating(3);
      },
      statFile: async (o) => stat?.(o) ?? { parentfolderid: "100" },
      upload: async ({ filename, bytes }) => {
        uploads.push({ filename, byte: wmpByte(bytes) });
        return {
          fileid: filename === "a.mp3" ? 7 : 8,
          name: filename,
          size: bytes.length,
          modified: 20,
        };
      },
      now: () => clock++,
    });
    return {
      controller,
      t1,
      t2,
      uploads,
      changes,
      goOnline() {
        up.add("ready");
      },
    };
  }

  it("flush wysyła rekordy wg createdAt, po sukcesie czyści kolejkę i cache jest spójny", async () => {
    const h = makeMulti();
    h.controller.rate(h.t1, 5); // createdAt 100 — offline
    h.controller.rate(h.t2, 4); // createdAt 101 — offline
    await h.controller.whenIdle();
    expect(await listPendingRatings(db)).toHaveLength(2);

    h.goOnline();
    const summary = await h.controller.flush();

    expect(summary).toMatchObject({ flushed: 2, failed: 0, aborted: 0, skipped: 0 });
    expect(h.uploads).toEqual([
      { filename: "a.mp3", byte: 255 },
      { filename: "b.mp3", byte: 196 },
    ]);
    expect(await listPendingRatings(db)).toEqual([]);
    expect((await get(db, STORES.TRACKS, h.t1.key)).rating).toBe(5);
    expect((await get(db, STORES.TRACKS, h.t1.key)).pendingUpload).toBeUndefined();
    expect((await get(db, STORES.TRACKS, h.t2.key)).rating).toBe(4);
    expect(h.changes.filter((c) => c.pending === false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: h.t1.key, rating: 5 }),
        expect.objectContaining({ key: h.t2.key, rating: 4 }),
      ]),
    );
  });

  it("konflikt tego samego Utworu: tylko najnowszy wpis wchodzi do uploadu (LWW)", async () => {
    const h = makeMulti();
    h.controller.rate(h.t1, 1);
    await h.controller.whenIdle();
    h.controller.rate(h.t1, 3);
    await h.controller.whenIdle();
    h.controller.rate(h.t1, 5);
    await h.controller.whenIdle();

    h.goOnline();
    const summary = await h.controller.flush();
    expect(summary.flushed).toBe(1);
    expect(h.uploads).toEqual([{ filename: "a.mp3", byte: 255 }]);
  });

  it("rozbieżny Fingerprint → przerwanie z informacją, bez uploadu, ⏳ znika", async () => {
    const h = makeMulti({
      stat: async () => ({ parentfolderid: "100", size: 100, modified: 99 }),
    });
    h.controller.rate(h.t1, 5);
    await h.controller.whenIdle();

    h.goOnline();
    const summary = await h.controller.flush();
    expect(summary.aborted).toBe(1);
    expect(h.uploads).toEqual([]);
    expect(await listPendingRatings(db)).toEqual([]); // rekord nie wraca do kolejki
    const last = h.changes.at(-1);
    expect(last).toMatchObject({ key: h.t1.key, pending: false });
    expect(last.info).toMatch(/file changed/i);
    expect(last.rating).toBe(null); // rozbieżność unieważnia cache ocen (spec §4a)
  });

  it("flush przy martwej sieci → rekord zostaje, failed rośnie", async () => {
    const h = makeMulti();
    h.controller.rate(h.t1, 5);
    await h.controller.whenIdle();

    const summary = await h.controller.flush();
    expect(summary.failed).toBe(1);
    expect(await listPendingRatings(db)).toHaveLength(1);
  });

  it("udany zapis online przebija kolejkę (po każdym sukcesie)", async () => {
    const h = makeMulti();
    h.controller.rate(h.t2, 4); // do kolejki
    await h.controller.whenIdle();
    h.goOnline();

    h.controller.rate(h.t1, 5); // sukces online → flush tła
    await h.controller.whenIdle();

    expect(h.uploads.map((u) => u.filename)).toEqual(["a.mp3", "b.mp3"]);
    expect(await listPendingRatings(db)).toEqual([]);
  });
});

describe("TAP tempo — zapis BPM (bilet 13)", () => {
  it("setBpm optymistycznie ustawia BPM i woła onBpmChange przed fetchem", async () => {
    let fetchCalls = 0;
    const { controller, ratings, bpmChanges } = makeController({
      ratings: new Map([["pcloud|7", { rating: 3, bpm: null, tagsReadAt: 1 }]]),
      fetchBytes: async () => {
        fetchCalls++;
        return mp3WithRating(3);
      },
    });
    controller.setBpm(makeTrack(), 128);
    expect(ratings.get("pcloud|7").bpm).toBe(128);
    expect(bpmChanges[0]).toMatchObject({ key: "pcloud|7", bpm: 128, pending: true });
    expect(fetchCalls).toBe(0);
    await controller.whenIdle();
    expect(bpmChanges.at(-1)).toMatchObject({ bpm: 128, pending: false });
  });

  it("upload niesie TXXX bpm, zachowuje POPM i aktualizuje cache + Fingerprint", async () => {
    const uploads = [];
    const { controller, ratings, track } = makeController({
      ratings: new Map([["pcloud|7", { rating: 3, ratingSource: "WMP", bpm: null }]]),
      upload: async ({ bytes }) => {
        uploads.push(bytes);
        return { fileid: track.fileid, name: track.name, size: bytes.length, modified: 20 };
      },
    });
    controller.setBpm(track, 128);
    await controller.whenIdle();

    expect(uploads).toHaveLength(1);
    expect(bpmValue(uploads[0])).toBe(128);
    expect(wmpByte(uploads[0])).toBe(128); // 3★ nietknięte
    const rec = await get(db, STORES.TRACKS, "pcloud|7");
    expect(rec).toMatchObject({ bpm: 128, rating: 3, ratingSource: "WMP" });
    expect(rec.fingerprint).toEqual({ size: uploads[0].length, modified: 20 });
    expect(ratings.get("pcloud|7").bpm).toBe(128);
  });

  it("awaria trwała wycofuje BPM do ostatniego potwierdzonego stanu", async () => {
    const { controller, ratings, bpmChanges } = makeController({
      ratings: new Map([["pcloud|7", { rating: 3, bpm: 100 }]]),
      fetchBytes: async () => {
        throw new Error("no such file");
      },
    });
    controller.setBpm(makeTrack(), 140);
    await controller.whenIdle();

    expect(ratings.get("pcloud|7").bpm).toBe(100);
    const last = bpmChanges.at(-1);
    expect(last).toMatchObject({ bpm: 100, pending: false });
    expect(last.error).toBeInstanceOf(Error);
  });

  it("odrzuca BPM niecałkowite lub <= 0", () => {
    const { controller } = makeController();
    expect(() => controller.setBpm(makeTrack(), 0)).toThrow(RangeError);
    expect(() => controller.setBpm(makeTrack(), 120.5)).toThrow(RangeError);
  });
});

describe("TAP tempo — BPM nie kłóci się z kolejką ocen (bilet 13)", () => {
  it("zapis BPM zachowuje poczekującą ocenę i jej ⏳ (pendingUpload)", async () => {
    const { controller, track } = makeController({
      ratings: new Map([
        ["pcloud|7", { rating: 5, ratingSource: "WMP", bpm: null, pendingUpload: true }],
      ]),
    });
    await put(db, STORES.TRACKS, "pcloud|7", {
      rating: 5,
      ratingSource: "WMP",
      bpm: null,
      pendingUpload: true,
    });
    controller.setBpm(track, 100);
    await controller.whenIdle();
    const rec = await get(db, STORES.TRACKS, "pcloud|7");
    expect(rec.bpm).toBe(100);
    expect(rec.rating).toBe(5); // plik ma 3★ — poczekująca ocena ma pierwszeństwo
    expect(rec.pendingUpload).toBe(true);
  });
});

describe("TAP tempo — Fingerprint kolejki po zapisie BPM (bilet 13)", () => {
  it("zapis BPM odświeża Fingerprint poczekującej oceny (nie unieważnia jej)", async () => {
    const track = makeTrack();
    await enqueuePendingRating(db, {
      key: track.key,
      fingerprint: { size: 100, modified: 10 },
      ratingByte: 255,
      action: "set",
      createdAt: 1,
    });
    const { controller } = makeController({
      track,
      ratings: new Map([["pcloud|7", { rating: 5, pendingUpload: true }]]),
      upload: async ({ bytes }) => ({
        fileid: track.fileid,
        name: track.name,
        size: bytes.length,
        modified: 20,
      }),
    });
    await put(db, STORES.TRACKS, track.key, {
      rating: 5,
      pendingUpload: true,
      fingerprint: { size: 100, modified: 10 },
    });
    controller.setBpm(track, 90);
    await controller.whenIdle();
    const [pending] = await listPendingRatings(db);
    expect(pending.fingerprint).toEqual({ size: expect.any(Number), modified: 20 });
    expect(pending.ratingByte).toBe(255);
  });
});
