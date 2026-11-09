// Web Worker: parsowanie headów ID3 (music-metadata) poza wątkiem UI (bilet #7).
// Protokół: { id, bytes: ArrayBuffer } (transferable) → { id, result } | { id, error }.
import { parseHead } from "./id3-parser.js";

self.onmessage = async (/** @type {MessageEvent} */ e) => {
  const { id, bytes } = /** @type {{ id: number, bytes: ArrayBuffer }} */ (e.data);
  try {
    const result = await parseHead(new Uint8Array(bytes));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
