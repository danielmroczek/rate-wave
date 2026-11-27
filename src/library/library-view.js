// Widok biblioteki (bilet 04): drzewko Roczników po lewej (klik = filtr,
// „wszystkie" = reset, aktywny pełnym tłem, puste Roczniki widoczne) +
// windowed lista (bilet: ~30 rzędów, rAF, 60 FPS). Row: nazwa + placeholder
// gwiazdek + BPM slot + badge slot.

import { countUnrated, filterByRocznik } from "./listing.js";
import { WindowedList, ROW_HEIGHT } from "./windowing.js";
import { loadLibraryOrFetch, loadRatings } from "./library-controller.js";
import { loadLibrary, deleteLibrary } from "./library-cache.js";
import { createRootPicker } from "./root-picker.js";
import { createTagReadController } from "./tag-read-controller.js";
import { createRatingController, EMPTY_FLUSH_SUMMARY } from "../ratings/rating-controller.js";
import { createStarControl, setPendingDisplay, setStarDisplay } from "../ratings/star-control.js";
import { listPendingRatings, pendingRatingStars } from "../ratings/pending-ratings.js";
import { isEditableTarget } from "../ui/keyboard.js";
import { isValidBpm } from "../tags/bpm-value.js";
import { HEAD_BATCH_CAP } from "../api/proxy-batch.js";
import { get, put, putMany, saveSetting, STORES } from "../store/db.js";
import { loadSession } from "../player/player-state.js";
import {
  DEFAULT_SORT_MODE,
  isSortMode,
  nextUnrated,
  searchFilter,
  SORT_COLUMNS,
  sortTracks,
  toggleSortMode,
} from "./filter-sort.js";

/** Widok biblioteki zamontowany. */
let mounted = false;

/** Biblioteki do tej granicy backfillują „bezpośrednio" (bez restForBackfill). */
const DIRECT_BACKFILL_LIMIT = 50;

/** Aktywny kontroler odczytu tagów (do posprzątania przy unmount). */
let tagControllerRef = /** @type {ReturnType<typeof createTagReadController> | null} */ (null);

/** Listener skrótów 1–5/0 (sprzątany przy unmount). */
let ratingKeyHandlerRef = /** @type {((e: KeyboardEvent) => void) | null} */ (null);

/** Timer szukajki (bilet 12; sprzątany przy unmount). */
let searchDebounceRef = /** @type {any} */ (null);

/** Handler scrolla kółkiem nad paskiem Roczników (sprzątany przy unmount). */
let rocznikWheelRef = /** @type {any} */ (null);

/** Timer komunikatu o nieudanym zapisie. */
let ratingNoteTimer = /** @type {any} */ (null);

/** Timer odświeżenia sorta Tempo po doreadzie BPM (throttle). */
let tempoRefreshTimer = /** @type {any} */ (null);

/** Hak `window.flush` ustawiony przez bieżący mount (sprzątany przy unmount). */
let flushGlobalRef = /** @type {(() => Promise<any>) | null} */ (null);

/** Leniwy import cienkiego klienta fetch — produkcja nie wstrzykuje pcloudApi. */
async function resolveApi(/** @type {(o: any) => Promise<any> | undefined} */ injected) {
  if (injected) return injected;
  const { pcloudApi } = await import("../auth/pcloud-api.js");
  return pcloudApi;
}

/** @param {string | null | undefined} id */
function hasFolder(id) {
  return typeof id === "string" && id.length > 0;
}

/**
 * Callback błędów pickera/rebuild: wywołuje app-level `onError`, a komunikat
 * trafia na pasek `#picker-note` (tworzony w firstRootChoice) — albo nowy
 * wiersz na empty-state, gdy pasek nie istnieje (np. błąd rebuild z chipa).
 * @param {{ onError?: (e: Error) => void }} opts
 */
function makePickerErrorHandler({ onError }) {
  return (/** @type {Error} */ err) => {
    console.warn("[library] root picker failed", err);
    onError?.(err);
    let note = document.getElementById("picker-note");
    if (!note || !note.isConnected) {
      note = document.createElement("p");
      note.id = "picker-note";
      note.className = "hint";
      document.getElementById("empty-state")?.append(note);
    }
    note.textContent = `Could not reach pCloud: ${err?.message ?? err}`;
  };
}

/**
 * Pierwszy wybór roota na empty-state: „entire account" albo picker.
 * @param {{ emptyState: HTMLElement, pcloudApi: (o: any) => Promise<any>, token?: string, hostname?: string, onError?: (e: Error) => void }} opts
 * @returns {Promise<{ folderId: string, name: string | null } | null>}
 */
