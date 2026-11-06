// @vitest-environment happy-dom
// Bilet #17 — testy widoku biblioteki: error path pickera (picker.open()
// odrzuca → dialog znika, onError → stan błędu na empty-state) oraz
// folderName po przebudowie (chip → wybór → sources.document.folderName =
// nowa nazwa). happy-dom dostarcza document; IDB przez fake-indexeddb.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB as openAppDB, STORES } from "../store/db.js";
import { mountLibraryView, unmountLibraryView } from "./library-view.js";
import { get } from "../store/db.js";

const FOLDERS = [
  { folderid: 1, name: "Muzyka" },
  { folderid: 2, name: "Audiobooki" },
];
/** Minimalna szafa IndexedDB — pełny schemat aplikacji przez openAppDB. */
function openDb() {
  return openAppDB();
}

/** Yes, fixture: pCloud root z dwoma podfolderami (Rocznikami). */
/** Mock pcloudApi: userinfo OK; recursive listing poddrzewa zwraca 1 utwór MP3. */
function makeApi() {
  return async ({ method, params = {} }) => {
    if (method === "userinfo") {
      return { result: 0, userid: 1, email: "a@b.c" };
    }
    if (method === "listfolder") {
      const fid = String(params.folderid ?? "0");
      if (fid === "0") {
        return {
          result: 0,
          metadata: {
            folderid: 0,
            name: "/",
            contents: FOLDERS.map((f) => ({ ...f, isfolder: true })),
          },
        };
      }
      const f = FOLDERS.find((x) => String(x.folderid) === fid);
      return {
        result: 0,
        metadata: {
          folderid: f.folderid,
          name: f.name,
          contents: [{ fileid: 900, name: "t.mp3", isfolder: false, size: 1 }],
        },
      };
    }
    throw new Error(`unexpected call: ${method} ${JSON.stringify(params)}`);
  };
}
/** Mock pcloudApi: each listing call rejects (scenariusz błędu sieci/API). */
function makeErrorApi() {
  return async ({ method }) => {
    if (method === "userinfo") return { result: 0, userid: 1, email: "a@b.c" };
    throw new Error("pCloud API error 1101: Invalid request.");
  };
}

let db;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  db = await openDb();
  localStorage.clear();
  document.body.innerHTML =
    '<div id="viewport"></div><div id="toolbar"></div><div id="count"></div><div id="empty-state" hidden></div>';
});

afterEach(() => {
  unmountLibraryView();
  db?.close();
});

