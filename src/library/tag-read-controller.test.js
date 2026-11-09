// Kontroler odczytu tagów (bilet #7): batch /head, eskalacja, cache, priorytety.
// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB, STORES } from "../store/db.js";
import { createTagReadController, fingerprintEqual } from "./tag-read-controller.js";

const TRACKS = [
  { key: "pcloud|1", fileid: 1, fingerprint: { size: 100, modified: 5 } },
  { key: "pcloud|2", fileid: 2, fingerprint: { size: 200, modified: 6 } },
  { key: "pcloud|3", fileid: 3, fingerprint: { size: 300, modified: 7 } },
];

function okBatch(delayMs = 0) {
  return async ({ fileids }) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return new Map(
      fileids.map((fileid) => [
        fileid,
        { status: "ok", bytes: new Uint8Array([0x49, 0x44, 0x33]) },
      ]),
    );
  };
}

function makeParse(overrides = {}) {
  return async () => ({
    rating: null,
    ratingSource: null,
    rgGainDb: null,
    rgSource: null,
    framesSeen: false,
    ...overrides,
  });
}

/** @type {IDBDatabase} */
let db;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  db = await openDB();
});

function makeController({
  ratings = new Map(),
  fetchHeadBatchImpl = okBatch(),
  parseImpl,
  fetchTrackStreamImpl = async () => new Response(new Uint8Array(32)),
  now,
  idleDelayMs = 0,
}) {
  /** @type {any[]} */
  const reads = [];
  const controller = createTagReadController({
    db,
    token: "tok",
    tracks: TRACKS,
    ratings,
    onTagsRead: (key, rec) => reads.push({ key, rec }),
    fetchHeadBatchImpl,
    fetchTrackStreamImpl,
    parseImpl: parseImpl ?? makeParse(),
    now,
    idleDelayMs,
  });
  return { controller, reads };
}

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("visible przepływ", () => {
  it("batch z /head → parse → cache z Fingerprintem i tagsReadAt; onTagsRead dla każdego", async () => {
    const { controller, reads } = makeController({
      parseImpl: makeParse({
        rating: 4,
        ratingSource: "max",
        rgGainDb: -6.5,
        rgSource: "TXXX",
        framesSeen: true,
      }),
    });
    controller.setVisibleTracks([TRACKS[0], TRACKS[1]]);
    await flush();
    expect(reads.map((r) => r.key).sort()).toEqual(["pcloud|1", "pcloud|2"]);
    for (const r of reads) {
      expect(r.rec.rating).toBe(4);
      expect(r.rec.ratingSource).toBe("max");
      expect(r.rec.rgGainDb).toBe(-6.5);
      expect(r.rec.rgSource).toBe("TXXX");
      expect(r.rec.tagsReadAt).toBeGreaterThan(0);
      expect(r.rec.fingerprint).toEqual(TRACKS.find((t) => t.key === r.key).fingerprint);
    }
  });

  it("cached (tagsReadAt zgodny) — nie fetchuje ponownie", async () => {
    let calls = 0;
    const impl = async ({ fileids }) => {
      calls += fileids.length;
      return okBatch()({ fileids });
    };
    const ratings = new Map([
      ["pcloud|1", { fingerprint: TRACKS[0].fingerprint, tagsReadAt: 1, rating: 3 }],
    ]);
    const { controller, reads } = makeController({ fetchHeadBatchImpl: impl, ratings });
    controller.setVisibleTracks([TRACKS[0], TRACKS[1]]);
    await flush();
    expect(calls).toBe(1); // tylko fileid 2
    expect(reads.map((r) => r.key)).toEqual(["pcloud|2"]);
  });
});

describe("eskalacja 8 KB → 512 KB → 2 MB", () => {
  it("brak ramek w headzie → /stream Range, a po znalezieniu — ocena z eskalacji", async () => {
    /** @type {string[]} */
    const ranges = [];
    const streamImpl = async ({ range }) => {
      ranges.push(range);
      return new Response(new Uint8Array([0xff, 0xff]));
    };
    let parseCall = 0;
    const parseImpl = async () => {
      parseCall++;
      return parseCall === 1
        ? { rating: null, rgGainDb: null, rgSource: null, ratingSource: null, framesSeen: false }
        : { rating: 5, ratingSource: "WMP", rgGainDb: null, rgSource: null, framesSeen: true };
    };
    const { controller, reads } = makeController({ parseImpl, fetchTrackStreamImpl: streamImpl });
    controller.setVisibleTracks([TRACKS[0]]);
    await flush();
    expect(ranges).toEqual(["bytes=0-524287"]);
    expect(reads[0].rec.rating).toBe(5);
    expect(reads[0].rec.ratingSource).toBe("WMP");
  });

  it("dwie eskalacje bez ramek = bez oceny (rating null, tagsReadAt ustawione)", async () => {
    const streamImpl = async () => new Response(new Uint8Array(32));
    const { controller, reads } = makeController({ fetchTrackStreamImpl: streamImpl });
    controller.setVisibleTracks([TRACKS[0]]);
    await flush();
    expect(reads[0].rec.rating).toBe(null);
    expect(reads[0].rec.ratingSource).toBe(null);
    expect(reads[0].rec.tagsReadAt).toBeGreaterThan(0);
  });
});

