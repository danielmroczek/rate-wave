// @vitest-environment happy-dom
// Testy widoku playera (bilet 06): struktura wg prototypu, scrubbing klik/drag,
// Space/N/P + brak kolizji z polami tekstowymi, waveform placeholder.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  it("domyślnie gra przez proxy /stream (getLink → { link }, string skrzynkowany w obiekt)", async () => {
    const log = [];
    const view = mount({ getLink: undefined, createAudio: factoryWithLog(log) });
    await view.play(TRACK);
    expect(log.at(-1).src).toContain("/stream");
    expect(log.at(-1).src).toContain("fileid=1");
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
