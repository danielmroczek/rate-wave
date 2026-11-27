// @vitest-environment happy-dom
// Testy widoku playera (bilet 06): struktura wg prototypu, scrubbing klik/drag,
// Space/N/P + brak kolizji z polami tekstowymi, waveform placeholder.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "../store/db.js";
import { mountPlayer } from "./player-view.js";

let db;
let dispose;
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  db = await openDB();
  document.body.innerHTML = '<div id="player" hidden></div>';
});

afterEach(() => {
  dispose?.();
  db?.close();
});

/** Fake audio + kontroladuration/paused dla testów widoku. */
function fakeAudioFactory() {
  return function make() {
    const listeners = new Map();
    const a = {
      src: "",
      preload: "",
      currentTime: 0,
      duration: NaN,
      paused: true,
      async play() {
        a.paused = false;
      },
      pause() {
        a.paused = true;
      },
      addEventListener(type, fn) {
        (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn);
      },
    };
    a._emit = (type) => {
      for (const fn of listeners.get(type) ?? []) fn({ target: a });
    };
    return a;
  };
}

function mount(overrides = {}) {
  const getLink = async (t) => ({ link: `https://h/t?t=${t.key}` });
  const view = mountPlayer({
    db,
    getLink,
    createAudio: fakeAudioFactory(),
    ...overrides,
  });
  dispose = () => view.dispose();
  return view;
}

const TRACK = { key: "pcloud|1", fileid: 1, name: "A.mp3" };
const TRACK2 = { key: "pcloud|2", fileid: 2, name: "B.mp3" };

describe("mountPlayer — struktura (prototyp player-ux)", () => {
  it("domyślnie pobiera Utwór POST-em i gra z Blob URL-a (token nie trafia do URL-a)", async () => {
    const log = [];
    const realFetch = globalThis.fetch;
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new Blob(["ID3"], { type: "audio/mpeg" }), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    URL.createObjectURL = vi.fn(() => "blob:track-1");
    URL.revokeObjectURL = vi.fn();
    try {
      const view = mount({ getLink: undefined, createAudio: factoryWithLog(log) });
      await view.play(TRACK);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/stream"),
        expect.objectContaining({ method: "POST" }),
      );
      expect(log.at(-1).src).toBe("blob:track-1");
    } finally {
      globalThis.fetch = realFetch;
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
  });

  it("ma tytuł, gwiazdki, transport, czas i duży slot waveformu (jeden pasek scrubbingu)", () => {
    mount();
    expect(document.getElementById("ptitle").textContent).toBe("Nothing selected");
    expect(document.getElementById("pstars").textContent).toContain("☆");
    for (const id of ["pbtn-prev", "pbtn-play", "pbtn-next", "ptime", "wave-slot"]) {
      expect(document.getElementById(id)).toBeTruthy();
    }
    expect(document.getElementById("pbar")).toBeNull(); // jeden pasek, bez duplikatu
    const wave = document.getElementById("wave-slot");
    expect(wave.textContent).toContain("placeholder");
    expect(wave.textContent).toContain("after the first rating");
  });
});

/** pomocnik: przechwytuje utworzone audio (factory z rejestracją) */
function factoryWithLog(log) {
  const base = fakeAudioFactory();
  return () => {
    const a = base();
    log.push(a);
    return a;
  };
}

describe("scrubbing przez factory-log", () => {
  it("waveform (placeholder) = jedyny pasek: klik/drag ustawia currentTime, ARIA + warstwa postępu", async () => {
    const log = [];
    const view = mount({ createAudio: factoryWithLog(log) });
    await view.play(TRACK);
    const a = log.at(-1);
    a.duration = 100;

    const wave = document.getElementById("wave-slot");
    const fill = document.getElementById("wave-fill");
    expect(wave.getAttribute("role")).toBe("slider");
    wave.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 34 });
    wave.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 50, bubbles: true, pointerId: 1 }),
    );
    expect(a.currentTime).toBe(25); // 50/200 * 100 s
    expect(fill.style.width).toBe("25%");

    // drag do końca
    wave.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 200, bubbles: true, pointerId: 1 }),
    );
    expect(a.currentTime).toBe(100);
    wave.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));

    // ARIA na wave slot aktualizowane jak na pbar
    expect(wave.getAttribute("aria-valuenow")).toBe("100");
  });
});

describe("klawiatura", () => {
  it("Space → toggle play/pause; N/P zmieniają Utwór po playliście", async () => {
    const log = [];
    const view = mount({ createAudio: factoryWithLog(log) });
    view.setPlaylist([TRACK, TRACK2]);
    await view.play(TRACK);
    const a = log.at(-1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(a.paused).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(a.paused).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(view.currentTrack.key).toBe("pcloud|2");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "P", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(view.currentTrack.key).toBe("pcloud|1");
  });

  it("klawisze nie kolidują z polami tekstowymi (input — Space wpisuje spację)", async () => {
    const log = [];
    const view = mount({ createAudio: factoryWithLog(log) });
    await view.play(TRACK);
    const a = log.at(-1);
    a.paused = false;

    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(a.paused).toBe(false); // toggle NIE zadziałał
  });

  it("przed wyborem Utworu Space nic nie robi (brak tracka)", () => {
    mount();
    expect(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })),
    ).not.toThrow();
  });
});

