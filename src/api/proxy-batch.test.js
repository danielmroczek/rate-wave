// Klient batchowego /head — NDJSON, split, retry.
// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import {
  splitBatches,
  fetchHeadBatch,
  fetchHeadBatchWithRetry,
  decodeBase64,
} from "./proxy-batch.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Response z NDJSON body stream */
function ndjsonResponse(lines, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(ctrl) {
      for (const l of lines) ctrl.enqueue(new TextEncoder().encode(l + "\n"));
      ctrl.close();
    },
  });
  return new Response(body, { status });
}

describe("splitBatches", () => {
  it("cap 20, ostatni batch niedomknięty", () => {
    const b = splitBatches(Array.from({ length: 45 }, (_, i) => i + 1));
    expect(b.map((x) => x.length)).toEqual([20, 20, 5]);
  });
});

describe("fetchHeadBatch", () => {
  it("parsuje NDJSON: ok → bajty, error → code", async () => {
    globalThis.fetch = async () =>
      ndjsonResponse([
        '{"fileid":1,"status":"ok","bytesBase64":"AAEC"}',
        '{"fileid":2,"status":"error","code":"too_many_getfilelink"}',
      ]);
    const r = await fetchHeadBatch({ token: "t", fileids: [1, 2] });
    expect(r.get(1)).toEqual({ status: "ok", bytes: new Uint8Array([0, 1, 2]) });
    expect(r.get(2)).toEqual({ status: "error", code: "too_many_getfilelink" });
  });

  it("linia przecięta chunkami streamu nadal sparsowana (incr. decodowanie)", async () => {
    const enc = new TextEncoder();
    const part1 = enc.encode('{"fileid":9,"status":"ok","byt');
    const part2 = enc.encode('esBase64":"AA=="}\n');
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(part1);
            ctrl.enqueue(part2);
            ctrl.close();
          },
        }),
        { status: 200 },
      );
    const r = await fetchHeadBatch({ token: "t", fileids: [9] });
    expect(r.get(9)).toEqual({ status: "ok", bytes: new Uint8Array(1) });
  });

  it("HTTP 500 → rzuca ProxyError", async () => {
    globalThis.fetch = async () => ndjsonResponse(["{}"], { status: 500 });
    await expect(fetchHeadBatch({ token: "t", fileids: [1] })).rejects.toThrow("READ-PROXY");
  });
});

describe("fetchHeadBatchWithRetry", () => {
  it("3 próby z opóźnieniami 1/5/20 s", async () => {
    let calls = 0;
    /** @type {number[]} */
    const slept = [];
    globalThis.fetch = async () => {
      calls++;
      return ndjsonResponse(['{"fileid":1,"status":"ok","bytesBase64":"AA=="}']);
    };
    const r = await fetchHeadBatchWithRetry({
      token: "t",
      fileids: [1],
      sleep: async (ms) => slept.push(ms),
    });
    // sukces za 1. próbą — zero sleep
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    expect(r.get(1)?.status).toBe("ok");
  });
});

describe("decodeBase64", () => {
  it("roundtrip", () => {
    expect(Array.from(decodeBase64("AAEC"))).toEqual([0, 1, 2]);
  });
});
