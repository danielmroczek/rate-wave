// Kontroler biblioteki (bilet 04): listing pCloud → cache IDB, odczyt z cache
// przy kolejnych wejściach (zero requestów listing), filtr Rocznika + licznik.
// Logika niezależna od DOM (testowalne).

import { buildLibrary, filterByRocznik, countUnrated, LISTING_PARAMS } from "./listing.js";
import { loadLibrary, saveLibrary, saveTracks } from "./library-cache.js";
import { getAllKeys, getAllValues, get, put, STORES } from "../store/db.js";

/** @typedef {import("./listing.js").Library} Library */

/** Leniwy import cienkiego klienta fetch — testy wstrzykują własne pcloudApi. */
async function defaultApi() {
  const { pcloudApi } = await import("../auth/pcloud-api.js");
  return pcloudApi;
}

/**
 * Pobiera listing roota (bez recursive) i skleja go z rekursywnym listingiem
 * podfolderów 1. poziomu. pCloud odpowiada 1101 „Invalid request" na
 * `folderid=0&recursive=1` (rekursja roota — research/perf-3000.md mierzył na
 * podfolderze); wynik końcowy identyczny: pełne drzewo w metadata.contents.
 *
 * @param {(opts: any) => Promise<any>} api
 * @param {{ hostname: string, token?: string, onProgress?: (p: { loaded: number, total: number, name?: string }) => void }} opts
 * @returns {Promise<any>} odpowiedź w kształcie `{ result: 0, metadata: {...} }`
 */
async function listRootPlusTopFolders(api, { hostname, token, onProgress }) {
  const root = await api({
    method: "listfolder",
    params: { folderid: "0", timeformat: LISTING_PARAMS.timeformat },
    token,
    hostname,
  });
  const folders = (root?.metadata?.contents ?? []).filter(
    (it) => it?.isfolder && String(it.name).toLowerCase() !== "warped",
  );

  const subtrees = /** @type {any[]} */ ([]);
  for (const [i, f] of folders.entries()) {
    console.info(`[library] per-folder listing ${i + 1}/${folders.length}: "${f.name}"…`);
    onProgress?.({ loaded: i, total: folders.length, name: String(f.name) });
    const sub = await api({
      method: "listfolder",
      params: {
        folderid: String(f.folderid),
        recursive: "1",
        timeformat: LISTING_PARAMS.timeformat,
      },
      token,
      hostname,
    });
    subtrees.push({ ...f, contents: sub?.metadata?.contents ?? [] });
  }

  // Zlewamy: pliki wprost z roota + roczniki zastąpione rekursywnym drzewem
  const subtreeById = new Map(subtrees.map((t) => [t.folderid, t]));
  const contents = (root?.metadata?.contents ?? []).map((it) =>
    it?.isfolder && subtreeById.has(it.folderid) ? subtreeById.get(it.folderid) : it,
  );
  return { result: 0, metadata: { ...root.metadata, contents } };
}

/**
 * Wczytuje bibliotekę pCloud: cache IDB → instant; inaczej listing z miriadem
 * strategii zapasowych. Persystencja: store `library` (listing + Fingerprint),
 * store `tracks` (rekordy z Fingerprintem, rating placeholder).
 *
 * @param {{ db: IDBDatabase, pcloudApi?: (opts: any) => Promise<any>, token?: string, hostname?: string, folderId?: string | null, onProgress?: (p: { loaded: number, total: number, name?: string }) => void }} opts
 *   `pcloudApi` injectable (domyślnie klient z auth/pcloud-api.js)
 * @returns {Promise<{ library: Library, fromCache: boolean, hostname?: string }>}
 */