function firstRootChoice({ emptyState, pcloudApi, token, hostname, onError }) {
  return /** @type {Promise<{ folderId: string, name: string | null } | null>} */ (
    new Promise((resolve) => {
      emptyState.hidden = false;
      emptyState.innerHTML = "";
      const t = document.createElement("p");
      t.append(
        Object.assign(document.createElement("strong"), {
          textContent: "Choose where your library lives.",
        }),
        document.createTextNode(" Default: your entire pCloud account."),
      );
      const wrap = document.createElement("p");
      const note = document.createElement("p");
      note.id = "picker-note";
      note.className = "hint";
      const btnAll = document.createElement("button");
      btnAll.type = "button";
      btnAll.className = "btn";
      btnAll.textContent = "Use entire account";
      btnAll.addEventListener("click", () => resolve({ folderId: "0", name: null }));
      const btnPick = document.createElement("button");
      btnPick.type = "button";
      btnPick.className = "btn ghost";
      btnPick.textContent = "Choose folder…";
      let settled = false;
      const pickerHandler = makePickerErrorHandler({ onError });
      btnPick.addEventListener("click", async () => {
        try {
          const choice = await openRootDialog({
            pcloudApi,
            token,
            hostname,
            onError: pickerHandler,
          });
          if (!settled) resolve(choice);
        } catch (e) {
          // Ostateczność (dialog nie powinien rzucać — fail() go zdejmuje):
          // nie zostawiaj wiszącego Promise.
          pickerHandler(/** @type {Error} */ (e));
          if (!settled) resolve(null);
        }
      });
      wrap.append(btnAll, btnPick);
      emptyState.append(t, wrap, note);
    })
  );
}

/**
 * Dialog wyboru folderu głównego (bilet #17): nawigacja poziomami, breadcrumb,
 * „Use this folder" (bieżący poziom) / Cancel. Zwraca `{ folderId, name }` lub null.
 * Błąd API (offline, 401, wynik ≠ 0) → dialog jest zdejmowany, choice=null;
 * `onError` (gdy przekazany) informuje użytkownika zamiast cichego zawieszenia.
 * @param {{ pcloudApi: (o: any) => Promise<any>, token?: string, hostname?: string, onError?: (e: Error) => void }} opts
 */
function openRootDialog({ pcloudApi, token, hostname, onError }) {
  return /** @type {Promise<{ folderId: string, name: string | null } | null>} */ (
    new Promise((resolve) => {
      const dlg = document.createElement("dialog");
      dlg.id = "dlg-root-picker";
      const h = document.createElement("h2");
      h.textContent = "Choose root folder";
      const crumb = document.createElement("p");
      crumb.className = "hint";
      const list = document.createElement("div");
      const footer = document.createElement("div");
      footer.id = "root-picker-footer";

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn ghost";
      cancel.textContent = "Cancel";
      const up = document.createElement("button");
      up.type = "button";
      up.className = "btn ghost";
      up.textContent = "↑ Up";
      const select = document.createElement("button");
      select.type = "button";
      select.className = "btn";
      select.textContent = "Use this folder";
      footer.append(cancel, up, select);
      dlg.append(h, crumb, list, footer);
      document.body.append(dlg);

      const picker = createRootPicker({ pcloudApi, token, hostname });
      /** @type {{ folderid: string, path: { folderid: number, name: string }[], folders: { folderid: number, name: string }[] } | undefined} */
      let level;
      let resolved = false;

      function done(/** @type {{ folderId: string, name: string | null } | null} */ choice) {
        if (resolved) return;
        resolved = true;
        dlg.close();
        dlg.remove();
        resolve(choice);
      }
      /** Fail w dialogu: zdejmij UI, poinformuj, zakończ jako „anulowany". */
      function fail(/** @type {any} */ err) {
        onError?.(
          err instanceof Error ? err : new Error(String(err?.message ?? err), { cause: err }),
        );
        done(null);
      }
      cancel.addEventListener("click", () => done(null));
      dlg.addEventListener("cancel", () => done(null));
      up.addEventListener("click", async () => {
        try {
          level = await picker.up();
          render();
        } catch (err) {
          fail(err);
        }
      });
      select.addEventListener("click", () => {
        const name = level && level.path.length ? level.path[level.path.length - 1].name : null;
        done({ folderId: level?.folderid ?? "0", name });
      });

      function render() {
        crumb.textContent = `Root${level?.path.length ? " / " + level.path.map((s) => s.name).join(" / ") : " (entire account)"}`;
        up.disabled = (level?.path.length ?? 0) === 0;
        list.innerHTML = "";
        for (const f of level?.folders ?? []) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "rocznik-btn";
          btn.textContent = f.name;
          btn.addEventListener("click", async () => {
            try {
              level = await picker.enter(f);
              render();
            } catch (err) {
              fail(err);
            }
          });
          list.append(btn);
        }
      }

      picker.open().then(
        (l) => {
          level = l;
          render();
          dlg.showModal();
        },
        (err) => fail(err),
      );
    })
  );
}

/**
 * Montuje widok biblioteki w #viewport. Bezpieczny wielokrotny (reconnect).
 *
 * @param {{ db: IDBDatabase, token?: string, hostname?: string, pcloudApi?: (o: any) => Promise<any>, folderId?: string | null, folderName?: string | null, onError?: (e: Error) => void,
 *   onRatingChange?: (key: string, state: { rating: number | null, pending: boolean, error?: Error }) => void,
 *   ratingIO?: { fetchBytes?: (o: any) => Promise<Uint8Array>, statFile?: (o: any) => Promise<any>, upload?: (o: any) => Promise<any>, now?: () => number } }} opts
 */
