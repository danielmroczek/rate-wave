// Punkty RK testowe do parsera ID3 (synthetic ID3v2 tag w pamięci).
const enc = (/** @type {string} */ s) => Array.from(new TextEncoder().encode(s));

function synchsafe(size) {
  return [(size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f];
}

function frame(id, body, { synch = false } = {}) {
  const size = synch
    ? synchsafe(body.length)
    : (() => {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, body.length, false);
        return Array.from(b);
      })();
  return new Uint8Array([...enc(id), ...size, 0, 0, ...body]);
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/**
 * ID3v2 tag (wersja `major`) z ramkami, doklejona do minimalnego audio-padding.
 * @param {number} major 3 | 4
 * @param {{ id: string, body: Uint8Array }[]} frames
 * @returns {Uint8Array}
 */
export function makeId3Head(major, frames) {
  const body = concat(...frames.map((f) => frame(f.id, f.body, { synch: major === 4 })));
  const tag = new Uint8Array([0x49, 0x44, 0x33, major, 0, 0, ...synchsafe(body.length)]);
  return concat(tag, body, new Uint8Array(256));
}

/** Ramka POPM: owner + rating byte (+ minimalny counter EE). */
export function popmBody(owner, rating) {
  return new Uint8Array([...enc(owner), 0, rating]);
}

/** Ramka TXXX (ID3): encoding, description\0, value. */
export function txxxBody(description, value) {
  return new Uint8Array([0, ...enc(description), 0, ...enc(value)]);
}

/** Ramka RVA2: identification\0, type, volume-adj (int16 BE, jednostka 1/512 dB). */
export function rva2Body(identification, raw) {
  const adj = new Uint8Array(2);
  new DataView(adj.buffer).setInt16(0, raw, false);
  return new Uint8Array([...enc(identification), 0, 1, ...adj]);
}

/** Ramka RVAD (ID3v2.3): flags + dane (uproszczona: 0x01, int16). */
export function rvadBody(raw) {
  const adj = new Uint8Array(2);
  new DataView(adj.buffer).setInt16(0, raw, false);
  return new Uint8Array([1, ...adj]);
}