export async function loadLibraryOrFetch({
  db,
  pcloudApi,
  token,
  hostname,
  folderId: folderIdRaw,
  onProgress,
}) {
  const cached = await loadLibrary(db);
  if (cached?.fingerprint && Array.isArray(cached.tracks)) {
    // Cache jest ważny tylko gdy rekordy `tracks` też dotrwały (reset może wygarnąć store)
    const trackKeys = await getAllKeys(db, STORES.TRACKS);
    if (trackKeys.length >= cached.tracks.length) {
      return { library: cached, fromCache: true };
    }
  }

  const api = pcloudApi ?? (await defaultApi());
  const searchHost =
    hostname === "eapi.pcloud.com" || hostname === "api.pcloud.com"
      ? hostname === "api.pcloud.com"
        ? "eapi.pcloud.com"
        : "api.pcloud.com"
      : "eapi.pcloud.com";

  // Wybrany folder główny (bilet #17): ≠0 → recursive działa bezpośrednio na nim
  // (1101 dotyczy tylko roota); =0 → pełna drabinka jak dotychczas.
  const folderId = String(folderIdRaw ?? "0");
  const LISTING_AT = { folderid: folderId, recursive: "1", timeformat: LISTING_PARAMS.timeformat };

  /**
   * Strategie listing — kolejność:
   * 1. wg spec: recursive na wybranym folderze na hoście z OAuth
   * 2. recursive na drugim hoście (rozjazd hostname/locationid)
   * 3. listing folderu + recursive per podfolder (1101 na recursive roota)
   * @type {Array<{ name: string, run: (h: string) => Promise<any>, hosts: string[] }>}
   */
  const strategies = [
    {
      name: "recursive",
      run: (h) => api({ method: "listfolder", params: LISTING_AT, token, hostname: h }),
      hosts: [hostname, searchHost].filter(Boolean),
    },
    ...(folderId === "0"
      ? [
          {
            name: "root-per-folder",
            run: (h) => listRootPlusTopFolders(api, { hostname: h, token, onProgress }),
            hosts: [hostname, searchHost].filter(Boolean),
          },
        ]
      : []),
  ];

  /** @type {any} */
  let lastError;
  for (const s of strategies) {
    for (const h of s.hosts) {
      try {
        const response = await s.run(h);
        const library = buildLibrary(response);

        // Cache: listing + Fingerprint w `library`, rekordy Utworów w `tracks`
        // (atomowy rebuild: scalenie rating/lastPlayed dzieje się w saveTracks).
        await saveTracks(db, library.tracks);
        await saveLibrary(db, library);
        // Zapamiętaj działający hostname + wybrany folder w `sources` — kolejne
        // sesje nie zgadują ani hosta, ani roota biblioteki.
        if (token) {
          const row = (await get(db, STORES.SOURCES, "pcloud")) ?? {};
          const changed = (h !== hostname && row.hostname !== h) || row.folderId !== folderId;
          if (changed) {
            row.hostname = h !== hostname ? h : (row.hostname ?? h);
            row.folderId = folderId;
            await put(db, STORES.SOURCES, "pcloud", row);
          }
        }
        return { library, fromCache: false, hostname: h };
      } catch (err) {
        lastError = err;
        // Auth error na hoście z OAuth = naprawdę złe cookie — przerywamy całość.
        // Auth error na hoście zapasowym to częsty rozjazd token↔host (token EU
        // odrzucony przez api.pcloud.com → 2094): nie porzucamy strategii.
        if (/** @type {any} */ (err)?.isAuthError && h === hostname) throw err;
        // Oczekiwany krok drabinki (nie błąd!): 1101 = brak recursive na roota,
        // 2094 = zapasowy host odrzuca token EU. Kolejna strategia/host przejmuje.
        console.info(
          `[library] ${s.name} on ${h} unavailable (${err?.message ?? err}) — trying next strategy…`,
        );
      }
    }
  }
  throw lastError;
}

/**
 * Czyta oceny Utworów z IDB do mapy trackKey → rekord (do licznika „M bez oceny").
 * getAllValues i getAllKeys mają tę samą kolejność — łączymy parami.
 * @param {IDBDatabase} db
 * @returns {Promise<Map<string, any>>}
 */
export async function loadRatings(db) {
  const [values, keys] = await Promise.all([
    getAllValues(db, STORES.TRACKS),
    getAllKeys(db, STORES.TRACKS),
  ]);
  const map = new Map();
  for (let i = 0; i < values.length; i++) map.set(keys[i], values[i]);
  return map;
}

/**
 * Licznik wg aktywnego filtra Rocznika: "N pozycji … M bez oceny".
 * @param {{ library: Library, rocznik: string|null, ratings: Map<string, any> }} opts
 * @returns {{ total: number, unrated: number, label: string }}
 */
export function makeCounter({ library, rocznik, ratings }) {
  const filtered = filterByRocznik(library.tracks, rocznik);
  const unrated = countUnrated(filtered, ratings);
  return {
    total: filtered.length,
    unrated,
    label: `${filtered.length} pozycji … ${unrated} bez oceny`,
  };
}
