// Klient READ-PROXY (bilet 05, spec §8: api/worker-proxy.js).
// Wywołania fetch przez proxy: /getfilelink (link dla <audio>) i /stream (bajty
// z ACAO dla odczytu tagów / waveformu / ReplayGain). <audio> gra bezpośrednio
// z linku — przez proxy idą tylko bajty czytane przez JS (T3c).

const PROXY_BASE_URL = import.meta.env?.VITE_RW_PROXY_URL || "http://localhost:8787";

export class ProxyError extends Error {
  constructor(code, status) {
    super(`READ-PROXY ${code}`);
    this.name = "ProxyError";
    this.statusCode = status;
    this.code = code;
  }
}

/**
 * Pobiera (przez passthrough proxy) link do pliku + czas wygaśnięcia.
 * @param {{ token: string, fileid?: string|number, path?: string, hostname?: string, contenttype?: string }} opts
 * @returns {Promise<{ link: string, expires: number }>}
 */
export async function getTrackLink({ token, fileid, path, hostname, contenttype }) {
  if (!fileid && !path) throw new Error("getTrackLink: fileid or path required");
  const url = new URL(`${PROXY_BASE_URL}/getfilelink`);
  url.searchParams.set("access_token", token);
  if (fileid != null) url.searchParams.set("fileid", String(fileid));
  if (path) url.searchParams.set("path", path);
  if (hostname) url.searchParams.set("hostname", hostname);
  if (contenttype) url.searchParams.set("contenttype", contenttype);

  const res = await fetch(url.href);
  if (res.status === 429) throw new ProxyError("too_many_getfilelink", 429);
  const data = await res.json();

  // Błędy proxy: 4xx/5xx zwracają {error}; 200 to JSON pCloud (result code).
  if (res.status >= 400) throw new ProxyError(data.error, res.status);
  if (data.result !== 0) {
    const e = new Error(`pCloud getfilelink error ${data.result}: ${data.error || "unknown"}`);
    e.isAuthError = data.result >= 2000 && data.result <= 2099;
    throw e;
  }
  const link = `https://${data.hosts[0]}${data.path}`;
  return { link, expires: data.expires };
}

/**
 * Czyta bajty utworu przez /stream z generowaniem linku w locie (tryb fileid).
 * Preferowany przepływ: pCloud link jest powiązany z IP, a egress IP Workera
 * losuje się per połączenie — /stream sam generuje link i pobiera bajty
 * w jednym wywołaniu: retry (8 × getfilelink + wszystkie hosty z hosts[]).
 * Skuteczność (zmierzone na produkcji, 27 prób): ~85%; brak rozwiązania na 100%.
 * @param {{ token: string, fileid?: string|number, path?: string, hostname?: string, range?: string, contenttype?: string }} opts
 * @returns {Promise<Response>} 200/206 z bajtami (do odczytu przez JS)
 */
export async function fetchTrackStream({ token, fileid, path, hostname, range, contenttype }) {
  if (!fileid && !path) throw new Error("fetchTrackStream: fileid or path required");
  const url = new URL(`${PROXY_BASE_URL}/stream`);
  url.searchParams.set("access_token", token);
  if (fileid != null) url.searchParams.set("fileid", String(fileid));
  if (path) url.searchParams.set("path", path);
  if (hostname) url.searchParams.set("hostname", hostname);
  if (contenttype) url.searchParams.set("contenttype", contenttype);
  const res = await fetch(url.href, { headers: range ? { Range: range } : undefined });
  if (!res.ok && res.status !== 206) {
    let code = res.statusText || "proxy_error";
    try {
      code = (await res.json()).error || code;
    } catch {
      /* odpowiedź bez JSON */
    }
    throw new ProxyError(code, res.status);
  }
  return res;
}

/**
 * Czyta bajty utworu już znanym linkiem przez /stream?url= (opcjonalny Range).
 * UWAGA: link pCloud jest powiązany z IP generacji — rzadko czytelny poza
 * workerem; typowo użyj fetchTrackStream.
 * @param {string} fileUrl link z getTrackLink
 * @param {{ range?: string }} opts np. { range: "bytes=0-65535" }
 * @returns {Promise<Response>} odpowiedź 200/206 (body do odczytu przez JS)
 */
export async function fetchTrackBytes(fileUrl, { range } = {}) {
  const url = `${PROXY_BASE_URL}/stream?url=${encodeURIComponent(fileUrl)}`;
  const headers = range ? { Range: range } : undefined;
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 206) {
    let code = res.statusText || "proxy_error";
    try {
      code = (await res.json()).error || code;
    } catch {
      /* odpowiedź bez JSON */
    }
    throw new ProxyError(code, res.status);
  }
  return res;
}

/** Czy link wygasł według `expires` (sekundy epoch) z getTrackLink. */
export function isLinkExpired(expires, now = Date.now()) {
  return typeof expires !== "number" || now / 1000 >= expires;
}
