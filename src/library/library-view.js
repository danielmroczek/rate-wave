// Widok biblioteki (bilet 04): drzewko Roczników po lewej (klik = filtr,
// „wszystkie" = reset, aktywny pełnym tłem, puste Roczniki widoczne) +
// windowed lista (bilet: ~30 rzędów, rAF, 60 FPS). Row: nazwa + placeholder
// gwiazdek + BPM slot + badge slot.

import { filterByRocznik } from "./listing.js";
import { WindowedList, ROW_HEIGHT } from "./windowing.js";
import { loadLibraryOrFetch, loadRatings, makeCounter } from "./library-controller.js";
import { loadLibrary, deleteLibrary } from "./library-cache.js";
import { createRootPicker } from "./root-picker.js";
import { get, put, STORES } from "../store/db.js";

/** Widok biblioteki zamontowany. */
let mounted = false;

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
  });

  function renderTrackRow(track) {
    const row = document.createElement("div");
    row.className = "list-row track-row";
    row.dataset.key = track.key;

    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = track.name;
    name.title = track.name;

    const stars = document.createElement("span");
    stars.className = "row-stars";
    stars.textContent = "☆☆☆☆☆";

    const bpm = document.createElement("span");
    bpm.className = "row-bpm slot";

    const badge = document.createElement("span");
    badge.className = "row-badge slot";

    row.append(name, stars, bpm, badge);
    return row;
  }

  let filtered = /** @type {import("./listing.js").LibraryTrack[]} */ (library.tracks);

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
}

/** Demontuje widok biblioteki (reset danych / logout). */
export function unmountLibraryView() {
  mounted = false;
  document.getElementById("library-layout")?.remove();
  document.getElementById("btn-root")?.remove();
  document.getElementById("viewport")?.classList.remove("viewport-library");
}
