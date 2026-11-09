// Hierarchia POPM (spec §2b) — czysta logika.
import { describe, it, expect } from "vitest";
import { byteToStars, pickRating, isWmpSource } from "./rating-byte.js";

describe("byteToStars — progi bajtowe", () => {
  it("krata {1,64,128,196,255} mapowana 1:1", () => {
    expect(byteToStars(1)).toBe(1);
    expect(byteToStars(64)).toBe(2);
    expect(byteToStars(128)).toBe(3);
    expect(byteToStars(196)).toBe(4);
    expect(byteToStars(255)).toBe(5);
  });
  it("bajty poza kratą → progi", () => {
    expect(byteToStars(62)).toBe(1);
    expect(byteToStars(127)).toBe(2);
    expect(byteToStars(150)).toBe(3);
    expect(byteToStars(254)).toBe(4);
  });
  it("bajt 0 i nonsense → null (ocena zdjęta)", () => {
    expect(byteToStars(0)).toBe(null);
    expect(byteToStars(-1)).toBe(null);
    expect(byteToStars(NaN)).toBe(null);
  });
});

describe("pickRating — hierarchia", () => {
  it("pusto → null (brak oceny, nie 0)", () => {
    expect(pickRating([])).toBe(null);
    expect(pickRating(undefined)).toBe(null);
  });
  it("WMP wygrywa, nawet gdy cudzy bajt wyższy", () => {
    const r = pickRating([
      { email: "a@b", rating: 255 },
      { email: "Windows Media Player 9 Series", rating: 128 },
    ]);
    expect(r).toEqual({ stars: 3, source: "WMP" });
  });
  it("bez WMP — maksymalna bajtowa cudzych", () => {
    const r = pickRating([
      { email: "x@y", rating: 196 },
      { email: "z@w", rating: 64 },
    ]);
    expect(r).toEqual({ stars: 4, source: "max" });
  });
  it("kilka ramek WMP → maksymalna z WMP", () => {
    const r = pickRating([
      { email: "Windows Media Player", rating: 128 },
      { email: "Windows Media Player 11", rating: 255 },
    ]);
    expect(r).toEqual({ stars: 5, source: "WMP" });
  });
  it("same bajty 0 → null", () => {
    expect(pickRating([{ email: "a@b", rating: 0 }])).toBe(null);
  });
  it("isWmpSource case-insensitive", () => {
    expect(isWmpSource("windows media player 9 series")).toBe(true);
    expect(isWmpSource("a@b")).toBe(false);
  });
});
