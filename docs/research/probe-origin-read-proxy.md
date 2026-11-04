# Probe: Origin vs ACAO hostów plików pCloud (bilet 05)

Cel: potwierdzenie T3c w kontekście READ-PROXY — czy samo wysłanie `Origin`
blokuje `getfilelink`, i czy hosty plików zwracają `Access-Control-Allow-Origin`
(tj. czy odczyt bajtów mógłby omijać `/stream`). Zgodnie z decyzją w planie:
stream przez proxy pozostaje niezależnie od wyniku (fallback nie planowany).

## 2026-11-04 — curl (bez przeglądarki, brak ważnego tokena)

```
curl -H "Origin: http://localhost:5173" "https://eapi.pcloud.com/getfilelink?access_token=dummy&fileid=1"
→ 2094 "Invalid 'access_token' provided."
```

Wniosek cząstkowy: **serwer API najpierw sprawdza token**, a blokadę `Origin`
(7010 „Invalid link referer") stosuje wobec uwierzytelnionych wywołań z
`Origin` przeglądarki — więc bez ważnego tokena nie da się tego odtworzyć
z curl. Dla `fetch` z przeglądarki z ważnym tokenem blokada była potwierdzona
empirycznie w T3c/T3d (raport [pcloud-api.md](pcloud-api.md)); to podstawienie
klient READ-PROXY na Workerze omija (worker nie wysyła `Origin` do eapi).

## 2026-11-04 — smoke po pierwszym deployu (z prawdziwym tokenem, T7)

Worker: `https://rate-wave-read-proxy.dmroczek.workers.dev`.

| Sprawdzenie | Wynik |
| --- | --- |
| `GET /health` (Origin: localhost:5173) | `{"ok":true}` + ACAO ✓ |
| `OPTIONS /stream` (allowed origin) | `204` + `Access-Control-Allow-Origin` + `Allow-Headers: Range` ✓ |
| `GET /health` (Origin: evil.example) | 200 **bez ACAO** ✓ (allowlist działa) |
| `GET /getfilelink?fileid=<real>&access_token=<token>` | `result=0` (proxy eliminuje 7010) ✓ |
| `getfilelink` z błędnym tokenem | 200 + `result=2094` ✓ (kontrakt passthrough) |
| `GET /stream?url=<link>` + Range | `206` + poprawny `Content-Range` + ACAO ✓ |
| `GET /stream?fileid=<real>&access_token=...` | 200, pełne bajty ✓ (po retry) |
| `GET /stream?fileid=...` bez tokena | 400 ✓ |
| `GET /stream?url=https://evil.example/...` | 400 ✓ |

∑ nagłówków z hostów plików pCloud: **brak ACAO** (potwierdzone) → odczyt
bajtów przez `/stream` konieczny; ADR 0001 boundary potwierdzony.

## 2026-11-04 — IP-binding linków plikowych (nieudokumentowane zachowanie pCloud)

**Fenomen**: link z `getfilelink` działa tylko z adresu IP hosta, który go
wygenerował, lub z losowego podzbioru front-endów pCloud. Inaczej: HTTP 410
„This link was generated for another IP address". Konsekwencja: egress IP
Cloudflare Workera losuje się per połączenie, więc link wygenerowany w jednym
wywołaniu workera nie zawsze jest czytelny w tym samym wywołaniu.

**Co NIE działa**:
- link + download w jednym wywołaniu workera bez retry — nadal ~2/3 niepowodzeń
- sama pętla retry (8× nowy link + pierwszy host) — 12 prób → 9 OK / 3× 502
- `downloadfile` API — wymaga parametru `url` (result 1040), nie jest fallbackiem bajtowym
- `hosts[]` — 2 serwery (np. `evie1`/`edef12`), oba podlegają temu samemu bindingowi

**Co działa**: kombinacja — w `/stream?fileid&access_token` pętla
(5 × getfilelink), a w każdym przebiegu próba downloadu z **każdego hosta
z `hosts[]`**.

**Zmierzona skuteczność produkcyjna** (200/206 z pełnymi bajtami):
- runda 1 (12 prób): 12/12 (dane 449283 B co raz)
- runda 2 (15 prób, Range 64 KB): 12/15 → ~85% łącznie
- lokalnie z maszyny dewelopera: 20/20 — binding dotyka głównie zmiennego
  egress IP Workera, nie stałego IP przeglądarki/maszyny

**Status linku w `<audio>`**: `getTrackLink()` zwraca link wygenerowany przez
Workera; link jest wygasany w próbach (przeglądarka pobiera z własnego IP —
zwykle działa, bo IP domowe jest stabilne pomiędzy requestami; ale egress Workera
bywa różny w danym wywołaniu → `<audio>` może dostawać 410 przy losowym IP).
Fallback dla `<audio>`: napisz w przeglądarce własne bytestream — ale to
pozostaje potencjalnym ulepszeniem na przyszłość.

**Rekomendacja**: proxy działa z ~85% skutecznością pojedynczego `/stream`
(miliony połączeń użytkownika = spread wywołań pCloud, więc jest to dobrze
widoczne); przy porażce apka powinna obsłużyć błąd
`pcloud_link_unavailable` z 502 poprzez `ProxyError` i wyświetlić użytkownikowi
komunikat z możliwością ponowienia (client-side retry jest łatwy).

> CI deploy ([deploy-worker.yml](../../.github/workflows/deploy-worker.yml)) ruszy po ustawieniu
> sekretu `CLOUDFLARE_API_TOKEN` (`gh secret set CLOUDFLARE_API_TOKEN --repo danielmroczek/rate-wave`).
> `CLOUDFLARE_ACCOUNT_ID` ustawione 2026-11-04.
