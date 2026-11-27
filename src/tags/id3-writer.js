// Rewrite oceny w tagu ID3 (bilet #8, spec §2a; zachowanie zweryfikowane testem T7):
// dokładnie jedna ramka POPM WMP (owner bez `@`, kraty 1/64/128/196/255), usunięcie
// oceny = usunięcie ramki (nigdy bajt 0), cudze ramki i TXXX ReplayGain nietknięte.
//
// Tag istniejący zachowuje swoją wersję (v2.3 zostaje v2.3 — nigdy nie upgrade'ujemy
// do v2.4); plik bez tagu dostaje nowy ID3v2.3. Rozmiar istniejącego tagu jest
// zachowany, gdy nowa treść się mieści — audio zostaje pod tym samym offsetem.

import { isWmpSource, pickRating } from "./rating-byte.js";
import { isValidBpm, parseBpmValue } from "./bpm-value.js";

/** Owner ramki WMP (Latin-1, bez `@` — to nie adres e-mail). */
export const WMP_OWNER = "Windows Media Player 9 Series";

/** Description ramki TXXX z tempem (małe litery — spójnie z replaygain). */
export const BPM_TXXX_DESCRIPTION = "bpm";

/** Skala WMP: gwiazdki → bajt ratingu POPM. */
export const WMP_RATING_BYTES = Object.freeze({ 1: 1, 2: 64, 3: 128, 4: 196, 5: 255 });

/** Minimalny zapas paddingu przy tworzeniu/przepełnieniu tagu (jak w T7). */
const TAG_PADDING = 512;

/**
 * Gwiazdki (1–5) → bajt POPM w skali WMP. `null` (brak oceny) → null.
 * @param {number | null} stars
 * @returns {number | null}
 */
export function starsToByte(stars) {
  if (stars == null) return null;
  const byte = WMP_RATING_BYTES[/** @type {1|2|3|4|5} */ (stars)];
  if (byte === undefined) throw new RangeError(`starsToByte: invalid rating ${stars}`);
  return byte;
}

/**
 * @typedef {{ id: string, flags: number[], body: Uint8Array }} Id3Frame
 * @typedef {{ owner: string, rating: number }} PopmInfo
 */

/** @param {Uint8Array} bytes @param {number} at */
function readU32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/** @param {Uint8Array} bytes @param {number} at */
function readSynchsafe(bytes, at) {
  return (
    ((bytes[at] & 0x7f) << 21) |
    ((bytes[at + 1] & 0x7f) << 14) |
    ((bytes[at + 2] & 0x7f) << 7) |
    (bytes[at + 3] & 0x7f)
  );
}

/** @param {Uint8Array} out @param {number} at @param {number} value */
function writeSynchsafe(out, at, value) {
  out[at] = (value >>> 21) & 0x7f;
  out[at + 1] = (value >>> 14) & 0x7f;
  out[at + 2] = (value >>> 7) & 0x7f;
  out[at + 3] = value & 0x7f;
}

