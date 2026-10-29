# pCloud API dla aplikacji 100% przeglądarkowej — research

Data: 2026-10-26 · Źródła: docs.pcloud.com, repo SDK `pCloud/pcloud-sdk-js`, własne testy curl (CORS).
Ticket: `.scratch/music-rater-target/issues/02-pcloud-api.md`

---

## Podsumowanie

**Werdykt: WARUNKOWO TAK** — wariant 100% przeglądarkowy jest realny (OAuth implicit, nadpisywanie plików i przekazywanie tokena w URL są udokumentowane, a CORS na API potwierdzony empirycznie), ale **warunkiem jest przejście 2 testów empirycznych**, których dokumentacja nie rozstrzyga:

1. **Ograniczenie referera na `getfilelink`/`getaudiolink`** — obie metody mają w dokumentacji dopisek *"This method can't be used from web applications. Referrer is restricted to pcloud.com."* Nie wiadomo, czy polityka `Referrer-Policy: no-referrer` z pominięciem nagłówka `Referer` omija ten block (prawdopodobne, ale niepewne). To ryzyko nr 1 i to ono decyduje o potrzebie proxy.
2. **Range + CORS na serwerach plików** (`cXX.pcloud.com`) — `<audio>` wymaga HTTP Range dla scrubowania; dokumentacja nie opisuje nagłówków serwera zawartości ani parametru `range`. Do testu.

**Trzy kluczowe fakty:**

1. **CORS na `api.pcloud.com`/`eapi.pcloud.com`: POTWIERDZONY EMPIRYCZNIE** (test curl 2026-10-26): `Access-Control-Allow-Origin: *` na GET i błędach API, preflight `OPTIONS` zwraca `Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS`. **Uwaga:** serwer **nie** zwraca `Access-Control-Allow-Headers`, więc nagłówek `Authorization` nie przeszedłby preflightu — token przekazujemy jako **parametr zapytania** `access_token=` (udokumentowany parametr globalny), nie jako nagłówek.
2. **OAuth dla czystego klienta:** pCloud oficjalnie rekomenduje **token flow (implicit)** dla aplikacji klienckich („Token flow is appropriate for pure client-side apps – such for mobile devices or based only on JavaScript"); token nie wygasa („the access tokens given from pCloud API do not expire"). **PKCE: nie istnieje** w dokumentacji. Flow `code` jest też wykonalny z przeglądarki (wymaga wymiany `code`→`access_token` z `client_secret` w requescie do API — secret exposure, ale flow oficjalnie wspierany; SDK to pokazuje). `hostname` (`api…` vs `eapi…`) i `locationid` przychodzą w odpowiedzi OAuth.
3. **Zapis z powrotem:** `uploadfile` z **tym samym `filename`** do tego samego `folderid` **nadpisuje plik**, a stara wersja zostaje jako rewizja: *"If a file with the same name already exists in the directory, it is overwritten and old one is saved as revision."* Czyli dokładnie model wymagany przez music-rater (modyfikacja ID3 → upload w to samo miejsce → pCloud trzyma wersje). Historia wersji dostępna przez `listrevisions`/`revertrevision`.

---

## 1. OAuth i rejestracja aplikacji

### Rejestracja aplikacji
- Portal developerów to **`https://docs.pcloud.com/my_apps/`** (wymaga zalogowania kontem pCloud; strona logowania się renderuje — nie dało się zweryfikować dokładnych pól formularza). Odnośnik „My Apps” jest widoczny w menu każdej strony docs.pcloud.com. Rejestracja daje `client_id` (public) oraz `app_secret`. Adres `https://developers.pcloud.com/` zwrócił 404 — jedynym działającym portalem jest `docs.pcloud.com/my_apps/`.
- Dokumentacja OAuth indeks: `https://docs.pcloud.com/methods/oauth_2.0/` — tylko dwie metody: `authorize` i `oauth2_token`.
- ❗ Niezweryfikowane: czy pCloud wymaga rejestracji whitelisty `redirect_uri` przy tworzeniu aplikacji i jakie wartości akceptuje (dokumentacja milczy). Do testu po założeniu appki.

