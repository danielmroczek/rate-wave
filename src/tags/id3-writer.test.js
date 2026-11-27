// ID3v2.3 rewrite oceny (bilet #8, spec §2a; szablon zachowania z testu T7).
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { rewriteId3Rating, rewriteId3Tags, WMP_OWNER } from "./id3-writer.js";

const OLD_WMP_BODY = [...latin1(WMP_OWNER + "\0"), 196, 0, 0, 0, 0];
const FOREIGN_BODY = [...latin1("MusicBee\0"), 64];
const TXXX_RG_BODY = [0, ...latin1("replaygain_track_gain"), 0, ...latin1("+3.75 dB")];
const AUDIO = [0xff, 0xfb, 0x90, 0x64, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66];

/** @param {number[]} head */
function bytes(...parts) {
  const out = [];
  for (const p of parts) out.push(...p);
  return new Uint8Array(out);
}

/** @param {string} s */
function latin1(s) {
  return [...s].map((c) => c.charCodeAt(0));
}

/** @param {string} id @param {number[]} body @param {number[]} [flags] */
function frame(id, body, flags = [0, 0]) {
  const size = body.length;
  return bytes(
    latin1(id),
    [(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff],
    flags,
    body,
  );
}

/** @param {number} bodySize */
function synchsafe(bodySize) {
  return [
    (bodySize >>> 21) & 0x7f,
    (bodySize >>> 14) & 0x7f,
    (bodySize >>> 7) & 0x7f,
    bodySize & 0x7f,
  ];
}

/** @param {Uint8Array[]} frames @param {{ major?: number, padding?: number }} [opts] */
function id3Tag(frames, { major = 3, padding = 64 } = {}) {
  const body = bytes(
    ...frames,
    Array.from({ length: padding }, () => 0),
  );
  return bytes([0x49, 0x44, 0x33, major, 0, 0], synchsafe(body.length), body);
}

/** Test-local frame reader — mirrors the v2.3 spec, independent of the writer. */
function readFrames(buf) {
  expect([...buf.subarray(0, 3)]).toEqual([0x49, 0x44, 0x33]);
  const major = buf[3];
  const size =
    ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const frames = [];
  let p = 10;
  const end = 10 + size;
  while (p + 10 <= end) {
    const id = String.fromCharCode(...buf.subarray(p, p + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len =
      major === 4
        ? ((buf[p + 4] & 0x7f) << 21) |
          ((buf[p + 5] & 0x7f) << 14) |
          ((buf[p + 6] & 0x7f) << 7) |
          (buf[p + 7] & 0x7f)
        : ((buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7]) >>> 0;
    frames.push({ id, body: buf.subarray(p + 10, p + 10 + len) });
    p += 10 + len;
  }
  return { major, frames, end };
}

/** @param {Uint8Array} body */
function popmBody(body) {
  const z = body.indexOf(0);
  return {
    owner: String.fromCharCode(...body.subarray(0, z)),
    rating: body[z + 1],
    rest: [...body.subarray(z + 2)],
  };
}

const WMP_BYTES = { 1: 1, 2: 64, 3: 128, 4: 196, 5: 255 };

describe("rewriteId3Rating — ustawianie oceny w ramce WMP", () => {
  it("1–5★ zapisuje kratę WMP (1/64/128/196/255) w jednej ramce z ownerem bez @", () => {
    const original = bytes(
      id3Tag([
        frame("POPM", OLD_WMP_BODY),
        frame("POPM", FOREIGN_BODY),
        frame("TXXX", TXXX_RG_BODY),
      ]),
      AUDIO,
    );
    for (const stars of /** @type {const} */ ([1, 2, 3, 4, 5])) {
      const out = rewriteId3Rating(original, { stars });
      const parsed = readFrames(out.bytes);
      const popms = parsed.frames.filter((f) => f.id === "POPM").map((f) => popmBody(f.body));
      const wmp = popms.filter((p) => p.owner === WMP_OWNER);
      expect(wmp).toHaveLength(1);
      expect(wmp[0].owner).not.toContain("@");
      expect(wmp[0].rating).toBe(WMP_BYTES[stars]);
      expect(out.rating).toBe(stars);
      expect(out.ratingSource).toBe("WMP");
    }
  });

  it("cudze ramki i TXXX ReplayGain zostają bajt w bajt; audio nietknięte", () => {
    const original = bytes(
      id3Tag([
        frame("POPM", OLD_WMP_BODY),
        frame("POPM", FOREIGN_BODY),
        frame("TXXX", TXXX_RG_BODY),
      ]),
      AUDIO,
    );
    const out = rewriteId3Rating(original, { stars: 3 });
    const parsed = readFrames(out.bytes);
    const foreign = parsed.frames.find(
      (f) => f.id === "POPM" && popmBody(f.body).owner === "MusicBee",
    );
    const txxx = parsed.frames.find((f) => f.id === "TXXX");
    expect([.../** @type {any} */ (foreign).body]).toEqual(FOREIGN_BODY);
    expect([.../** @type {any} */ (txxx).body]).toEqual(TXXX_RG_BODY);
    expect([...out.bytes.subarray(parsed.end)]).toEqual(AUDIO);
  });

  it("zachowuje istniejący rozmiar tagu (padding zjada różnicę), więc audio zostaje pod tym samym offsetem", () => {
    const original = bytes(
      id3Tag([frame("POPM", OLD_WMP_BODY), frame("TXXX", TXXX_RG_BODY)], { padding: 200 }),
      AUDIO,
    );
    const out = rewriteId3Rating(original, { stars: 5 });
    expect(out.bytes.length).toBe(original.length);
    expect([...out.bytes.subarray(original.length - AUDIO.length)]).toEqual(AUDIO);
  });

  it("dwie ramki WMP (case-insensitive) → dokładnie jedna po zapisie", () => {
    const second = [...latin1("windows media player 9 series\0"), 1];
    const original = bytes(id3Tag([frame("POPM", OLD_WMP_BODY), frame("POPM", second)]), AUDIO);
    const out = rewriteId3Rating(original, { stars: 2 });
    const popms = readFrames(out.bytes)
      .frames.filter((f) => f.id === "POPM")
      .map((f) => popmBody(f.body));
    expect(popms.filter((p) => /windows media player/i.test(p.owner))).toHaveLength(1);
    expect(popms[0].rating).toBe(64);
  });

  it("ponowny zapis tej samej oceny jest idempotentny (bajt w bajt)", () => {
    const original = bytes(
      id3Tag([frame("POPM", OLD_WMP_BODY), frame("TXXX", TXXX_RG_BODY)]),
      AUDIO,
    );
    const once = rewriteId3Rating(original, { stars: 4 });
    const twice = rewriteId3Rating(once.bytes, { stars: 4 });
    expect([...twice.bytes]).toEqual([...once.bytes]);
  });
});

describe("rewriteId3Rating — usuwanie oceny", () => {
  it("usuwa ramkę WMP (żadnego bajtu 0); cudza ramka zostaje i wygrywa hierarchię", () => {
    const original = bytes(
      id3Tag([frame("POPM", OLD_WMP_BODY), frame("POPM", FOREIGN_BODY)]),
      AUDIO,
    );
    const out = rewriteId3Rating(original, { stars: null });
    const popms = readFrames(out.bytes)
      .frames.filter((f) => f.id === "POPM")
      .map((f) => popmBody(f.body));
    expect(popms.some((p) => p.owner === WMP_OWNER)).toBe(false);
    expect(popms.some((p) => p.rating === 0)).toBe(false);
    expect(popms).toHaveLength(1);
    expect(popms[0].owner).toBe("MusicBee");
    // Hierarchia odczytu: brak WMP → maksimum cudzych (64 → 2★).
    expect(out.rating).toBe(2);
    expect(out.ratingSource).toBe("max");
  });

  it("bez cudzych ramek usunięcie = brak oceny (rating null)", () => {
    const original = bytes(id3Tag([frame("POPM", OLD_WMP_BODY)]), AUDIO);
    const out = rewriteId3Rating(original, { stars: null });
    expect(readFrames(out.bytes).frames.filter((f) => f.id === "POPM")).toHaveLength(0);
    expect(out.rating).toBe(null);
    expect(out.ratingSource).toBe(null);
  });
});

/** @param {string} description @param {string} value → body TXXX (Latin-1) */
function buildTxxx(description, value) {
  return bytes([0], latin1(description), [0], latin1(value));
}

/** @param {Uint8Array} body TXXX body → { description, value } */
function readTxxx(body) {
  const z = body.indexOf(0, 1);
  return {
    encoding: body[0],
    description: String.fromCharCode(...body.subarray(1, z)),
    value: String.fromCharCode(...body.subarray(z + 1)),
  };
}

describe("rewriteId3Tags — TAP tempo (TXXX bpm, bilet 13)", () => {
  it("zapisuje TXXX z description „bpm” (małe litery) i wartością int", () => {
    const original = bytes(id3Tag([frame("TXXX", TXXX_RG_BODY)]), AUDIO);
    const out = rewriteId3Tags(original, { bpm: 123 });
    const parsed = readFrames(out.bytes);
    const tx = parsed.frames.filter((f) => f.id === "TXXX").map((f) => readTxxx(f.body));
    const bpm = tx.find((f) => f.description === "bpm");
    expect(bpm).toEqual({ encoding: 0, description: "bpm", value: "123" });
    expect(out.bpm).toBe(123);
    // ReplayGain nietknięty.
    expect(tx.some((f) => f.description === "replaygain_track_gain")).toBe(true);
    expect([...out.bytes.subarray(parsed.end)]).toEqual(AUDIO);
  });

  it("ponowny zapis podmienia istniejącą ramkę bpm — dokładnie jedna, bez duplikatu", () => {
    const original = bytes(id3Tag([frame("TXXX", buildTxxx("bpm", "90"))]), AUDIO);
    const out = rewriteId3Tags(original, { bpm: 128 });
    const tx = readFrames(out.bytes)
      .frames.filter((f) => f.id === "TXXX")
      .map((f) => readTxxx(f.body));
    const bpmFrames = tx.filter((f) => f.description.toLowerCase() === "bpm");
    expect(bpmFrames).toHaveLength(1);
    expect(bpmFrames[0].value).toBe("128");
    expect(out.bpm).toBe(128);
  });

  it("opis bpm dopasowany case-insensitive (np. BPM z innego taggera)", () => {
    const original = bytes(id3Tag([frame("TXXX", buildTxxx("bpm", "90"))]), AUDIO);
    const out = rewriteId3Tags(original, { bpm: 100 });
    const bpmFrames = readFrames(out.bytes)
      .frames.filter((f) => f.id === "TXXX")
      .map((f) => readTxxx(f.body))
      .filter((f) => f.description.toLowerCase() === "bpm");
    expect(bpmFrames).toHaveLength(1);
    expect(bpmFrames[0].value).toBe("100");
  });

  it("bpm null usuwa własną ramkę, reszta tagu zostaje", () => {
    const original = bytes(
      id3Tag([frame("TXXX", buildTxxx("bpm", "120")), frame("TXXX", TXXX_RG_BODY)]),
      AUDIO,
    );
    const out = rewriteId3Tags(original, { bpm: null });
    const tx = readFrames(out.bytes)
      .frames.filter((f) => f.id === "TXXX")
      .map((f) => readTxxx(f.body));
    expect(tx.some((f) => f.description.toLowerCase() === "bpm")).toBe(false);
    expect(tx.some((f) => f.description === "replaygain_track_gain")).toBe(true);
    expect(out.bpm).toBe(null);
  });

  it("ocena i bpm w jednym rewrite: POPM WMP + TXXX bpm, cudze ramki nietknięte", () => {
    const original = bytes(
      id3Tag([
        frame("POPM", OLD_WMP_BODY),
        frame("POPM", FOREIGN_BODY),
        frame("TXXX", TXXX_RG_BODY),
      ]),
      AUDIO,
    );
    const out = rewriteId3Tags(original, { stars: 4, bpm: 87 });
    const parsed = readFrames(out.bytes);
    const popms = parsed.frames.filter((f) => f.id === "POPM").map((f) => popmBody(f.body));
    expect(popms.find((p) => p.owner === WMP_OWNER)?.rating).toBe(196);
    expect(popms.some((p) => p.owner === "MusicBee")).toBe(true);
    expect(out.rating).toBe(4);
    expect(out.bpm).toBe(87);
    expect([...out.bytes.subarray(parsed.end)]).toEqual(AUDIO);
  });

  it("plik bez tagu + bpm → nowy ID3v2.3 z TXXX bpm, audio nietknięte", () => {
    const out = rewriteId3Tags(bytes(AUDIO), { bpm: 111 });
    const parsed = readFrames(out.bytes);
    expect(parsed.major).toBe(3);
    const tx = parsed.frames.map((f) => readTxxx(f.body));
    expect(tx).toEqual([{ encoding: 0, description: "bpm", value: "111" }]);
    expect([...out.bytes.subarray(parsed.end)]).toEqual(AUDIO);
  });

  it("bez stars/bpm nic nie zmienia (rewrite zachowawczy)", () => {
    const original = bytes(id3Tag([frame("TXXX", TXXX_RG_BODY)]), AUDIO);
    const out = rewriteId3Tags(original, {});
    expect([...out.bytes]).toEqual([...original]);
  });
});

describe("rewriteId3Rating — plik bez tagu ID3", () => {
  it("dokleja nowy ID3v2.3 z ramką WMP + padding, audio nietknięte", () => {
    const original = bytes(AUDIO);
    const out = rewriteId3Rating(original, { stars: 5 });
    const parsed = readFrames(out.bytes);
    expect(parsed.major).toBe(3);
    const wmp = parsed.frames.filter((f) => f.id === "POPM").map((f) => popmBody(f.body));
    expect(wmp).toHaveLength(1);
    expect(wmp[0].owner).toBe(WMP_OWNER);
    expect(wmp[0].rating).toBe(255);
    expect([...out.bytes.subarray(parsed.end)]).toEqual(AUDIO);
    expect(parsed.end).toBeGreaterThan(original.length); // tag + padding przed audio
    expect(out.rating).toBe(5);
  });

  it("usunięcie oceny z pliku bez tagu nic nie zmienia", () => {
    const original = bytes(AUDIO);
    const out = rewriteId3Rating(original, { stars: null });
    expect([...out.bytes]).toEqual(AUDIO);
    expect(out.rating).toBe(null);
  });
});
