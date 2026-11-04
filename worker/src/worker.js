// rate-wave READ-PROXY (bilet 05, ADR 0001): passthrough getfilelink + bajty z ACAO.
// Worker bezstanowy — token użytkownika przychodzi w query (passthrough), nigdy
// nie jest logowany ani przekazywany poza pCloud. Logujemy tylko metodę, ścieżkę
// i wynik — NIGDY query-string.

const API_HOSTS = new Set(["eapi.pcloud.com", "api.pcloud.com"]);
const PCLOUD_HOST_RE = /\.pcloud\.com$/;
const MAX_INFLIGHT_GETFILELINK = 10;

// In-memory licznik zaległych getfilelink per token-hash (ADR 0001).
// Cold start resetuje licznik — akceptowalne: aplikacja jest jednoużytkownikowa.
const inflight = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return preflight(request, env);
    if (request.method !== "GET")
      return jsonError(405, "method_not_allowed", corsHeaders(request, env));

    if (url.pathname === "/getfilelink") return handleGetFileLink(request, env, url);
    if (url.pathname === "/stream") return handleStream(request, env, url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...corsHeaders(request, env),
        },
      });
    }
    return jsonError(404, "not_found", corsHeaders(request, env));
  },
};

// === /getfilelink: wywołanie eapi i zwrot JSON z linkiem (app używa go dla <audio>) ===
async function handleGetFileLink(request, env, url) {
  const cors = corsHeaders(request, env);
  const params = url.searchParams;
  const token = params.get("access_token");
  if (!token) return jsonError(400, "missing_access_token", cors);

  const outcome = await callGetFileLink(token, {
    fileid: params.get("fileid"),
    path: params.get("path"),
    hostname: params.get("hostname"),
    forcedownload: params.get("forcedownload"),
    contenttype: params.get("contenttype"),
  });

  // Błąd walidacji / rate-limitu: gotowa Response — doklej ACAO dla przeglądarki.
  if (outcome instanceof Response) {
    return new Response(await outcome.text(), {
      status: outcome.status,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  }
  // Odpowiedź pCloud 1:1 (result=0 lub result!=0 — decyzja po stronie aplikacji).
  return new Response(outcome.body, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

// Wywołanie getfilelink na eapi z limitem zaległych wywołań (≤10, AC).
// Zwraca {body} (JSON pCloud) albo Response (błąd walidacji / 429) — błędy
// walidacji bez ACAO; odbiorca musi je owinąć corsHeaders().
const MAX_STREAM_ATTEMPTS = 8; // IP-binding: ~85% udanych streamów wymaga kilku linków
async function callGetFileLink(token, { fileid, path, hostname, forcedownload, contenttype }) {
  hostname = hostname || "eapi.pcloud.com";
  if (!API_HOSTS.has(hostname)) return jsonError(400, "bad_api_host", {});

  const api = new URL(`https://${hostname}/getfilelink`);
  api.searchParams.set("access_token", token);
  if (fileid) api.searchParams.set("fileid", fileid);
  else if (path) api.searchParams.set("path", path);
  else return jsonError(400, "missing_fileid_or_path", {});
  if (forcedownload) api.searchParams.set("forcedownload", forcedownload);
  if (contenttype) api.searchParams.set("contenttype", contenttype);

  const tokenKey = await hashToken(token);
  if (!acquireInflight(tokenKey)) {
    console.log("getfilelink rate-limited (inflight=%d)", MAX_INFLIGHT_GETFILELINK);
    return jsonError(429, "too_many_getfilelink", {});
  }
  try {
    let res;
    try {
      res = await fetch(api.href);
    } catch (err) {
      console.error("getfilelink network error: %s", err.message);
      return jsonError(502, "upstream_network_error", {});
    }

    const body = await res.text();
    let result = null;
    try {
      result = JSON.parse(body).result;
    } catch {
      /* nie-JSON → liczymy jako błąd */
    }
    console.log("getfilelink fileid=%s http=%s result=%s", fileid, res.status, result);

    return { ok: res.ok && result === 0, body };
  } finally {
    releaseInflight(tokenKey);
  }
}

// === /stream: bajty z hosta plików pCloud z przekazaniem Range ===
// Tryby: url=<link z getTrackLink> (a) albo fileid/path+access_token (b) —
// getfilelink i pobranie bajtów w jednym wywołaniu workera, bo link pCloud
// jest powiązany z adresem IP („generated for another IP"), a egress IP
// Workera może się zmieniać między requestami.
async function handleStream(request, env, url) {
  const range = request.headers.get("Range");
  const cors = corsHeaders(request, env);

  const target = url.searchParams.get("url");
  const fileid = url.searchParams.get("fileid");
  const path = url.searchParams.get("path");
  if (!target && !fileid && !path) return jsonError(400, "missing_url", cors);

  if (!target) {
    const token = url.searchParams.get("access_token");
    if (!token) return jsonError(400, "missing_access_token", cors);

    // Link plikowy pCloud jest powiązany z IP, które wygenerowało getfilelink
    // (nieudokumentowane; „generated for another IP" → 410). Egress IP Workera
    // losuje się per-connection, więc link + download w jednym wywołaniu trafiają
    // czasem na ten sam IP — stąd kilka przebiegów w pętli (empirycznie ~1/3
    // trafi per próba).
    let lastError = null;
    for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
      const outcome = await callGetFileLink(token, {
        fileid,
        path,
        hostname: url.searchParams.get("hostname"),
        forcedownload: url.searchParams.get("forcedownload"),
        contenttype: url.searchParams.get("contenttype"),
      });
      if (outcome instanceof Response) {
        // Błąd walidacji / 429 — przepisz odpowiedź z ACAO.
        return new Response(await outcome.text(), {
          status: outcome.status,
          headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
        });
      }
      let data;
      try {
        data = JSON.parse(outcome.body);
      } catch {
        return jsonError(502, "getfilelink_error", cors);
      }
      if (data.result !== 0 || !Array.isArray(data.hosts) || !data.hosts[0]) {
        // Błąd pCloud (np. token) — przekaż JSON 1:1 ze spójnym kontraktem result code.
        return new Response(outcome.body, {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
        });
      }
      // Link powiązany z IP potrafi zadziałać na innym hoście file-serverów
      // z hosts[] (fenomen testowany empirycznie — patrz research probe) —
      // iteruj po wszystkich zanim odpalisz kolejne getfilelink.
      const hosts = data.hosts || [];
      for (const host of hosts) {
        lastError = await downloadBytes(cors, range, `https://${host}${data.path}`);
        if (lastError.status < 400) return lastError;
      }
    }
    if (lastError) {
      console.log("stream ip-binded link failed after retries (http=%s)", lastError.status);
    }
    return jsonError(502, "pcloud_link_unavailable", cors);
  }

  return downloadBytes(cors, range, target);
}

// Pobranie bajtów z walidacją hosta i przekazaniem nagłówków plikowych.
async function downloadBytes(cors, range, target) {
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonError(400, "bad_url", cors);
  }
  if (targetUrl.protocol !== "https:" || !PCLOUD_HOST_RE.test(targetUrl.hostname)) {
    return jsonError(400, "bad_target_host", cors);
  }
  // Host możliwy tylko jako wynik getfilelink — link plikowy pCloud nie zawiera tokena.
  if (targetUrl.searchParams.has("access_token")) return jsonError(400, "token_in_file_url", cors);

  const headers = new Headers();
  if (range) headers.set("Range", range);

  let res;
  try {
    res = await fetch(targetUrl.href, { headers });
  } catch (err) {
    console.error("stream network error: %s", err.message);
    return jsonError(502, "upstream_network_error", cors);
  }

  // Transparentne przepuszczenie 200/206 z nagłówkami istotnymi dla odtwarzacza.
  const out = new Headers(cors);
  for (const h of [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "Last-Modified",
    "ETag",
  ]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  console.log(
    "stream host=%s range=%s http=%s",
    targetUrl.hostname,
    range ? "present" : "none",
    res.status,
  );
  return new Response(res.body, { status: res.status, headers: out });
}

// === CORS ===
function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(requestOrUrl, env) {
  const origin = (requestOrUrl.headers ?? new Headers()).get("Origin") ?? "";
  const headers = { Vary: "Origin" };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function preflight(request, env) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request, env),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// === Rate-limit (in-memory, per token) ===
function acquireInflight(key) {
  const n = inflight.get(key) ?? 0;
  if (n >= MAX_INFLIGHT_GETFILELINK) return false;
  inflight.set(key, n + 1);
  return true;
}

function releaseInflight(key) {
  const n = (inflight.get(key) ?? 1) - 1;
  if (n <= 0) inflight.delete(key);
  else inflight.set(key, n);
}

export async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function resetInflight() {
  inflight.clear();
}

// === Pomocnicze ===
function jsonError(status, code, cors) {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}
