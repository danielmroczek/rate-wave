// Testy logiki playera (bilet 06): session load/save, lastPlayed, throttling
// 5 s + zapis przy pause, scrubbing przed/at metadata, transport N/P.
// IDB przez fake-indexeddb, audio injectable (fake HTMLMediaElement).

import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB, get, put, STORES, SESSION_KEY } from "../store/db.js";
import { createPlayer, loadSession, saveSession, markLastPlayed } from "./player-state.js";

/** Fake audio: udaje powierzchnię HTMLMediaElement (EventListener API). */
function fakeAudio() {
  const listeners = new Map();
  const a = {
    src: "",
    preload: "",
    currentTime: 0,
    duration: NaN,
    paused: true,
    muted: false,
    play: async () => {
      a.paused = false;
    },
    pause: () => {
      a.paused = true;
    },
    addEventListener(type, fn) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn);
    },
    emit(type, ev = {}) {
      for (const fn of listeners.get(type) ?? []) fn({ target: a, ...ev });
    },
  };
  return a;
}

let db;
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  db = await openDB();
});

const TRACK = { key: "pcloud|1", fileid: 1, name: "t.mp3" };

describe("session store", () => {
  it("saveSession/loadSession round-trips trackKey + positionSec (source z playera)", async () => {
    await saveSession(db, { source: "pcloud", trackKey: "pcloud|9", positionSec: 42.5 });
    const sess = await loadSession(db);
    expect(sess).toEqual({ source: "pcloud", trackKey: "pcloud|9", positionSec: 42.5 });
    const raw = await get(db, STORES.SESSION, SESSION_KEY);
    expect(raw.trackKey).toBe("pcloud|9");
  });

  it("loadSession → undefined gdy brak wpisu", async () => {
    expect(await loadSession(db)).toBeUndefined();
  });
});

describe("lastPlayed", () => {
  it("dopisuje lastPlayed do istniejącego rekordu tracks", async () => {
    await putTrack(db, TRACK.key);
    await markLastPlayed(db, TRACK.key, 1111);
    const rec = await get(db, STORES.TRACKS, TRACK.key);
    expect(rec.lastPlayed).toBe(1111);
    expect(rec.fingerprint).toBeDefined();
  });

  it("tworzy rekord gdy brak (biblioteka przebudowana)", async () => {
    await markLastPlayed(db, "pcloud|X", 2222);
    const rec = await get(db, STORES.TRACKS, "pcloud|X");
    expect(rec).toEqual({ lastPlayed: 2222 });
  });
});

async function putTrack(db, key) {
  await put(db, STORES.TRACKS, key, { fingerprint: { size: 1, modified: 1 }, rating: null });
}

