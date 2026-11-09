// Klient parsera headów: Web Worker (vite module worker) z fallbackiem na
// parsowanie w wątku bieżącym (testy / brak Worker global).
import { parseHead } from "./id3-parser.js";

/**
 * @returns {{ parse: (bytes: Uint8Array) => Promise<any>, dispose: () => void }}
 */
export function createHeadParser() {
  /** @type {Worker | null} */
  let worker = null;
  let seq = 0;
  /** @type {Map<number, { resolve: (r: any) => void, reject: (e: any) => void }>} */
  const pending = new Map();

  function ensure() {
    if (worker) return worker;
    worker = new Worker(new URL("./id3-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (/** @type {MessageEvent} */ e) => {
      const { id, result, error } = /** @type {any} */ (e.data);
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (error) entry.reject(new Error(error));
      else entry.resolve(result);
    };
    worker.onerror = (e) => {
      for (const [, entry] of pending) entry.reject(new Error(e.message || "worker error"));
      pending.clear();
    };
    return worker;
  }

  return {
    async parse(bytes) {
      if (typeof Worker === "undefined") return parseHead(bytes);
      const w = ensure();
      const id = ++seq;
      const copy = bytes.slice();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ id, bytes: copy.buffer }, [copy.buffer]);
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      pending.clear();
    },
  };
}
