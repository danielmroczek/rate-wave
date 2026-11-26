// Sort (4 tryby, spec §5d) + szukajka (spec §5e) — bilet 12. Logika czysta
// (Node-testowalna); library-view podłącza ją pod <select>/szukajkę.

/** Tryby sortowania (spec §5d). Kierunek wynika z sufiksu -asc/-desc. */
export const SORT_MODES = /** @type {const} */ ([
  { id: "name-asc", label: "Nazwa A→Z" },
  { id: "name-desc", label: "Nazwa Z→A" },
  { id: "rating-desc", label: "Ocena ↓" },
  { id: "rating-asc", label: "Ocena ↑" },
  { id: "tempo-asc", label: "Tempo ↑" },
  { id: "tempo-desc", label: "Tempo ↓" },
  { id: "recent-desc", label: "Ostatnio słuchane ↓" },
  { id: "recent-asc", label: "Ostatnio słuchane ↑" },
]);

export const DEFAULT_SORT_MODE = "name-asc";

/** @param {any} v */
export const isSortMode = (v) => SORT_MODES.some((m) => m.id === v);

/**
 * Kolumny sortowalne na liście (§5d): klik = sort po kolumnie,
 * kolejny klik przełącza kierunek. `modes[0]` = domyślny kierunek kolumny.
 */
export const SORT_COLUMNS = /** @type {const} */ ([
  { id: "name", label: "Nazwa", modes: ["name-asc", "name-desc"] },
  { id: "rating", label: "Ocena", modes: ["rating-desc", "rating-asc"] },
  { id: "tempo", label: "Tempo", modes: ["tempo-asc", "tempo-desc"] },
  { id: "played", label: "Słuchane", modes: ["recent-desc", "recent-asc"] },
]);

/** Kolumna, do której należy tryb sorta (np. "name-asc" → "name"). */
export function columnOfSortMode(mode) {
  for (const col of SORT_COLUMNS) {
    if (col.modes.includes(mode)) return col.id;
  }
  return "name";
}

/**
 * Przełącza tryb sorta w ramach kolumny (klik w aktywny nagłówek).
 * Kolumny jednokierunkowe (brak drugiego trybu) zwracają to samo.
 */
export function toggleSortMode(mode) {
  for (const col of SORT_COLUMNS) {
    const i = col.modes.indexOf(mode);
    if (i >= 0) return col.modes[(i + 1) % col.modes.length];
  }
  return DEFAULT_SORT_MODE;
}

// Collator z `numeric` sortuje „rec_2021-02-06_…" naturalnie po liczbach.
const nameCollator = new Intl.Collator("pl", { numeric: true, sensitivity: "base" });

/** Kolejność wg nazwy pliku; remis (identyczna nazwa) łamany po key. */
export function compareNames(a, b) {
  return nameCollator.compare(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Liczbowa gałąź comparatora: liczba albo null (brak oceny/BPM/lastPlayed). */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Sortuje Utwory (spec §5d). Oceny z mapy rekordów IDB (optimistic).
 * name-desc/name-asc — wg nazwy (default A→Z, zgodnie z §5d)
 * rating-desc/asc — wg oceny; brak oceny zawsze na końcu
 * tempo-asc/desc — wg BPM; utwory bez BPM na końcu, potem alfabetycznie
 * recent — lastPlayed malejąco; nigdy nie słuchane na końcu, wg nazwy
 * @param {any[]} tracks
 * @param {string} mode
 * @param {Map<string, any>} [ratings] — trackKey → rekord (`tracks` IDB)
 */
export function sortTracks(tracks, mode = DEFAULT_SORT_MODE, ratings = new Map()) {
  const out = [...tracks];
  switch (mode) {
    case "name-desc":
      out.sort((a, b) => compareNames(b, a));
      break;
    case "rating-desc":
    case "rating-asc": {
      const dir = mode === "rating-asc" ? 1 : -1;
      // brak oceny zawsze na końcu, także przy „↑” („do zrobienia” wygląda inaczej)
      const rating = (t) => num(ratings.get(t.key)?.rating);
      out.sort((a, b) => {
        const ra = rating(a);
        const rb = rating(b);
        if (ra === null && rb === null) return compareNames(a, b);
        if (ra === null) return 1;
        if (rb === null) return -1;
        return (ra - rb) * dir || compareNames(a, b);
      });
      break;
    }
    case "tempo-asc":
    case "tempo-desc": {
      const dir = mode === "tempo-asc" ? 1 : -1;
      const bpm = (t) => num(ratings.get(t.key)?.bpm);
      out.sort((a, b) => {
        const va = bpm(a);
        const vb = bpm(b);
        if (va === null && vb === null) return compareNames(a, b);
        if (va === null) return 1;
        if (vb === null) return -1;
        return (va - vb) * dir || compareNames(a, b);
      });
      break;
    }
    case "recent-desc":
    case "recent": {
      const last = (t) => num(ratings.get(t.key)?.lastPlayed) ?? 0;
      out.sort((a, b) => last(b) - last(a) || compareNames(a, b));
      break;
    }
    case "recent-asc": {
      const last = (t) => num(ratings.get(t.key)?.lastPlayed) ?? 0;
      out.sort((a, b) => last(a) - last(b) || compareNames(a, b));
      break;
    }
    case "name-asc":
    default:
      out.sort(compareNames);
      break;
  }
  return out;
}

/** Filtr szukajki: substring case-insensitive po nazwie pliku. */
export function searchFilter(tracks, query) {
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  return q ? tracks.filter((t) => t.name.toLowerCase().includes(q)) : [...tracks];
}

/** Liczba pozycji bez oceny („M bez oceny”) — wg ocen w mapie rekordów. */
export function countUnrated(tracks, ratings = new Map()) {
  let n = 0;
  for (const t of tracks) {
    const rec = ratings.get(t.key);
    if (!rec || typeof rec.rating !== "number") n += 1;
  }
  return n;
}

/**
 * Następny nieoceniony Utwór po `fromKey` na bieżącej liście („→ ☆”/`U`, §5b).
 * Wrap-around: szuka od wiersza po `fromKey` do końca i od początku.
 * @param {any[]} tracks
 * @param {Map<string, any>} [ratings]
 * @param {string | null} [fromKey]
 */
export function nextUnrated(tracks, ratings = new Map(), fromKey = null) {
  const n = tracks.length;
  if (!n) return null;
  const start = fromKey
    ? Math.max(
        0,
        tracks.findIndex((t) => t.key === fromKey),
      )
    : 0;
  for (let i = 0; i < n; i++) {
    const t = tracks[(start + i) % n];
    if (fromKey && t.key === fromKey) continue;
    const rec = ratings.get(t.key);
    if (!rec || rec.rating == null) return t;
  }
  return null;
}