/** Czeka aż predykat się spełni (z limitem) — klik jest async. */
async function waitFor(fn, timeout = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (fn()) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe("mountLibraryView — listing error (bez interakcji usera hosting nie startuje)", () => {
  it("Use entire account → listing rzuca 1101, empty-state pokazuje błąd, onError wołany", async () => {
    let notified = "";
    const pending = mountLibraryView({
      db,
      pcloudApi: makeErrorApi(),
      token: "t",
      hostname: "eapi.pcloud.com",
      onError: (e) => {
        notified = e.message;
      },
    });
    // Czekamy aż first-choice się wyrenderuje, potem wybieramy całe konto.
    await waitFor(() =>
      [...(document.getElementById("empty-state")?.querySelectorAll("button") ?? [])].some(
        (b) => b.textContent === "Use entire account",
      ),
    );
    [...document.getElementById("empty-state").querySelectorAll("button")]
      .find((b) => b.textContent === "Use entire account")
      .click();
    await expect(pending).rejects.toThrow(/1101/);
    const empty = document.getElementById("empty-state");
    expect(empty.textContent).toContain("1101");
    expect(notified).toContain("1101");
  });
});

describe("mountLibraryView — rebuild z pickera aktualizuje sources.folderName", () => {
  it("zmiana roota z chipu → sources.document.folderName = nowa nazwa", async () => {
    await mountLibraryView({
      db,
      pcloudApi: makeApi(),
      token: "t",
      hostname: "eapi.pcloud.com",
      folderId: "1",
      folderName: "Muzyka",
    });
    expect(document.getElementById("btn-root")?.textContent).toContain("Muzyka");

    const chip = document.getElementById("btn-root");
    expect(chip).toBeTruthy();
    chip.click();
    // dialog otwarty: wejdź do „Audiobooki" (2), potem „Use this folder".
    const dlg = document.getElementById("dlg-root-picker");
    await waitFor(() => dlg && dlg.open);
    expect(dlg).toBeTruthy();
    const target = [...dlg.querySelectorAll(".rocznik-btn")].find(
      (b) => b.textContent === "Audiobooki",
    );
    expect(target).toBeTruthy();
    target.click();
    await waitFor(() => [...(dlg?.querySelectorAll(".rocznik-btn") ?? [])].length === 0);
    const select = [...dlg.querySelectorAll("#root-picker-footer button")].find(
      (b) => b.textContent === "Use this folder",
    );
    expect(select.textContent).toBe("Use this folder");
    select.click();

    await waitFor(
      () =>
        document.getElementById("btn-root") !== undefined &&
        (document.getElementById("btn-root")?.textContent ?? "").includes("Audiobooki"),
    );
    const chipNow = document.getElementById("btn-root");
    expect(chipNow?.textContent).toContain("Audiobooki");
    const row = await get(db, STORES.SOURCES, "pcloud");
    expect(row.folderId).toBe("2");
    expect(row.folderName).toBe("Audiobooki");
  });
});

describe("mountLibraryView — selectKey: sync player → lista (bilet 06)", () => {
  it("podświetla wiersz wskazany przez player (N/P) bez grania", async () => {
    const restoreHeight = stubListHeight();
    await seedCache(db);
    const played = [];
    const api = await mountLibraryView({
      db,
      pcloudApi: makeApi(),
      token: "t",
      hostname: "eapi.pcloud.com",
      onPlay: (t, opts) => played.push({ t, opts }),
    });
    expect(api.selectKey("pcloud|901")).toBe(true);
    expect(
      document.querySelector('.track-row[data-key="pcloud|901"]').classList.contains("sel"),
    ).toBe(true);
    expect(played).toEqual([]); // selekcja bez onPlay
    restoreHeight.mockRestore();
  });

  it("Utwór poza filtrem Rocznika → reset na „All” i wtedy zaznaczenie", async () => {
    const restoreHeight = stubListHeight();
    const tracks = [];
    // biblioteka: 2 utwory w różnych Rocznikach
    const libTracks = [
      {
        key: "pcloud|1",
        fileid: 1,
        name: "a.mp3",
        rocznik: "2001",
        size: 1,
        modified: 1,
        fingerprint: { size: 1, modified: 1 },
      },
      {
        key: "pcloud|2",
        fileid: 2,
        name: "b.mp3",
        rocznik: "2002",
        size: 1,
        modified: 1,
        fingerprint: { size: 1, modified: 1 },
      },
    ];
    await saveTracks(db, libTracks);
    await saveLibrary(db, {
      tracks: libTracks,
      roczniki: [
        { name: "2001", count: 1 },
        { name: "2002", count: 1 },
      ],
      fingerprint: { size: 2, modified: 1 },
    });
    tracks.length = 0;
    const api = await mountLibraryView({
      db,
      pcloudApi: makeApi(),
      token: "t",
      hostname: "eapi.pcloud.com",
    });
    // włącz filtr 2001: tylko a.mp3 widoczne
    [...document.querySelectorAll("#roczniki .rocznik-btn")]
      .find((b) => b.dataset.rocznik === "2001")
      .click();
    expect(document.querySelector('.track-row[data-key="pcloud|2"]')).toBeNull();
    // player wskoczył na b.mp3 (2002) — lista ma pokazać „All" + zaznaczyć
    expect(api.selectKey("pcloud|2")).toBe(true);
    expect(
      document.querySelector('.track-row[data-key="pcloud|2"]').classList.contains("sel"),
    ).toBe(true);
    // filtr wrócił na „All" — wiersz a.mp3 znowu na liście
    expect(document.querySelector('.track-row[data-key="pcloud|1"]')).toBeTruthy();
    // active sidebar = All
    const all = [...document.querySelectorAll("#roczniki .rocznik-btn")].find(
      (b) => b.dataset.rocznik === "__all__",
    );
    expect(all.classList.contains("active")).toBe(true);
    restoreHeight.mockRestore();
  });

  it("nieznany key → false, bez zmian", async () => {
    const restoreHeight = stubListHeight();
    await seedCache(db);
    const api = await mountLibraryView({
      db,
      pcloudApi: makeApi(),
      token: "t",
      hostname: "eapi.pcloud.com",
    });
    expect(api.selectKey("pcloud|GONE")).toBe(false);
    expect(document.querySelector(".track-row.sel")).toBeNull();
    restoreHeight.mockRestore();
  });
});

// ── Bilet 06: klik wiersza → onPlay; Pełny powrót sesji ────────────────────

import { vi } from "vitest";
import { saveLibrary, saveTracks } from "./library-cache.js";
import { saveSession } from "../player/player-state.js";

/** happy-dom: clientHeight=0 → windowed lista nie renderuje rzędów; mock 440px. */
function stubListHeight() {
  return vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(440);
}

/** Cached biblioteka z 2 utworami (pomija listing — onLoad z IDB). */
async function seedCache(db, { withTrack2 = true } = {}) {
  const tracks = [
    {
      key: "pcloud|900",
      fileid: 900,
      name: "t.mp3",
      rocznik: null,
      size: 1,
      modified: 1,
      fingerprint: { size: 1, modified: 1 },
    },
  ];
  if (withTrack2) {
    tracks.push({
      key: "pcloud|901",
      fileid: 901,
      name: "u.mp3",
      rocznik: null,
      size: 2,
      modified: 2,
      fingerprint: { size: 2, modified: 2 },
    });
  }
  await saveTracks(db, tracks);
  await saveLibrary(db, { tracks, roczniki: [], fingerprint: { size: 3, modified: 2 } });
  return tracks;
}

describe("mountLibraryView — klik wiersza (bilet 06)", () => {
  it("klik wiersza → onPlay(track) + zaznaczenie .sel", async () => {
    const restoreHeight = stubListHeight();
    await seedCache(db);
    const played = [];
    await mountLibraryView({
      db,
      pcloudApi: makeApi(),
      token: "t",
      hostname: "eapi.pcloud.com",
      onPlay: (t, opts) => played.push({ t, opts }),
      onPlaylist: () => {},
    });

    const row = document.querySelector('.track-row[data-key="pcloud|900"]');
    expect(row).toBeTruthy();
    row.click();
    await waitFor(() => played.length === 1);
    expect(played[0].t.key).toBe("pcloud|900");
    expect(row.classList.contains("sel")).toBe(true);
    restoreHeight.mockRestore();
  });
});

describe("mountLibraryView — Pełny powrót sesji (bilet 06)", () => {
  it("session.trackKey istnieje → onPlay(track, { startAt }) i zaznaczenie", async () => {
    const restoreHeight = stubListHeight();
    const tracks = await seedCache(db);
    await saveSession(db, { trackKey: "pcloud|901", positionSec: 33 });
    const played = [];
    await mountLibraryView({
      db,
      pcloudApi: makeApi(),
      token: "t",
      hostname: "eapi.pcloud.com",
      onPlay: (t, opts) => played.push({ t, opts }),
    });
    expect(played).toEqual([{ t: tracks[1], opts: { startAt: 33 } }]);
    expect(
      document.querySelector('.track-row[data-key="pcloud|901"]').classList.contains("sel"),
    ).toBe(true);
    restoreHeight.mockRestore();
  });

  it("Utwór zniknął z biblioteki → degradacja: zaznaczenie listy (pierwszy wiersz), bez odtwarzania", async () => {
    const restoreHeight = stubListHeight();
    const tracks = await seedCache(db);
    await saveSession(db, { trackKey: "pcloud|GONE", positionSec: 10 });
    const played = [];
    await mountLibraryView({
      db,
      pcloudApi: makeApi(),
      token: "t",
      hostname: "eapi.pcloud.com",
      onPlay: (t, opts) => played.push({ t, opts }),
    });
    expect(played).toEqual([]);
    expect(
      document.querySelector('.track-row[data-key="pcloud|900"]').classList.contains("sel"),
    ).toBe(true);
    expect(tracks).toHaveLength(2);
    restoreHeight.mockRestore();
  });

  it("pusta biblioteka → brak zaznaczenia, brak błędu", async () => {
    const restoreHeight = stubListHeight();
    await saveLibrary(db, { tracks: [], roczniki: [], fingerprint: { size: 0, modified: 0 } });
    await saveSession(db, { trackKey: "pcloud|900", positionSec: 5 });
    const played = [];
    await mountLibraryView({
      db,
      pcloudApi: makeApi(),
      token: "t",
      hostname: "eapi.pcloud.com",
      onPlay: (t, opts) => played.push({ t, opts }),
    });
    expect(played).toEqual([]);
    expect(document.querySelector(".track-row.sel")).toBeNull();
    restoreHeight.mockRestore();
  });

  it("session restore działa też bez onPlay (tolerancja braku playera) — tylko zaznaczenie", async () => {
    const restoreHeight = stubListHeight();
    await seedCache(db);
    await saveSession(db, { trackKey: "pcloud|900", positionSec: 7 });
    const api = await mountLibraryView({
      db,
      pcloudApi: makeApi(),
      token: "t",
      hostname: "eapi.pcloud.com",
    });
    expect(typeof api.selectKey).toBe("function");
    expect(
      document.querySelector('.track-row[data-key="pcloud|900"]').classList.contains("sel"),
    ).toBe(true);
    restoreHeight.mockRestore();
  });
});
