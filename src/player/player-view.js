// Widok playera (bilet 06): przyklejony na dole wg prototypu
// .scratch/prototypes/player-ux/ — tytuł, gwiazdki (placeholder), transport
// (play/pause, następny/poprzedni), jeden duży waveform ze scrubbingiem
// (klik/drag) — typ placeholder, dopóki nie powstanie prawdziwy wave,
// obok aktualny czas.

import { createPlayer, loadSession } from "./player-state.js";
import { createTapTempo } from "./tap-tempo.js";
import { fetchTrackBlob } from "../api/worker-proxy.js";
import { createStarControl } from "../ratings/star-control.js";
import { isEditableTarget } from "../ui/keyboard.js";

/** mm:ss (duration z preload=metadata — działa od startu, bez peaks). */
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Montuje player w `#player`. Zwraca API: play(track, opts), setPlaylist(tracks),
 * dispose(). `getLink` injectable (domyślnie POST /stream → Blob URL).
 *
 * @param {{ db: IDBDatabase, token?: string, hostname?: string, getLink?: (t: any) => Promise<any>,
 *   createAudio?: () => any, saveIntervalMs?: number, playerEl?: HTMLElement, doc?: Document,
 *   onTrackChange?: (t: any) => void, getRating?: (key: string) => number | null,
 *   isPending?: (key: string) => boolean,
 *   onRate?: (track: any, stars: number) => void,
 *   getBpm?: (key: string) => number | null,
 *   onBpm?: (track: any, bpm: number) => void,
 *   tapNow?: () => number, bpmSaveDelayMs?: number,
 *   onNextUnrated?: () => boolean }} opts
 */
