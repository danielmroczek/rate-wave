// Cache biblioteki w IndexedDB (bilet 04, spec §4a): store `library` (listing +
// Fingerprint, klucz Źródła 'pcloud') + store `tracks` (rekordy z Fingerprintem,
// ocena placeholder na teraz). Ponowne wejście = zero requestów listing.

import { get, put, del, clearStore, STORES } from "../store/db.js";
import { PCLOUD_SOURCE_KEY } from "../auth/token-store.js";

/**
 * @typedef {import("./listing.js").Library} Library
 */

/**
 * Zapisuje listing + Fingerprint do store `library` pod kluczem Źródła.
 * @param {IDBDatabase} db
 * @param {Library} library
 */
export async function saveLibrary(db, library) {
  await put(db, STORES.LIBRARY, PCLOUD_SOURCE_KEY, library);
}

/**
 * Czyta cache biblioteki. Zwraca Library albo undefined (brak/wpis).
 * @param {IDBDatabase} db
 * @returns {Promise<Library | undefined>}
 */
export async function loadLibrary(db) {
  return /** @type {Promise<Library | undefined>} */ (get(db, STORES.LIBRARY, PCLOUD_SOURCE_KEY));
}

/**
 * Usuwa cache biblioteki (np. po invalidate / reset źródła).
 * @param {IDBDatabase} db
 */
export async function deleteLibrary(db) {
  await del(db, STORES.LIBRARY, PCLOUD_SOURCE_KEY);
}

/**
 * Wsadza rekordy Utworów do store `tracks` (jedna transaction — 3635 wpisów idzie szybko).
 * Ocena na teraz: placeholder (rating nie istnieje / null) — bilet oceniania uzupełni.
 * @param {IDBDatabase} db
 * @param {import("./listing.js").LibraryTrack[]} tracks
 */
export async function saveTracks(db, tracks) {
  const tx = db.transaction(STORES.TRACKS, "readwrite");
  const store = tx.objectStore(STORES.TRACKS);
  for (const t of tracks) {
    store.put({ fingerprint: t.fingerprint, rating: null }, t.key);
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("saveTracks failed"));
    tx.onabort = () => reject(new Error("saveTracks aborted"));
  });
}

/**
 * Czyści store `tracks` (rebudowa po invalidate listing).
 * @param {IDBDatabase} db
 */
export async function clearTracks(db) {
  await clearStore(db, STORES.TRACKS);
}