/** @param {string} text @returns {Uint8Array} Latin-1 (dla ownerów POPM). */
function latin1Encode(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** @param {Uint8Array} bytes @returns {string} */
function latin1Decode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/**
 * Rozbija body TXXX na [description, value], respektując bajt kodowania
 * (0 = Latin-1, 1 = UTF-16 z BOM, 2 = UTF-16BE, 3 = UTF-8).
 * @param {Uint8Array} body
 * @returns {[string, string]}
 */
function decodeTxxxParts(body) {
  if (body.length === 0) return ["", ""];
  const encoding = body[0];
  const data = body.subarray(1);

  if (encoding === 1 || encoding === 2) {
    let start = 0;
    let littleEndian = encoding === 1;
    if (encoding === 1 && data.length >= 2) {
      if (data[0] === 0xff && data[1] === 0xfe) {
        littleEndian = true;
        start = 2;
      } else if (data[0] === 0xfe && data[1] === 0xff) {
        littleEndian = false;
        start = 2;
      }
    }
    const units = [];
    for (let i = start; i + 1 < data.length; i += 2) {
      units.push(littleEndian ? data[i] | (data[i + 1] << 8) : (data[i] << 8) | data[i + 1]);
    }
    let split = units.indexOf(0);
    if (split < 0) split = units.length;
    const decode = (/** @type {number[]} */ list) => String.fromCharCode(...list);
    const valueUnits = units.slice(split + 1);
    const valueEnd = valueUnits.indexOf(0);
    return [
      decode(units.slice(0, split)),
      decode(valueEnd < 0 ? valueUnits : valueUnits.slice(0, valueEnd)),
    ];
  }

  const z = data.indexOf(0);
  const descBytes = z < 0 ? data : data.subarray(0, z);
  const valueBytes = z < 0 ? new Uint8Array(0) : data.subarray(z + 1);
  const vEnd = valueBytes.indexOf(0);
  const valueSlice = vEnd < 0 ? valueBytes : valueBytes.subarray(0, vEnd);
  if (encoding === 3) {
    const dec = new TextDecoder("utf-8");
    return [dec.decode(descBytes), dec.decode(valueSlice)];
  }
  return [latin1Decode(descBytes), latin1Decode(valueSlice)];
}

/** @param {Uint8Array} body @returns {boolean} */
function isBpmTxxx(body) {
  return decodeTxxxParts(body)[0].trim().toLowerCase() === BPM_TXXX_DESCRIPTION;
}

/**
 * Wartość TXXX bpm → int albo null.
 * @param {Uint8Array} body
 * @returns {number | null}
 */
function bpmFromTxxx(body) {
  const [description, text] = decodeTxxxParts(body);
  if (description.trim().toLowerCase() !== BPM_TXXX_DESCRIPTION) return null;
  return parseBpmValue(text);
}

/**
 * Body TXXX: kodowanie ISO-8859-1, description + NUL, wartość (+ NUL).
 * @param {string} description
 * @param {string} value
 */
function buildTxxxBody(description, value) {
  const desc = latin1Encode(description);
  const val = latin1Encode(value);
  const body = new Uint8Array(1 + desc.length + 1 + val.length);
  body[0] = 0;
  body.set(desc, 1);
  body[desc.length + 1] = 0;
  body.set(val, desc.length + 2);
  return body;
}

/**
 * Body ramki POPM → owner + bajt ratingu. Ramka bez terminatora ownerа jest
 * traktowana jako nieczytelna (zwracamy null — zostawiamy ją nietkniętą).
 * @param {Uint8Array} body
 * @returns {PopmInfo | null}
 */
function popmInfo(body) {
  const z = body.indexOf(0);
  if (z < 0) return null;
  return {
    owner: latin1Decode(body.subarray(0, z)),
    rating: body.length > z + 1 ? body[z + 1] : 0,
  };
}

/** @param {number} byte @returns {Uint8Array} owner + NUL + rating (counter pominięty — legalne). */
function buildPopmBody(byte) {
  const owner = latin1Encode(WMP_OWNER);
  const body = new Uint8Array(owner.length + 2);
  body.set(owner, 0);
  body[owner.length] = 0;
  body[owner.length + 1] = byte;
  return body;
}

/**
 * Odczyt struktury tagu ID3v2 z początku bufora. Obsługuje v2.3/v2.4;
 * unsynchronizacja i wersje inne niż 2.3/2.4 są odrzucane (nie zgadujemy).
 * @param {Uint8Array} bytes
 * @returns {{ has: boolean, major: 3|4, end: number, frames: Id3Frame[] }}
 */
export function parseId3Tag(bytes) {
  const empty = { has: false, major: /** @type {3|4} */ (3), end: 0, frames: [] };
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33)
    return empty;
  const major = bytes[3];
  if (major !== 3 && major !== 4) {
    throw Object.assign(new Error(`Unsupported ID3v2.${major} tag`), {
      code: "unsupported_id3_version",
    });
  }
  const flags = bytes[5];
  if (flags & 0x80) {
    throw Object.assign(new Error("Unsupported unsynchronised ID3 tag"), {
      code: "unsupported_unsynchronisation",
    });
  }
  const bodySize = readSynchsafe(bytes, 6);
  const end = Math.min(bytes.length, 10 + bodySize + (major === 4 && flags & 0x10 ? 10 : 0));
  let pos = 10;

  if (flags & 0x40) {
    // Extended header: pomijamy (CRC/restrictions nie przenosimy).
    if (pos + 4 > end) return { has: true, major, end, frames: [] };
    const extLen = major === 4 ? readSynchsafe(bytes, pos) : readU32(bytes, pos) + 4;
    pos += Math.max(4, extLen);
  }

  /** @type {Id3Frame[]} */
  const frames = [];
  while (pos + 10 <= end) {
    const id = latin1Decode(bytes.subarray(pos, pos + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding / koniec ramek
    const size = major === 4 ? readSynchsafe(bytes, pos + 4) : readU32(bytes, pos + 4);
    if (size === 0 || pos + 10 + size > end) break;
    frames.push({
      id,
      flags: [bytes[pos + 8], bytes[pos + 9]],
      body: bytes.subarray(pos + 10, pos + 10 + size),
    });
    pos += 10 + size;
  }
  return { has: true, major, end, frames };
}

/**
 * Przepisuje tag ID3: ocena (POPM WMP) i/lub BPM (TXXX `bpm`) — pola, których
 * nie podano, zostają nietknięte; `null` usuwa. Reszta ramek i audio bez zmian.
 * Zwraca też wartości efektywne po zapisie (ocena wg hierarchii odczytu).
 *
 * @param {Uint8Array} bytes
 * @param {{ stars?: 1|2|3|4|5|null, bpm?: number|null }} [opts]
 * @returns {{ bytes: Uint8Array, rating: number | null, ratingSource: "WMP" | "max" | null, bpm: number | null }}
 */
export function rewriteId3Tags(bytes, { stars, bpm } = {}) {
  const setStars = stars !== undefined;
  const setBpm = bpm !== undefined;
  const byte = setStars ? starsToByte(stars ?? null) : null;
  if (setBpm && bpm != null && !isValidBpm(bpm)) {
    throw new RangeError(`rewriteId3Tags: invalid bpm ${bpm}`);
  }
  const tag = parseId3Tag(bytes);
  if (!tag.has && !(setStars && byte != null) && !(setBpm && bpm != null)) {
    return { bytes, rating: null, ratingSource: null, bpm: null };
  }

  /** @type {Id3Frame[]} */
  const kept = [];
  let popmPlaced = false;
  let bpmPlaced = false;
  for (const frame of tag.frames) {
    if (setStars && frame.id === "POPM") {
      const info = popmInfo(frame.body);
      if (info && isWmpSource(info.owner)) {
        // Podmiana w miejscu pierwszej ramki WMP (kolejność ramek zachowana).
        if (!popmPlaced) {
          if (byte != null) kept.push({ id: "POPM", flags: [0, 0], body: buildPopmBody(byte) });
          popmPlaced = true;
        }
        continue;
      }
    }
    if (setBpm && frame.id === "TXXX" && isBpmTxxx(frame.body)) {
      if (!bpmPlaced) {
        if (bpm != null) {
          kept.push({
            id: "TXXX",
            flags: [0, 0],
            body: buildTxxxBody(BPM_TXXX_DESCRIPTION, String(bpm)),
          });
        }
        bpmPlaced = true;
      }
      continue;
    }
    kept.push(frame);
  }
  if (setStars && byte != null && !popmPlaced) {
    kept.push({ id: "POPM", flags: [0, 0], body: buildPopmBody(byte) });
  }
  if (setBpm && bpm != null && !bpmPlaced) {
    kept.push({
      id: "TXXX",
      flags: [0, 0],
      body: buildTxxxBody(BPM_TXXX_DESCRIPTION, String(bpm)),
    });
  }

  const popms = kept
    .filter((f) => f.id === "POPM")
    .map((f) => popmInfo(f.body))
    .filter((info) => info != null)
    .map((info) => ({
      email: /** @type {PopmInfo} */ (info).owner,
      rating: /** @type {PopmInfo} */ (info).rating,
    }));
  const effective = pickRating(popms);

  let effectiveBpm = null;
  for (const f of kept) {
    if (f.id !== "TXXX") continue;
    const value = bpmFromTxxx(f.body);
    if (value != null) {
      effectiveBpm = value;
      break;
    }
  }

  const framesSize = kept.reduce((n, f) => n + 10 + f.body.length, 0);
  const available = tag.has ? tag.end - 10 : 0;
  const targetBody =
    framesSize <= available
      ? available
      : Math.ceil((framesSize + TAG_PADDING) / TAG_PADDING) * TAG_PADDING;
  if (targetBody > 0x0fffffff) throw new Error("ID3 tag too large");

  const audio = bytes.subarray(tag.has ? tag.end : 0);
  const major = tag.has ? tag.major : 3;
  const out = new Uint8Array(10 + targetBody + audio.length);
  out[0] = 0x49;
  out[1] = 0x44;
  out[2] = 0x33;
  out[3] = major;
  out[4] = 0;
  out[5] = 0; // bez unsync/extended/footer
  writeSynchsafe(out, 6, targetBody);
  let pos = 10;
  for (const frame of kept) {
    for (let i = 0; i < 4; i++) out[pos + i] = frame.id.charCodeAt(i);
    if (major === 4) writeSynchsafe(out, pos + 4, frame.body.length);
    else {
      const size = frame.body.length;
      out[pos + 4] = (size >>> 24) & 0xff;
      out[pos + 5] = (size >>> 16) & 0xff;
      out[pos + 6] = (size >>> 8) & 0xff;
      out[pos + 7] = size & 0xff;
    }
    out[pos + 8] = frame.flags[0] ?? 0;
    out[pos + 9] = frame.flags[1] ?? 0;
    out.set(frame.body, pos + 10);
    pos += 10 + frame.body.length;
  }
  out.set(audio, 10 + targetBody);

  return {
    bytes: out,
    rating: effective?.stars ?? null,
    ratingSource: effective?.source ?? null,
    bpm: effectiveBpm,
  };
}

/**
 * Ustawia (stars 1–5) albo usuwa (null) ocenę w ramce WMP, zostawiając resztę
 * tagu i audio nietknięte.
 *
 * @param {Uint8Array} bytes
 * @param {{ stars: 1|2|3|4|5|null }} opts
 * @returns {{ bytes: Uint8Array, rating: number | null, ratingSource: "WMP" | "max" | null, bpm: number | null }}
 */
export function rewriteId3Rating(bytes, { stars }) {
  return rewriteId3Tags(bytes, { stars });
}
