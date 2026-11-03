// Testy parsowania listing pCloud → biblioteka (bilet 04).

import { describe, it, expect } from "vitest";
import {
  buildLibrary,
  filterByRocznik,
  countUnrated,
  rocznikOf,
  makeTrack,
  LISTING_PARAMS,
} from "./listing.js";

/** Przykładowe drzewo listing — kształt odpowiedzi `listfolder?recursive=1`. */
function fakeResponse() {
  return {
    result: 0,
    metadata: {
      folderid: 0,
      name: "/",
      isfolder: true,
      contents: [
        {
          folderid: 100,
          name: "2017",
          isfolder: true,
          contents: [
            { fileid: 1, name: "a.mp3", size: 1000, modified: 1700000000, isfolder: false },
            { fileid: 2, name: "b.mp3", size: 2000, modified: 1700000100, isfolder: false },
            { fileid: 3, name: "projekt.asd", size: 50, modified: 1700000200, isfolder: false },
            { fileid: 4, name: "wrong.wav", size: 60, modified: 1700000300, isfolder: false },
          ],
        },
        {
          folderid: 200,
          name: "2018",
          isfolder: true,
          contents: [
            {
              folderid: 210,
              name: "warped",
              isfolder: true,
              contents: [
                {
                  fileid: 5,
                  name: "warped.mp3",
                  size: 3000,
                  modified: 1700000400,
                  isfolder: false,
                },
              ],
            },
            {
              folderid: 220,
              name: "take2",
              isfolder: true,
              contents: [
                {
                  fileid: 6,
                  name: "c.MP3",
                  size: 4000,
                  modified: 1700000500,
                  isfolder: false,
                },
              ],
            },
          ],
        },
        {
          folderid: 300,
          name: "2019",
          isfolder: true,
          contents: [], // pusty Rocznik — widoczny, count 0
        },
        { fileid: 9, name: "root-file.mp3", size: 500, modified: 1700000600, isfolder: false },
      ],
    },
  };
}

describe("LISTING_PARAMS", () => {
  it("rekursywny listing z folderid=0 i timestampami", () => {
    expect(LISTING_PARAMS).toEqual({ folderid: "0", recursive: "1", timeformat: "timestamp" });
  });
});

describe("rocznikOf / makeTrack", () => {
  it("Rocznik = 1. poziom podfolderów", () => {
    expect(rocznikOf(["2017", "take2"])).toBe("2017");
    expect(rocznikOf([])).toBe(null);
  });

  it("rekord Utworu z Fingerprintem i kluczem 'pcloud|<fileid>'", () => {
    const t = makeTrack({ fileid: 7, name: "x.mp3", size: 111, modified: 222 }, ["2017"]);
    expect(t.key).toBe("pcloud|7");
    expect(t.rocznik).toBe("2017");
    expect(t.fingerprint).toEqual({ size: 111, modified: 222 });
  });
});

describe("buildLibrary", () => {
  it("przyjmuje tylko MP3; .asd i nie-MP3 odfiltrowane", () => {
    const lib = buildLibrary(fakeResponse());
    const names = lib.tracks.map((t) => t.name).sort();
    expect(names).toEqual(["a.mp3", "b.mp3", "c.MP3", "root-file.mp3"]);
  });

  it("odrzuca całą gałąź warped/", () => {
    const lib = buildLibrary(fakeResponse());
    expect(lib.tracks.some((t) => t.name === "warped.mp3")).toBe(false);
  });

  it("Roczniki = 1. poziom podfolderów; puste widoczne z count=0", () => {
    const lib = buildLibrary(fakeResponse());
    const r = Object.fromEntries(lib.roczniki.map((x) => [x.name, x.count]));
    expect(r).toEqual({ 2017: 2, 2018: 1, 2019: 0 });
  });

  it("nested Rocznik nie powtarza się w rocznikach (2. poziom = zwykły podfolder)", () => {
    const lib = buildLibrary(fakeResponse());
    expect(lib.roczniki.map((x) => x.name)).not.toContain("take2");
  });

  it("Fingerprint listing: suma byte + max modified", () => {
    const lib = buildLibrary(fakeResponse());
    expect(lib.fingerprint.size).toBe(1000 + 2000 + 4000 + 500);
    expect(lib.fingerprint.modified).toBe(1700000600);
  });
});

describe("filterByRocznik / countUnrated", () => {
  const lib = buildLibrary(fakeResponse());

  it("null = wszystkie", () => {
    expect(filterByRocznik(lib.tracks, null).length).toBe(lib.tracks.length);
  });

  it("filtr Rocznika zwraca tylko jego Utwory", () => {
    const f = filterByRocznik(lib.tracks, "2017");
    expect(f.every((t) => t.rocznik === "2017")).toBe(true);
    expect(f.length).toBe(2);
  });

  it("brak ocen (placeholder) → M = N", () => {
    const ratings = new Map();
    expect(countUnrated(lib.tracks, ratings)).toBe(lib.tracks.length);
    // jedna oceniona
    ratings.set(lib.tracks[0].key, { rating: 5 });
    expect(countUnrated(lib.tracks, ratings)).toBe(lib.tracks.length - 1);
  });
});
