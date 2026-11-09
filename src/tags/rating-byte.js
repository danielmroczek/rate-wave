// Hierarchia POPM (spec §2b, bilet #7): ramka WMP wygrywa; gdy brak — maksymalna
// bajtowa cudzych; bajty poza kratą {1,64,128,196,255} mapowane progami;
// brak ramek = bez oceny (nie 0).

/** E-mail/owner ramki WMP (case-insensitive match na „Windows Media Player"). */
export const WMP_EMAIL_RE = /windows media player/i;

/**
 * Mapowanie bajtu POPM → liczba gwiazdek (1–5). Bajt 0 = ocena zdjęta → null.
 * @param {number} byte
 * @returns {number | null}
 */
export function byteToStars(byte) {
  if (typeof byte !== "number" || !Number.isFinite(byte) || byte <= 0) return null;
  if (byte <= 63) return 1;
  if (byte <= 127) return 2;
  if (byte <= 195) return 3;
  if (byte <= 254) return 4;
  return 5;
}

/**
 * @param {string | null | undefined} email
 * @returns {boolean}
 */
export function isWmpSource(email) {
  return typeof email === "string" && WMP_EMAIL_RE.test(email);
}

/** Ramka POPM w surowej postaci (owner + bajt ratingu). @typedef {{ email?: string, rating: number }} PopmFrame */

/**
 * Wybiera ocenę wg spec §2b: WMP wygrywa (maksymalna z ramek WMP), inaczej
 * maksymalna bajtowa cudzych. Ramki z bajtem 0 (ocena zdjęta) nie uczestniczą.
 * @param {PopmFrame[]} frames
 * @returns {{ stars: number, source: "WMP" | "max" } | null} null = brak ramek / bez oceny
 */
export function pickRating(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const rated = frames.filter((f) => byteToStars(f?.rating) != null);
  if (rated.length === 0) return null;
  const wmp = rated.filter((f) => isWmpSource(f.email));
  const pool = wmp.length > 0 ? wmp : rated;
  const best = pool.reduce((a, b) => (b.rating > a.rating ? b : a));
  return {
    stars: /** @type {number} */ (byteToStars(best.rating)),
    source: wmp.length > 0 ? "WMP" : "max",
  };
}
