// Testy czystej logiki windowing (bilet 04): zakresy okna, clamp scrollTop.

import { describe, it, expect } from "vitest";
import { windowRange, ROW_HEIGHT, OVERSCAN } from "./windowing.js";

describe("windowRange", () => {
  it("stała wysokość rzędu eksport / kolejność parametrów spójne", () => {
    expect(typeof ROW_HEIGHT).toBe("number");
    expect(OVERSCAN).toBeGreaterThanOrEqual(0);
  });

  it("scrollTop=0 → pierwsze okno od zera", () => {
    const r = windowRange({ totalRows: 3635, viewportHeight: ROW_HEIGHT * 10, scrollTop: 0 });
    expect(r.first).toBe(0);
    expect(r.last).toBe(10 + OVERSCAN);
    expect(r.offset).toBe(0);
  });

  it("środek listy: first ~ scrollTop/rowHeight - overscan", () => {
    const scrollTop = 1000 * ROW_HEIGHT;
    const r = windowRange({ totalRows: 3635, viewportHeight: ROW_HEIGHT * 10, scrollTop });
    expect(r.first).toBe(1000 - OVERSCAN);
    expect(r.offset).toBe(r.first * ROW_HEIGHT);
  });

  it("koniec listy: last = totalRows, nie wychodzi poza", () => {
    const scrollTop = 3634 * ROW_HEIGHT;
    const r = windowRange({ totalRows: 3635, viewportHeight: ROW_HEIGHT * 10, scrollTop });
    expect(r.last).toBe(3635);
    expect(r.first).toBeLessThanOrEqual(3634);
  });

  it("clamp scrollTop poniżej 0 i powyżej max", () => {
    expect(
      windowRange({ totalRows: 100, viewportHeight: 10 * ROW_HEIGHT, scrollTop: -500 }).first,
    ).toBe(0);
    expect(
      windowRange({
        totalRows: 100,
        viewportHeight: 10 * ROW_HEIGHT,
        scrollTop: 1e9,
      }).last,
    ).toBe(100);
  });

  it("pusta lista / zerowy viewport → puste okno", () => {
    expect(windowRange({ totalRows: 0, viewportHeight: 100, scrollTop: 0 })).toEqual({
      first: 0,
      last: 0,
      offset: 0,
    });
    expect(windowRange({ totalRows: 100, viewportHeight: 0, scrollTop: 0 })).toEqual({
      first: 0,
      last: 0,
      offset: 0,
    });
  });
});
