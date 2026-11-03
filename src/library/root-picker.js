// Picker folderu głównego biblioteki pCloud (bilet #17). Nawigacja poziomami
// (listfolder bez recursive), wybór folderu = folderid dla buildowania listingu.
// Czysty moduł — DOM podpina library-view.

/**
 * @param {{ pcloudApi: (opts: any) => Promise<any>, token?: string, hostname?: string }} opts
 * @returns {{
 *   open: () => Promise<{ folderid: string, path: { folderid: number, name: string }[], folders: any[] }>,
 *   enter: (f: { folderid: number, name: string }) => Promise<any>,
 *   up: () => Promise<any>,
 *   choose: () => Promise<{ folderid: string, name: string | null }>,
 * }}
 */
export function createRootPicker({ pcloudApi, token, hostname }) {
  /** @type {string} */
  let current = "0";
  /** @type {{ folderid: number, name: string }[]} */
  const stack = [];

  async function list() {
    const resp = await pcloudApi({
      method: "listfolder",
      params: { folderid: current, timeformat: "timestamp" },
      token,
      hostname,
    });
    const folders = (resp?.metadata?.contents ?? [])
      .filter((it) => it?.isfolder)
      .map((f) => ({ folderid: f.folderid, name: String(f.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { folderid: current, path: [...stack], folders };
  }

  return {
    open: list,
    async enter(/** @type {{ folderid: number, name: string }} */ f) {
      stack.push(f);
      current = String(f.folderid);
      return list();
    },
    async up() {
      // Rodzic = przedostatni element ścieżki (ostatni to bieżący poziom).
      stack.pop();
      current = stack.length ? String(stack[stack.length - 1].folderid) : "0";
      return list();
    },
    async choose() {
      return { folderid: current, name: stack.length ? stack[stack.length - 1].name : null };
    },
  };
}
