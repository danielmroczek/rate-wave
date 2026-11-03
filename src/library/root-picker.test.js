// Pickera folderu głównego (bilet #17): nawigacja poziomami pCloud
// (listfolder) + wybór folderu. Logika czysta — testowalna bez DOM.

import { describe, it, expect } from "vitest";
import { createRootPicker } from "./root-picker.js";

const fakeApi =
  (tree) =>
  async ({ method, params }) => {
    if (method !== "listfolder") throw new Error("unexpected method");
    const node = tree.get(String(params.folderid));
    if (!node) throw new Error("folder not found");
    return {
      result: 0,
      metadata: { isfolder: true, folderid: Number(params.folderid), contents: node },
    };
  };

const TREE = new Map([
  [
    "0",
    [
      { folderid: 1, name: "Muzyka", isfolder: true },
      { folderid: 2, name: "Dokumenty", isfolder: true },
      { fileid: 9, name: "stray.mp3", size: 1, modified: 1, isfolder: false },
    ],
  ],
  [
    "1",
    [
      { folderid: 11, name: "2017", isfolder: true },
      { folderid: 12, name: "2018", isfolder: true },
      { fileid: 8, name: "cover.jpg", size: 2, modified: 1, isfolder: false },
    ],
  ],
  ["11", [{ fileid: 3, name: "a.mp3", size: 3, modified: 1, isfolder: false }]],
]);

describe("createRootPicker", () => {
  it("startuje na root (folderid=0), pokazuje tylko podfoldery", async () => {
    const p = createRootPicker({
      pcloudApi: fakeApi(TREE),
      token: "t",
      hostname: "eapi.pcloud.com",
    });
    const level = await p.open();
    expect(level.folderid).toBe("0");
    expect(level.path).toEqual([]);
    expect(level.folders.map((f) => f.name)).toEqual(["Dokumenty", "Muzyka"]); // alfabetycznie, bez plików
  });

  it("enter — wchodzimy głębiej, path rośnie; up — wracamy", async () => {
    const p = createRootPicker({
      pcloudApi: fakeApi(TREE),
      token: "t",
      hostname: "eapi.pcloud.com",
    });
    await p.open();
    const child = await p.enter({ folderid: 1, name: "Muzyka" });
    expect(child.folderid).toBe("1");
    expect(child.path.map((s) => s.name)).toEqual(["Muzyka"]);
    const back = await p.up();
    expect(back.folderid).toBe("0");
    expect(back.path).toEqual([]);
  });

  it("choose — zwraca { folderid, name }; wybór roota dozwolony (folderid '0')", async () => {
    const p = createRootPicker({
      pcloudApi: fakeApi(TREE),
      token: "t",
      hostname: "eapi.pcloud.com",
    });
    await p.open();
    await p.enter({ folderid: 1, name: "Muzyka" });
    await p.enter({ folderid: 11, name: "2017" });
    const chosen = await p.choose();
    expect(chosen).toEqual({ folderid: "11", name: "2017" });
    await p.up();
    await p.up();
    expect(await p.choose()).toEqual({ folderid: "0", name: null }); // całe konto
  });
});
