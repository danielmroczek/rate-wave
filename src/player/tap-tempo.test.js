// TAP tempo (bilet 13, spec §5f): tick = tap; 3+ ticki → BPM ze średniej
// interwału, zaokrąglone do całego; dłuższa pauza / reset restartuje od zera.
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { bpmFromTaps, createTapTempo } from "./tap-tempo.js";

describe("bpmFromTaps", () => {
  it("3 ticki co 500 ms → 120 BPM", () => {
    expect(bpmFromTaps([0, 500, 1000])).toBe(120);
  });

  it("mniej niż 3 ticki → brak BPM", () => {
    expect(bpmFromTaps([])).toBe(null);
    expect(bpmFromTaps([0, 500])).toBe(null);
  });

  it("BPM ze średniej interwału, zaokrąglone (±1 BPM)", () => {
    // interwały 400 i 500 → średnia 450 ms → 133,33 → 133
    expect(bpmFromTaps([0, 400, 900])).toBe(133);
    // 410 ms → 146,34 → 146
    expect(bpmFromTaps([0, 410, 820])).toBe(146);
  });

  it("nieregularne ticki nie mogą dać zerowego/ujemnego interwału", () => {
    expect(bpmFromTaps([0, 0, 500])).toBe(120);
  });
});

describe("createTapTempo", () => {
  it("zbiera ticki i liczy BPM od trzeciego tapnięcia", () => {
    let t = 1000;
    const tap = createTapTempo({ now: () => t });
    expect(tap.tap()).toMatchObject({ bpm: null, taps: 1 });
    t += 500;
    expect(tap.tap()).toMatchObject({ bpm: null, taps: 2 });
    t += 500;
    expect(tap.tap()).toMatchObject({ bpm: 120, taps: 3 });
    expect(tap.bpm).toBe(120);
  });

  it("kolejne ticki uśredniają wszystkie interwały sesji", () => {
    let t = 0;
    const tap = createTapTempo({ now: () => t });
    for (const ms of [0, 500, 1000, 1500]) {
      t = ms;
      tap.tap();
    }
    expect(tap.bpm).toBe(120);
  });

  it("pauza > 2 s restartuje od zera (retry)", () => {
    let t = 0;
    const tap = createTapTempo({ now: () => t });
    tap.tap();
    t += 500;
    tap.tap();
    t += 500;
    expect(tap.tap().bpm).toBe(120);

    t += 3000;
    expect(tap.tap()).toMatchObject({ bpm: null, taps: 1 });
  });

  it("reset() czyści sesję natychmiast", () => {
    let t = 0;
    const tap = createTapTempo({ now: () => t });
    tap.tap();
    t += 500;
    tap.tap();
    t += 500;
    tap.tap();
    tap.reset();
    expect(tap.bpm).toBe(null);
    expect(tap.taps).toBe(0);
  });
});