export async function mountLibraryView({
  db,
  token,
  hostname,
  pcloudApi,
  folderId: storedFolderId,
  folderName: storedFolderName,
  onPlay,
  onPlaylist,
  onError,
  onRatingChange,
  onBpmChange,
  ratingIO,
}) {
  if (mounted) return;
  const emptyState = document.getElementById("empty-state");
  const count = document.getElementById("count");
  if (!emptyState || !count) return;
  mounted = true;

  // ── pierwszy wybór roota (bilet #17): wymagany, domyślnie całe konto; ──
  // pomijany gdy cache istnieje albo root już zapisany w sources.
  /** @type {string} */
  let folderId = hasFolder(storedFolderId) ? /** @type {string} */ (storedFolderId) : "0";
  /** @type {string | null} */
  let rootName = storedFolderName ?? null;
  const hasCache = Boolean((await loadLibrary(db))?.fingerprint);
  const api = await resolveApi(pcloudApi);
  if (!hasCache && !hasFolder(storedFolderId)) {
    const choice = await firstRootChoice({
      emptyState,
      pcloudApi: api,
      token,
      hostname,
      onError: makePickerErrorHandler({ onError }),
    });
    if (choice) {
      folderId = choice.folderId;
      rootName = choice.name;
    }
  }

  // ── stan ładowania: cache-miss oznacza listing(y), UI pokazuje postęp ──
  const loadingText = document.createElement("p");
  const onProgress = (/** @type {{ loaded: number, total: number, name?: string }} */ p) => {
    if (loadingText.isConnected) {
      loadingText.textContent =
        p.total > 0
          ? `Loading your library… ${p.loaded}/${p.total} (${p.name ?? "…"})`
          : "Loading your library… fetching folder list…";
    }
  };
  function showLoading(/** @type {string} */ msg) {
    emptyState.hidden = false;
    emptyState.innerHTML = "";
    loadingText.textContent = msg;
    emptyState.append(loadingText);
  }
  function showError(/** @type {any} */ err) {
    emptyState.hidden = false;
    emptyState.innerHTML = "";
    const h = document.createElement("p");
    h.append(
      Object.assign(document.createElement("strong"), { textContent: "Failed to load library" }),
    );
    const detail = document.createElement("p");
    detail.textContent = String(err?.message ?? err);
    emptyState.append(h, detail);
  }

  /** @type {import("./listing.js").Library} */
  let library;
  try {
    showLoading("Loading your library…");
    ({ library } = await loadLibraryOrFetch({
      db,
      token,
      hostname,
      pcloudApi: api,
      folderId,
      onProgress,
    }));
  } catch (err) {
    mounted = false;
    console.warn("[library] load failed", err);
    showError(err);
    onError?.(err instanceof Error ? err : new Error(String(err?.message ?? err), { cause: err }));
    throw err;
  }

  // folderName pomocniczy do sources (controller persistuje folderId)
  try {
    const row = await get(db, STORES.SOURCES, "pcloud");
    if (row && row.folderName !== (rootName ?? null)) {
      row.folderName = rootName ?? null;
      await put(db, STORES.SOURCES, "pcloud", row);
    }
  } catch {
    /* brak nazwy nie blokuje */
  }

  /** @type {Map<string, any>} */
  const ratings = await loadRatings(db);

  // Kolejka ocen z poprzedniej sesji (bilet #9): gwiazdki od razu, ale z ⏳
  // aż do potwierdzenia flushu (kolejność wg createdAt pilnuje kontroler).
  /** @type {Set<string>} */
  const pendingKeys = new Set();
  /** @type {Array<{store: string, key: IDBValidKey, value: any}>} */
  const pendingEntries = [];
  for (const rec of await listPendingRatings(db)) {
    pendingKeys.add(rec.key);
    const merged = {
      ...ratings.get(rec.key),
      rating: pendingRatingStars(rec),
      pendingUpload: true,
    };
    ratings.set(rec.key, merged);
    pendingEntries.push({ store: STORES.TRACKS, key: rec.key, value: merged });
  }
  // Cache ocen w IDB też widzi stan kolejki (§7: natychmiastowa aktualizacja).
  if (pendingEntries.length) await putMany(db, pendingEntries);

  // ── odczyt tagów lazy (bilet #7): gwiazdki widocznych przez batchowy /head ──
  /** @type {ReturnType<typeof createTagReadController> | null} */
  let tagController = null;
  function makeTagController() {
    const c = createTagReadController({
      db,
      token: /** @type {string} */ (token),
      tracks: library.tracks,
      ratings,
      onTagsRead: (key, rec) => {
        // Kolejka ma pierwszeństwo nad tagiem z pliku do czasu potwierdzenia (⏳).
        if (pendingKeys.has(key)) {
          ratings.set(key, { ...rec, rating: getRating(key), pendingUpload: true });
        } else {
          ratings.set(key, rec);
        }
        refreshRowStars(key);
        refreshRowBpm(key);
        // Tag read może odkryć BPM — player pokazuje wartość dla bieżącego Utworu.
        onBpmChange?.(key, { bpm: getBpm(key), pending: false });
        updateCounter();
        scheduleTempoUpdate();
      },
    });
    tagControllerRef = c;
    return c;
  }
  if (token) tagController = makeTagController();

  // ── zapis oceny (bilet #8): optimistic + serializowany upload ──
  /** @type {ReturnType<typeof createRatingController> | null} */
  let ratingController = null;
  function makeRatingController() {
    if (!token) return null;
    return createRatingController({
      db,
      token,
      hostname,
      tracks: library.tracks,
      ratings,
      onChange: (key, state) => {
        if (state.pending) pendingKeys.add(key);
        else pendingKeys.delete(key);
        refreshRowStars(key);
        refreshRowBpm(key);
        updateCounter();
        onRatingChange?.(key, state);
        if (state.error) showRatingError(state.error);
        else if (state.info) showRatingNote(state.info);
        else if (state.queued) showRatingNote("Rating queued — will retry when online.");
      },
      onBpmChange: (key, state) => {
        refreshRowBpm(key);
        scheduleTempoUpdate();
        onBpmChange?.(key, state);
        if (state.error) showRatingNote(`Tempo not saved: ${state.error.message}`);
      },
      fetchBytes: ratingIO?.fetchBytes,
      statFile: ratingIO?.statFile,
      upload: ratingIO?.upload,
      now: ratingIO?.now,
    });
  }
  ratingController = makeRatingController();

  const ratingNote = document.createElement("span");
  ratingNote.id = "rating-note";
  ratingNote.className = "hint";
  ratingNote.setAttribute("role", "status");
  ratingNote.hidden = true;
  document.getElementById("count")?.after(ratingNote);

  /** @param {string} text */
  function showRatingNote(text) {
    ratingNote.textContent = text;
    ratingNote.hidden = false;
    if (ratingNoteTimer) clearTimeout(ratingNoteTimer);
    ratingNoteTimer = setTimeout(() => {
      ratingNote.hidden = true;
    }, 6000);
  }

  /** @param {Error} err */
  function showRatingError(err) {
    showRatingNote(`Rating not saved: ${err.message}`);
  }

  /** Aktualnie aktywny Rocznik (null = „wszystkie"). */
  let rocznik = /** @type {string | null} */ (null);

  // ── layout: sidebar Roczników + lista windowed ─────────────
  emptyState.hidden = true;

  const layout = document.createElement("div");
  layout.id = "library-layout";

  const sidebar = document.createElement("nav");
  sidebar.id = "roczniki";
  sidebar.setAttribute("aria-label", "Years");

  // Scroll kółkiem myszy nad poziomym paskiem Roczników (mobile) –
  // przekształcamy pionowy obrót kółka w poziomy scroll (bilet 12).
  const rocznikWheel = (e) => {
    if (e.deltaY === 0) return;
    // Przechwytujemy tylko gdy pasek faktycznie przewija się w poziomie.
    if (sidebar.scrollWidth <= sidebar.clientWidth) return;
    const atStart = sidebar.scrollLeft <= 0;
    const atEnd = sidebar.scrollLeft >= sidebar.scrollWidth - sidebar.clientWidth - 1;
    const dir = e.deltaY > 0 ? 1 : -1;
    // Na krańcach paska umożliwimy zdarzenie przejść dalej (np. na listę plików).
    if ((dir > 0 && atEnd) || (dir < 0 && atStart)) return;
    e.preventDefault();
    sidebar.scrollLeft += e.deltaY;
  };
  sidebar.addEventListener("wheel", rocznikWheel, { passive: false });
  rocznikWheelRef = { el: sidebar, fn: rocznikWheel };

  const listViewport = document.createElement("div");
  listViewport.id = "track-list";
  listViewport.tabIndex = 0;

  // Nagłówek kolumn sortowalnych nad listą (bilet 12, §5d): klik = sort.
  const listHeader = document.createElement("div");
  listHeader.id = "list-header";

  const listWrapper = document.createElement("div");
  listWrapper.id = "list-wrapper";
  listWrapper.append(listHeader, listViewport);

  layout.append(sidebar, listWrapper);
  const viewportHost = document.getElementById("viewport");
  viewportHost?.append(layout);
  viewportHost?.classList.add("viewport-library");
  const list = new WindowedList({
    viewport: listViewport,
    rowHeight: ROW_HEIGHT,
    renderRow: ({ index }) => renderTrackRow(filtered[index]),
    onVisibleChange: ({ first, last }) => {
      if (!tagController) return;
      // Widoczne = okno ±1 batch (plan biletu #7, bez IntersectionObserver per wiersz).
      const from = Math.max(0, first - HEAD_BATCH_CAP);
      const to = Math.min(filtered.length, last + HEAD_BATCH_CAP);
      const windowTracks = filtered.slice(from, to);
      tagController.setVisibleTracks(windowTracks);
      // Backfill: brak visible-pending → reszta biblioteki w tle (idle kolejka;
      // mała biblioteka jedzie bezpośrednio).
      if (filtered.length > DIRECT_BACKFILL_LIMIT) {
        tagController.enqueueIdle(restForBackfill());
      } else {
        const windowSet = new Set(windowTracks);
        tagController.enqueueIdle(filtered.filter((t) => !windowSet.has(t)));
      }
      tagController.onVisibleSettled();
    },
  });

  listViewport.addEventListener("scroll", () => tagController?.onScrollActive(), {
    passive: true,
  });

  // ── strzałki + Enter na liście (bilet 12, spec §5c) ────────────
  /** Aktualny indeks wiersza w fokusie (klawiatura); null = brak fokusu. */
  let focusIndex = /** @type {number | null} */ (null);

  listViewport.addEventListener("keydown", (e) => {
    if (isEditableTarget(e)) return;
    const N = filtered.length;
    if (!N) return;
    const k = e.key;
    if (k !== "ArrowDown" && k !== "ArrowUp" && k !== "Home" && k !== "End" && k !== "Enter")
      return;
    e.preventDefault();
    let i = focusIndex;
    if (i == null) {
      const si = filtered.findIndex((t) => t.key === selectedKey);
      i = si >= 0 ? si : 0;
    }
    if (k === "ArrowDown") i = Math.min(N - 1, i + 1);
    else if (k === "ArrowUp") i = Math.max(0, i - 1);
    else if (k === "Home") i = 0;
    else if (k === "End") i = N - 1;
    focusIndex = i;
    focusRowByIndex(i);
    if (k === "Enter") selectTrack(filtered[i]);
  });

  /** Fokusuje (i scrolluje do) wiersz o indeksie `i` na liście. */
  function focusRowByIndex(i) {
    const key = filtered[i]?.key;
    if (!key) return;
    let el = listViewport.querySelector(`.track-row[data-key="${key}"]`);
    if (!el) {
      // wiersz poza oknem windowingu — najpierw scroll
      const vpH = listViewport.clientHeight || 1;
      listViewport.scrollTop = Math.max(0, i * ROW_HEIGHT - vpH / 2 + ROW_HEIGHT / 2);
      list.update();
      el = listViewport.querySelector(`.track-row[data-key="${key}"]`);
    }
    if (el) {
      el.focus();
      const vpH = listViewport.clientHeight || 1;
      const top = i * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT;
      if (top < listViewport.scrollTop || bottom > listViewport.scrollTop + vpH) {
        listViewport.scrollTop = Math.max(0, top - vpH / 2 + ROW_HEIGHT / 2);
        list.update();
      }
    }
  }

  /** Tracki jeszcze nie przeczytane (status != done) — do idle kolejki. */
  function restForBackfill() {
    return filtered.filter((t) => {
      const rec = ratings.get(t.key);
      return !(rec && rec.tagsReadAt != null);
    });
  }

  /**
   * Formatuje znacznik czasu na krótki opis względny („5 min”, „3 dni”).
   * @param {number | null | undefined} ts — ms epoch albo null/undefined
   */
  function relativeTime(ts) {
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
    const diff = Date.now() - ts;
    if (diff < 60000) return "teraz";
    const min = Math.floor(diff / 60000);
    if (min < 60) return `${min} min`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs} godz.`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days} dni`;
    const wks = Math.floor(days / 7);
    if (wks < 5) return `${wks} tyg.`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} mies.`;
    return `${Math.floor(days / 365)} lat`;
  }

  /** Aktualnie zaznaczony Utwór (podświetlenie `.sel` na liście). */
  let selectedKey = /** @type {string | null} */ (null);

  function renderTrackRow(track) {
    const row = document.createElement("div");
    row.className = "list-row track-row";
    if (track.key === selectedKey) row.classList.add("sel");
    row.dataset.key = track.key;
    // wiersz focusowalny programowo (strzałki na liście, §5c)
    row.tabIndex = -1;

    const name = document.createElement("span");
    name.className = "row-name col-name";
    name.textContent = track.name;
    name.title = track.name;

    const stars = createStarControl({ onRate: (n) => rateKey(track.key, n) }).element;
    stars.classList.add("col-rating");
    applyRowStars(stars, track.key);

    const bpm = document.createElement("span");
    bpm.className = "row-bpm slot col-tempo";
    applyRowBpm(bpm, track.key);

    const lastPlayed = document.createElement("span");
    lastPlayed.className = "row-last slot col-played";
    lastPlayed.textContent = relativeTime(ratings.get(track.key)?.lastPlayed);

    // Klik/tap wiersza wybiera Utwór i od razu odtwarza (bilet 06).
    row.addEventListener("click", () => selectTrack(track));

    row.append(name, stars, bpm, lastPlayed);
    return row;
  }

  function updateSelectionClasses() {
    for (const el of listViewport.querySelectorAll(".track-row")) {
      el.classList.toggle("sel", el.dataset.key === selectedKey);
    }
  }

  /** Gwiazdki wiersza wg cache `tracks`: ocena → ★; przed odczytem/bez oceny → outline (placeholder §2b). */
  function applyRowStars(/** @type {HTMLElement} */ el, /** @type {string} */ key) {
    const rec = ratings.get(key);
    const rating = rec && typeof rec.rating === "number" ? rec.rating : null;
    setStarDisplay(el, rating);
    el.classList.toggle("pending", !rating);
    setPendingDisplay(el, pendingKeys.has(key));
  }

  /** Odświeża gwiazdki widocznego wiersza po odczycie tagów (bilet #7). */
  function refreshRowStars(/** @type {string} */ key) {
    for (const el of listViewport.querySelectorAll(".track-row")) {
      if (el.dataset.key !== key) continue;
      const stars = el.querySelector(".row-stars");
      if (stars) applyRowStars(/** @type {HTMLElement} */ (stars), key);
    }
  }

  /** BPM wiersza z cache `tracks` (bilet 13); brak = pusta komórka. */
  function applyRowBpm(/** @type {HTMLElement} */ el, /** @type {string} */ key) {
    const bpm = ratings.get(key)?.bpm;
    const value = isValidBpm(bpm) ? bpm : null;
    el.textContent = value == null ? "" : String(value);
    el.title = value == null ? "" : `${value} BPM`;
  }

  /** Odświeża komórkę BPM widocznego wiersza (po odczycie tagów / zapisie). */
  function refreshRowBpm(/** @type {string} */ key) {
    for (const el of listViewport.querySelectorAll(".track-row")) {
      if (el.dataset.key !== key) continue;
      const cell = el.querySelector(".row-bpm");
      if (cell) applyRowBpm(/** @type {HTMLElement} */ (cell), key);
    }
  }

  /**
   * Zaznacza wiersz na liście i (jeśli `onPlay`) od razu odtwarza Utwór.
   * @param {import("./listing.js").LibraryTrack} track
   * @param {{ startAt?: number, autoplay?: boolean }} [playOpts]
   */
  function selectTrack(track, playOpts) {
    selectedKey = track.key;
    focusIndex = Math.max(
      0,
      filtered.findIndex((t) => t.key === track.key),
    );
    updateSelectionClasses();
    if (onPlay) onPlay(track, playOpts);
    touchLastPlayed(track.key);
  }

  /**
   * Play zaczął się dla `key` → odśwież lastPlayed w mapie rekordów i (dla
   * sorta „recent”) przenieś Utwór na górę.
   */
  function touchLastPlayed(key) {
    const rec = ratings.get(key);
    if (rec) rec.lastPlayed = Date.now();
    refreshRowLastPlayed(key);
    if (["recent", "recent-desc", "recent-asc"].includes(sortMode)) update();
  }

  /** Odświeża komórkę „Słuchane” widocznego wiersza po zmianie lastPlayed. */
  function refreshRowLastPlayed(key) {
    for (const el of listViewport.querySelectorAll(".track-row")) {
      if (el.dataset.key !== key) continue;
      const cell = el.querySelector(".row-last");
      if (cell) cell.textContent = relativeTime(ratings.get(key)?.lastPlayed);
    }
  }

  /**
   * Ocena Utworu (1–5 albo null = usuń). Optimistic aktualizuje mapę i DOM
   * synchronicznie; upload idzie w tle, po kolei (bilet #8).
   * @param {string} key
   * @param {1|2|3|4|5|null} stars
   * @returns {boolean}
   */
  function rateKey(key, stars) {
    const track = library.tracks.find((t) => t.key === key);
    if (!track) return false;
    if (!ratingController) {
      showRatingError(new Error("not connected to pCloud"));
      return false;
    }
    try {
      ratingController.rate(track, stars);
      return true;
    } catch (err) {
      showRatingError(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  /** Aktualna ocena (optimistic) dla Utworu — player synchronizuje z tego. */
  function getRating(key) {
    const rec = ratings.get(key);
    return rec && typeof rec.rating === "number" ? rec.rating : null;
  }

  /** BPM z cache (bilet 13) — player pokazuje wartość dla bieżącego Utworu. */
  function getBpm(key) {
    const rec = ratings.get(key);
    return isValidBpm(rec?.bpm) ? rec.bpm : null;
  }

  /**
   * Zapis BPM wystukanego w playerze (bilet 13) — tym samym przepływem co Ocena.
   * @param {string} key
   * @param {number} bpm
   * @returns {boolean}
   */
  function setBpm(key, bpm) {
    const track = library.tracks.find((t) => t.key === key);
    if (!track) return false;
    if (!ratingController) {
      showRatingError(new Error("not connected to pCloud"));
      return false;
    }
    try {
      ratingController.setBpm(track, bpm);
      return true;
    } catch (err) {
      showRatingError(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  /** Czy Ocena czeka w `pending-ratings` (⏳ w wierszu i w playerze). */
  function isPending(key) {
    return pendingKeys.has(key);
  }

  /** Ręczny/dev flush kolejki; w produkcji też start aplikacji i udany zapis online. */
  function flush() {
    return ratingController ? ratingController.flush() : Promise.resolve(EMPTY_FLUSH_SUMMARY);
  }

  /** Skróty 1–5 (ocena) i 0 (usuń) — dotyczą zaznaczonego Utworu (spec §5c). */
  function onRatingKey(e) {
    if (e.repeat || isEditableTarget(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!/^[0-5]$/.test(e.key) || !selectedKey) return;
    e.preventDefault();
    rateKey(selectedKey, e.key === "0" ? null : /** @type {1|2|3|4|5} */ (Number(e.key)));
  }
  document.addEventListener("keydown", onRatingKey);
  ratingKeyHandlerRef = onRatingKey;

  let filtered = /** @type {import("./listing.js").LibraryTrack[]} */ (library.tracks);

  // ── sort/szukajka (bilet 12, spec §5d/§5e) ────────────────────
  /** Aktualny tryb sortowania (name-asc default, §5d). */
  let sortMode = DEFAULT_SORT_MODE;
  /** Treść szukajki (substring po nazwie pliku, §5e). */
  let searchQuery = "";
  /** Debounce szukajki (~200 ms). */
  let searchDebounce = /** @type {any} */ (null);

  // Zapamiętane per urządzenie ustawienia paska (store `settings`, spec §4a).
  const savedBar = (await get(db, STORES.SETTINGS, "library-bar").catch(() => null)) ?? null;
  if (savedBar) {
    // legacy „recent" z wcześniejszych sesji → „recent-desc"
    const saved = savedBar.sort === "recent" ? "recent-desc" : savedBar.sort;
    if (isSortMode(saved)) sortMode = saved;
    if (typeof savedBar.search === "string") searchQuery = savedBar.search;
  }

  /** Zapisuje sort + szukajkę per urządzenie (store `settings`). */
  function persistBar() {
    saveSetting(db, "library-bar", { sort: sortMode, search: searchQuery }).catch(() => {});
  }

  /**
   * Synchronizacja player → lista (bilet 06): podświetla wiersz key (i dociąga
   * go do widoku). Gdy Utwór jest poza aktywnym filtrem Rocznika — reset filtra
   * na „All", żeby zaznaczenie było widoczne.
   * @param {string} key
   * @returns {boolean} true, gdy Utwór istnieje w bibliotece i zaznaczono
   */
  function selectKey(key) {
    const track = library.tracks.find((t) => t.key === key);
    if (!track) return false;
    if (!filtered.some((t) => t.key === key)) {
      rocznik = null;
      renderSidebar();
      update(); // setRows → scrollTop=0, kolejny scrollTo i tak ustawi
    }
    selectedKey = key;
    list.update();
    updateSelectionClasses();
    const idx = filtered.findIndex((t) => t.key === key);
    if (idx >= 0) {
      const vpH = listViewport.clientHeight || 1;
      const top = idx * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT;
      if (top < listViewport.scrollTop || bottom > listViewport.scrollTop + vpH) {
        listViewport.scrollTop = Math.max(0, top - vpH / 2 + ROW_HEIGHT / 2);
        list.update();
      }
    }
    return true;
  }

  function filteredTracks() {
    const byRocznik = filterByRocznik(library.tracks, rocznik);
    return searchFilter(byRocznik, searchQuery);
  }

  function updateCounter() {
    const unrated = countUnrated(filtered, ratings);
    count.textContent = `${filtered.length} pozycji … ${unrated} bez oceny`;
  }

  function renderSidebar() {
    sidebar.innerHTML = "";

    const all = document.createElement("button");
    all.type = "button";
    all.className = "rocznik-btn";
    all.dataset.rocznik = "__all__";
    all.textContent = "All";
    all.addEventListener("click", () => {
      rocznik = null;
      update();
    });
    sidebar.append(all);

    for (const r of library.roczniki) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "rocznik-btn";
      el.dataset.rocznik = r.name;
      el.textContent = `${r.name} (${r.count})`;
      el.addEventListener("click", () => {
        rocznik = r.name;
        update();
      });
      sidebar.append(el);
    }
  }

  /** Nagłówki kolumn sortowalnych (§5d): klik = sort po kolumnie. */
  function renderHeader() {
    listHeader.innerHTML = "";
    for (const col of SORT_COLUMNS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `col-sort col-${col.id}`;
      btn.dataset.col = col.id;
      btn.textContent = col.label;
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      btn.append(arrow);
      btn.addEventListener("click", () => {
        // klik w nieaktywną kolumnę → domyślny kierunek; w aktywną → toggle
        const active = col.modes.includes(sortMode);
        sortMode = active ? toggleSortMode(sortMode) : col.modes[0];
        persistBar();
        update();
      });
      listHeader.append(btn);
    }
  }

  /** Odświeża strzałki i aria-sort w nagłówkach po zmianie sortMode. */
  function updateHeader() {
    for (const btn of listHeader.querySelectorAll(".col-sort")) {
      const col = SORT_COLUMNS.find((c) => c.id === btn.dataset.col);
      const active = col.modes.includes(sortMode);
      const dir = sortMode.endsWith("-asc") ? "↑" : "↓";
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-sort", active ? (dir === "↑" ? "ascending" : "descending") : "none");
      const arrow = btn.querySelector(".sort-arrow");
      if (arrow) arrow.textContent = active ? dir : "";
    }
  }

  /**
   * Po doreadzie BPM lista w trybie Tempo musi się przestawić; batchowy odczyt
   * tagów dostarcza wartości seriami, więc odświeżamy rzadko (throttle 200 ms).
   */
  function scheduleTempoUpdate() {
    if (sortMode !== "tempo-asc" && sortMode !== "tempo-desc") return;
    if (tempoRefreshTimer) return;
    tempoRefreshTimer = setTimeout(() => {
      tempoRefreshTimer = null;
      update();
    }, 200);
  }

  function update() {
    filtered = sortTracks(filteredTracks(), sortMode, ratings);
    focusIndex = null; // sort/szukajka przestawiły listę — fokus klawiatury resetujemy
    list.setRows(filtered.length);
    updateCounter();
    updateHeader();
    onPlaylist?.(filtered);

    // hierarchia tłem: aktywny Rocznik pełnym tłem
    for (const el of sidebar.querySelectorAll(".rocznik-btn")) {
      const active = (el.dataset.rocznik === "__all__" ? null : el.dataset.rocznik) === rocznik;
      el.classList.toggle("active", active);
      el.setAttribute("aria-pressed", String(active));
    }
  }

  // ── chip „Root: …" w toolbarze; klik → picker; zmiana → rebuild (bilet #17) ──
  const chip = document.createElement("button");
  chip.type = "button";
  chip.id = "btn-root";
  chip.className = "btn ghost";
  chip.setAttribute("aria-label", "Change the root folder of your library");
  chip.textContent = `Root: ${rootName ?? "All files"}`;
  document.getElementById("toolbar")?.prepend(chip);

  chip.addEventListener("click", async () => {
    const previousFolderId = folderId;
    const previousName = rootName;
    const choice = await openRootDialog({
      pcloudApi: api,
      token,
      hostname,
      onError: makePickerErrorHandler({ onError }),
    });
    if (!mounted || !choice) return;
    chip.disabled = true;
    await deleteLibrary(db); // pojedynczy wpis cache — zmiana roota nadpisuje (Q7)
    folderId = choice.folderId;
    rootName = choice.name;
    chip.textContent = `Root: ${rootName ?? "All files"}`;
    try {
      showLoading("Loading your library…");
      viewportHost?.classList.remove("viewport-library");
      ({ library } = await loadLibraryOrFetch({
        db,
        token,
        hostname,
        pcloudApi: api,
        folderId,
        onProgress,
      }));
      rocznik = null;
      tagController?.destroy();
      tagController = null;
      makeTagController();
      ratingController = makeRatingController();
      renderSidebar();
      update();
      emptyState.hidden = true;
      viewportHost?.classList.add("viewport-library");
      // folderName po przebudowie — sources jest jedynym źródłem nazwy roota
      // przy kolejnym boocie (folderId persistuje controller; bilet #17 review).
      try {
        const row = (await get(db, STORES.SOURCES, "pcloud")) ?? {};
        const next = rootName ?? null;
        if (row.folderName !== next) {
          row.folderName = next;
          await put(db, STORES.SOURCES, "pcloud", row);
        }
      } catch {
        /* brak nazwy nie blokuje */
      }
    } catch (err) {
      console.warn("[library] rebuild failed", err);
      showError(err);
      onError?.(
        err instanceof Error ? err : new Error(String(err?.message ?? err), { cause: err }),
      );
      // Przywróć poprzedni widok — zmiana roota się nie dokonała.
      viewportHost?.classList.add("viewport-library");
      chip.textContent = `Root: ${previousName ?? "All files"}`;
      rootName = previousName;
      folderId = previousFolderId;
    } finally {
      if (mounted) chip.disabled = false;
    }
  });

  renderSidebar();
  renderHeader();
  update();

  const searchInput = document.getElementById("q");
  if (searchInput) {
    searchInput.value = searchQuery;
    searchInput.disabled = false;
    searchInput.addEventListener("input", () => {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        searchQuery = searchInput.value;
        persistBar();
        update();
      }, 200);
      searchDebounceRef = searchDebounce;
    });
  }

  // ── Pełny powrót sesji (bilet 06): store `session` → ostatni Utwór + pozycja.
  // Degradacja: Utwór zniknął z biblioteki → tylko zaznaczenie listy (pierwszy
  // wiersz, bez odtwarzania); pusta biblioteka → brak zaznaczenia.
  try {
    const sess = await loadSession(db);
    const sessKey = sess?.trackKey;
    if (typeof sessKey === "string" && sessKey) {
      const last = library.tracks.find((t) => t.key === sessKey) ?? null;
      if (last) {
        selectTrack(last, { startAt: Number(sess?.positionSec) || 0 });
      } else if (library.tracks.length > 0) {
        selectedKey = library.tracks[0].key;
        updateSelectionClasses();
        console.info(`[library] session track ${sessKey} gone — selected first row only`);
      } else {
        console.info("[library] empty library — no selection");
      }
    }
  } catch (err) {
    console.warn("[library] session restore failed", err);
  }

  // Flush kolejki przy starcie aplikacji (spec §7) + ręczny hak `window.flush`
  // dla dev/testów. Bilet 13 dokłada tu tylko detektory sieci i Background Sync.
  /** @type {any} */ (globalThis).flush = flush;
  flushGlobalRef = flush;
  void flush().catch(() => {});

  /** Następny nieoceniony Utwór na bieżącej liście („→ ☆”/`U`, spec §5b). */
  function playNextUnrated() {
    const next = nextUnrated(filtered, ratings, selectedKey);
    if (!next) return false;
    selectTrack(next);
    return true;
  }

  return {
    selectKey, // sync player → lista (transport N/P, bilet 06)
    /** Ocena Utworu z playera/skrótów (optimistic, bilet #8). */
    rate: rateKey,
    /** Ocena z cache w pamięci (player wyświetla gwiazdki). */
    getRating,
    /** BPM z cache (player wyświetla tempo). */
    getBpm,
    /** Zapis BPM z TAP-a (bilet 13). */
    setBpm,
    /** Czy Ocena czeka w kolejce (⏳, bilet #9). */
    isPending,
    /** Flush `pending-ratings` (bilet #9). */
    flush,
    /** Skok do następnego nieocenionego na bieżącej liście (→ ☆/U). */
    playNextUnrated,
  };
}

/** Demontuje widok biblioteki (reset danych / logout). */
export function unmountLibraryView() {
  tagControllerRef?.destroy();
  tagControllerRef = null;
  if (ratingKeyHandlerRef) document.removeEventListener("keydown", ratingKeyHandlerRef);
  ratingKeyHandlerRef = null;
  if (ratingNoteTimer) clearTimeout(ratingNoteTimer);
  ratingNoteTimer = null;
  if (tempoRefreshTimer) clearTimeout(tempoRefreshTimer);
  tempoRefreshTimer = null;
  if (searchDebounceRef) clearTimeout(searchDebounceRef);
  searchDebounceRef = null;
  if (rocznikWheelRef) {
    rocznikWheelRef.el.removeEventListener("wheel", rocznikWheelRef.fn);
    rocznikWheelRef = null;
  }
  if (flushGlobalRef && /** @type {any} */ (globalThis).flush === flushGlobalRef) {
    delete (/** @type {any} */ (globalThis).flush);
  }
  flushGlobalRef = null;
  document.getElementById("rating-note")?.remove();
  mounted = false;
  document.getElementById("library-layout")?.remove();
  document.getElementById("btn-root")?.remove();
  document.getElementById("viewport")?.classList.remove("viewport-library");
}
