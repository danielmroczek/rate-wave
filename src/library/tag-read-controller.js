// Kontroler odczytu tagów (bilet #7): gwiazdki dla widocznych wierszy przez
// batchowy /head, eskalacja 8 KB → 512 KB → 2 MB (pojedynczy /stream), dociąganie
// reszty biblioteki w tle (idle) bez blokowania scrolla. Wyniki → store `tracks`
// z walidacją Fingerprint (rozbieżność = jak bez oceny).
//
// Kolejki: visible (max 3 równoległe batche) > idle (1, sekwencyjnie; start przy
// braku visible-pending + 3 s stabilności, pauza podczas aktywnego scrolla).

import { HEAD_BATCH_CAP, fetchHeadBatchWithRetry } from "../api/proxy-batch.js";
import { fetchTrackStream } from "../api/worker-proxy.js";
import { put, get, STORES } from "../store/db.js";
import { createHeadParser } from "../tags/head-parser-client.js";

/** Zakresy eskalacji (po 8 KB headzie): 0–512 KB, potem 0–2 MB. */
const ESCALATION_RANGES = ["bytes=0-524287", "bytes=0-2097151"];

/** @param {{ size?: number, modified?: number } | undefined} a */
/** @param {{ size?: number, modified?: number } | undefined} b */
export function fingerprintEqual(a, b) {
  return !!a && !!b && a.size === b.size && a.modified === b.modified;
}

/**
 * @typedef {object} TagReadControllerOpts
 * @property {IDBDatabase} db
 * @property {string} token
 * @property {import("./listing.js").LibraryTrack[]} tracks
 * @property {Map<string, any>} ratings — map trackKey → rekord IDB
 * @property {(trackKey: string, record: any) => void} onTagsRead
 * @property {(opts: any) => Promise<any>} [fetchHeadBatchImpl]
 * @property {(opts: any) => Promise<Response>} [fetchTrackStreamImpl]
 * @property {(bytes: Uint8Array) => Promise<any>} [parseImpl] — default: Web Worker
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 * @property {number} [visibleConcurrency] — równoległe batche dla widocznych (default 3)
 * @property {number} [idleDelayMs] — stabilność przed backfill (default 3000)
 */

/**
 * @param {TagReadControllerOpts} opts
 */
