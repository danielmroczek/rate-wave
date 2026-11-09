// @vitest-environment node
// Parser headów ID3 (bilet #7): POPM + ReplayGain z ~64/8 KB heada przez music-metadata.

import { describe, it, expect } from "vitest";
import { parseHead } from "./id3-parser.js";
import { makeId3Head, popmBody, txxxBody, rva2Body, rvadBody } from "./test-heads.js";

describe("parseHead — POPM", () => {
  it("WMP wygrywa z cudzą wyższą ramką; kratowy bajt mapowany 1:1", async () => {
    const bytes = makeId3Head(3, [
      { id: "POPM", body: popmBody("Windows Media Player 9 Series", 128) },
      { id: "POPM", body: popmBody("foo@bar", 196) },
    ]);
    const r = await parseHead(bytes);
    expect(r).toMatchObject({ rating: 3, ratingSource: "WMP", framesSeen: true });
  });

  it("bez WMP — maksymalna bajtowa cudzych", async () => {
    const bytes = makeId3Head(3, [
      { id: "POPM", body: popmBody("a@b", 64) },
      { id: "POPM", body: popmBody("c@d", 196) },
    ]);
    const r = await parseHead(bytes);
    expect(r).toMatchObject({ rating: 4, ratingSource: "max" });
  });

  it("bajt spoza kraty → progi (255 → 5)", async () => {
    const bytes = makeId3Head(4, [{ id: "POPM", body: popmBody("Windows Media Player 11", 200) }]);
    const r = await parseHead(bytes);
    expect(r.rating).toBe(4);
  });

  it("brak ramek POPM → rating null, ratingSource null", async () => {
    const bytes = makeId3Head(3, [
      { id: "TIT2", body: new Uint8Array([0, ...new TextEncoder().encode("x")]) },
    ]);
    const r = await parseHead(bytes);
    expect(r.rating).toBe(null);
    expect(r.ratingSource).toBe(null);
    expect(r.framesSeen).toBe(false);
  });

  it("śmieci (brak ID3) → null bez rzucenia", async () => {
    const r = await parseHead(new Uint8Array(4096).fill(0x5a));
    expect(r.rating).toBe(null);
    expect(r.rgGainDb).toBe(null);
  });
});

describe("parseHead — ReplayGain", () => {
  it("TXXX replaygain_track_gain (case-insensitive) → wartość dB", async () => {
    const bytes = makeId3Head(3, [
      { id: "TXXX", body: txxxBody("ReplayGain_Track_Gain", "-6.5 dB") },
    ]);
    const r = await parseHead(bytes);
    expect(r).toMatchObject({ rgGainDb: -6.5, rgSource: "TXXX", framesSeen: true });
  });

  it("RVA2 — raw / 512 dB", async () => {
    const bytes = makeId3Head(4, [{ id: "RVA2", body: rva2Body("track", -1024) }]);
    const r = await parseHead(bytes);
    expect(r.rgSource).toBe("RVA2");
    expect(r.rgGainDb).toBeCloseTo(-2, 2);
  });

  it("TXXX ma pierwszeństwo przed RVA2", async () => {
    const bytes = makeId3Head(4, [
      { id: "TXXX", body: txxxBody("replaygain_track_gain", "+3.0 dB") },
      { id: "RVA2", body: rva2Body("track", -512) },
    ]);
    const r = await parseHead(bytes);
    expect(r.rgSource).toBe("TXXX");
    expect(r.rgGainDb).toBe(3.0);
  });

  it("RVAD fallback (v2.3, raw/512 … signature ramki bez value)", async () => {
    const bytes = makeId3Head(3, [{ id: "RVAD", body: rvadBody(-512) }]);
    const r = await parseHead(bytes);
    if (r.rgSource === "RVAD") expect(r.rgGainDb).toBeCloseTo(-1, 2);
  });
});
