// Zapis oceny (bilet #8, spec §10a krok 1 z 2): optimistic UI → bajty przez
// READ-PROXY → rewrite ID3v2.3 (ramka WMP) → uploadfile overwrite → cache
// `tracks` z nowym Fingerprintem. Uploady są serializowane (kolejność kliknięć =
// kolejność wysyłki); pełna kolejka z flagą ⏳ i pending-ratings to bilet #9.
//
// Awaria: optimistic jest wycofywany do ostatniego potwierdzonego stanu (czytanego
// z IDB), więc UI nie kłamie. Późniejszy klik nie jest nadpisywany wynikiem
// starszego uploadu, który właśnie się zakończył.

import { fetchTrackStream } from "../api/worker-proxy.js";
import { pcloudApi, uploadFileOverwrite } from "../auth/pcloud-api.js";
import { PCLOUD_SOURCE_KEY } from "../auth/token-store.js";
import { get, putMany, STORES } from "../store/db.js";
import { loadLibrary } from "../library/library-cache.js";
import { rewriteId3Rating } from "../tags/id3-writer.js";

/** @param {any} rec */
function ratingOf(rec) {
  return rec && typeof rec.rating === "number" ? rec.rating : null;
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
 * @property {() => number} [now]
 */

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

  /** @param {() => Promise<void>} task */
  function enqueue(task) {
    outstanding++;
    const run = uploadTail.then(task, task);
    uploadTail = run.then(
      () => {},
      () => {},
    );
    run.then(settle, settle).catch(() => {});
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
      } catch (err) {
        await rollback(key, version, /** @type {Error} */ (err));
      }
    });
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

  return {
    rate,
    /** Czeka aż kolejka uploadów się opróżni (testy, flush w bilecie #9). */
    whenIdle() {
      if (outstanding === 0) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
  };
}
