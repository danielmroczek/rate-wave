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
 * Atomowy rebuild store `tracks` w jednej transakcji: snapshot poprzedniego stanu
 * kursorem → clear → wstawienie scalone z poprzednim stanem. Scalanie musi dziać
 * się w TEJ SAMEJ transakcji (dawniej clearTracks + saveTracks = dwie transakcje,
 * więc clear kasował rating/lastPlayed zanim save zdążył je scalić).
 * Reguły (spec §4a/§4b): rozbieżność Fingerprintu czyści pola tagowe (rating →
 * null), `lastPlayed` zostaje zawsze; Utwór usunięty ze Źródła znika.
 * @param {IDBDatabase} db
 * @param {import("./listing.js").LibraryTrack[]} tracks
 */
export async function saveTracks(db, tracks) {
  const tx = db.transaction(STORES.TRACKS, "readwrite");
  const store = tx.objectStore(STORES.TRACKS);

  const existing = /** @type {Map<any, any>} */ (new Map());
  await new Promise((resolve, reject) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        existing.set(c.key, c.value);
        c.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error ?? new Error("saveTracks snapshot failed"));
  });

  store.clear();
  for (const t of tracks) {
    const prev = existing.get(t.key);
    store.put(mergeTrack(prev, t), t.key);
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("saveTracks failed"));
    tx.onabort = () => reject(new Error("saveTracks aborted"));
  });
}

/**
 * Scalony rekord Utworu: rating żyje tylko przy zgodnym Fingerprintzie
 * (rozbieżność = unieważnienie pól tagowych), lastPlayed przeżywa zawsze.
 * @param {any} prev
 * @param {import("./listing.js").LibraryTrack} t
 */
function mergeTrack(prev, t) {
  if (!prev) return { fingerprint: t.fingerprint, rating: null };
  const diverged =
    prev.fingerprint &&
    t.fingerprint &&
    (prev.fingerprint.size !== t.fingerprint.size ||
      prev.fingerprint.modified !== t.fingerprint.modified);
  return {
    fingerprint: t.fingerprint,
    rating: diverged ? null : (prev.rating ?? null),
    ...("lastPlayed" in prev ? { lastPlayed: prev.lastPlayed } : {}),
  };
}

/**
 * Czyści store `tracks` (rebudowa po invalidate listing).
 * @param {IDBDatabase} db
 */
export async function clearTracks(db) {
  await clearStore(db, STORES.TRACKS);
}
