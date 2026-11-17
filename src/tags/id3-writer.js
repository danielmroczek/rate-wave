// Rewrite oceny w tagu ID3 (bilet #8, spec §2a; zachowanie zweryfikowane testem T7):
// dokładnie jedna ramka POPM WMP (owner bez `@`, kraty 1/64/128/196/255), usunięcie
// oceny = usunięcie ramki (nigdy bajt 0), cudze ramki i TXXX ReplayGain nietknięte.
//
// Tag istniejący zachowuje swoją wersję (v2.3 zostaje v2.3 — nigdy nie upgrade'ujemy
// do v2.4); plik bez tagu dostaje nowy ID3v2.3. Rozmiar istniejącego tagu jest
// zachowany, gdy nowa treść się mieści — audio zostaje pod tym samym offsetem.

import { isWmpSource, pickRating } from "./rating-byte.js";

/** Owner ramki WMP (Latin-1, bez `@` — to nie adres e-mail). */
export const WMP_OWNER = "Windows Media Player 9 Series";

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
 * Ustawia (stars 1–5) albo usuwa (null) ocenę w ramce WMP, zostawiając resztę
 * tagu i audio nietknięte. Zwraca też ocenę efektywną wg hierarchii odczytu
 * (po usunięciu WMP może wygrać cudza ramka).
 *
 * @param {Uint8Array} bytes
 * @param {{ stars: 1|2|3|4|5|null }} opts
 * @returns {{ bytes: Uint8Array, rating: number | null, ratingSource: "WMP" | "max" | null }}
 */
export function rewriteId3Rating(bytes, { stars }) {
  const byte = starsToByte(stars);
  const tag = parseId3Tag(bytes);

  if (!tag.has && byte == null) {
    return { bytes, rating: null, ratingSource: null };
  }

  /** @type {Id3Frame[]} */
  const kept = [];
  let insertAt = -1;
  for (const frame of tag.frames) {
    const info = frame.id === "POPM" ? popmInfo(frame.body) : null;
    if (info && isWmpSource(info.owner)) {
      if (insertAt < 0) insertAt = kept.length;
      continue;
    }
    kept.push(frame);
  }

  if (byte != null) {
    const replacement = { id: "POPM", flags: [0, 0], body: buildPopmBody(byte) };
    if (insertAt >= 0) kept.splice(insertAt, 0, replacement);
    else kept.push(replacement);
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
  };
}
