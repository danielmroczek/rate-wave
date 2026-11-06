// Widok playera (bilet 06): przyklejony na dole wg prototypu
// .scratch/prototypes/player-ux/ — tytuł, gwiazdki (placeholder), transport
// (play/pause, następny/poprzedni), jeden duży waveform ze scrubbingiem
// (klik/drag) — typ placeholder, dopóki nie powstanie prawdziwy wave,
// obok aktualny czas.

import { createPlayer, loadSession } from "./player-state.js";
import { getTrackLink } from "../api/worker-proxy.js";

/** mm:ss (duration z preload=metadata — działa od startu, bez peaks). */
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Czy klucz Wake z eventów klawiatury trafia w pole tekstowe (nie przejmujemy skrótów). */
function isEditableTarget(e) {
  const t = /** @type {any} */ (e.target);
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

/**
 * Montuje player w `#player`. Zwraca API: play(track, opts), setPlaylist(tracks),
 * dispose(). `getLink` injectable (domyślnie READ-PROXY getTrackLink).
 *
 * @param {{ db: IDBDatabase, token?: string, hostname?: string, getLink?: (t: any) => Promise<any>,
 *   createAudio?: () => any, saveIntervalMs?: number, playerEl?: HTMLElement, doc?: Document,
 *   onTrackChange?: (t: any) => void }} opts
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
}) {
  const host = playerEl ?? doc.getElementById("player");
  if (!host) throw new Error("mountPlayer: #player not found");

  host.innerHTML = "";
  host.hidden = false;

  // ── struktura wg prototypu player-ux ────────────────────────
  const title = doc.createElement("div");
  title.id = "ptitle";
  title.textContent = "Nothing selected";

  const stars = doc.createElement("div");
  stars.id = "pstars";
  stars.className = "row-stars";
  stars.textContent = "☆☆☆☆☆";
  stars.title = "Rating — coming in a later ticket";

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
  transport.append(btnPrev, btnPlay, btnNext);

  host.append(title, stars, waveRow, transport, note);

  // ── stan: playlist do transportu N/P ────────────────────────
  let playlist = /** @type {any[]} */ ([]);

  const link = getLink ?? ((t) => getTrackLink({ token, hostname, fileid: t.fileid }));
  const player = createPlayer({
    db,
    getLink: link,
    ...(createAudio ? { createAudio } : {}),
    ...(saveIntervalMs !== undefined ? { saveIntervalMs } : {}),
    ...(onTrackChange ? { onTrackChange } : {}),
    onState(state) {
      title.textContent = state.track ? state.track.name : "Nothing selected";
      btnPlay.textContent = state.playing ? "⏸" : "▶";
      // Autoplay po przywróceniu sesji może być zablokowany — podświetl play,
      // żeby „po tapnięciu” Utwór wznowił się od zapisanej pozycji.
      btnPlay.classList.toggle("pulse", state.status === "autoplay-blocked");
      note.textContent =
        state.status === "autoplay-blocked"
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
  btnPrev.addEventListener("click", () => void player.step(playlist, -1));
  btnNext.addEventListener("click", () => void player.step(playlist, 1));

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
    /** Pełny powrót: odczyt store `session` → { trackKey, positionSec } lub null. */
    restore() {
      return loadSession(db);
    },
    dispose() {
      doc.removeEventListener("keydown", onKey);
      doc.defaultView?.removeEventListener("beforeunload", onBeforeUnload);
      player.pause();
      host.innerHTML = "";
    },
  };
}