### Flow autoryzacji
Źródło: [authorize](https://docs.pcloud.com/methods/oauth_2.0/authorize.html).

- URL startowy: `https://my.pcloud.com/oauth2/authorize` z `client_id` + `response_type` = `code` lub `token`.
- **Token (implicit) flow**: token przylatuje w **fragmencie URI** (`#access_token=…&token_type=bearer&uid=…&state=…&locationid=[1|2]&hostname=[api.pcloud.com|eapi.pcloud.com]`). Fragment nie trafia do serwera — idealny dla statycznego hosta. `redirect_uri` jest **obowiązkowy** dla token flow.
  - Cytat: *"Token flow is appropriate for pure client-side apps – such for mobile devices or based only on JavaScript."*
- **Code flow**: `redirect_uri` **opcjonalny** — jeśli pominąć, pCloud **wyświetla kod użytkownikowi do skopiowania** (przydatny fallback desktopowy). Wymiana kodu: [oauth2_token](https://docs.pcloud.com/methods/oauth_2.0/oauth2_token.html) (`client_id` + `client_secret` + `code`) → `{access_token, token_type: "bearer", uid}`.
- `state` wspierany (anti-CSRF). `force_reapprove`, `permissions` (`manageshares`) — opcjonalne.

### redirect_uri — co działa
- Z przykładów oficjalnego SDK: `redirect_uri: 'http://127.0.0.1:8080/oauth.html'` ([examples/upload.html](https://github.com/pCloud/pcloud-sdk-js/blob/master/examples/upload.html), [listfolder.html](https://github.com/pCloud/pcloud-sdk-js/blob/master/examples/listfolder.html)) — **localhost/http 127.0.0.1 jest akceptowany** (przynajmniej dla tych zarejestrowanych app). SDK `docs/oauth.md`: *"Setup a redirect url to which you have access to and can place a static html page"* → **zwykły statyczny https host to obsługiwany scenariusz**.
- Custom URI scheme dla PWA: **brak danych w docs** — wymaga testu (najpewniej odrzucone; bezpieczniej użyć zwykłego https URL + obsługi fragmentu w tej samej stronce).

### Tokeny — używanie i życie
- [Global parameters](https://docs.pcloud.com/methods/intro/global_parameters.html): `access_token` – „This is an OAuth 2.0 bearer token…"; można go dać w URL-u **albo** w nagłówku `Authorization: Bearer …` ([OAuth 2.0 index](https://docs.pcloud.com/methods/oauth_2.0/)) — **w przeglądarce używamy parametru zapytania**, bo preflight nie akceptuje nagłówka `Authorization` (patrz sekcja CORS).
- [OAuth 2.0 index](https://docs.pcloud.com/methods/oauth_2.0/): *"With the current implementation the access tokens given from pCloud API do not expire."* → **brak refresh tokena i brak odświeżania** (uproszczenie — token trzymamy w `localStorage`).
- Dla tokenów z logowania `getauth` istnieją `authexpire` (max 2 lata) i `authinactiveexpire` (max ~62 dni) ([global_parameters](https://docs.pcloud.com/methods/intro/global_parameters.html), [authentication](https://docs.pcloud.com/methods/intro/authentication.html)); widok wszystkich tokenów: `listtoken`.
- **PKCE: NIE** — nie ma `code_challenge`/`code_verifier` w żadnej z dwóch metod OAuth; to starszy, uproszczony OAuth-2.

### Alternatywa: poll_token (bez redirect_uri)
SDK JS implementuje `initOauthPollToken({client_id, …})` — otwiera popup autoryzacji z losowym `request_id`, a przeglądarka polling’uje `oauth2_token` z `response_type=poll_token` po obu serwerach (`api` i `eapi`), aż token się pojawi ([src/oauth/index.js](https://github.com/pCloud/pcloud-sdk-js/blob/master/src/oauth/index.js)). To pozwala **całkiem pominąć redirect_uri** — ciekawa opcja dla PWA/desktopowego wariantu. Nie jest to udokumentowane na docs.pcloud.com — traktować jako „SDK-internal", do owinięcia fallbackiem.

---

## 2. CORS i SDK JS

### CORS — testy własne (2026-10-26, curl)
Testy (dokładne komendy w sekcji „Testy empiryczne", T1):

| scena | wynik |
| --- | --- |
| `GET https://api.pcloud.com/getapiserver` z `Origin: https://example.com` | `HTTP 200` + **`Access-Control-Allow-Origin: *`** |
| `GET https://eapi.pcloud.com/getapiserver` z `Origin` | `HTTP 200` + **`Access-Control-Allow-Origin: *`** |
| Preflight `OPTIONS /listfolder` (Requested-Method: GET, Request-Headers: authorization) | `200`, `ACAO: *`, `Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS`, `Access-Control-Max-Age: 86400`; **brak `Access-Control-Allow-Headers`** |
| Preflight `OPTIONS /uploadfile` (POST, content-type) | `200`, `ACAO: *`, `Allow-Methods: GET, POST, PUT, OPTIONS` |
| `GET /listfolder` bez auth (odpowiedź błędu `{"result":1000}`) | `ACAO: *` także na błędach; błąd w body JSON + `X-Error: 1000` |

**Wnioski:**
- ✅ `fetch` z przeglądarki na `api.pcloud.com` i `eapi.pcloud.com` zadziała (listing JSON, upload, wymiana kodu OAuth `oauth2_token`).
- ❗ `ACAO: *` oznacza, że request musi iść z `credentials: 'omit'` (domyślnie tak). Nie możemy używać cookies z pcloud.com do auth — niepotrzebne, token idzie w URL.
- ❗ Preflight nie odbija nagłówków requestu (`Access-Control-Allow-Headers` brak). Nagłówek `Authorization` zablokuje pytanie preflightem w Chrome. **Dokumentacja** twierdzi, że `Authorization: Bearer` wspierany — ale **empirycznie nie for CORS**. → Używamy `?access_token=`.
- ⚠️ Ten zestaw testów nie obejmuje serwerów zawartości `cXX.pcloud.com` (patrz T3/T4).

### Community/Knowledge
- Oficjalny **JavaScript SDK istnieje i celuje w przeglądarkę**: [docs.pcloud.com/sdks/javascript.html](https://docs.pcloud.com/sdks/javascript.html) → [github.com/pCloud/pcloud-sdk-js](https://github.com/pCloud/pcloud-sdk-js). Ma `src/utils/browser/…` oraz `examples/*.html` (listfolder, upload, download, oauth w popupie) — łączenie przez `<script src="https://unpkg.com/pcloud-sdk-js@latest/dist/pcloudsdk.js">` w docs [install.md](https://github.com/pCloud/pcloud-sdk-js/blob/master/docs/install.md).
- SDK `createClient(token, type, useProxy)` — domyślnie OAuth token; `useProxy: true` żąda najbliższego API-proxy przez `getapiserver` i fallbackuje na `api.pcloud.com` przy network-error ([docs/createclient.md](https://github.com/pCloud/pcloud-sdk-js/blob/master/docs/createclient.md)). Niestety SDK nie podbija `ApiMethod` default `eapi…` vs `hostname` z OAuth — w ApiMethod default jest `eapi.pcloud.com`, w createClient fallbackowa wartość `api.pcloud.com`; **u nas i tak bierzemy `hostname` z OAuth**.
- Uwaga SDK: *"some are subject to restrictions, if you use `oauth`"* ([docs/api.md](https://github.com/pCloud/pcloud-sdk-js/blob/master/docs/api.md)) — nie sprecyzowano, o które metody chodzi; prawdopodobnie właśnie o `getfilelink`-niestreamingowe.
- W dockach nie znaleziono wprost ostrzeżenia o braku CORS; dopisek o refererze przy `getfilelink`/`getaudiolink` jest jedynym „wrogim dla webu” elementem.

---

## 3. Listing folderów — `listfolder`

Źródło: [listfolder](https://docs.pcloud.com/methods/folder/listfolder.html).

- `GET https://{hostname}/listfolder?access_token=…&folderid=…` — `folderid` **albo** `path` (path jest odradzany przez docs; root folder ma `folderid=0` — [general](https://docs.pcloud.com/)).
- Opcjonalne: `recursive`, `showdeleted`, `nofiles` (tylko podfoldery), `noshares`.
- Odpowiedź: `metadata` folderu z `contents` — pliki mają `fileid`, `name`, `size`, `contenttype` (np. `audio/mpeg`), `category: 3` (audio wg przykładu), **`modified`** (RFC 2822, np. `"Wed, 02 Oct 2013 13:23:19 +0000"`), `created`, `hash`, `path`.
- **Paginacja: BRAK**. `listfolder` nie ma `pagestart`/`pagelimit` (te parametry występują w innych pCloud API, nie tutaj) — klient dostaje **cały** katalog w jednym JSON-ie. Dla scenariusza „wybierz folder → playlista” to OK (katalogi z nagraniami mają dziesiątki–setki plików).
- **Filtrowanie po rozszerzeniu: BRAK** server-side — filtrowanie po stronie klienta po `name`/`category` (albo globalne `filtermeta`/`filterfilemeta` żeby zredukować ruch — patrz [global_parameters](https://docs.pcloud.com/methods/intro/global_parameters.html)).
- Rozwiązanie folderid vs path: wystarczy `listfolder?folderid=0`, użytkownik klika po folderach (lub SDK `listfolder(folderid)`).
- Czas modyfikacji: używamy `modified` + parametr globalny `timeformat=timestamp` dla lekkiego porównywania (unix ts zamiast RFC 2822).

---

## 4. Odtwarzanie audio: `getfilelink` vs `getaudiolink`

### `getfilelink` — link do pliku
Źródło: [streaming/getfilelink](https://docs.pcloud.com/methods/streaming/getfilelink.html).

- `GET /getfilelink?access_token=…&fileid=…` → `{ path, expires, hosts: ["c63.pcloud.com", …] }`; **URL budujemy sami**: `https://{hosts[0]}{path}`.
- Opcje: `forcedownload` (Content-Type octet-stream), `contenttype` (własny!), `maxspeed`, `skipfilename`.
- ⚠️ **KRYTYCZNE DLA PRZEGLĄDARKI**: na górze strony opisu: *"This method can't be used from web applications. Referrer is restricted to pcloud.com."*
  - Interpretacja: pCloud najwyraźniej sprawdza nagłówek `Referer` wysłany przez przeglądarkę przy metodach streamingowych; jeśli widać nie-pcloud referrer → ODMOWA. Nagłówek `Referer` da się wyzerować w aplikacji polityką `no-referrer` (`<meta name="referrer" content="no-referrer">` lub `Referrer-Policy: no-referrer`) — wtedy serwer może (a) przepuścić żądanie (brak nagłówka = brak ograniczenia) albo (b) odmówić „bezpośrednio”. **Dokumentacja milczy o (b).** → Test T3 rozstrzyga.
  - Uwaga: `file/getfilelink` (bliźniacza ścieżka w kategorii „File” w menu docs) zwraca tylko ogólne boilerplate — nie udało się zweryfikować, czy pod tym adresem istnieje osobny wariant metody.
- Żywotność linku: odpowiedź zawiera pole **`expires`** (data), ale **dokładny TTL NIE jest udokumentowany** — dokumentacja pokazuje `expires` tylko w przykładzie. Bezpiecznik: prosić o świeży link przy starcie odtwarzania i regenerować przy `onerror`.
- **Parametr `range`: NIE ISTNIEJE** w opisie metody. HTTP Range na serwerze zawartości musi być sprawdzony empirycznie (T4) — bez tego `<audio seek>` może nie działać poprawnie (albo działa, bo Apache/CloudHTTPd zwykle wspiera `Accept-Ranges: bytes`).

### `getaudiolink` — transkodowanie audio
Źródło: [streaming/getaudiolink](https://docs.pcloud.com/methods/streaming/getaudiolink.html).

- Serwuje audio **transkodowane do MP3** (abitrate 16–320 kbit, domyślnie 192) i pozwala **wyciągnąć ścieżkę audio z wideo**; link wspiera parametr **`start`** (sekundy — przeskok). Przydatny, gdy w chmurze znajdą się nagrania w formatach innych niż MP3 (np. FLAC).
- ⚠️ To samo ograniczenie referera: *“This method can't be used from web applications. Referrer is restricted to pcloud.com.”* → ten sam test T3.
- Interpretacja: własny odtwarzacz pCloud korzysta z tych metod z domeny pcloud.com — to zabezpieczenie anty-hotlinkowe, a nie kwestia CORS.

### Waveform (Web Audio)
- Aby zdekodować MP3 do waveformu (`decodeAudioData`), potrzebne jest pobranie (przynajmniej początku) pliku z **CORS**-allowed origin (fetch/XHR). Zwykłe `<audio src=…>` bez `crossOrigin` gra nawet bez CORS, ale MediaElementSource/decodeAudioData wymaga nagłówków CORS na serwerze **pliku** (`cXX.pcloud.com`) — **dokumentacja milczy**; test T4. Fallback: brak waveformu.

---

## 5. Zapis z powrotem — `uploadfile`, wersjonowanie, atomowość

Źródło: [uploadfile](https://docs.pcloud.com/methods/file/uploadfile.html).

- `POST https://{hostname}/uploadfile` — `multipart/form-data`; natywnie zgodne z `<form>` / `FormData` z przeglądarki (parametry **przed plikami**). Auth: `access_token=…` w URL.
- Pole formularza obojętne; nazwa pliku brana z `filename` w części multipart (tak jak robi to przeglądarka) lub parametr `filename`.
- **SEMANTYKA NADPISYWANIA (kluczowy cytat):**
  > *"If a file with the same name already exists in the directory, it is overwritten and old one is saved as revision. Overwriting a file with the same data does nothing except updating the modification time of the file."*
  
  Czyli **uploadfile z tym samym `filename` do tego samego `folderid` = replaced**, i pCloud zachowuje starą wersję jako rewizję. Brak potrzeby delete+upload. Opcja `renameifexists=1` odwrotna — tworzy `name (2).ext`; **my NIE używamy**.
- Opcje użyteczne:
  - `nopartial=1` — połączenie przerwane → nie zostawi posiekłego pliku. **Zalecane w nas** (partial MP3 w chmurze = uszkodzony utwór).
  - `mtime` (i `ctime` z `mtime`) — zachowanie „starej" daty modyfikacji przy odnowionej wersji (przydatne, bo ratingu nie chcemy traktować jako „nagrano-świeżego"). Do decyzji w produktie.
  - `progresshash` + [`uploadprogress`](https://docs.pcloud.com/methods/file/uploadprogress.html) — progress polling; alternatywnie XHR `upload.onprogress` w przeglądarce (prostsze).
- Odpowiedź: `{fileids:[…], metadata:[…]}` — z niej łatwo zaktualizować metadata pozycji w UI.
- **Wersjonowanie / historia wersji:**
  - [listrevisions](https://docs.pcloud.com/methods/revisions/listrevisions.html) — lista rewizji (`revisionid`, `size`, `hash`, `created`) dla `fileid`/`path`.
  - [revertrevision](https://docs.pcloud.com/methods/revisions/revertrevision.html) — powrót do wersji (mechanizm „cofij ocenę" na poziomie pliku).
  - Globalnie: metody `fileid`-owe akceptują `revisionid` (np. `getfilelink` starej wersji) — patrz [global_parameters](https://docs.pcloud.com/methods/intro/global_parameters.html).
- **Atomowość:** upload jest jednorazowy, ale **nie daje gwarancji interleaving** — równoległe ocenianie tej samej piosenki (2 strony) może nałożyć się na siebie. W aplikacji single-user; wystarczy kolejka serializująca uploady + `nopartial`. Fallback: `listrevisions` zawsze pozwala wrócić.
- **Pliki duże a przeglądarka:** MP3 nagrania to dyktowane rząd wielkości kilka–kilkadziesiąt MB. `FormData` + `Blob` w Chrome/Desktop i **Android Chrome** — bez problemu. Modyfikując ID3 pamiętać o przepisaniu **całego** pliku (ID3v2 na początku jest łatwy; ID3v1 na końcu; przepisanie całego pliku w pamięci przeglądarki jest w pełni realne).

---

## 6. Limity i serwery regionalne

### Serwery
- Dwa centra danych: **US → `api.pcloud.com`**, **EU → `eapi.pcloud.com`** ([General](https://docs.pcloud.com/)). **Wybór następuje w OAuth**: odpowiedź `authorize` zwraca `locationid` (1=US, 2=EU) i `hostname` — [authorize](https://docs.pcloud.com/methods/oauth_2.0/authorize.html). **Bierzemy `hostname` z OAuth i używamy do wszystkich kolejnych wywołań** (SDK `oauth.popup` konsekwentnie zwraca `locationid` też).
- `getapiserver` ([general/getapiserver](https://docs.pcloud.com/methods/general/getapiserver.html)) — **nie wymaga auth**; zwraca najbliższe serwery (`api-ams1.pcloud.com` etc.), SDK używa jako proxy; **zalecane:** fallback „network error → oficjalny `hostname`" (SDK robi to samo).

### Rate limits
- **Brak udokumentowanych limitów requestów** na docs.pcloud.com (przeszukałem: brak strony „rate limit"). Jedyny udokumentowany limiter: **error 4000 „Too many login tries from this IP address"** w tabelach błędów (dotyczy **uwierzytelniania**, nie data-requests).
- Publiczne linki mają limit ruchu (endpoint `account_ispublinktrafficlimited` w SDK) — nie dotyczy nas, bo nasze żądania są uwierzytelnione.
- **Praktyka:** play/ocena = pojedynczy request per akcja; upload tylko przy ocenie → natężenie znikome. Ryzyko throttlingu w praktyce małe, ale **nieudokumentowane** — zaznaczam jako brak gwarancji.

---

## 7. Wniosek: czysta przeglądarka vs proxy

| warstwa | status | uzasadnienie |
| --- | --- | --- |
| OAuth (login z przeglądarki) | ✅ OK | authorization endpoint na `my.pcloud.com` (nie api!) — brak problemów z CORS, token flow implicit; `hostname`/`locationid` dostarczane w odpowiedzi |
| Listing folderów | ✅ | `listfolder` przez `fetch`, CORS potwierdzony |
| Upload zapisu | ✅ | `uploadfile` `FormData` POST, CORS preflight potwierdzony; semantyka nadpisywania (z rewizją) potwierdzona w dokumentacji |
| **Odtwarzanie (sciezka do pliku)** | ⚠️ RISK | `getfilelink`/`getaudiolink` — referer-restriction; do testu T3. **Jeśli test padnie → konieczny mini-proxy** (np. Cloudflare Worker: przekazuje `?fileid=`, po stronie proxy wywołuje `getfilelink` z tokenem i streamuje Content-Range). Jeśli przejdzie z `no-referrer` → 100% przeglądarka. |
| Range / scrubbing | ⚠️ TEST | T4 — `Accept-Ranges`/`206` na `cXX.pcloud.com`. Nagrania MP3 z pCloud „przewijają się" w appce pCloud → serwer z dużym prawdopodobieństwem wspiera Range; ale trzeba potwierdzić + CORS (jeśli chcemy waveform). |
| Rate limits | niezdefiniowane w docs | brak udokumentowanych limitów; praktyczne nasycenie niskie |

**Plan architektoniczny:** zbudować aplikację **bez backendu**, ale od pierwszego commitu odseparować „provider pCloud" za interfejsem (`listFiles`, `getAudioSrc`, `putModified`), żeby zmiana „→ Cloudflare Worker proxy" była jedną klasą a nie refaktoryztem całej appki. To zwarunkuje product-timeline.

**Dowody mocne vs słabe:**
- SOLID: CORS API-hosts (test własny), semantyka overwrite (dokumentacja dosłowna), OAuth flows (dokumentacja dosłowna + SDK kod), brak paginacji `listfolder` (dokumentacja), `access_token` param, `listrevisions`.
- WYMAGA TESTU / SLABE: referer-restriction bypass (T3), Range+CORS na hostach plików (T4), reguły whitelistowania `redirect_uri` (dokumentacja milczy; SDK-przykład sugeruje prostotę), limit ruchu/rate limits (brak docs), żywotność linku `expires` (tylko przykład).

---

## Testy empiryczne

Status: T1–T5, T7 — **WYKONANE** (2026-10-26/27/28). T6 — do wykonania (czeka na rejestrację appki).
> **🏁 Wyrok ostateczny (2026-10-28, T7):** Cloudflare Worker **potrzebny TYLKO jako read-proxy** (pobranie bajtów pliku na rewrite oceny). **Zapis ocen (`uploadfile`) gra w 100% z przeglądarki** ( Origin nie blokuje metod zapisu/metadata). Odtwarzanie `<audio>` — bez proxy (media elementy nie wysyłają Origin). Waveform — bez zmian (precomputed peaks, bilet 14).
> **⚙ Nowy fakt (2026-10-28, T3c):** metody streamingowe (`getfilelink`/`getaudiolink`) **odrzucają żądania z nagłówkiem `Origin`** (`result=7010 „Invalid link referer"` — nazwa myląca, chodzi o Origin, NIE o Referer; `Referer` dowolny → przechodzi). `fetch()` cross-origin zawsze wysyła `Origin` →ajo go `getfilelink` z przeglądarki jest niemożliwy. `<audio src>` (media element) nie wysyła Origin → playback działa.

> **✅ Werdykt testu T5 (2026-10-27, token z rclone, tag-test): fileid jest STABILNY przy nadpisaniu przez `uploadfile`; tag ID3 (POPM) przetrwał; endpoint `listrevisions` NIEDOSTĘPNY (404) — istnienie rewizji do potwierdzenia w innym kształcie (web UI „Versions" / inna metoda), ale dla klucza cache z biletu „Model stanu i trwałości" pozostały warunek jest spełniony: **`'pcloud|'+fileid` przetrwa nadpisanie pliku** (dokładnie ten sam fileid po overwrite nową treścią: hash i size się zmieniły, fileid bez zmian; confirms LWW bez duplikatów w bibliotece).

> **⚠ Werdykt testów T3–T4 (2026-10-27, token z rclone, konto dmroczek, eapi): NIE POTRZEBUJEMY PROXY/Cloudflare Workera dla audio.**
> - **T3**: `getfilelink` i `getaudiolink` zwracają `result:0` **bez nagłówka Referer** (no-referrer) i **nawet z obcym Refererem** (`https://evil.example.com`) — dopisek z docs *„Referrer is restricted to pcloud.com”* nie odpala się w praktyce (przynajmniej dla tego konta/appki). Download z hosta contentowego też OK (HTTP 200, `audio/mpeg`). **Do dodatkowego potwierdzenia**: test w prawdziwej przeglądarce ze strony z `<meta name="referrer" content="no-referrer">` (T3c), bo curl zawsze emuluje „brak nagłówka” tak samo jak przeglądarka z no-referrer.
> - **T4**: na serwerze contentowym `evie1.pcloud.com` (hosts z getfilelink): `206 Partial Content`, `Content-Range: bytes 0-1023/452829`, `Accept-Ranges: bytes` — **scrubbing w `<audio>` zadziała**. **ALE: brak `Access-Control-Allow-Origin`** w odpowiedzi na żądanie z `Origin: https://example.com` → `fetch()` z JS na URL serwera plików nie zwróci odpowiedzi front-endowi (CORS blokuje). Implication dla aplikacji:
>   - `<audio>` **bez `crossOrigin`** — playback + scrubbing ✅ (media elementy są zwolnione z CORS przy zwykłym odtwarzaniu),
>   - **waveform z pliku audio przez fetch() ❌** — nie zadziała bez proxy (lub bez użycia analyseru na żywym strumieniu `<audio>` zamiast fetch/decodeAudioData).
>   - zob. „Sugestia implementacyjna” (pkt 4) — ripple effect na bilet „Waveform”.

### T1 — CORS na api.pcloud.com / eapi.pcloud.com ✅ DONE
```powershell
curl.exe -s -D - -o NUL -H "Origin: https://example.com" "https://api.pcloud.com/getapiserver"
curl.exe -s -D - -o NUL -H "Origin: https://example.com" "https://eapi.pcloud.com/getapiserver"
curl.exe -s -D - -o NUL -X OPTIONS -H "Origin: https://example.com" `
  -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: authorization" `
  "https://api.pcloud.com/listfolder"
curl.exe -s -D - -o NUL -X OPTIONS -H "Origin: https://myapp.example" `
  -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type" `
  "https://api.pcloud.com/uploadfile"
```
**Wynik (2026-10-26):** na wszystkich 4 — `Access-Control-Allow-Origin: *`; OPTIONS zwraca `Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS`, `Access-Control-Max-Age: 86400`; odpowiedź błędu (`{"result":1000}`) też ma ACAO. **Brak** `Access-Control-Allow-Headers` → wniosek: nie używać nagłówka `Authorization`, token zawsze w URL `?access_token=`.

### T2 — test dymny: pełne `fetch` z przeglądarki (10 minut, jeden plik HTML)
Statyczna strona na dowolnym https host (albo lokalnie `http://localhost:8080`) z:
```html
<meta name="referrer" content="no-referrer">
```
i skryptem: wklej ręcznie `access_token`, wywołaj `fetch("https://eapi.pcloud.com/userinfo?access_token=…")`, potem `listfolder?folderid=0` i render listy. **Kryterium:** brak błędów CORS w konsoli = warstwa metadata w 100% przeglądarkowa.

### T3 — referer-restriction na `getfilelink` (decydujące o proxy)
> **✅ DONE 2026-10-27** (fileid 71496730995, eapi, token z rclone): `getfilelink` **bez nagłówka** → `result:0` + `path`/`hosts`/`expires`; **z obcym Refererem** (`https://evil.example.com`) → też `result:0`. `getaudiolink` bez Referera → też OK. Download z hosta contentowego bez Referera → `HTTP 200`, `audio/mpeg`, pełne 452 829 B. **Blokada referera nie istnieje w praktyce** — proxy zbędne. Brak tylko potwierdzenia z prawdziwej przeglądarki (T3c, meta no-referrer) — formalność.
Posiadając appkę (client_id, client_secret) i przykładowy MP3 w chmurze:
```powershell
# 3a) curl BEZ nagłówka Referer (symulacja no-referrer):
curl.exe -s -H "Origin: https://myapp.example" `
  "https://eapi.pcloud.com/getfilelink?access_token=ACCESS&fileid=FILEID"
# 3b) curl Z obcym Referer (symulacja przegladarki z domena):
curl.exe -s -H "Origin: https://myapp.example" -H "Referer: https://myapp.example/" `
  "https://eapi.pcloud.com/getfilelink?access_token=ACCESS&fileid=FILEID"
# 3c) to samo z przegladarki (strona z <meta name="referrer" content="no-referrer">) -> ten sam fetch
```
**Kryterium:** `3a` zwraca `{result:0, path, hosts, expires}`; `3b` zwraca błąd (oczekiwany „Access denied" / inny) → potwierdza, że ograniczenie dotyczy nagłówka Referer a brak nagłówka przepowiada sukces. Jeśli **3a też pada** → proxy obowiązkowe dla audio (plan B: Cloudflare Worker z `getfilelink` po stronie server-side). Uwaga: samo wywołanie w 3a bez Referer emulowane przez curl; przeglądarka wysyłająca `no-referrer` **nie wysyła nagłówka** — powinno być równoważne; potwierdzenie w 3c.

### T4 — Range + CORS na serwerze plików (`cXX.pcloud.com`)
> **✅ DONE 2026-10-27** (host `evie1.pcloud.com`, link z T3): `Range: bytes=0-1023` z `Origin: https://example.com` → **`206 Partial Content`**, `Content-Range: bytes 0-1023/452829`, `Accept-Ranges: bytes`, `Content-Type: audio/mpeg`. **ALERT: brak `Access-Control-Allow-Origin`** w odpowiedzi. Range poza rozmiarem (`bytes=999999999-`) → też 206 (serwer clampsuje, brak 416).
>
> Klejnoty praktyczne: scrubbing ✅ w `<audio>` **bez atrybutu `crossOrigin`**; waveform przez `fetch`+`decodeAudioData` ❌ bez proxy — patrz werdykt u góry sekcji „Testy empiryczne”. Rozwiązania dla waveformu: (a) AnalyserNode na żywym `<audio>` (bez pełnej dekompresji), (b) mini-proxy tylko dla waveformu (Cloudflare Worker robiący passthrough + dopisanie ACAO), (c) prekomputed peaks cache w IndexedDB lub tagach ID3.
Z linku z T3:
```powershell
# HEAD + Range z obcym Origin:
curl.exe -s -D - -o NUL -H "Origin: https://myapp.example" -I "https://c63.pcloud.com/HASH/FILE.MP3"
curl.exe -s -D - -o NUL -H "Origin: https://myapp.example" -H "Range: bytes=0-1023" `
  "https://c63.pcloud.com/HASH/FILE.MP3"
```
**Kryterium pozytywne:** odpowiedź `206 Partial Content`, nagłówek `Content-Range: bytes 0-1023/<size>`, najodważniej **`Accept-Ranges: bytes`** i (dla waveformu) `Access-Control-Allow-Origin: *` (lub echo Origin). Jeśli brak ACAO — `<audio>` używać **bez** `crossOrigin` (playback OK), waveform odrapić lub fetch przez proxy. Jeśli brak `206`/Range — scrubbing w przeglądarce będzie zepsuty → proxy z obsługą Content-Range.

### T5 — overwrite + wersjonowanie (end-to-end oceny)

> **✅ DONE 2026-10-27** (eapi + tag-test, fileid 71496730995 = `rec-2024-12-24_10-27_2373.mp3`, token z rclone):
> 1. Re-upload tego samego pliku pod tym samym filename/folderid → **fileid bez zmian** (`71496730995`), size/hash bez zmian — zgodne.
> 2. **Prawdziwy overwrite kontrolny** (plik probe `t5a.txt` 1024 B → nadpisanie 2048 B inną treścią, ten sam filename/folderid) → **fileid przetrwał** (`110584515724`, hash/size zmienione, `modified` zaktualizowane). ⚠ Pułapka metodyczna: pole `filename=...` w multipart zostaje zignorowane przez pCloud, jeśli istnieje już pole plikowe z własną nazwą — nazwę pliku wynikowego wymusza się przez `filename` w `Content-Disposition` pola plikowego (curl `-F "file=@...;filename=..."`), nie przez osobne pole formularza.
> 3. **POPM po overwrite**: pierwsze 64 KB nadpisanego MP3 zawiera `POPM` (tag intact) — podmiana zawartości nie usuwa ramki.
> 4. `listrevisions` → **404 Not Found** (endpoint niewspierany na eapi / nieudokumentowany). Wnioski o rewizjach: czerpane z web UI/literatury i lekko zaufane; nie blokują żadnej decyzji w mapie (klucz cache zależny wyłącznie od stabilności fileid — ✅).
> 5. Cleanup: oba pliki probe usunięte (`deletefile` result=0, pliki w Trash).
>
> **Werdykt T5**: `uploadfile` nadpisuje plik **z zachowaniem fileid** → klucz cache `'pcloud|'+fileid` jest trwały; LWW bez duplikatów potwierdzone. Mechanizm rewizji (pCloud „Versions") istnieje integracyjnie — ale do przebadania dopiero gdyby user chciał efektywnie użyć historii wersji w appce (poza zakresem).

```powershell
# upload A, potem upload A' (modifie ID3), do tego samego folderid/filename:
curl.exe -s -F "file=@test.mp3" "https://eapi.pcloud.com/uploadfile?access_token=ACCESS&folderid=FID&nopartial=1"
curl.exe -s -F "file=@test-rated.mp3" "https://eapi.pcloud.com/uploadfile?access_token=ACCESS&folderid=FID&nopartial=1"
# sprawdzenie rewizji i że fileid nie zmienia się:
# ⚠ UWAGA (wynik z 2026-10-27): "listrevisions" NIE istnieje na eapi (404 Not Found) —
# fileid-stability i POPM-integrity potwierdzone realnym testem, punkt o rewizjach w kryterium jest nieosiągalny.
curl.exe -s "https://eapi.pcloud.com/listrevisions?access_token=ACCESS&fileid=FILEID" # -> 404
curl.exe -s -o NUL -D - -H "Range: bytes=0-1023" "https://c63.pcloud.com/<link z getfilelink/download pliku>"
```
**Kryterium:** drugi upload zwraca **ten sam `fileid`** (nie nowy), `size` zaktualizowany, plik pobrany ponownie zawiera zmodyfikowany tag ID3, a `listrevisions` pokazuje min. 1 rewizję z oryginalnym `size` i datą.

### T3c/T3d — prawdziwa przeglądarka: no-referrer + blokada `Origin` 🏁 DONE 2026-10-28

> **✅ T3d (playback) PASS:** `<audio src=getfilelink-URL>` bez `crossOrigin`, strona z `<meta name="referrer" content="no-referrer">`, origin `http://localhost:8127` → `loadedmetadata`, `duration=28.2 s` — **media element gra** (nie wysyła nagłówka `Origin`, więc jego nie dotyczy blokada 7010; spójne z T3/T4).
>
> **❗ T3c (fetch) FAIL — NIESPODZIEWANY FAKT:** `fetch()` na `getfilelink` z przeglądarki → `result=7010 „Invalid link referer."`. Curl (T3) tego nie wykrył, bo **nie wysyłał nagłówka `Origin`**. Matryca nagłówków (script `.scratch/pcloud-t7/referer-matrix.ps1`, 2026-10-28):
>
> | nagłówki | wynik |
> |---|---|
> | goły request | result=0 |
> | **`Origin: http://localhost:8127`** (bez Referer) | **result=7010** |
> | `Origin` + `Referer` (dowolny, nawet evil.example.com) | result=7010 |
> | `Referer` bez `Origin` (dowolny host) | result=0 |
>
> **Wniosek:** trigger = **obecność nagłówka `Origin`** (każdy cross-origin `fetch()` go wysyła automatycznie — nie da się go usunąć z JS). Nazwa błędu „Invalid link referer" jest myląca — `Referer` nie gra roli. `getaudiolink` → ta sama blokada; **metody zapisu/metadata (uploadfile/listfolder/stat/userinfo) z `Origin` → result=0** (matryca `origin-write.ps1`).
> **Konsekwencja:** `getfilelink` z przeglądarki (fetch) niemożliwy → **read-proxy (Cloudflare Worker) dla odczytu bajtów pliku**; `<audio src>` (bez Origin) i uploadfile — bez zmian, bez proxy.

### T7 — upload flow oceny z przeglądarki 🏁 DONE 2026-10-28 — **PASS**

> **✅ WYNIK: pełny cykl zapisu oceny (ID3 rewrite POPM + `uploadfile` overwrite) działa z czystej przeglądarki.**
> Strona testowa: `.scratch/pcloud-t7/index.html` (servowane `python -m http.server 8127`, `<meta referrer=no-referrer>`, dev-token z `secrets/token.env`); plik: `tag-test/rec-2024-12-24_10-27_2373.mp3` (fileid 71496730995, ID3v2.3, POPM WMP 196).
>
> | krok | wynik |
> |---|---|
> | T7a odczyt bajtów pliku z pCloud | ❌ z przeglądarki (getfilelink→7010; brak ACAO na hostach contentowych — T4); w teście: kopia same-origin pobrana wcześniejszym curl |
> | T7b ID3 rewrite w RAM (vanilla JS parser/writer ID3v2.3) | ✅ tagSize 4190→684+512pad; WMP POPM 1:1 keep; TXXX replaygain keep; nowa POPM `music-rater@local` rating byte 128 |
> | T7c `POST uploadfile` z `fetch()` + FormData (Origin: http://localhost:8127) | ✅ **result=0, 250 ms, fileid zachowany** (71496730995), size 449 283 B |
> | weryfikacja bajtów w chmurze (curl, parse hex) | ✅ POPM WMP=196 intact, TXXX intact (`+3.75 dB` / peak `1.107203`), POPM own=`music-rater@local` rating=128 |
> | T3d `<audio>` na świeżym linku po rewrite | ✅ loadedmetadata 28.2 s (plik gra) |
>
> **Werdykty na architekturę:**
> 1. **Zapis ocen bez proxy** — uploadfile nie podlega blokadzie Origin; CORS (T1) potwierdzony; overwrite z zachowaniem fileid (T5) — **klucz `'pcloud|'+fileid` bezpieczny**.
> 2. **Read-proxy (Cloudflare Worker) potrzebny dla odczytu bajtów** — getfilelink (7010 z Origin) i hosty contentowe (brak ACAO) blokują fetch. Zakres: `getfilelink` passthrough + stream bajtów pliku z dopisanym ACAO. Reszta API (listing, upload, auth) — bezpośrednio z przeglądarki.
> 3. **Waveform** — bez zmian wg biletu 14 (precomputed peaks; przy okazji read-proxy można dorzucić passthrough dla waveform, ale nie jest wymagany).
> 4. UWAGA metodyczna: parser ID3v2.3 w przeglądarce (vanilla, ~50 linii) spisał się bez zarzutu na plikach z biblioteki — write-path z audytu (`sample-file-tag-audit.md` §7) potwierdzony praktyką.

### T6 (opcjonalnie, wariant PWA/desktop) — wariacje `redirect_uri`
Po rejestracji appki sprawdzić, czy `redirect_uri` można zmienić (host/ścieżka) bez tworzenia nowej appki, czy `localhost` faktycznie działa oraz czy custom scheme (`musicrater://`) jest akceptowane przez `authorize`. Dokumentacja milczy; wyniki zapisać w notatkach decyzyjnych projektu.

---

## Sugestia implementacyjna (bez wpływu na werdykt)

1. **OAuth:** implicit `response_type=token` z `redirect_uri` na nasz statyczny https host + `state`; odczyt `locationid`/`hostname` z URL-fragmentu; token do `localStorage` (nie wygasa); fallback desktopowy: code flow „kod do skopiowania” (bez redirect_uri w ogóle).
2. **Klient:** własny cienki klient na `fetch` (SDK `pcloud-sdk-js` jest opcjonalne — ma moduły przeglądarkowe; przydatne jako referencja `ApiMethod` i `oauth.popup`).
3. **Zapis:** ocena → modyfikacja ID3 w pamięci (jsmediatags/id3 zapis) → `FormData` POST `uploadfile` z `nopartial=1` + `renameifexists=0` (default) → update bpp z odpowiedzi.
4. **Odtwarzanie:** `getfilelink` → `<audio src="https://{hosts[0]}{path}" preload="metadata">`; przy `onerror` regeneracja linku (pole `expires`); waveform tylko jeśli T4 pokaże CORS na serwerze plików.
