// Zapis oceny (bilety #8/#9, spec §10a): optimistic UI → bajty przez READ-PROXY
// → rewrite ID3v2.3 (ramka WMP) → uploadfile overwrite → cache `tracks` z nowym
// Fingerprintem. Uploady są serializowane (kolejność kliknięć = kolejność wysyłki).
//
// Awaria trwała: optimistic jest wycofywany do ostatniego potwierdzonego stanu
// (czytanego z IDB), więc UI nie kłamie. Awaria przejściowa (sieć/offline):
// ocena ląduje w `pending-ratings` (LWW po Utworze) i zostaje w UI z ⏳ do czasu
// potwierdzenia; flush() wysyła kolejkę wg `createdAt` z read-checkiem
// Fingerprintu. Detektory sieci + Background Sync dokłada bilet 13.

import { fetchTrackStream } from "../api/worker-proxy.js";
import { pcloudApi, uploadFileOverwrite } from "../auth/pcloud-api.js";
import { PCLOUD_SOURCE_KEY } from "../auth/token-store.js";
import { get, put, putMany, STORES } from "../store/db.js";
import { loadLibrary } from "../library/library-cache.js";
import { rewriteId3Rating, starsToByte } from "../tags/id3-writer.js";
import {
  enqueuePendingRating,
  listPendingRatings,
  pendingRatingStars,
  removePendingRating,
} from "./pending-ratings.js";

/** @param {any} rec */
function ratingOf(rec) {
  return rec && typeof rec.rating === "number" ? rec.rating : null;
}

/**
 * Awaria przejściowa = warto spróbować później (sieć, offline, timeout, 5xx, sesja).
 * Błędy trwałe (zły fileid, brak Utworu, 4xx inne niż sesja) nie wracają do kolejki.
 * @param {unknown} err
 */
export function isTransientError(err) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const e = /** @type {any} */ (err);
  if (e?.isNetworkError || e?.isAuthError) return true;
  if (typeof e?.status === "number") {
    return [401, 403, 408, 429].includes(e.status) || e.status >= 500;
  }
  if (e?.name === "TypeError" || e?.name === "AbortError" || e?.name === "NetworkError")
    return true;
  const message = String(e?.message ?? e ?? "");
  return /network|failed to fetch|fetch failed|offline|unavailable|timeout|timed out/i.test(
    message,
  );
}

/** @param {{ token: string, hostname?: string, fileid: number }} opts */
async function defaultFetchBytes({ token, hostname, fileid }) {
  const res = await fetchTrackStream({ token, hostname, fileid });
  return new Uint8Array(await res.arrayBuffer());
}

/** Folder zawierający plik — cache z listingu, a dla starych cache'y `stat`. */
async function defaultStatFile({ token, hostname, fileid }) {
  const res = await pcloudApi({
    method: "stat",
    params: { fileid: String(fileid) },
    token,
    hostname,
  });
  return res?.metadata ?? null;
}

/** Wspólny łańcuch uploadów — max 1 zapis w całej aplikacji, także po rebuildzie roota. */
let uploadTail = Promise.resolve();

/**
 * @typedef {object} RatingControllerOpts
 * @property {IDBDatabase} db
 * @property {string} token
 * @property {string} [hostname]
 * @property {import("../library/listing.js").LibraryTrack[]} tracks — obiekty biblioteki (mutowane Fingerprintem)
 * @property {Map<string, any>} ratings — cache w pamięci (trackKey → rekord)
 * @property {(key: string, state: { rating: number | null, pending: boolean, error?: Error }) => void} onChange
 * @property {(opts: { token: string, hostname?: string, fileid: number }) => Promise<Uint8Array>} [fetchBytes]
 * @property {(opts: { token: string, hostname?: string, fileid: number }) => Promise<any>} [statFile]
 * @property {(opts: any) => Promise<{ fileid: number, name?: string, size: number, modified: number }>} [upload]
 * @property {(err: unknown) => boolean} [isTransient] — awaria przejściowa → kolejka zamiast rollbacku
 * @property {() => number} [now]
 */

/**
 * @typedef {object} FlushSummary
 * @property {number} flushed
 * @property {number} aborted
 * @property {number} failed
 * @property {number} skipped
 */

/** @type {FlushSummary} */
export const EMPTY_FLUSH_SUMMARY = Object.freeze({
  flushed: 0,
  aborted: 0,
  failed: 0,
  skipped: 0,
});

const FILE_CHANGED = "File changed since the rating was queued — rating was not saved.";

