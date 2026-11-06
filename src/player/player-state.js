// Logika playera (bilet 06): odtwarzanie z linku pCloud (<audio>, zero proxy
// bajtów), scrubbing z duration z preload=metadata, throttled (5 s) zapis
// pozycji do store `session` + przy pause, lastPlayed w store `tracks` przy
// każdym starcie odtwarzania. Niezależna od DOM (audio injectable — testowalne).

import { get, put, STORES } from "../store/db.js";

// Session (Pełny powrót) — kontrakt jeden, w store/db.js (§4a); re-eksport dla
// view/library-view, zero drugiego dostawcy tego samego rekordu.
import { loadSession, saveSession } from "../store/db.js";
export { loadSession, saveSession };

/**
 * Zapisuje `lastPlayed` (ms epoch) w rekordzie Utworu (store `tracks`) — przy
 * każdym starcie odtwarzania. Rekord może nie istnieć (biblioteka przebudowana
 * między zapisem a odtworzeniem) — tworzony jest minimalny; rebuild cache
 * biblioteki zachowuje lastPlayed (spec §4a: przeżywa unieważnienie).
 * @param {IDBDatabase} db
 * @param {string} trackKey
 * @param {number} [now] — injectable dla testów
 */
export async function markLastPlayed(db, trackKey, now = Date.now()) {
  const rec = (await get(db, STORES.TRACKS, trackKey)) ?? {};
  rec.lastPlayed = now;
  await put(db, STORES.TRACKS, trackKey, rec);
}

/**
 * Player Audio API — minimalna powierzchnia z HTMLMediaElement używana tutaj.
 * @typedef {{ src?: string, preload?: string, currentTime: number, duration: number, paused: boolean,
 *   play(): Promise<void>, pause(): void, addEventListener(type: string, fn: (e: any) => void): void }} PlayerAudio
 */

/**
 * Tworzy sterownik odtwarzania. `getLink(track)` → `{ link }` (READ-PROXY
 * getfilelink). `createAudio()` domyślnie nowy HTMLAudioElement.
 *
 * @param {{ db: IDBDatabase, getLink: (track: any) => Promise<{ link: string, expires?: number }>,
 *   createAudio?: () => PlayerAudio, saveIntervalMs?: number, clock?: { now(): number },
 *   onState?: (s: { track?: any, playing: boolean, position: number, duration: number, status?: string }) => void,
 *   onTrackChange?: (track: any) => void }} opts
 */
