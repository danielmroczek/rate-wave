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