export function createTagReadController({
  db,
  token,
  tracks,
  ratings,
  onTagsRead,
  fetchHeadBatchImpl = fetchHeadBatchWithRetry,
  fetchTrackStreamImpl = fetchTrackStream,
  parseImpl,
  now = () => Date.now(),
  visibleConcurrency = 3,
  idleDelayMs = 3000,
}) {
  /** @typedef {"queued" | "inflight" | "inflight-esc" | "done" | "failed"} TrackStatus */
  /** @type {Map<string, TrackStatus>} */
  const statuses = new Map();
  /** @type {Array<{ tracks: import("./listing.js").LibraryTrack[] }>} */
  const visibleTasks = [];
  /** @type {Array<{ tracks: import("./listing.js").LibraryTrack[] }>} */
  const idleTasks = [];
  let inflightVisible = 0;
  let inflightIdle = 0;
  let idleTimer = /** @type {any} */ (null);
  let destroyed = false;

  const parser = parseImpl ? { parse: parseImpl, dispose() {} } : createHeadParser();

  function cachedEnough(track) {
    const rec = ratings.get(track.key);
    return rec && rec.tagsReadAt != null && fingerprintEqual(rec.fingerprint, track.fingerprint);
  }

  function chunk(tracksList) {
    const fresh = tracksList.filter((t) => !statuses.has(t.key));
    const out = [];
    for (let i = 0; i < fresh.length; i += HEAD_BATCH_CAP)
      out.push(fresh.slice(i, i + HEAD_BATCH_CAP));
    for (const batch of out) for (const t of batch) statuses.set(t.key, "queued");
    return out;
  }

  /**
   * Ustawia zbiór widocznych Utworów (okno widoczne ±1 batch); tworzy/priorytetyzuje batche.
   * @param {import("./listing.js").LibraryTrack[]} visibleTracks
   */
  function setVisibleTracks(visibleTracks) {
    if (destroyed) return;
    for (const batch of chunk(visibleTracks)) visibleTasks.push({ tracks: batch });
    schedule();
  }

  /**
   * Backfill: dolej resztę biblioteki jako idle (wywoływane po pierwszym oknie).
   * @param {import("./listing.js").LibraryTrack[]} restTracks
   */
  function enqueueIdle(restTracks) {
    if (destroyed) return;
    for (const batch of chunk(restTracks)) idleTasks.push({ tracks: batch });
    schedule();
  }

  /** Odczyt w jednym Tasku: batch /head → parse → eskalacja → cache. */
  async function runTask(task, kind) {
    if (kind === "visible") inflightVisible++;
    else inflightIdle++;
    try {
      const pendingTracks = task.tracks.filter((t) => statuses.get(t.key) === "queued");
      if (pendingTracks.length === 0) return;

      const fileids = pendingTracks.map((t) => Number(t.fileid));
      /** @type {Map<number, any>} */
      let results = new Map();
      try {
        results = await fetchHeadBatchImpl({ token, fileids });
      } catch {
        // Sieć/proxy padły po retryach batcha — spróbuj ponownie (do limitu
        // prób per-track), potem „unread do końca sesji" (status failed).
        requeueFailed(pendingTracks, kind);
        return;
      }

      const errored = [];
      for (const t of pendingTracks) {
        const entry = results.get(Number(t.fileid));
        if (!entry || entry.status !== "ok") {
          errored.push(t);
          continue;
        }
        statuses.set(t.key, "inflight-esc");
        const okToWrite = await handleOk(t, entry.bytes, kind);
        if (okToWrite) statuses.set(t.key, "done");
      }
      // Błędy per-plik: 3 próby łącznie → potem failed (nieprzeczytany do końca sesji).
      requeueFailed(errored, kind);
    } finally {
      if (kind === "visible") inflightVisible--;
      else inflightIdle--;
      schedule();
    }
  }

  /**
   * Błędy (sieć/proxy lub linie status:„error"): maks. 3 próby łącznie per track
   * (counter per track, nie per batch — bieżnia batcha może się zmieniać),
   * potem failed — bez ponownego odczytu do końca sesji.
   * @param {import("./listing.js").LibraryTrack[]} tracksList
   * @param {"visible" | "idle"} kind
   */
  function requeueFailed(tracksList, kind) {
    if (tracksList.length === 0) return;
    /** @type {import("./listing.js").LibraryTrack[]} */
    const retryTracks = [];
    for (const t of tracksList) {
      const n = (attempts.get(t.key) ?? 0) + 1;
      attempts.set(t.key, n);
      if (n < 3) {
        statuses.set(t.key, "queued"); // 3. próba będzie ostatnią
        retryTracks.push(t);
      } else {
        statuses.set(t.key, "failed"); // „nieprzeczytany" do końca sesji
      }
    }
    if (retryTracks.length) {
      (kind === "visible" ? visibleTasks : idleTasks).unshift({
        tracks: retryTracks,
      });
    }
  }

  /** @type {Map<string, number>} */
  const attempts = new Map(); // per-track próby/odczyt (limit 3, potem failed)

  /**
   * Plik z OK headem: parse (+ eskalacja gdy brak ramek) → zapis cache.
   * Zwraca false, gdy eskalacja nie dała wyniku (błąd sieci) i zapis z „bez
   * oceny" byłby sfabrykowany — plik wraca do kolejki.
   * @param {import("./listing.js").LibraryTrack} track
   * @param {Uint8Array} bytes
   * @param {"visible" | "idle"} kind
   * @returns {Promise<boolean>}
   */
  async function handleOk(track, bytes, kind) {
    let tags = await parser.parse(bytes);
    if (!tags.framesSeen) {
      tags = null;
      for (const range of ESCALATION_RANGES) {
        try {
          const res = await fetchTrackStreamImpl({ token, fileid: track.fileid, range });
          const buf = new Uint8Array(await res.arrayBuffer());
          tags = await parser.parse(buf);
        } catch {
          /* błąd eskalacji → kolejny zakres; ostatecznie retrack */
        }
        if (tags?.framesSeen) break;
      }
      if (!tags) {
        // Obie eskalacje nieudane (sieć) — nie zapisujemy „bez oceny".
        requeueFailed([track], kind);
        return false;
      }
    }
    await writeTrackRecord(track, tags);
    return true;
  }

  /**
   * Zapis rekordu Utworu z walidacją Fingerprint (per-odczyt): rozbieżność =
   * jak bez oceny (null, tagsReadAt null → ponowny odczyt w kolejnej sesji).
   * @param {import("./listing.js").LibraryTrack} track
   * @param {any} tags
   */
  async function writeTrackRecord(track, tags) {
    const prev = (await get(db, STORES.TRACKS, track.key)) ?? null;
    const diverged = prev && !fingerprintEqual(prev.fingerprint, track.fingerprint);
    const rating = diverged || tags.rating == null ? null : tags.rating;
    /** @type {any} */
    const record = {
      fingerprint: track.fingerprint,
      rating: diverged ? null : (prev?.rating ?? rating),
      ratingSource: diverged ? null : (tags.ratingSource ?? prev?.ratingSource ?? null),
      rgGainDb: diverged ? null : (tags.rgGainDb ?? prev?.rgGainDb ?? null),
      rgSource: diverged ? null : (tags.rgSource ?? prev?.rgSource ?? null),
      tagsReadAt: diverged ? null : now(), // rozbieżność → re-read następnej sesji
    };
    if (prev && "lastPlayed" in prev) record.lastPlayed = prev.lastPlayed;
    await put(db, STORES.TRACKS, track.key, record);
    ratings.set(track.key, record);
    onTagsRead(track.key, record);
  }

  function idleAllowed() {
    if (idleDelayMs <= 0) return visibleTasks.length === 0 && inflightVisible === 0;
    // backfill start: brak visible-pending + stabilność (scroll/okno uspokojone)
    const stable = now() - Math.max(lastScrollAt, lastVisibleChangeAt) >= idleDelayMs;
    return stable && visibleTasks.length === 0 && inflightVisible === 0;
  }

  function schedule() {
    if (destroyed) return;
    while (visibleTasks.length > 0 && inflightVisible < visibleConcurrency) {
      const task = /** @type {any} */ (visibleTasks.shift());
      runTask(task, "visible").catch(() => {}); // statusy już cofnięte / retry
    }
    if (idleTasks.length > 0 && inflightIdle < 1 && idleAllowed()) {
      const task = /** @type {any} */ (idleTasks.shift());
      runTask(task, "idle").catch(() => {});
    } else if (idleTasks.length > 0 && !idleTimer) {
      idleTimer = setTimeout(
        () => {
          idleTimer = null;
          schedule();
        },
        Math.max(50, Math.min(idleDelayMs, 1000)),
      );
    }
  }

  let lastScrollAt = 0;
  let lastVisibleChangeAt = 0;

  function onScrollActive() {
    lastScrollAt = now();
  }
  function onVisibleSettled() {
    lastVisibleChangeAt = now();
  }

  function destroy() {
    destroyed = true;
    visibleTasks.length = 0;
    idleTasks.length = 0;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    parser.dispose();
  }

  // Cache: cofnij status dla Utworów już z odczytem (nie ma sensu read-out).
  for (const t of tracks) {
    if (cachedEnough(t)) statuses.set(t.key, "done");
  }

  return { setVisibleTracks, enqueueIdle, onScrollActive, onVisibleSettled, destroy };
}
