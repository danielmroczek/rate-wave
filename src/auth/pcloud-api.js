// pCloud API — warstwa wywołań (bilet 03, spec §3a, §8).
// Token zawsze jako ?access_token= (preflight nie akceptuje nagłówka Authorization, T1).
// EU konta → eapi.pcloud.com; US → api.pcloud.com — hostname z OAuth fragmentu.

import { apiBaseUrl } from "./token-store.js";

/**
 * Wywołuje metodę API pCloud z tokenem.
 * @param {{ method: string, params?: Record<string, string>, token: string, hostname?: string }} opts
 * @returns {Promise<any>} JSON odpowiedź pCloud
 * @throws {Error} gdy wynik !== 0 (result code pCloud) lub network fail
 */
export async function pcloudApi({ method, params = {}, token, hostname }) {
  const url = new URL(`${apiBaseUrl({ hostname })}/${method}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  let res;
  try {
    res = await fetch(url.href);
  } catch (err) {
    // Błąd sieci (DNS, timeout, CORS, offline) — zostawiamy token, nie czyścimy.
    const e = new Error(`pCloud API network error: ${err.message}`);
    e.isNetworkError = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`pCloud API HTTP ${res.status}`);
    e.status = res.status;
    e.isAuthError = res.status === 401 || res.status === 403;
    throw e;
  }
  const data = await res.json();
  if (data.result !== 0) {
    const e = new Error(`pCloud API error ${data.result}: ${data.error || "unknown"}`);
    // pCloud result codes: 2000-2099 = auth errors (expired/invalid token)
    e.isAuthError = data.result >= 2000 && data.result <= 2099;
    throw e;
  }
  return data;
}

/**
 * Zapis pliku z nadpisaniem (bilet #8, spec §3a/§10a; T5/T7):
 * `POST uploadfile?access_token=&folderid=&nopartial=1` — multipart z jednym polem
 * plikowym; nazwa pliku wyłącznie w `Content-Disposition` (osobne pole `filename`
 * jest ignorowane przez pCloud — pułapka z T5). Ten sam folder + nazwa = overwrite
 * z zachowaniem `fileid`.
 *
 * @param {{ token: string, hostname?: string, folderId: string | number, filename: string,
 *   bytes: Uint8Array, mimeType?: string }} opts
 * @returns {Promise<{ fileid: number, name: string, size: number, modified: number }>}
 */
export async function uploadFileOverwrite({
  token,
  hostname,
  folderId,
  filename,
  bytes,
  mimeType = "audio/mpeg",
}) {
  if (!token) throw new Error("uploadFileOverwrite: token required");
  if (folderId == null || folderId === "")
    throw new Error("uploadFileOverwrite: folderId required");
  if (!filename) throw new Error("uploadFileOverwrite: filename required");

  const url = new URL(`${apiBaseUrl({ hostname })}/uploadfile`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("folderid", String(folderId));
  url.searchParams.set("nopartial", "1");
  url.searchParams.set("timeformat", "timestamp");

  // Nazwa pliku tylko tu — FormData wygeneruje `filename` w Content-Disposition.
  // Nagłówka Content-Type nie ustawiamy: boundary należy do przeglądarki.
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), filename);

  let res;
  try {
    res = await fetch(url.href, { method: "POST", body: form });
  } catch (err) {
    const e = new Error(`pCloud upload network error: ${err.message}`);
    e.isNetworkError = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`pCloud upload HTTP ${res.status}`);
    e.status = res.status;
    e.isAuthError = res.status === 401 || res.status === 403;
    throw e;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("pCloud upload: invalid JSON response");
  }
  if (data.result !== 0) {
    const e = new Error(`pCloud upload error ${data.result}: ${data.error || "unknown"}`);
    e.isAuthError = data.result >= 2000 && data.result <= 2099;
    throw e;
  }

  const meta = Array.isArray(data.metadata) ? data.metadata[0] : data.metadata;
  return {
    fileid: Number(meta?.fileid ?? data.fileids?.[0]),
    name: String(meta?.name ?? filename),
    size: Number(meta?.size) || bytes.length,
    modified: toEpochSeconds(meta?.modified, Math.floor(Date.now() / 1000)),
  };
}

/**
 * pCloud z `timeformat=timestamp` zwraca sekundy; bez niego RFC 2822. Sprowadzamy
 * oba warianty do unix seconds (Fingerprint porównuje liczby).
 * @param {unknown} value
 * @param {number} fallback
 */
function toEpochSeconds(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (value.trim() !== "" && Number.isFinite(asNumber)) return asNumber;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return fallback;
}

/**
 * Unieważnia token OAuth po stronie pCloud (`deletetoken`, #18). Wywoływane
 * przez „Sign out”; lokalne dane czyścimy niezależnie od wyniku (best-effort).
 * @param {{ token: string, hostname?: string }} opts
 * @returns {Promise<void>}
 */
export async function revokeToken({ token, hostname }) {
  if (!token) throw new Error("revokeToken: token required");
  await pcloudApi({ method: "deletetoken", token, hostname });
}

/**
 * Waliduje token przez `userinfo`. Zwraca dane użytkownika lub rzuca błąd.
 * @param {{ token: string, hostname: string }} opts
 * @returns {Promise<{ userid: number, email: string, name: string }>}
 */
export async function validateToken(opts) {
  console.log("[auth] Calling userinfo to validate token…");
  const data = await pcloudApi({ method: "userinfo", token: opts.token, hostname: opts.hostname });
  console.log("[auth] userinfo OK — userid=%s, email=%s", data.userid, data.email);
  return {
    userid: data.userid,
    email: data.email,
    name: data.name,
  };
}
