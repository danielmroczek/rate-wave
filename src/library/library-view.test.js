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
