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

- Worker contract (po #18): `POST /getfilelink` (form body) returns the pCloud
  JSON with the file link, `POST /stream` (form body) streams bytes with
  per-origin `Access-Control-Allow-Origin` (fetch-reads: tags, waveform,
  ReplayGain, rating rewrite, playback Blob), `GET /stream?url=…` streams a
  known link, and legacy `GET /stream?fileid=…&access_token=…` remains only for
  pre-#18 PWA clients.
- Rate limiting (`≤12 outstanding getfilelink`; podniesione z 10 przy #19 —
  /head używa 12 równoległych fetchy, pomiar: brak 429 do 30 równoległych)
  is enforced in-memory per
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

## Aktualizacja 2026-11-18 (#18): token w POST body

Token nie jest już wysyłany w query przez klientów JS. Wdrożono wariant
docelowy:

- `POST /getfilelink` i `POST /stream` przyjmują parametry (w tym
  `access_token`) w **body** `application/x-www-form-urlencoded`;
  `POST` z innym `Content-Type` jest odrzucany (`unsupported_content_type`),
  więc token nie może wrócić do query stringa;
- `/getfilelink` i `/head` są **POST-only**; `/head` przyjmuje `access_token`
  w JSON body (`{"fileids":[…],"access_token":"…"}`, migracja zapowiedziana
  w bilecie #19);
- pCloud `eapi` akceptuje POST z parametrami w body, więc passthrough zostaje
  1:1; POST z form-urlencoded jest CORS **simple request** (preflight tylko
  wtedy, gdy klient dokłada nagłówek `Range`, co worker i tak obsługuje);
- `<audio src>` nie potrafi wysłać POST-a, więc odtwarzanie **nie używa już
  URL-a proxy z tokenem**: `fetchTrackBlob` pobiera cały Utwór przez
  `POST /stream`, a player gra z Blob URL-a (pliki są małe, średnio ~1,6 MB).
  Dzięki temu bieżąca aplikacja nie umieszcza tokena w żadnym URL-u.

**Legacy:** `GET /stream?fileid=…&access_token=…` zostaje w workerze wyłącznie
dla starych wersji PWA w cache'ach przeglądarek. Nowe klienty go nie używają;
usunąć po przejściu cache rollover. Token nigdy nie trafia na URL-e hostów
plików pCloud i nie jest logowany.

Dodatkowe twardnienie z biletu #18:

- UI „Sign out” (`auth-flow.signOut`) woła `deletetoken` (best-effort, token
  z IDB albo fallback z localStorage), a następnie usuwa lokalną kopię tokena
  (localStorage + mirror IDB) i cały rekord źródła wraz z wyborem folderu;
- udokumentowano, że token żyje w `localStorage` i nie wygasa (brak refresha —
  [research](../research/pcloud-api.md)); „Clear all data” czyści oba magazyny.
