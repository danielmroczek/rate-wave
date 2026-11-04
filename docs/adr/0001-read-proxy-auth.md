# 0001 — Read Proxy: token passthrough w query (worker bezstanowy), nie sekret server-side

Data: 2026-11-04 · Status: zaakceptowany · Związek: bilet 05 (spec pkt 12.2, T3c)

## Kontekst

All fetch-reads of track bytes from pCloud must go through a Read Proxy
(Cloudflare Worker) because pCloud file hosts reject browser requests with an
`Origin` header (7010) and never return `Access-Control-Allow-Origin`. The
proxy must call `getfilelink` (an authenticated API method) on the user's
behalf. Two viable auth models for that call:

1. **Server-side secret** — the worker stores its own `access_token` as a
   Cloudflare secret and authenticates itself. Downside: the app is intended
   for arbitrary pCloud users whose tokens come from the app's OAuth flow
   (#3); a single baked-in secret token would act as the maintainer's token,
   coupling every user's reads to one fixed identity, and requiring manual
   provisioning/rotation separate from the app's OAuth lifecycle.
2. **Passthrough** — the app sends the user's OAuth token in the query
   (`?access_token=…`) on each call; the worker uses it server-side and never
   logs or forwards it beyond pCloud.

## Decyzja

Passthrough (option 2). The worker is stateless, holds no secrets, and acts
with the caller's identity. This exposes the token in the worker's own URL
(query string) — accepted, because:

- the token never appears on file-host URLs (links returned by `getfilelink`
  carry no token), so the acceptance criterion "no token in file-domain URLs"
  holds;
- the worker is instructed to never log query strings (only method, path,
  result, status);
- pCloud API protocol itself passes tokens in query (no `Authorization`
  preflight support, T1), so the URL surface is not a new class of exposure.

## Konsekwencje

- Worker contract: `GET /getfilelink?…&access_token=…` returns the pCloud JSON
  with the file link (used directly by `<audio>`), `GET /stream?url=…` streams
  bytes with per-origin `Access-Control-Allow-Origin` (fetch-reads: tags,
  waveform, ReplayGain, rating rewrite).
- Rate limiting (`≤10 outstanding getfilelink`) is enforced in-memory per
  token; cold start resets it, which is safe for a single-user-at-a-time app.
- Origin allowlist (workers vars), not `*`, prevents the proxy from becoming
  an open CORS relay; stream targets are restricted to `*.pcloud.com` hosts.
- Link expiry (`expires`, ~6 h) is the app's concern; the proxy stays dumb.
- **IP-bound links (discovered post-deploy)**: pCloud file links work only
  from/for certain IPs (undocumented; mismatch → HTTP 410). The worker's
  egress IP varies per connection, so `/stream` gained a `?fileid=…` mode that
  regenerates the link and retries across all `hosts[]` in one invocation
  (~85% measured success; `downloadfile` is not a fallback — result 1040).
  Evidence: [probe research](../research/probe-origin-read-proxy.md).

## Wariant docelowy (opcjonalne TODO): token w POST body

Obecny passthrough w query string jest akceptowalny (HTTPS + brak logowania
query + token nigdy nie ląduje na URL-ach hostów plików), ale można go wyciąć
z URL-i całkowicie:

- `POST /stream` i `POST /getfilelink` z tokenem w **body**
  (`application/x-www-form-urlencoded`);
- to **simple request** per CORS — bez preflightu, więc `fetch` z przeglądarki
  nadal działa wprost;
- pCloud `eapi` akceptuje POST z parametrami w body, więc passthrough po
  stronie workera zostaje 1:1.

Nieinwazyjna rozszerzona twardnienie do rozważenia razem z tym wariantem:
- przycisk rewokacji tokena w UI (`deletetoken` API);
- jawny komunikat, że token żyje w `localStorage` (bez refresha — tokeny
  OAuth pCloud nie wygasają, [research](../research/pcloud-api.md)).

Status: **nie zaplanowane do biletu 05**; osobny bilet: [#18](https://github.com/danielmroczek/rate-wave/issues/18).
