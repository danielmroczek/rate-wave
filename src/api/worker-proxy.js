// Klient READ-PROXY (bilet 05, spec §8: api/worker-proxy.js).
// Wszystkie odczyty bajtów i /getfilelink wysyłają token w body POST (#18).
// Playback nie wystawia tokena w URL-u: `fetchTrackBlob` pobiera bajty POST-em,
// a `<audio>` gra z Blob URL-a.

/**
 * Baza URL READ-PROXY (współdzielona przez worker-proxy + proxy-batch).
 */
export const PROXY_BASE_URL = import.meta.env?.VITE_RW_PROXY_URL || "http://localhost:8787";

export class ProxyError extends Error {
  constructor(code, status) {
    super(`READ-PROXY ${code}`);
    this.name = "ProxyError";
    this.statusCode = status;
    this.code = code;
  }
}

/**
 * Form-urlencoded body dla POST-ów proxy (#18) — token nie trafia do URL-a.
 * @param {Record<string, string|number|undefined|null>} fields
 * @returns {URLSearchParams}
 */
function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) body.set(key, String(value));
  }
  return body;
}

/**
 * Pobiera (przez passthrough proxy) link do pliku + czas wygaśnięcia.
 * @param {{ token: string, fileid?: string|number, path?: string, hostname?: string, contenttype?: string }} opts
 * @returns {Promise<{ link: string, expires: number }>}
 */
export async function getTrackLink({ token, fileid, path, hostname, contenttype }) {
  if (!fileid && !path) throw new Error("getTrackLink: fileid or path required");
  const res = await fetch(`${PROXY_BASE_URL}/getfilelink`, {
    method: "POST",
    body: formBody({ access_token: token, fileid, path, hostname, contenttype }),
  });
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
 * Token idzie w form-urlencoded body POST (#18); `Range` — jak dotąd — nagłówkiem.
 * @param {{ token: string, fileid?: string|number, path?: string, hostname?: string, range?: string, contenttype?: string }} opts
 * @returns {Promise<Response>} 200/206 z bajtami (do odczytu przez JS)
 */
export async function fetchTrackStream({ token, fileid, path, hostname, range, contenttype }) {
  if (!fileid && !path) throw new Error("fetchTrackStream: fileid or path required");
  const res = await fetch(`${PROXY_BASE_URL}/stream`, {
    method: "POST",
    body: formBody({ access_token: token, fileid, path, hostname, contenttype }),
    headers: range ? { Range: range } : undefined,
  });
  if (!res.ok && res.status !== 206) {
    let code = res.statusText || "proxy_error";
    try {
      code = (await res.json()).error || code;
    } catch {
      /* odpowiedź bez JSON */
    }
    throw new ProxyError(code, res.status);
  }
  await throwIfPcloudJsonError(res);
  return res;
}

/**
 * Pobiera cały Utwór przez POST /stream i zwraca Blob do `URL.createObjectURL`.
 * Odtwarzanie z Blob-a trzyma token poza URL-em (`<audio src>` nie potrafi
 * wysłać POST-a, więc zamiast URL-a proxy dostaje obiekt w pamięci, #18).
 * Pliki w bibliotece są małe (średnio ~1,6 MB), więc pełne pobranie jest
 * akceptowalne; Blob umożliwia też od razu seek po całym materiale.
 * @param {{ token: string, fileid?: string|number, path?: string, hostname?: string, contenttype?: string }} opts
 * @returns {Promise<Blob>}
 */
export async function fetchTrackBlob(opts) {
  const res = await fetchTrackStream(opts);
  return res.blob();
}

/**
 * `/stream` w trybie fileid potrafi zwrócić 200 z JSON-em pCloud, gdy getfilelink
 * zwrócił błąd (result != 0) — czytelnik bajtów musi to zobaczyć jako błąd,
 * a nie sparsować JSON jako audio (bilet #8: zapis oceny).
 * @param {Response} res
 */
async function throwIfPcloudJsonError(res) {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return;
  let data;
  try {
    data = await res.json();
  } catch {
    throw new ProxyError("unexpected_json", 502);
  }
  if (data && typeof data.result === "number") {
    const e = new Error(`pCloud stream error ${data.result}: ${data.error || "unknown"}`);
    e.isAuthError = data.result >= 2000 && data.result <= 2099;
    throw e;
  }
  throw new ProxyError(String(data?.error ?? "unexpected_json"), 502);
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
  await throwIfPcloudJsonError(res);
  return res;
}

/** Czy link wygasł według `expires` (sekundy epoch) z getTrackLink. */
export function isLinkExpired(expires, now = Date.now()) {
  return typeof expires !== "number" || now / 1000 >= expires;
}
