// @vitest-environment node
import { describe, it, expect } from "vitest";
import { isValidBpm, parseBpmValue, MAX_BPM } from "./bpm-value.js";

describe("parseBpmValue", () => {
  it("liczba i dopisek BPM", () => {
    expect(parseBpmValue("128")).toBe(128);
    expect(parseBpmValue(" 128 BPM ")).toBe(128);
    expect(parseBpmValue("119.6")).toBe(120);
  });

  it("śmieci / zero / ujemne → null", () => {
    expect(parseBpmValue("")).toBe(null);
    expect(parseBpmValue("fast")).toBe(null);
    expect(parseBpmValue("0")).toBe(null);
    expect(parseBpmValue("-120")).toBe(null);
  });
});

describe("isValidBpm", () => {
  it("tylko dodatnie całkowite w zakresie", () => {
    expect(isValidBpm(120)).toBe(true);
    expect(isValidBpm(MAX_BPM)).toBe(true);
    expect(isValidBpm(0)).toBe(false);
    expect(isValidBpm(120.5)).toBe(false);
    expect(isValidBpm(MAX_BPM + 1)).toBe(false);
    expect(isValidBpm("120")).toBe(false);
  });
});
