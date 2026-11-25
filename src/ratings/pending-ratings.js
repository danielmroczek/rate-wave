// Kolejka ocen oczekujących na zapis (bilet #9, spec §4a/§7): store
// `pending-ratings` trzyma JEDEN rekord na Utwór (klucz jak w `tracks`), więc
// ostatni klik wygrywa (LWW) i tylko on wejdzie do uploadu. Rekord:
// { fingerprint, ratingByte, action: "set"|"remove", createdAt }.
//
// Interfejs jest domknięty tym biletem: bilet 13 (offline) dokłada wyłącznie
// detektory sieci i Background Sync, nie zmieniając kształtu kolejki.

import { del, get, getAllEntries, put, STORES } from "../store/db.js";
import { byteToStars } from "../tags/rating-byte.js";

/**
 * @typedef {object} PendingRating
 * @property {string} key — klucz Utworu (`pcloud|<fileid>` / `local|<relpath>`)
 * @property {{ size: number, modified: number } | null} fingerprint — stan pliku w chwili kolejkowania
 * @property {number} ratingByte — bajt POPM (0 = ocena zdjęta)
 * @property {"set" | "remove"} action
 * @property {number} createdAt — ms; kolejność flushu
 */

/**
 * Ocena (1–5 albo null) niesiona przez rekord kolejki. Jedno miejsce dekodowania
 * pary `action` + `ratingByte` dla kontrolera i widoku.
 * @param {Pick<PendingRating, "action" | "ratingByte">} rec
 * @returns {number | null}
 */
export function pendingRatingStars(rec) {
  return rec.action === "remove" ? null : byteToStars(rec.ratingByte);
}

/**
 * Dopisuje/zastępuje rekord kolejki (LWW po kluczu Utworu).
 * @param {IDBDatabase} db
 * @param {PendingRating} rating
 */
export function enqueuePendingRating(db, rating) {
  const { key, ...value } = rating;
  return put(db, STORES.PENDING_RATINGS, key, value);
}

/**
 * Rekordy kolejki rosnąco po `createdAt` (kolejność uploadów przy flushu).
 * @param {IDBDatabase} db
 * @returns {Promise<PendingRating[]>}
 */
export async function listPendingRatings(db) {
  const entries = await getAllEntries(db, STORES.PENDING_RATINGS);
  return /** @type {PendingRating[]} */ (
    entries
      .map(({ key, value }) => ({ key, ...value }))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  );
}

/**
 * Usuwa rekord po potwierdzonym zapisie. `ifCreatedAt` chroni nowszy wpis,
 * który powstał w trakcie trwającego flushu (LWW).
 * @param {IDBDatabase} db
 * @param {string} key
 * @param {{ ifCreatedAt?: number }} [opts]
 */
export async function removePendingRating(db, key, { ifCreatedAt } = {}) {
  if (ifCreatedAt === undefined) {
    await del(db, STORES.PENDING_RATINGS, key);
    return;
  }
  const rec = await get(db, STORES.PENDING_RATINGS, key);
  if (!rec || rec.createdAt === ifCreatedAt) {
    await del(db, STORES.PENDING_RATINGS, key);
  }
}