/**
 * @param {RatingControllerOpts} opts
 */
export function createRatingController({
  db,
  token,
  hostname,
  tracks,
  ratings,
  onChange,
  fetchBytes = defaultFetchBytes,
  statFile = defaultStatFile,
  upload = uploadFileOverwrite,
  isTransient = isTransientError,
  now = () => Date.now(),
}) {
  const byKey = new Map(tracks.map((t) => [t.key, t]));
  /** Ostatnia potwierdzona ocena (na wypadek braku rekordu w IDB). @type {Map<string, number|null>} */
  const confirmed = new Map();
  /** Wersja kliknięcia — starszy upload nie nadpisuje nowszego UI. @type {Map<string, number>} */
  const versions = new Map();

  let outstanding = 0;
  /** @type {Array<() => void>} */
  let idleResolvers = [];

  function settle() {
    outstanding--;
    if (outstanding === 0 && idleResolvers.length) {
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }

  /** @param {() => Promise<any>} task */
  function enqueue(task) {
    outstanding++;
    const run = uploadTail.then(task, task);
    uploadTail = run.then(
      () => {},
      () => {},
    );
    run.then(settle, settle).catch(() => {});
    return run;
  }

  /**
   * Folder docelowy uploadu. Nowe listingi niosą `folderid`; stare cache'e go nie
   * mają — wtedy jedno `stat?fileid=` (jak w T7) zamiast wymuszać re-listing.
   * @param {import("../library/listing.js").LibraryTrack} track
   * @returns {Promise<string>}
   */
  async function folderIdFor(track) {
    if (track.folderid != null) return track.folderid;
    const meta = await statFile({ token, hostname, fileid: Number(track.fileid) });
    const folderid = meta?.parentfolderid;
    if (folderid == null) throw new Error("rating: cannot resolve the file's parent folder");
    track.folderid = String(folderid);
    return track.folderid;
  }

  /**
   * Ustawia ocenę (1–5) albo usuwa ją (null). Zwraca natychmiast po aktualizacji
   * optimistic — praca (fetch + rewrite + upload) idzie w tle, po kolei.
   * @param {import("../library/listing.js").LibraryTrack | string} trackOrKey
   * @param {1|2|3|4|5|null} stars
   */
  function rate(trackOrKey, stars) {
    if (stars != null && (!Number.isInteger(stars) || stars < 1 || stars > 5)) {
      throw new RangeError(`rate: invalid rating ${stars}`);
    }
    const key = typeof trackOrKey === "string" ? trackOrKey : trackOrKey.key;
    const track = byKey.get(key) ?? (typeof trackOrKey === "string" ? null : trackOrKey);
    if (!confirmed.has(key)) confirmed.set(key, ratingOf(ratings.get(key)));

    const version = (versions.get(key) ?? 0) + 1;
    versions.set(key, version);

    // Optimistic — synchronicznie, przed jakimkolwiek await (< 50 ms, spec §11).
    const prev = ratings.get(key) ?? {};
    ratings.set(key, { ...prev, rating: stars });
    onChange(key, { rating: stars, pending: true });

    enqueue(async () => {
      try {
        if (!track) throw new Error("rating: track not found in library");
        const folderId = await folderIdFor(track);
        const original = await fetchBytes({
          token,
          hostname,
          fileid: Number(track.fileid),
        });
        const rewritten = rewriteId3Rating(original, { stars });
        const meta = await upload({
          token,
          hostname,
          folderId,
          filename: track.name,
          bytes: rewritten.bytes,
        });
        if (Number(meta.fileid) !== Number(track.fileid)) {
          throw new Error(
            `rating: uploadfile returned fileid ${meta.fileid}, expected ${track.fileid}`,
          );
        }
        await commit(track, rewritten, meta, version);
        // Potwierdzone online → ewentualna starsza pozycja kolejki jest nieaktualna.
        // Bezpieczne: kolejka jest serializowana, więc nowszy klik jeszcze nie zdążył
        // dopisać swojego rekordu.
        await removePendingRating(db, key);
        // Nowy zapis online = okazja do przebicia kolejki (spec §7).
        void flush().catch((e) => console.warn("[rating] background flush failed", e));
      } catch (err) {
        if (isTransient(err)) {
          await queuePending(key, track, stars, version, /** @type {Error} */ (err));
        } else {
          await rollback(key, version, /** @type {Error} */ (err));
        }
      }
    });
  }

  /**
   * Awaria przejściowa: zostaw optimistic (⏳) i dopisz do kolejki (LWW po kluczu).
   * @param {string} key
   * @param {import("../library/listing.js").LibraryTrack | null} track
   * @param {1|2|3|4|5|null} stars
   * @param {number} version
   * @param {Error} error
   */
  async function queuePending(key, track, stars, version, error) {
    const fallback = track?.fingerprint ?? (await get(db, STORES.TRACKS, key))?.fingerprint ?? null;
    try {
      await enqueuePendingRating(db, {
        key,
        fingerprint: fallback,
        ratingByte: stars == null ? 0 : starsToByte(stars),
        action: stars == null ? "remove" : "set",
        createdAt: now(),
      });
    } catch (e) {
      console.warn("[rating] queue failed", e);
      await rollback(key, version, error);
      return;
    }
    const prev = ratings.get(key) ?? {};
    const queued = { ...prev, rating: stars, pendingUpload: true };
    ratings.set(key, queued);
    // Cache ocen w IDB niesie stan kolejki (§7), żeby restart i listing widziały ⏳.
    try {
      const record = (await get(db, STORES.TRACKS, key)) ?? {};
      await put(db, STORES.TRACKS, key, { ...record, rating: stars, pendingUpload: true });
    } catch (e) {
      console.warn("[rating] pending cache update failed", e);
    }
    if (versions.get(key) === version) {
      onChange(key, { rating: stars, pending: true, queued: true });
    }
  }

  /**
   * @param {import("../library/listing.js").LibraryTrack} track
   * @param {{ rating: number | null, ratingSource: "WMP" | "max" | null }} rewritten
   * @param {{ size: number, modified: number }} meta
   * @param {number} version
   */
  async function commit(track, rewritten, meta, version) {
    const key = track.key;
    const fingerprint = { size: meta.size, modified: meta.modified };
    track.size = fingerprint.size;
    track.modified = fingerprint.modified;
    track.fingerprint = fingerprint;

    const library = await loadLibrary(db);
    const cachedTrack = library?.tracks?.find((t) => t.key === key);
    if (cachedTrack) {
      cachedTrack.size = fingerprint.size;
      cachedTrack.modified = fingerprint.modified;
      cachedTrack.fingerprint = fingerprint;
    }

    const prevRecord = (await get(db, STORES.TRACKS, key)) ?? {};
    /** @type {any} */
    const record = {
      ...prevRecord,
      fingerprint,
      rating: rewritten.rating,
      ratingSource: rewritten.ratingSource,
      tagsReadAt: now(),
    };
    delete record.pendingUpload;
    /** @type {any[]} */
    const entries = [{ store: STORES.TRACKS, key, value: record }];
    if (library) entries.push({ store: STORES.LIBRARY, key: PCLOUD_SOURCE_KEY, value: library });
    await putMany(db, entries);

    confirmed.set(key, rewritten.rating);
    if (versions.get(key) === version) {
      ratings.set(key, record);
      onChange(key, { rating: rewritten.rating, pending: false });
    }
    // Starszy upload: zostawiamy nowszy optimistic w mapie/UI; jego własny
    // upload właśnie jest w kolejce i potwierdzi stan.
  }

  /**
   * Wycofanie optimistic do stanu z IDB (ostatni potwierdzony zapis). Gdy IDB nie
   * ma rekordu, wracamy do oceny sprzed kliknięcia.
   * @param {string} key
   * @param {number} version
   * @param {Error} error
   */
  async function rollback(key, version, error) {
    if (versions.get(key) !== version) return; // nowszy klik przejmie UI
    console.warn("[rating] save failed", error);
    try {
      const record = await get(db, STORES.TRACKS, key);
      const rating = record ? ratingOf(record) : (confirmed.get(key) ?? null);
      if (record) {
        delete record.pendingUpload;
        ratings.set(key, record);
      } else {
        const prev = ratings.get(key) ?? {};
        ratings.set(key, { ...prev, rating });
      }
      onChange(key, { rating, pending: false, error });
    } catch (e) {
      console.warn("[rating] rollback failed", e);
      const prev = ratings.get(key) ?? {};
      const rating = confirmed.get(key) ?? null;
      ratings.set(key, { ...prev, rating });
      onChange(key, { rating, pending: false, error });
    }
  }

  /**
   * Read-check Fingerprintu: rozbieżność = plik zmienił się od kolejkowania.
   * @param {{ size: number, modified: number } | null} fp
   * @param {any} meta
   */
  function fingerprintDiverged(fp, meta) {
    if (!fp || !meta) return false;
    if (typeof meta.size === "number" && fp.size !== meta.size) return true;
    if (typeof meta.modified === "number" && fp.modified !== meta.modified) return true;
    return false;
  }

  /**
   * Informuje UI, że pozycja kolejki została odrzucona (rozbieżny Fingerprint)
   * i czyści ⏳; pola tagowe cache są unieważniane (spec §4a).
   * @param {string} key
   * @param {any} rec
   * @param {string} message
   */
  async function abortQueued(key, rec, message) {
    await removePendingRating(db, key, { ifCreatedAt: rec.createdAt });
    // Rozbieżny Fingerprint unieważnia pola tagowe cache (spec §4a) — gwiazdki nie kłamią.
    const record = (await get(db, STORES.TRACKS, key)) ?? {};
    delete record.pendingUpload;
    record.rating = null;
    record.ratingSource = null;
    record.tagsReadAt = null;
    await put(db, STORES.TRACKS, key, record);
    ratings.set(key, record);
    onChange(key, { rating: null, pending: false, info: message });
  }

  /**
   * Wysyła JEDEN rekord kolejki. Zwraca wynik dla podsumowania flushu.
   * @param {import("./pending-ratings.js").PendingRating} rec
   * @returns {Promise<"flushed"|"aborted"|"failed"|"skipped"|"transient">}
   */
  async function flushOne(rec) {
    const { key } = rec;
    const track = byKey.get(key);
    if (!track) return "skipped"; // inny root/Źródło — rekord czeka na swoją bibliotekę

    // 1. Tani read-check metadanych przed pobraniem całego pliku.
    if (rec.fingerprint) {
      try {
        const meta = await statFile({ token, hostname, fileid: Number(track.fileid) });
        if (fingerprintDiverged(rec.fingerprint, meta)) {
          await abortQueued(key, rec, FILE_CHANGED);
          return "aborted";
        }
      } catch (err) {
        if (isTransient(err)) return "transient";
        // Trwały błąd statu nie blokuje zapisu — fetch i tak sprawdzi rozmiar.
      }
    }

    const stars = pendingRatingStars(rec);
    const version = versions.get(key) ?? 0;

    try {
      const folderId = await folderIdFor(track);
      const original = await fetchBytes({ token, hostname, fileid: Number(track.fileid) });
      // 2. Read-check po bajtach: inny rozmiar = inny plik niż kolejkowany.
      if (fingerprintDiverged(rec.fingerprint, { size: original.byteLength })) {
        await abortQueued(key, rec, FILE_CHANGED);
        return "aborted";
      }
      const rewritten = rewriteId3Rating(original, { stars });
      const meta = await upload({
        token,
        hostname,
        folderId,
        filename: track.name,
        bytes: rewritten.bytes,
      });
      if (Number(meta.fileid) !== Number(track.fileid)) {
        throw new Error(
          `rating: uploadfile returned fileid ${meta.fileid}, expected ${track.fileid}`,
        );
      }
      await commit(track, rewritten, meta, version);
      await removePendingRating(db, key, { ifCreatedAt: rec.createdAt });
      return "flushed";
    } catch (err) {
      if (isTransient(err)) return "transient"; // rekord zostaje na następny flush
      await removePendingRating(db, key, { ifCreatedAt: rec.createdAt });
      await rollback(key, version, /** @type {Error} */ (err));
      return "failed";
    }
  }

  /**
   * Flush `pending-ratings` (spec §7): kolejność = `createdAt`, max 1 upload naraz.
   * Wywoływany przy starcie aplikacji, po udanym zapisie online i przez
   * `window.flush` (dev). Bilet 13 dokłada `online` + Background Sync.
   * @returns {Promise<FlushSummary>}
   */
  function flush() {
    return enqueue(async () => {
      const records = await listPendingRatings(db);
      /** @type {FlushSummary} */
      const summary = { ...EMPTY_FLUSH_SUMMARY };
      for (const rec of records) {
        const outcome = await flushOne(rec);
        if (outcome === "flushed") summary.flushed++;
        else if (outcome === "aborted") summary.aborted++;
        else if (outcome === "skipped") summary.skipped++;
        else {
          summary.failed++;
          // Sieć padła — dalsze rekordy i tak nie przejdą; zostają w kolejce.
          if (outcome === "transient") break;
        }
      }
      return summary;
    });
  }

  return {
    rate,
    flush,
    /** Czeka aż kolejka uploadów się opróżni (testy, zamknięcie aplikacji). */
    whenIdle() {
      if (outstanding === 0) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
  };
}
