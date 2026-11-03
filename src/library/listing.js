// Filtrowanie i spłaszczanie rekurencyjnego listingu pCloud (bilet 04, spec §4a).
// Rocznik = 1. poziom podfolderów pod rootem (folderid=0). Filtrowanie po naszej
// stronie: .asd (pliki projektowe), warped/, nie-MP3. Fingerprint rekordu =
// { size, modified } — walidacja per-odczyt (spec §4a, timeformat=timestamp).

/** Katalogi do odrzucenia (cała gałąź, spec "warped/"). */
const EXCLUDED_DIRS = new Set(["warped"]);

/** @typedef {{ key: string, fileid: number, name: string, rocznik: string|null, size: number, modified: number, fingerprint: { size: number, modified: number } }} LibraryTrack */
/** @typedef {{ name: string, count: number }} RocznikEntry */
/** @typedef {{ tracks: LibraryTrack[], roczniki: RocznikEntry[], fingerprint: { size: number, modified: number } }} Library */

/** Parametry 1× rekurencyjnego listingu (spec: zero stronicowania, ts zamiast RFC 2822). */
export const LISTING_PARAMS = { folderid: "0", recursive: "1", timeformat: "timestamp" };

/**
 * Skraca ścieżkę do 1. poziomu podfolderów roota (literał Rocznika).
 * @param {string[]} segments — segmenty od roota
 * @returns {string|null} nazwa Rocznika (null dla plików bezpośrednio w root)
 */
export function rocznikOf(segments) {
  return segments.length > 0 ? segments[0] : null;
}

/**
 * Rekord Utworu z Fingerprintem (spec: klucz 'pcloud|'+fileid).
 * @param {any} file — filemetadata listing pCloud
 * @param {string[]} segments — segmenty od roota
 * @returns {LibraryTrack}
 */
export function makeTrack(file, segments) {
  const size = Number(file.size) || 0;
  const modified = Number(file.modified) || 0;
  return {
    key: `pcloud|${file.fileid}`,
    fileid: file.fileid,
    name: String(file.name),
    rocznik: rocznikOf(segments),
    size,
    modified,
    fingerprint: { size, modified },
  };
}

/**
 * Rekursywnie zbiera MP3 z drzewa listing pCloud. Odporny na oba warianty pCloud:
 * foldery zagnieżdżone w `contents` (recursive listing) oraz w `children`.
 * Uwzględnia: `.asd` ODPAD (nie-MP3), `warped/` gałąź ODPADA, pliki bez fileid ODPADAJĄ.
 *
 * @param {any} node — foldermetadata (root): { contents?: any[] }
 * @param {LibraryTrack[]} out — akumulator wyjściowy
 * @param {string[]} segments — segmenty katalogów od roota
 * @returns {number} suma byte wszystkich przyjętych MP3 (składnik Fingerprintu listing)
 */
export function collectTracks(node, out = [], segments = []) {
  const items = node?.contents ?? node?.children ?? [];
  const dirs = [];
  let sumBytes = 0;

  for (const item of items) {
    if (item?.isfolder) {
      if (EXCLUDED_DIRS.has(String(item.name).toLowerCase())) continue;
      dirs.push(item);
    } else if (item && typeof item.fileid !== "undefined" && !item.isfolder) {
      if (!String(item.name).toLowerCase().endsWith(".mp3")) continue;
      out.push(makeTrack(item, segments));
      sumBytes += Number(item.size) || 0;
    }
  }

  for (const folder of dirs) {
    sumBytes += collectTracks(folder, out, [...segments, String(folder.name)]);
  }
  return sumBytes;
}

/**
 * Buduje roczniki z listingu: 1. poziom podfolderów roota — widoczne zawsze, nawet puste.
 * @param {any} root — foldermetadata roota
 * @param {LibraryTrack[]} tracks — utwory zebrane z drzewa
 * @returns {RocznikEntry[]}
 */
export function rocznikiFromRoot(root, tracks) {
  const counts = new Map();
  for (const t of tracks) {
    if (t.rocznik === null) continue;
    counts.set(t.rocznik, (counts.get(t.rocznik) ?? 0) + 1);
  }

  const roczniki = [];
  const seen = new Set();
  const rootItems = root?.contents ?? root?.children ?? [];
  for (const item of rootItems) {
    if (!item?.isfolder || EXCLUDED_DIRS.has(String(item.name).toLowerCase())) continue;
    const name = String(item.name);
    if (seen.has(name)) continue;
    seen.add(name);
    roczniki.push({ name, count: counts.get(name) ?? 0 });
  }
  return roczniki;
}

/**
 * Pełna transformacja: odpowiedź `listfolder?folderid=0&recursive=1&timeformat=timestamp`
 * → `{ tracks, roczniki, fingerprint }`. Fingerprint listing = { suma byte, maxModified }.
 * @param {any} response — JSON odpowiedzi pCloud (result===0); drzewo w `response.metadata`
 * @returns {Library}
 */
export function buildLibrary(response) {
  const root = response?.metadata ?? response;
  const tracks = [];
  const totalBytes = collectTracks(root, tracks);
  const maxModified = tracks.reduce((m, t) => Math.max(m, t.modified), 0);
  return {
    tracks,
    roczniki: rocznikiFromRoot(root, tracks),
    fingerprint: { size: totalBytes, modified: maxModified },
  };
}

/**
 * Filtruje Utwory według aktywnego Rocznika (null = bez filtra / „wszystkie").
 * @param {LibraryTrack[]} tracks
 * @param {string|null} rocznik
 * @returns {LibraryTrack[]}
 */
export function filterByRocznik(tracks, rocznik) {
  if (rocznik === null || rocznik === undefined) return tracks;
  return tracks.filter((t) => t.rocznik === rocznik);
}

/**
 * Liczba pozycji bez oceny — licznik "N pozycji … M bez oceny" wg aktywnego filtra.
 * @param {LibraryTrack[]} tracks
 * @param {Map<string, { rating?: number | null } | undefined>} ratings — map trackKey → rekord IDB
 * @returns {number}
 */
export function countUnrated(tracks, ratings) {
  let n = 0;
  for (const t of tracks) {
    const rec = ratings.get(t.key);
    if (!rec || typeof rec.rating !== "number") n += 1;
  }
  return n;
}
