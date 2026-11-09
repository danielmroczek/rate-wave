// Parser headów ID3 (bilet #7, spec §2b/§5): ~8 KB head → POPM + ReplayGain.
// Czysto JS (music-metadata parseBuffer), wywoływany w Web Workerze przez
// id3-head-worker.js; w testach bezpośrednio.

import { parseBuffer } from "music-metadata";
import { pickRating } from "./rating-byte.js";

/**
 * @typedef {object} HeadTagResult
 * @property {number | null} rating — gwiazdki 1–5 wg hierarchii POPM (null = bez oceny)
 * @property {"WMP" | "max" | null} ratingSource
 * @property {number | null} rgGainDb — ReplayGain track gain [dB]
 * @property {"TXXX" | "RVA2" | "RVAD" | "APE" | null} rgSource
 * @property {boolean} framesSeen — czy w headzie był cokolwiek POPM/RG (decyzja o eskalacji)
 */

/** Regex na tekst TXXX/APE gain: „±x[.y] dB" / „±x[.y]" (bezpośrednie wartości APE). */
const RG_DB_RE = /^([+-]?\d+(?:\.\d+)?)\s*dB$/i;
const RG_BARE_RE = /^([+-]?\d+(?:\.\d+)?)$/;
const RG_NAME_RE = /replaygain_track_gain/i;

/**
 * @param {string} text
 * @returns {number | null}
 */
function parseDbText(text) {
  const s = String(text ?? "").trim();
  const m = RG_DB_RE.exec(s) ?? RG_BARE_RE.exec(s);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Ramka native music-metadata: { id, value }; TXXX bywa spłaszczony do
 * „TXXX:<description>". Zwraca [description, text] ramki TXXX.
 * @param {{ id: string, value: any }} frame
 * @returns {[string, string] | null}
 */
function txxxParts(frame) {
  if (typeof frame.value === "string" && frame.id.startsWith("TXXX:")) {
    return [frame.id.slice(5), frame.value];
  }
  if (frame.id === "TXXX" && frame.value && typeof frame.value === "object") {
    return [String(frame.value.description ?? ""), String(frame.value.text ?? "")];
  }
  return null;
}

/**
 * Minimalny walker tagu ID3v2.3/2.4 dla ramek pomijanych przez music-metadata
 * (RVA2/RVAD). Zbirka ciał ramek zadanego id (nagłówek tagu + ramki w payload).
 * @param {Uint8Array} bytes
 * @param {string} id — dokładnie 4 znaki
 * @returns {Uint8Array[]}
 */
export function scanId3Frames(bytes, id) {
  const out = [];
  if (bytes.length < 10) return out;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return out;
  const major = bytes[3];
  if (major < 3 || major > 4) return out;
  const tagSize =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  const end = Math.min(bytes.length, 10 + tagSize);
  let p = 10;
  while (p + 10 <= end) {
    const fid = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(fid)) break; // padding / koniec
    const s = bytes[p + 4] | (bytes[p + 5] << 8) | (bytes[p + 6] << 16) | (bytes[p + 7] << 24);
    const size =
      major === 4
        ? (bytes[p + 4] << 21) | (bytes[p + 5] << 14) | (bytes[p + 6] << 7) | bytes[p + 7]
        : s >>> 0;
    if (size <= 0 || p + 10 + size > end) break;
    if (fid === id) out.push(bytes.subarray(p + 10, p + 10 + size));
    p += 10 + size;
  }
  return out;
}

/**
 * RVA2 body: identification\0, channel type (1 bajt), volume adjustment (int16 BE / 512 dB), peaks.
 * RVAD (v2.3) legszy fallback: flags (1 bajt), przy bicie 0x01 int16 BE / 512 dB.
 * @param {Uint8Array} bytes
 * @returns {number | null} gain w dB
 */
