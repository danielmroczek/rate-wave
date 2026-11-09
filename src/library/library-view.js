// Widok biblioteki (bilet 04): drzewko Roczników po lewej (klik = filtr,
// „wszystkie" = reset, aktywny pełnym tłem, puste Roczniki widoczne) +
// windowed lista (bilet: ~30 rzędów, rAF, 60 FPS). Row: nazwa + placeholder
// gwiazdek + BPM slot + badge slot.

import { filterByRocznik } from "./listing.js";
import { WindowedList, ROW_HEIGHT } from "./windowing.js";
import { loadLibraryOrFetch, loadRatings, makeCounter } from "./library-controller.js";
import { loadLibrary, deleteLibrary } from "./library-cache.js";
import { createRootPicker } from "./root-picker.js";
import { createTagReadController } from "./tag-read-controller.js";
import { HEAD_BATCH_CAP } from "../api/proxy-batch.js";
import { get, put, STORES } from "../store/db.js";
import { loadSession } from "../player/player-state.js";

/** Widok biblioteki zamontowany. */
let mounted = false;

/** Biblioteki do tej granicy backfillują „bezpośrednio" (bez restForBackfill). */
const DIRECT_BACKFILL_LIMIT = 50;

/** Aktywny kontroler odczytu tagów (do posprzątania przy unmount). */
let tagControllerRef = /** @type {ReturnType<typeof createTagReadController> | null} */ (null);

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
 * @param {{ db: IDBDatabase, token?: string, hostname?: string, pcloudApi?: (o: any) => Promise<any>, folderId?: string | null, folderName?: string | null, onError?: (e: Error) => void }} opts
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
        ratings.set(key, rec);
        refreshRowStars(key);
        updateCounter();
      },
    });
    tagControllerRef = c;
    return c;
  }
  if (token) tagController = makeTagController();

  /** Aktualnie aktywny Rocznik (null = „wszystkie"). */
  let rocznik = /** @type {string | null} */ (null);

  // ── layout: sidebar Roczników + lista windowed ─────────────
  emptyState.hidden = true;

  const layout = document.createElement("div");
  layout.id = "library-layout";

  const sidebar = document.createElement("nav");
  sidebar.id = "roczniki";
  sidebar.setAttribute("aria-label", "Years");

  const listViewport = document.createElement("div");
  listViewport.id = "track-list";
  listViewport.tabIndex = 0;

  layout.append(sidebar, listViewport);
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

  /** Tracki jeszcze nie przeczytane (status != done) — do idle kolejki. */
  function restForBackfill() {
    return filtered.filter((t) => {
      const rec = ratings.get(t.key);
      return !(rec && rec.tagsReadAt != null);
    });
  }

  /** Aktualnie zaznaczony Utwór (podświetlenie `.sel` na liście). */
  let selectedKey = /** @type {string | null} */ (null);

  function renderTrackRow(track) {
    const row = document.createElement("div");
    row.className = "list-row track-row";
    if (track.key === selectedKey) row.classList.add("sel");
    row.dataset.key = track.key;

    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = track.name;
    name.title = track.name;

    const stars = document.createElement("span");
    stars.className = "row-stars";
    applyRowStars(stars, track.key);

    const bpm = document.createElement("span");
    bpm.className = "row-bpm slot";

    const badge = document.createElement("span");
    badge.className = "row-badge slot";

    // Klik/tap wiersza wybiera Utwór i od razu odtwarza (bilet 06).
    row.addEventListener("click", () => selectTrack(track));

    row.append(name, stars, bpm, badge);
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
    el.textContent = rating ? "★".repeat(rating) + "☆".repeat(5 - rating) : "☆☆☆☆☆";
    el.classList.toggle("pending", !rating);
  }

  /** Odświeża gwiazdki widocznego wiersza po odczycie tagów (bilet #7). */
  function refreshRowStars(/** @type {string} */ key) {
    for (const el of listViewport.querySelectorAll(".track-row")) {
      if (el.dataset.key !== key) continue;
      const stars = el.querySelector(".row-stars");
      if (stars) applyRowStars(/** @type {HTMLElement} */ (stars), key);
    }
  }

  /**
   * Zaznacza wiersz na liście i (jeśli `onPlay`) od razu odtwarza Utwór.
   * @param {import("./listing.js").LibraryTrack} track
   * @param {{ startAt?: number, autoplay?: boolean }} [playOpts]
   */
  function selectTrack(track, playOpts) {
    selectedKey = track.key;
    updateSelectionClasses();
    if (onPlay) onPlay(track, playOpts);
  }

  let filtered = /** @type {import("./listing.js").LibraryTrack[]} */ (library.tracks);

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
    return filterByRocznik(library.tracks, rocznik);
  }

  function updateCounter() {
    count.textContent = makeCounter({ library, rocznik, ratings }).label;
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

  function update() {
    filtered = filteredTracks();
    list.setRows(filtered.length);
    updateCounter();
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
  update();

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

  return { selectKey }; // sync player → lista (transport N/P, bilet 06)
}

/** Demontuje widok biblioteki (reset danych / logout). */
export function unmountLibraryView() {
  tagControllerRef?.destroy();
  tagControllerRef = null;
  mounted = false;
  document.getElementById("library-layout")?.remove();
  document.getElementById("btn-root")?.remove();
  document.getElementById("viewport")?.classList.remove("viewport-library");
}