describe("createPlayer", () => {
  function mkPlayer({ clock, saveIntervalMs = 5000 } = {}) {
    const states = [];
    const links = [];
    const player = createPlayer({
      db,
      getLink: async (t) => {
        links.push(t.key);
        return { link: `https://file-host/download?t=${t.key}` };
      },
      createAudio: fakeAudio,
      saveIntervalMs,
      ...(clock ? { clock } : {}),
      onState: (s) => states.push(s),
    });
    return { player, states, links };
  }

  it("play ustawia src z getfilelink + preload=metadata, gra", async () => {
    const { player, states, links } = mkPlayer();
    await player.play(TRACK);
    expect(links).toEqual(["pcloud|1"]);
    const a = player.audio;
    expect(a.src).toBe("https://file-host/download?t=pcloud|1");
    expect(a.preload).toBe("metadata");
    expect(a.paused).toBe(false);
    expect(states.some((s) => s.playing === true)).toBe(true);
  });

  it("odtwarza od startAt po loadedmetadata (Pełny powrót)", async () => {
    const { player } = mkPlayer();
    await player.play(TRACK, { startAt: 30 });
    const a = /** @type {any} */ (player.audio);
    a.duration = 100;
    a.emit("loadedmetadata");
    expect(a.currentTime).toBe(30);
  });

  it("zapisuje pozycję co 5 s (timeupdate throttle) i przy pause", async () => {
    let t = 0;
    const clock = { now: () => t };
    const { player } = mkPlayer({ clock });
    await player.play(TRACK);
    const a = /** @type {any} */ (player.audio);
    await new Promise((r) => setTimeout(r, 0));

    // start odtwarzania → natychmiastowy zapis pozycji (0)
    expect((await loadSession(db)).positionSec).toBe(0);

    a.currentTime = 4;
    t += 1000; // < 5 s od ostatniego zapisu → brak zapisu
    a.emit("timeupdate");
    await new Promise((r) => setTimeout(r, 0));
    expect((await loadSession(db)).positionSec).toBe(0);

    t += 5000;
    a.currentTime = 9;
    a.emit("timeupdate"); // ≥ 5 s → zapis
    await new Promise((r) => setTimeout(r, 0));
    expect((await loadSession(db)).positionSec).toBe(9);

    a.currentTime = 12;
    player.pause(); // pause → force save bez throttlingu
    await new Promise((r) => setTimeout(r, 0));
    const sess = await loadSession(db);
    expect(sess.positionSec).toBe(12);
    expect(sess.trackKey).toBe("pcloud|1");
  });

  it("seekTo clampuje do duration nawet przed peaks (scrubbing od startu)", async () => {
    const { player } = mkPlayer();
    await player.play(TRACK, { autoplay: false });
    const a = /** @type {any} */ (player.audio);
    a.duration = 80;
    player.seekTo(120);
    expect(a.currentTime).toBe(80);
    player.seekTo(-5);
    expect(a.currentTime).toBe(0);
  });

  it("toggle pauzuje i wznawia", async () => {
    const { player } = mkPlayer();
    await player.play(TRACK);
    const a = /** @type {any} */ (player.audio);
    player.toggle();
    expect(a.paused).toBe(true);
    player.toggle();
    expect(a.paused).toBe(false);
  });

  it("step: następny/poprzedni z playlisty; brak ruchu na krańcach", async () => {
    const { player, links } = mkPlayer();
    await player.play(TRACK); // selection wymagane przez step
    const b = { key: "pcloud|2", fileid: 2, name: "b.mp3" };
    expect(await player.step([TRACK, b], 1)).toBe(true);
    expect(player.track.key).toBe("pcloud|2");
    expect(await player.step([TRACK, b], -1)).toBe(true);
    expect(player.track.key).toBe("pcloud|1");
    expect(await player.step([TRACK, b], -1)).toBe(false); // już pierwszy
    expect(links).toEqual(["pcloud|1", "pcloud|2", "pcloud|1"]);
  });

  it("markLastPlayed jest zapisywany przy każdym play", async () => {
    const { player } = mkPlayer();
    await putTrack(db, TRACK.key);
    await player.play(TRACK);
    await new Promise((r) => setTimeout(r, 0));
    const rec = await get(db, STORES.TRACKS, TRACK.key);
    expect(typeof rec.lastPlayed).toBe("number");
  });

  it("race: szybkie kliknięcie A→B — gra tylko ostatnio wybrany Utwór", async () => {
    /** @type {any[]} */
    const audioLog = [];
    let releaseA;
    const gateA = new Promise((r) => (releaseA = r));
    const player = createPlayer({
      db,
      getLink: async (t) => {
        if (t.key === "pcloud|A") await gateA; // link A wraca PÓŹNIEJ niż B
        return { link: `https://h/${t.key}` };
      },
      createAudio() {
        const a = fakeAudio();
        audioLog.push(a);
        return a;
      },
    });
    const pA = player.play({ key: "pcloud|A", fileid: 1, name: "a.mp3" });
    const pB = player.play({ key: "pcloud|B", fileid: 2, name: "b.mp3" });
    releaseA();
    await Promise.all([pA, pB]);
    expect(player.track.key).toBe("pcloud|B");
    // tylko jeden audio element wsunięty do odtwarzania — starszy porzucony
    expect(audioLog).toHaveLength(1);
    expect(audioLog[0].src).toBe("https://h/pcloud|B");
  });

  it("błąd getLink → status error, brak audio", async () => {
    const states = [];
    const player = createPlayer({
      db,
      getLink: async () => {
        throw new Error("too_many_getfilelink");
      },
      createAudio: fakeAudio,
      onState: (s) => states.push(s),
    });
    await player.play(TRACK);
    expect(states.at(-1).status).toContain("error");
    expect(player.audio).toBeUndefined();
  });

  it("onTrackChange: przy każdym skutecznym play/step, nigdy przy porzuconym (race)", async () => {
    const changes = [];
    let releaseA;
    const gateA = new Promise((r) => (releaseA = r));
    const player = createPlayer({
      db,
      getLink: async (t) => {
        if (t.key === "pcloud|A") await gateA;
        return { link: `https://h/${t.key}` };
      },
      createAudio: fakeAudio,
      onTrackChange: (t) => changes.push(t.key),
    });
    const trackB = { key: "pcloud|B", fileid: 2, name: "b.mp3" };
    const pA = player.play({ key: "pcloud|A", fileid: 1, name: "a.mp3" });
    const pB = player.play(trackB);
    releaseA();
    await Promise.all([pA, pB]);
    // A porzucone — tylko B zgłasza zmianę; step natomiast nadaje własne zdarzenie
    expect(changes).toEqual(["pcloud|B"]);

    const c = { key: "pcloud|C", fileid: 3, name: "c.mp3" };
    await player.step([{ ...TRACK }, trackB, c], 1);
    expect(changes).toEqual(["pcloud|B", "pcloud|C"]);
  });
});