export function id3VolumeGainDb(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const z = bytes.indexOf(0);
  if (z < 0 || z + 3 > bytes.length) {
    // brak identyfikatora → prawdopodobnie RVAD: flags + int16
    if (bytes.length >= 3) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + 1, 2);
      return dv.getInt16(0, false) / 512;
    }
    return null;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset + z + 2, 2);
  return dv.getInt16(0, false) / 512;
}

/**
 * RVA2/RVAD z heada — szuka ramki i konwertuje surowy int16 na dB.
 * @param {Uint8Array} bytes head
 * @returns {{ gainDb: number, source: "RVA2" | "RVAD" } | null}
 */
export function scanRva(bytes) {
  for (const id of /** @type {const} */ (["RVA2", "RVAD"])) {
    const v = id3VolumeGainDb(scanId3Frames(bytes, id)[0]);
    if (v != null) return { gainDb: v, source: id };
  }
  return null;
}

/**
 * Parsuje head MP3 (bajty z /head albo eskalacji /stream) na tagi.
 * Nigdy nie rzuca — śmieci/garść niedanych bajtów = wynik z samymi nullami.
 * @param {Uint8Array} bytes
 * @returns {Promise<HeadTagResult>}
 */
export async function parseHead(bytes) {
  /** @type {HeadTagResult} */
  const empty = {
    rating: null,
    ratingSource: null,
    rgGainDb: null,
    rgSource: null,
    framesSeen: false,
  };
  if (!bytes || bytes.length === 0) return empty;

  let md;
  try {
    md = await parseBuffer(bytes, { mimeType: "audio/mpeg" }, { duration: false });
  } catch {
    return empty;
  }

  const native = md?.native ?? {};
  /** @type {Array<{ id: string, value: any }>} */
  const frames = [];
  for (const groupFrames of Object.values(native)) {
    if (Array.isArray(groupFrames)) frames.push(...groupFrames);
  }

  let rgGainDb = null;
  let rgSource = /** @type {"TXXX" | "RVA2" | "RVAD" | "APE" | null} */ (null);
  for (const f of frames) {
    if (f.id === "TXXX" || f.id.startsWith("TXXX:")) {
      const parts = txxxParts(f);
      if (parts && RG_NAME_RE.test(parts[0])) {
        const db = parseDbText(parts[1]);
        if (db != null) {
          rgGainDb = db;
          rgSource = "TXXX";
          break;
        }
      }
    }
  }
  if (rgSource === null) {
    // RVA2/RVAD pomijane przez music-metadata — ręczny walker ID3v2.
    const rva = scanRva(bytes);
    if (rva) {
      rgGainDb = rva.gainDb;
      rgSource = rva.source;
    }
  }
  if (rgSource === null) {
    for (const f of frames) {
      if (RG_NAME_RE.test(String(f.id ?? ""))) {
        const db = typeof f.value === "string" ? parseDbText(f.value) : null;
        if (db != null) {
          rgGainDb = db;
          rgSource = "APE";
          break;
        }
      }
    }
  }

  const popmFrames = frames
    .filter((f) => f.id === "POPM")
    .map((f) => ({ email: f.value?.email, rating: Number(f.value?.rating) }));
  const pick = pickRating(popmFrames);
  if (!pick && Array.isArray(md.common?.rating) && md.common.rating.length > 0) {
    // Fallback: znormalizowane ratingi (np. APE) → bajt = round(rating × 255)
    const asFrames = md.common.rating.map((r) => ({
      email: String(r.source ?? ""),
      rating: Math.round((Number(r.rating) || 0) * 255),
    }));
    const alt = pickRating(asFrames);
    if (alt) {
      return { rating: alt.stars, ratingSource: alt.source, rgGainDb, rgSource, framesSeen: true };
    }
  }

  return {
    rating: pick?.stars ?? null,
    ratingSource: pick?.source ?? null,
    rgGainDb,
    rgSource,
    framesSeen: pick != null || rgSource != null,
  };
}