describe("tytuł i czas", () => {
  it("pokazuje nazwę Utworu i timeupdate → mm:ss / mm:ss", async () => {
    const log = [];
    const view = mount({ createAudio: factoryWithLog(log) });
    await view.play(TRACK);
    const a = log.at(-1);
    expect(document.getElementById("ptitle").textContent).toBe("A.mp3");

    a.duration = 125;
    a.currentTime = 62;
    a._emit("timeupdate");
    expect(document.getElementById("ptime").textContent).toBe("1:02 / 2:05");
    expect(document.getElementById("wave-fill").style.width).toBe("49.6%");
  });

  it("autoplay-blocked → puls na play + widoczny hint (nie cicho)", async () => {
    const failingFactory = () => ({
      src: "",
      preload: "",
      currentTime: 0,
      duration: 100,
      paused: true,
      play: async () => {
        throw new Error("NotAllowedError: play() requires a user gesture");
      },
      pause() {},
      addEventListener() {},
    });
    const view = mount({ createAudio: failingFactory });
    await view.play(TRACK);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById("pbtn-play").classList.contains("pulse")).toBe(true);
    expect(document.getElementById("pnote").textContent).toContain("tap");
  });

  it("błąd getLink (padnięty READ-PROXY) → komunikat w #pnote, brak audio", async () => {
    const view = mount({
      getLink: async () => {
        throw new Error("READ-PROXY 502");
      },
    });
    await view.play(TRACK);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById("pnote").textContent).toContain("READ-PROXY 502");
  });

  it("przycisk play działa jak toggle", async () => {
    const log = [];
    const view = mount({ createAudio: factoryWithLog(log) });
    await view.play(TRACK);
    const a = log.at(-1);
    document.getElementById("pbtn-play").click();
    expect(a.paused).toBe(true);
    document.getElementById("pbtn-play").click();
    expect(a.paused).toBe(false);
  });
});

describe("mountPlayer — gwiazdki oceny (bilet 08)", () => {
  it("pokazuje ocenę z cache i klik gwiazdki woła onRate(track, n)", async () => {
    const rated = [];
    const view = mount({
      getRating: (key) => (key === "pcloud|1" ? 4 : null),
      onRate: (t, n) => rated.push([t.key, n]),
    });
    await view.play(TRACK);
    const buttons = [...document.querySelectorAll("#pstars .star-btn")];
    expect(buttons.map((b) => b.textContent).join("")).toBe("★★★★☆");
    buttons[2].click();
    expect(rated).toEqual([["pcloud|1", 3]]);
  });
});

describe("mountPlayer — ⏳ dla kolejki ocen (bilet 09)", () => {
  it("isPending pokazuje znacznik przy Utworze; setRating(key, rating, pending) go przełącza", async () => {
    const view = mount({
      getRating: () => 4,
      isPending: (key) => key === "pcloud|1",
    });
    await view.play(TRACK);
    const mark = () => document.querySelector("#pstars .pending-mark");
    expect(mark()?.hidden).toBe(false);

    view.setRating("pcloud|1", 4, false);
    expect(mark()?.hidden).toBe(true);

    view.setRating("pcloud|1", 4, true);
    expect(mark()?.hidden).toBe(false);
  });

  it("znacznik dotyczy tylko bieżącego Utworu", async () => {
    const view = mount({ getRating: () => 3, isPending: () => false });
    await view.play(TRACK);
    view.setRating("pcloud|2", 5, true);
    expect(document.querySelector("#pstars .pending-mark")?.hidden).toBe(true);
  });
});

// ── Bilet 12: „→ ☆” (następny nieoceniony) + skrót U ───────────────────────

describe("mountPlayer — „→ ☆” (bilet 12)", () => {
  it("przycisk „→ ☆” woła onNextUnrated", async () => {
    const calls = [];
    mount({
      onNextUnrated: () => {
        calls.push(1);
        return true;
      },
    });
    document.getElementById("pbtn-next-unrated").click();
    expect(calls.length).toBe(1);
  });

  it("klawisz U (i tylko U) woła onNextUnrated", async () => {
    const calls = [];
    mount({
      onNextUnrated: () => {
        calls.push(1);
        return true;
      },
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "U", bubbles: true }));
    expect(calls.length).toBe(2);
  });

  it("brak onNextUnrated → klik/przycisk nie rzuca", async () => {
    mount();
    expect(() => document.getElementById("pbtn-next-unrated").click()).not.toThrow();
  });
});