describe("rozbieżny Fingerprint", () => {
  it("rekord IDB z innym Fingerprintem → ocena null (jak bez oceny), tagsReadAt świeży", async () => {
    // W tym scenariuszu prev pochodzi z IDB: wash — seeded in IDB store with mismatching fingerprint:
    await import("../store/db.js").then(({ put }) =>
      put(db, STORES.TRACKS, "pcloud|1", {
        fingerprint: { size: 999, modified: 999 },
        rating: 5,
        ratingSource: "WMP",
      }),
    );
    const { controller, reads } = makeController({
      parseImpl: makeParse({ rating: 3, ratingSource: "max", framesSeen: true }),
    });
    controller.setVisibleTracks([TRACKS[0]]);
    await flush();
    expect(reads[0].rec.rating).toBe(null);
    expect(reads[0].rec.ratingSource).toBe(null);
    expect(reads[0].rec.rgGainDb).toBe(null);
    // Rozbieżny Fingerprint = jak bez oceny (tickets #7): tagsReadAt też null,
    // więc kolejna sesja ponowi odczyt.
    expect(reads[0].rec.tagsReadAt).toBe(null);
  });
});

describe("idle / backfill", () => {
  it("idle startuje dopiero po upływie idleDelayMs od ostaniej zmiany okna", async () => {
    let clock = 1000;
    const now = () => clock;
    const { controller, reads } = makeController({ now, idleDelayMs: 3000 });
    controller.setVisibleTracks([TRACKS[0]]);
    controller.enqueueIdle([TRACKS[1], TRACKS[2]]);
    await flush();
    expect(reads.map((r) => r.key).sort()).toEqual(["pcloud|1"]); // idle jeszcze nie
    clock += 3001; // upłynęła stabilność od zmiany okna
    await new Promise((r) => setTimeout(r, 1200)); // wewnętrzny timer 1 s
    await flush();
    expect(reads.map((r) => r.key).sort()).toEqual(["pcloud|1", "pcloud|2", "pcloud|3"]);
  });

  it("idleDelayMs=0 — idle startuje natychmiast po visible", async () => {
    const { controller, reads } = makeController({ idleDelayMs: 0 });
    controller.setVisibleTracks([TRACKS[0]]);
    controller.enqueueIdle([TRACKS[1], TRACKS[2]]);
    await flush();
    expect(reads.map((r) => r.key).sort()).toEqual(["pcloud|1", "pcloud|2", "pcloud|3"]);
  });

  it("aktywny scroll (onaScrollActive świeży) wstrzymuje idle", async () => {
    let clock = 1000;
    const now = () => clock;
    const { controller, reads } = makeController({ now, idleDelayMs: 3000 });
    controller.enqueueIdle([TRACKS[1]]);
    await flush();
    expect(reads.length).toBe(0);
    clock = 5000;
    controller.onScrollActive(); // świeży scroll
    await flush();
    clock = 9999; // < lastScroll + 3000
    expect(reads.length).toBe(0);
  });
});

describe("błędy i retry", () => {
  it("błąd per plik → 3 próby łącznie (1 + 2 retry), potem failed bez onTagsRead", async () => {
    let calls = 0;
    const impl = async ({ fileids }) => {
      calls++;
      return new Map(fileids.map((fileid) => [fileid, { status: "error", code: "x" }]));
    };
    const { controller, reads } = makeController({ fetchHeadBatchImpl: impl });
    controller.setVisibleTracks([TRACKS[0]]);
    await flush();
    expect(calls).toBe(3); // 3 próby łącznie, nie więcej
    expect(reads.length).toBe(0);
  });

  it("błąd całego batcha (sieć) — te same 3 próby per track, potem failed", async () => {
    let calls = 0;
    const impl = async () => {
      calls++;
      throw new Error("network down");
    };
    const { controller, reads } = makeController({ fetchHeadBatchImpl: impl });
    controller.setVisibleTracks([TRACKS[0]]);
    await flush();
    expect(calls).toBe(3);
    expect(reads.length).toBe(0);
  });

  it("eskalacja nieudana (sieć) → brak zapisu ratingu null, track wraca do kolejki", async () => {
    let streamCalls = 0;
    const streamImpl = async () => {
      streamCalls++;
      throw new Error("stream down");
    };
    const { controller, reads } = makeController({
      fetchTrackStreamImpl: streamImpl, // domyślny parse: framesSeen false
    });
    controller.setVisibleTracks([TRACKS[0]]);
    await flush();
    // 2 zakresy eskalacji × 3 próby (retry) — nigdy zapis rating=null z tagsReadAt
    expect(reads.length).toBe(0);
    expect(streamCalls).toBeGreaterThanOrEqual(2);
  });
});

describe("fingerprintEqual", () => {
  it("true/false", () => {
    expect(fingerprintEqual({ size: 1, modified: 2 }, { size: 1, modified: 2 })).toBe(true);
    expect(fingerprintEqual({ size: 1, modified: 2 }, { size: 1, modified: 3 })).toBe(false);
    expect(fingerprintEqual(undefined, { size: 1, modified: 2 })).toBe(false);
  });
});