export function createPlayer({
  db,
  getLink,
  createAudio,
  saveIntervalMs = 5000,
  clock = { now: () => Date.now() },
  onState,
  onTrackChange,
}) {
  /** @type {PlayerAudio | undefined} */
  let audio;
  let track; // aktualny Utwór
  let lastSaveAt = 0;
  let wantPlay = false;
  let pendingSeek = 0; // pozycja startowa czekająca na loadedmetadata
  let playSeq = 0; // sera wywołań play() — guard race szybkiego klikania
  let status; // sticky: "autoplay-blocked" / "error: …" aż do skutecznego startu

  function emit(s) {
    if (s !== undefined) {
      status = s; // nowy status nadpisuje
    } else if (audio && !audio.paused) {
      status = undefined; // odtwarzanie ruszyło — czyścimy hint błędu/blokady
    }
    onState?.({
      track,
      playing: wantPlay && Boolean(audio && !audio.paused),
      position: audio?.currentTime ?? pendingSeek,
      duration: duration(),
      status,
    });
  }

  /** Duration z media element (preload=metadata → znane od startu, bez peaks). */
  function duration() {
    const d = audio?.duration;
    return Number.isFinite(d) ? d : 0;
  }

  function scheduleSave(force = false, positionOverride) {
    const now = clock.now();
    if (!force && now - lastSaveAt < saveIntervalMs) return;
    lastSaveAt = now;
    if (!track) return;
    const position = positionOverride ?? audio?.currentTime ?? pendingSeek;
    saveSession(db, { source: "pcloud", trackKey: track.key, positionSec: position }).catch((err) =>
      console.warn("[player] session save failed", err),
    );
  }

  function wire(/** @type {PlayerAudio} */ a) {
    a.addEventListener("loadedmetadata", () => {
      if (pendingSeek > 0 && Number.isFinite(a.duration)) {
        try {
          a.currentTime = Math.min(pendingSeek, a.duration);
          pendingSeek = 0;
        } catch {
          /* seek przed danymi — pomiń */
        }
      }
      emit();
    });
    a.addEventListener("timeupdate", () => {
      scheduleSave();
      emit();
    });
    a.addEventListener("pause", () => {
      scheduleSave(true);
      emit();
    });
    a.addEventListener("ended", () => {
      scheduleSave(true, 0);
      wantPlay = false;
      emit("ended");
    });
  }

  /**
   * Wybiera Utwór i natychmiast odtwarza (Pełny powrót: `startAt` = sekunda
   * pozycji). Link z getfilelink idzie prosto do <audio src> — media element
   * czyta z pCloud bez proxy bajtów i bez nagłówka Origin (no-referrer w HTML).
   * @param {any} t
   * @param {{ startAt?: number, autoplay?: boolean }} [opts]
   */
  async function play(t, { startAt = 0, autoplay = true } = {}) {
    if (!t) return;
    const seq = ++playSeq; // tylko najświeższe play() może ustawić audio/track
    track = t;
    wantPlay = autoplay;
    pendingSeek = Number(startAt) > 0 ? Number(startAt) : 0;
    lastSaveAt = 0;
    emit("loading");

    markLastPlayed(db, t.key).catch((err) => console.warn("[player] lastPlayed save failed", err));

    try {
      const { link } = await getLink(t);
      if (seq !== playSeq) return; // w międzyczasie wybrano inny Utwór — porzuć
      audio?.pause();
      audio = createAudio ? createAudio() : new Audio();
      audio.preload = "metadata";
      wire(audio);
      audio.src = link;
      // Zmiana bieżącego Utwóra — lista może się podświetlić (sync player↔lista).
      onTrackChange?.(t);
      if (pendingSeek > 0) {
        // zapasowo już teraz — loadedmetadata poprawi, gdy duration gotowy
        try {
          audio.currentTime = pendingSeek;
        } catch {
          /* czekamy na metadata */
        }
      }
      emit();
      if (autoplay) {
        await audio.play().catch(() => emit("autoplay-blocked"));
      }
      if (seq === playSeq) {
        emit();
        // Pozycja startowa do sesji od razu (Pełny powrót ≡ ostatnia znana pozycja).
        scheduleSave(true, audio.currentTime || pendingSeek);
      }
    } catch (err) {
      emit(`error: ${/** @type {any} */ (err)?.message ?? err}`);
    }
  }

  function pause() {
    wantPlay = false;
    audio?.pause();
    scheduleSave(true);
    emit();
  }

  function toggle() {
    if (!track) return false;
    if (audio && !audio.paused) {
      pause();
    } else {
      wantPlay = true;
      audio?.play().catch(() => emit("autoplay-blocked"));
      emit();
    }
    return true;
  }

  /** Skok do sekundy (scrubbing) — działa od startu (duration z preload=metadata).
   *  Zapis pozycji throttled (drag nie wywołuje zapisu na każdy pointermove). */
  function seekTo(sec) {
    if (!audio || !Number.isFinite(audio.duration)) {
      pendingSeek = Math.max(0, sec);
      emit();
      return;
    }
    try {
      audio.currentTime = Math.max(0, Math.min(sec, audio.duration));
      scheduleSave();
      emit();
    } catch {
      pendingSeek = Math.max(0, sec);
      emit();
    }
  }

  /**
   * Następny/poprzedni Utwór z playlisty (transport N/P). Zwraca true gdy był komu.
   * @param {any[]} playlist
   * @param {number} offset — +1 następny, -1 poprzedni
   */
  async function step(playlist, offset) {
    if (!playlist?.length || !track) return false;
    const i = playlist.findIndex((t) => t.key === track.key);
    if (i < 0) return false;
    const nextIdx = Math.max(0, Math.min(i + offset, playlist.length - 1));
    if (nextIdx === i) return false;
    await play(playlist[nextIdx]);
    return true;
  }

  return {
    play,
    pause,
    toggle,
    seekTo,
    step,
    /** Aktualny Utwór (lub undefined). */
    get track() {
      return track;
    },
    get audio() {
      return audio;
    },
    /** Czas trwania aktualnego Utworu (0, dopóki metadata nie dotarła). */
    get duration() {
      return duration();
    },
    /** Persistuj pozycję natychmiast (beforeunload / dispose). */
    flushPosition() {
      scheduleSave(true);
    },
  };
}