// ── Bilet 13: TAP tempo (wystukanie → BPM → zapis) ──────────────────────────

describe("mountPlayer — TAP tempo (bilet 13)", () => {
  it("3 ticki co 500 ms → 120 BPM na wyświetlaczu i zapis przez onBpm", async () => {
    let t = 0;
    const saved = [];
    const view = mount({
      tapNow: () => t,
      bpmSaveDelayMs: 5,
      onBpm: (track, bpm) => saved.push([track.key, bpm]),
    });
    await view.play(TRACK);
    const tap = document.getElementById("pbtn-tap");
    for (let i = 0; i < 3; i++) {
      tap.click();
      t += 500;
    }
    expect(document.getElementById("pbpm").textContent).toBe("120 BPM");
    await new Promise((r) => setTimeout(r, 900));
    expect(saved).toEqual([["pcloud|1", 120]]);
  });

  it("mniej niż 3 ticki nie daje BPM i nic nie zapisuje", async () => {
    let t = 0;
    const saved = [];
    const view = mount({
      tapNow: () => t,
      bpmSaveDelayMs: 5,
      onBpm: (track, bpm) => saved.push([track.key, bpm]),
    });
    await view.play(TRACK);
    document.getElementById("pbtn-tap").click();
    t += 500;
    document.getElementById("pbtn-tap").click();
    expect(document.getElementById("pbpm").textContent).not.toContain("BPM");
    await new Promise((r) => setTimeout(r, 20));
    expect(saved).toEqual([]);
  });

  it("reset restartuje od zera (retry) i anuluje oczekujący zapis", async () => {
    let t = 0;
    const saved = [];
    const view = mount({
      tapNow: () => t,
      bpmSaveDelayMs: 5,
      onBpm: (track, bpm) => saved.push([track.key, bpm]),
    });
    await view.play(TRACK);
    const tap = document.getElementById("pbtn-tap");
    for (let i = 0; i < 3; i++) {
      tap.click();
      t += 500;
    }
    document.getElementById("pbtn-tap-reset").click();
    expect(document.getElementById("pbpm").textContent).toBe("");
    await new Promise((r) => setTimeout(r, 900));
    expect(saved).toEqual([]);
  });

  it("klawisz T jest tickiem, a zmiana Utworu pokazuje BPM z cache i czyści sesję", async () => {
    let t = 0;
    const view = mount({
      tapNow: () => t,
      bpmSaveDelayMs: 5,
      onBpm: () => {},
      getBpm: (key) => (key === "pcloud|2" ? 90 : null),
    });
    await view.play(TRACK);
    document.getElementById("pbtn-tap").click();
    t += 500;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    expect(document.getElementById("pbpm").textContent).not.toContain("BPM");

    await view.play(TRACK2);
    expect(document.getElementById("pbpm").textContent).toBe("90 BPM");
  });

  it("setBpm(key, bpm) synchronizuje wyświetlacz tylko dla bieżącego Utworu", async () => {
    const view = mount({ getBpm: () => null });
    await view.play(TRACK);
    view.setBpm("pcloud|2", 140);
    expect(document.getElementById("pbpm").textContent).toBe("");
    view.setBpm("pcloud|1", 140);
    expect(document.getElementById("pbpm").textContent).toBe("140 BPM");
  });
});

describe("mountPlayer — TAP tempo: granice zapisu (bilet 13)", () => {
  it("wolne tempo (<100 BPM) nie zapisuje w połowie sesji", async () => {
    let t = 0;
    const saved = [];
    const view = mount({
      tapNow: () => t,
      bpmSaveDelayMs: 5,
      onBpm: (track, bpm) => saved.push([track.key, bpm]),
    });
    await view.play(TRACK);
    const tap = document.getElementById("pbtn-tap");
    for (let i = 0; i < 3; i++) {
      tap.click();
      t += 667;
    }
    expect(document.getElementById("pbpm").textContent).toBe("90 BPM");
    await new Promise((r) => setTimeout(r, 500));
    expect(saved).toEqual([]); // jeszcze nie minął interwał 90 BPM
    tap.click();
    t += 667;
    await new Promise((r) => setTimeout(r, 1000));
    expect(saved).toEqual([["pcloud|1", 90]]);
  });

  it("zmiana Utworu zapisuje oczekujące BPM poprzedniego", async () => {
    let t = 0;
    const saved = [];
    const view = mount({
      tapNow: () => t,
      bpmSaveDelayMs: 60_000, // timer nie zdąży — zapis wymuszony zmianą Utworu
      onBpm: (track, bpm) => saved.push([track.key, bpm]),
    });
    await view.play(TRACK);
    const tap = document.getElementById("pbtn-tap");
    for (let i = 0; i < 3; i++) {
      tap.click();
      t += 500;
    }
    await view.play(TRACK2);
    expect(saved).toEqual([["pcloud|1", 120]]);
    expect(document.getElementById("pbpm").textContent).toBe("");
  });
});
