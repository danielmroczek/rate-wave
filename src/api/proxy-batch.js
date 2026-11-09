// Klient batchowego READ-PROXY /head (bilet #7, bilet proxy: NDJSON streamowany).
// Body: { fileids: [...] } (cap 20); odpowiedź: linia NDJSON per plik, wysyłana
// natychmiast. Retry błędów: 3 próby backoff (1 s / 5 s / 20 s).

import { ProxyError, PROXY_BASE_URL } from "./worker-proxy.js";

/** Limit batcha /head (worker cap 20; ≤50 subrequestów/request free tier). */
export const HEAD_BATCH_CAP = 20;

/** Opóźnienia retry [ms] — 3 próby po 1 s / 5 s / 20 s. */
export const HEAD_RETRY_DELAYS_MS = [1000, 5000, 20000];

/**
 * Wycina listę fileid na batche wg cap.
 * @param {number[]} fileids
 * @param {number} cap
 * @returns {number[][]}
 */
export function splitBatches(fileids, cap = HEAD_BATCH_CAP) {
  const out = [];
  for (let i = 0; i < fileids.length; i += cap) out.push(fileids.slice(i, i + cap));
  return out;
}

/**
 * base64 → bajty (NDJSON pole bytesBase64).
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Wynik pozycji batcha. @typedef {{ status: "ok", bytes: Uint8Array } | { status: "error", code: string }} HeadEntry */
/** Mapa fileid → wynik. @typedef {Map<number, HeadEntry>} HeadBatchResult */

/**
 * Jeden POST /head. Linie NDJSON trafiają do `onLine` na bieżąco; wynik = pełna
 * mapa po zamknięciu streamu. Rzuca ProxyError przy błędzie HTTP.
 * @param {{ token: string, fileids: number[], signal?: AbortSignal, onLine?: (line: any) => void }} opts
 * @returns {Promise<HeadBatchResult>}
 */
export async function fetchHeadBatch({ token, fileids, signal, onLine }) {
  if (!fileids.length || fileids.length > HEAD_BATCH_CAP) {
    throw new Error(`fetchHeadBatch: 1..${HEAD_BATCH_CAP} fileids required`);
  }
  const res = await fetch(`${PROXY_BASE_URL}/head?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileids }),
    signal,
  });
  if (!res.ok) {
    let code = res.statusText || "proxy_error";
    try {
      code = (await res.json()).error || code;
    } catch {
      /* odpowiedź bez JSON */
    }
    throw new ProxyError(code, res.status);
  }
  const result = /** @type {HeadBatchResult} */ (new Map());
  if (!res.body) return result;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // niedokończona/śmieciowa linia — pomijamy
      }
      const fileid = Number(entry.fileid);
      if (Number.isFinite(fileid)) {
        result.set(
          fileid,
          entry.status === "ok"
            ? { status: "ok", bytes: decodeBase64(String(entry.bytesBase64 ?? "")) }
            : { status: "error", code: String(entry.code ?? "unknown") },
        );
      }
      onLine?.(entry);
    }
  }
  return result;
}

/**
 * sleep injectable (testy). @param {number} ms */
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetchHeadBatch + retry (3 próby, backoff 1/5/20 s). Ostatnia porażka → throw.
 * @param {{ token: string, fileids: number[], signal?: AbortSignal, onLine?: (line: any) => void, sleep?: (ms: number) => Promise<void>, delays?: number[] }} opts
 * @returns {Promise<HeadBatchResult>}
 */
export async function fetchHeadBatchWithRetry({
  token,
  fileids,
  signal,
  onLine,
  sleep = defaultSleep,
  delays = HEAD_RETRY_DELAYS_MS,
}) {
  /** @type {any} */
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      return await fetchHeadBatch({ token, fileids, signal, onLine });
    } catch (err) {
      if (/** @type {any} */ (err)?.name === "AbortError") throw err;
      lastErr = err;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }
  throw lastErr;
}
