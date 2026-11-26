// Testy sort/szukajki (bilet 12, spec §5d/§5e) — logika czysta, Node.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_SORT_MODE,
  isSortMode,
  nextUnrated,
  searchFilter,
  sortTracks,
  SORT_MODES,
} from "./filter-sort.js";

const T = (key, name) => ({ key, name });
// kolejność w bibliotece celowo „nieposortowana"
const tracks = [T("a", "b.mp3"), T("b", "a.mp3"), T("c", "rec_2.mp3"), T("d", "rec_10.mp3")];

describe("SORT_MODES / walidacja trybu", () => {
  it("default = name-asc; wszystkie id przechodzą walidację", () => {
    expect(DEFAULT_SORT_MODE).toBe("name-asc");
    expect(isSortMode(DEFAULT_SORT_MODE)).toBe(true);
    for (const m of SORT_MODES) expect(isSortMode(m.id)).toBe(true);
    expect(isSortMode("bogus")).toBe(false);
  });
});

describe("sortTracks (spec §5d)", () => {
  it("name-asc: alfabetycznie (rec_2 przed rec_10 — numeric)", () => {
    expect(sortTracks(tracks, "name-asc").map((t) => t.name)).toEqual([
      "a.mp3",
      "b.mp3",
      "rec_2.mp3",
      "rec_10.mp3",
    ]);
  });

  it("name-desc: odwrotnie", () => {
    expect(sortTracks(tracks, "name-desc").map((t) => t.name)).toEqual([
      "rec_10.mp3",
      "rec_2.mp3",
      "b.mp3",
      "a.mp3",
    ]);
  });

  it("nie mutuje wejścia", () => {
    const copy = [...tracks];
    sortTracks(copy, "name-desc");
    expect(copy).toEqual(tracks);
  });

  it("brak mapy ocen = każdy nieoceniony; kolejność wg nazwy", () => {
    expect(sortTracks(tracks, "rating-desc").map((t) => t.name)).toEqual([
      "a.mp3",
      "b.mp3",
      "rec_2.mp3",
      "rec_10.mp3",
    ]);
  });

  describe("rating-desc / rating-asc", () => {
    const m = new Map([
      ["a", { rating: 3 }],
      ["b", {}],
      ["c", { rating: 5 }],
      ["d", { rating: 1 }],
    ]);

    it("rating-desc: najwyżej ocenione najpierw, brak oceny na końcu", () => {
      expect(sortTracks(tracks, "rating-desc", m).map((t) => t.key)).toEqual(["c", "a", "d", "b"]);
    });

    it("rating-asc: brak oceny też na końcu („do zrobienia” wygląda inaczej)", () => {
      expect(sortTracks(tracks, "rating-asc", m).map((t) => t.key)).toEqual(["d", "a", "c", "b"]);
    });

    it("remis ocen łamany po nazwie", () => {
      const tie = new Map([
        ["a", { rating: 5 }],
        ["b", { rating: 5 }],
        ["c", { rating: 1 }],
        ["d", { rating: 1 }],
      ]);
      // remis 1★: c („rec_2.mp3”) przed d („rec_10.mp3”); remis 5★: b („a.mp3”) przed a
      expect(sortTracks(tracks, "rating-asc", tie).map((t) => t.key)).toEqual(["c", "d", "b", "a"]);
    });
  });

  describe("tempo-asc / tempo-desc", () => {
    // BPM: a=60, b=120, c=60, d=brak
    const m = new Map([
      ["a", { bpm: 60 }],
      ["b", { bpm: 120 }],
      ["c", { bpm: 60 }],
      ["d", {}],
    ]);

    it("tempo-asc: wolniejsze BPM najpierw, bez BPM na końcu, remis po nazwie", () => {
      expect(sortTracks(tracks, "tempo-asc", m).map((t) => t.key)).toEqual(["a", "c", "b", "d"]);
    });

    it("tempo-desc: szybsze BPM najpierw, bez BPM na końcu", () => {
      expect(sortTracks(tracks, "tempo-desc", m).map((t) => t.key)).toEqual(["b", "a", "c", "d"]);
    });
  });

  describe("recent", () => {
    const m = new Map([
      ["a", { lastPlayed: 100 }],
      ["b", { lastPlayed: 300 }],
      ["c", { lastPlayed: 200 }],
      ["d", {}],
    ]);

    it("recent: lastPlayed malejąco, nienastuchane na końcu", () => {
      expect(sortTracks(tracks, "recent", m).map((t) => t.key)).toEqual(["b", "c", "a", "d"]);
    });

    it("recent bez danych: remis po nazwie (stabilny default)", () => {
      expect(sortTracks(tracks, "recent", new Map()).map((t) => t.name)).toEqual([
        "a.mp3",
        "b.mp3",
        "rec_2.mp3",
        "rec_10.mp3",
      ]);
    });
  });

  it("nieznany tryb = default (name-asc)", () => {
    expect(sortTracks(tracks, "bogus").map((t) => t.name)).toEqual([
      "a.mp3",
      "b.mp3",
      "rec_2.mp3",
      "rec_10.mp3",
    ]);
  });
});

describe("searchFilter (spec §5e)", () => {
  it("substring case-insensitive po nazwie pliku", () => {
    expect(searchFilter(tracks, "REC_").map((t) => t.key)).toEqual(["c", "d"]);
    expect(searchFilter(tracks, "rec_1").map((t) => t.key)).toEqual(["d"]);
    expect(searchFilter(tracks, "a.").map((t) => t.key)).toEqual(["b"]);
  });

  it("puste zapytanie → pełna lista (kopia)", () => {
    const out = searchFilter(tracks, "");
    expect(out).toHaveLength(tracks.length);
    expect(out).not.toBe(tracks);
  });
});

describe("nextUnrated (→ ☆ / U, §5b)", () => {
  const m = new Map([
    ["a", { rating: 3 }],
    ["b", { rating: 1 }],
    ["c", { rating: 2 }],
  ]);

  it("zwraca pierwszy nieoceniony po fromKey (d nieoceniony)", () => {
    expect(nextUnrated(tracks, m, "a")?.key).toBe("d");
    expect(nextUnrated(tracks, m, "b")?.key).toBe("d");
  });

  it("brak fromKey: pierwszy nieoceniony od początku", () => {
    expect(nextUnrated(tracks, m, null)?.key).toBe("d");
    expect(nextUnrated(tracks, m)?.key).toBe("d");
  });

  it("wszystkie ocenione → null; pusta lista → null", () => {
    const allRated = new Map(tracks.map((t) => [t.key, { rating: 5 }]));
    expect(nextUnrated(tracks, allRated, "a")).toBeNull();
    expect(nextUnrated([], m, "a")).toBeNull();
  });
});