export function mountPlayer({
  db,
  token,
  hostname,
  getLink,
  createAudio,
  saveIntervalMs,
  playerEl,
  doc = document,
  onTrackChange,
  getRating,
  isPending,
  onRate,
  getBpm,
  onBpm,
  tapNow,
  bpmSaveDelayMs = 600,
  onNextUnrated,
}) {
  const host = playerEl ?? doc.getElementById("player");
  if (!host) throw new Error("mountPlayer: #player not found");

  host.innerHTML = "";
  host.hidden = false;

  // ── struktura wg prototypu player-ux ────────────────────────
  const title = doc.createElement("div");
  title.id = "ptitle";
  title.textContent = "Nothing selected";

  const starsCtl = createStarControl({
    doc,
    label: "Rating",
    onRate: (n) => {
      const t = player.track;
      if (t && onRate) onRate(t, n);
    },
  });
  const stars = starsCtl.element;
  stars.id = "pstars";
  stars.title = "Rating (1–5, 0 clears)";

  // TAP tempo (bilet 13, spec §5f): klik/T = tick; 3+ ticki → BPM;
  // „↺” restartuje próbę; zapis po chwili bez tapnięć (jeden upload).
  const btnTap = doc.createElement("button");
  btnTap.type = "button";
  btnTap.id = "pbtn-tap";
  btnTap.className = "btn ghost tap-btn";
  btnTap.title = "Tap tempo (T) — tap the beat 3+ times";
  btnTap.textContent = "TAP";
  const bpmLabel = doc.createElement("span");
  bpmLabel.id = "pbpm";
  bpmLabel.title = "Tempo (BPM)";
  const btnTapReset = doc.createElement("button");
  btnTapReset.type = "button";
  btnTapReset.id = "pbtn-tap-reset";
  btnTapReset.className = "btn ghost tap-reset";
  btnTapReset.title = "Restart tapping";
  btnTapReset.textContent = "↺";
  const rateRow = doc.createElement("div");
  rateRow.id = "prate";
  rateRow.append(stars, btnTap, bpmLabel, btnTapReset);

  // Slot waveformu: placeholder — realny wave po pierwszej ocenie (bilet ocen).
  const waveSlot = doc.createElement("div");
  waveSlot.id = "wave-slot";
  waveSlot.className = "wave-slot";
  // warstwa postępu (scrubbing działa od razu, zanim powstanie prawdziwy wave)
  const waveFill = doc.createElement("div");
  waveFill.id = "wave-fill";
  const waveLabel = doc.createElement("span");
  waveLabel.className = "wave-label";
  waveLabel.textContent = "waveform: placeholder — appears after the first rating";
  waveSlot.append(waveFill, waveLabel);

  // Slot waveformu jest scrubowalny jak słupek (role slider wspólne).
  waveSlot.setAttribute("role", "slider");
  waveSlot.setAttribute("aria-label", "Position (waveform)");
  waveSlot.setAttribute("aria-valuemin", "0");
  waveSlot.setAttribute("aria-valuemax", "0");
  waveSlot.setAttribute("aria-valuenow", "0");
  waveSlot.tabIndex = 0;

  const time = doc.createElement("span");
  time.id = "ptime";
  time.textContent = "0:00 / 0:00";
  const waveRow = doc.createElement("div");
  waveRow.className = "wave-row";
  waveRow.append(waveSlot, time);

  const transport = doc.createElement("div");
  transport.id = "transport";
  const note = doc.createElement("span");
  note.id = "pnote";
  note.className = "hint";
  note.setAttribute("aria-live", "polite");
  note.role = "status";
  const btnPrev = doc.createElement("button");
  btnPrev.type = "button";
  btnPrev.id = "pbtn-prev";
  btnPrev.className = "tbtn";
  btnPrev.title = "Previous (P)";
  btnPrev.textContent = "⏮";
  const btnPlay = doc.createElement("button");
  btnPlay.type = "button";
  btnPlay.id = "pbtn-play";
  btnPlay.className = "tbtn main";
  btnPlay.title = "Play/Pause (Space)";
  btnPlay.textContent = "▶";
  const btnNext = doc.createElement("button");
  btnNext.type = "button";
  btnNext.id = "pbtn-next";
  btnNext.className = "tbtn";
  btnNext.title = "Next (N)";
  btnNext.textContent = "⏭";
  // „→ ☆”: następny nieoceniony na bieżącej liście (spec §5b; bilet 12)
  const btnNextUnrated = doc.createElement("button");
  btnNextUnrated.type = "button";
  btnNextUnrated.id = "pbtn-next-unrated";
  btnNextUnrated.className = "tbtn";
  btnNextUnrated.title = "Next unrated (U)";
  btnNextUnrated.textContent = "→ ☆";
  transport.append(btnPrev, btnPlay, btnNext, btnNextUnrated);

  host.append(title, rateRow, waveRow, transport, note);

  // ── stan: playlist do transportu N/P ────────────────────────
  let playlist = /** @type {any[]} */ ([]);
  let lastStarsKey = /** @type {string | null} */ (null);
  let lastStarsRating = /** @type {number | null | undefined} */ (undefined);
  /** Bieżący Utwór dla wyświetlacza BPM (detektor zmiany w onState). */
  let bpmTrackKey = /** @type {string | null} */ (null);
  /** @type {any} */
  let bpmTrack = null;
  const tapTempo = createTapTempo(tapNow ? { now: tapNow } : {});
  let bpmSaveTimer = /** @type {any} */ (null);
  let pendingBpm = /** @type {number | null} */ (null);

  /** @param {number | null} bpm */
  function renderBpm(bpm) {
    bpmLabel.textContent = bpm ? `${bpm} BPM` : "";
  }

  /** @param {any} track */
  function storedBpm(track) {
    return track && getBpm ? getBpm(track.key) : null;
  }

  /** Czyści ticki i anuluje oczekujący zapis (bez zapisywania). */
  function clearTapSession() {
    tapTempo.reset();
    if (bpmSaveTimer) clearTimeout(bpmSaveTimer);
    bpmSaveTimer = null;
    pendingBpm = null;
  }

  /** Dopisuje obliczone BPM, jeśli różni się od zapisanego. */
  function flushPendingBpm() {
    if (bpmSaveTimer) clearTimeout(bpmSaveTimer);
    bpmSaveTimer = null;
    const track = bpmTrack;
    const value = pendingBpm;
    pendingBpm = null;
    if (!track || value == null || storedBpm(track) === value) return;
    onBpm?.(track, value);
  }

  /** Retry („↺”): restart od zera, pokazuje BPM zapisany w pliku/cache. */
  function resetTapSession() {
    clearTapSession();
    renderBpm(storedBpm(bpmTrack));
  }

  /** @param {any} track */
  function switchBpmTrack(track) {
    flushPendingBpm(); // nie gub wystukanego tempa przy zmianie Utworu
    bpmTrack = track ?? null;
    clearTapSession();
    renderBpm(storedBpm(bpmTrack));
  }

  function tickTempo() {
    if (!player.track) return;
    const { bpm, taps } = tapTempo.tap();
    if (bpm == null) {
      bpmLabel.textContent = taps === 0 ? "" : "…";
      return;
    }
    renderBpm(bpm);
    pendingBpm = bpm;
    // Zapis po pauzie dłuższej niż interwał tapanego tempa — inaczej przy
    // wolnych tempach (<100 BPM) timer strzelałby między kolejnymi tickami.
    const interval = 60000 / bpm;
    const delay = Math.min(2000, Math.max(bpmSaveDelayMs, interval + 250));
    if (bpmSaveTimer) clearTimeout(bpmSaveTimer);
    bpmSaveTimer = setTimeout(flushPendingBpm, delay);
  }

  // <audio> gra z Blob URL-a: bajty pobiera POST /stream (token w body, nigdy
  // w URL-u). Blob trzymamy do zmiany Utworu i zwalniamy w dispose.
  let audioObjectUrl = /** @type {string | null} */ (null);
  let linkQueue = Promise.resolve();
  const link =
    getLink ??
    ((t) => {
      // Serializacja: szybkie klikanie dwóch Utworów nie może zwolnić URL-a,
      // którego player właśnie użył (każde pobranie kończy się przed następnym).
      const run = linkQueue.then(async () => {
        const blob = await fetchTrackBlob({ token, hostname, fileid: t.fileid });
        if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
        audioObjectUrl = URL.createObjectURL(blob);
        return { link: audioObjectUrl };
      });
      linkQueue = run.catch(() => {});
      return run;
    });
  const player = createPlayer({
    db,
    getLink: link,
    ...(createAudio ? { createAudio } : {}),
    ...(saveIntervalMs !== undefined ? { saveIntervalMs } : {}),
    ...(onTrackChange ? { onTrackChange } : {}),
    onState(state) {
      title.textContent = state.track ? state.track.name : "Nothing selected";
      btnPlay.textContent = state.playing ? "⏸" : "▶";
      const key = state.track?.key ?? null;
      if (key !== bpmTrackKey) {
        bpmTrackKey = key;
        switchBpmTrack(state.track);
      }
      const rating = key && getRating ? getRating(key) : null;
      const pending = key != null && isPending ? isPending(key) : false;
      if (key !== lastStarsKey || rating !== lastStarsRating) {
        starsCtl.setRating(rating);
        lastStarsKey = key;
        lastStarsRating = rating;
      }
      starsCtl.setPending(pending);
      // Autoplay po przywróceniu sesji może być zablokowany — podświetl play,
      // żeby „po tapnięciu” Utwór wznowił się od zapisanej pozycji.
      btnPlay.classList.toggle("pulse", state.status === "autoplay-blocked");
      note.textContent =
        state.status === "loading"
          ? "Loading track…"
          : state.status === "autoplay-blocked"
            ? "Playback needs a tap — press play."
            : (state.status ?? "").startsWith("error:")
              ? `Playback error: ${state.status.slice("error: ".length)}`
              : "";
      const dur = state.duration || 0;
      const width = dur > 0 ? `${Math.min(100, (state.position / dur) * 100)}%` : "0%";
      time.textContent = `${formatTime(state.position)} / ${formatTime(dur)}`;
      waveFill.style.width = width;
      waveSlot.setAttribute("aria-valuemax", String(Math.floor(dur)));
      waveSlot.setAttribute("aria-valuenow", String(Math.floor(state.position)));
    },
  });

  btnPlay.addEventListener("click", () => {
    btnPlay.classList.remove("pulse");
    player.toggle();
  });
  btnTap.addEventListener("click", tickTempo);
  btnTapReset.addEventListener("click", resetTapSession);
  btnPrev.addEventListener("click", () => void player.step(playlist, -1));
  btnNext.addEventListener("click", () => void player.step(playlist, 1));
  if (onNextUnrated) {
    btnNextUnrated.addEventListener("click", () => onNextUnrated());
    // kolejny nieoceniony: przycisk „→ ☆” + skrót U (spec §5b/§5c)
  }

  // ── scrubbing: klik/tap/drag po waveformie (pointer events)
  // + ←/→ ±10 s na focusie (jak w prototypie) ──────────────────
  function makeScrubber(/** @type {HTMLElement} */ el) {
    let dragging = false;
    function seekFromEvent(/** @type {PointerEvent} */ e) {
      const rect = el.getBoundingClientRect();
      const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
      const dur = player.duration;
      if (dur <= 0) return;
      player.seekTo(Math.max(0, Math.min(1, frac)) * dur);
    }
    el.addEventListener("pointerdown", (e) => {
      dragging = true;
      /** @type {any} */ (el).setPointerCapture?.(e.pointerId);
      seekFromEvent(e);
    });
    el.addEventListener("pointermove", (e) => {
      if (dragging) seekFromEvent(e);
    });
    el.addEventListener("pointerup", () => {
      dragging = false;
    });
    el.addEventListener("lostpointercapture", () => {
      dragging = false;
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const delta = e.key === "ArrowLeft" ? -10 : 10;
        player.seekTo((/** @type {any} */ (player.audio)?.currentTime ?? 0) + delta);
      }
    });
  }
  makeScrubber(waveSlot);

  // ── klawiatura: Space play/pause, N następny, P poprzedni; ──
  // nie koliduje z polami tekstowymi (input/textarea/select/contenteditable)
  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (isEditableTarget(e)) return;
    if (e.key === " ") {
      e.preventDefault();
      btnPlay.classList.remove("pulse");
      player.toggle();
    } else if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      void player.step(playlist, 1);
    } else if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      void player.step(playlist, -1);
    } else if (onNextUnrated && (e.key === "u" || e.key === "U")) {
      // kolejny nieoceniony (spec §5c)
      e.preventDefault();
      onNextUnrated();
    } else if (e.key === "t" || e.key === "T") {
      // TAP tempo (spec §5f)
      e.preventDefault();
      tickTempo();
    }
  }
  doc.addEventListener("keydown", onKey);

  // zapis pozycji przy wychodzeniu z aplikacji (flush ostatniej pozycji)
  function onBeforeUnload() {
    player.flushPosition();
  }
  doc.defaultView?.addEventListener("beforeunload", onBeforeUnload);

  return {
    /** Wybiera Utwór i od razu odtwarza (startAt — Pełny powrót). */
    play(track, opts) {
      return player.play(track, opts);
    },
    /** Ustawia playlistę dla transportu (lista Utworów po filtrze Rocznika). */
    setPlaylist(tracks) {
      playlist = tracks ?? [];
    },
    get currentTrack() {
      return player.track;
    },
    /** Synchronizacja gwiazdek z optimistic/confirmed zapisem (bilety #8/#9). */
    setRating(key, rating, pending = false) {
      if (player.track?.key !== key) return;
      lastStarsRating = rating;
      starsCtl.setRating(rating);
      starsCtl.setPending(pending);
    },
    /** Synchronizacja BPM z optimistic/confirmed zapisem (bilet #13). */
    setBpm(key, bpm) {
      if (player.track?.key !== key) return;
      renderBpm(bpm);
    },
    /** Pełny powrót: odczyt store `session` → { trackKey, positionSec } lub null. */
    restore() {
      return loadSession(db);
    },
    dispose() {
      doc.removeEventListener("keydown", onKey);
      doc.defaultView?.removeEventListener("beforeunload", onBeforeUnload);
      flushPendingBpm(); // nie gub wystukanego tempa przy zamykaniu
      clearTapSession();
      player.pause();
      if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
      audioObjectUrl = null;
      host.innerHTML = "";
    },
  };
}
