# Rejestracja aplikacji pCloud: cudze `client_id`, fallback bez OAuth, checklista

Data: 2026-10-27 · Ticket: `.scratch/music-rater-target/issues/12-pcloud-no-app-registration.md`
Źródła: docs.pcloud.com (authentication, getdigest, userinfo, listtoken, my_apps), repo SDK `pCloud/pcloud-sdk-js` (examples/, docs/), PyPI/GitHub `tomgross/pcloud` (+ issue #61), GitHub issue `lemourin/cloudbrowser#4`.
Uwaga metodyczna: **formularz rejestracji na `docs.pcloud.com/my_apps/` wymaga zalogowania** — bez loginu strona renderuje wyłącznie ramkę sign-in (sprawdzone 2026-10-27). Wszystko, co dotyczy samych pól formularza, jest rekonstrukcją z SDK/PyPI/issues, nie spojrzeniem na formularz pierwszy raz z serwera. Ograniczenie zaznaczam wprost w podsumowaniu i w checkliście.

---

## Podsumowanie

**Werdykt 1 — własna rejestracja: TAK, NIEZBĘDNA.** Decyduje `redirect_uri` w token flow (`response_type=token`): każdy publicznie znany `client_id` ma zarejestrowany **cudzy** redirect (`http://127.0.0.1:8080/oauth.html` w przykładach SDK, `http://localhost:65432/` w PyPI-pcloud, `http://localhost:12345/pcloud` w cloudbrowser). Nasz prod `https://danielmroczek.github.io/music-rater/` przez cudzą appkę nie przejdzie, a podmiana redirectu bez własności appki jest niemożliwa. Dodatkowo cudze `client_id` bywają wycofywane — dowód: `lemourin/cloudbrowser` z zahardkodowanym `YDVHLm8xYJm` dostał ``Error: Invalid 'client_id'`` (issue otwarty od 2021-08 do dziś bez poprawy).

**Werdykt 2 — fallback bez OAuth: istnieje i jest dobrze udokumentowany**, ale to **parametry globalne loginu**, nie osobna metoda. Nazwa punktu wejścia: **`userinfo`** z parametrami `getauth=1` + `username` + `password` (wariant bezpieczniejszy: `getdigest` + `passworddigest`). Token wraca w polu **`auth`** i używa się go potem jako parametru **`auth=`** (nie `access_token=`). Przykład:

```
https://eapi.pcloud.com/userinfo?getauth=1&logout=1&username=EMAIL&password=HASLO
```

Ryzyka: hasło w URL (logi serwera/proxy/historia paska adresu), lockout konta IP błędem **4000** „Too many login tries", tokeny loginowe **wygasają** (`authexpire`/`authinactiveexpire`) w odróżnieniu od nieexpirujących tokenów OAuth. Rozsądne **wyłącznie jako jednorazowy kanał awaryjny dla testów T3–T6** z curl/PowerShell, z unieważnieniem tokena po testach (`logout`/`deletetoken`). Nie jest to droga do osadzenia w aplikacji.

**Werdykt 3 — checklista rejestracji:** poniżej, krok po kroku (sekcja 6). Kluczowe fakty z rekonstrukcji: appkę tworzy się kliknięciem w portalu (pola: nazwa, opis, **redirect_uri** dodawane przy tworzeniu), `client_id` widać na stronie głównej appki od razu (SDK: „take note of the app key in the main page of the application once you create it"), `app_secret`/`client_secret` jest wydawany od razu, **implicit flow go nie potrzebuje** (secret tylko do wymiany `code`), a edycja redirectów po utworzeniu jest prawdopodobna (PyPI: redirect URI widoczny w ustawieniach po ponownym zalogowaniu) — **niezweryfikowane**, do potwierdzenia w teście T6.

---

## 1. Cudze `client_id` — co znalazłem i dlaczego nie nadają się

Inwentarz publicznie osadzonych w kodzie `client_id` (GitHub, pakiet oficjalnego SDK + projekty OSS):

| `client_id` | skąd | widoczny `redirect_uri` | przydatność |
| --- | --- | --- | --- |
| `p1WznE2dEPm` | oficjalny SDK JS: `examples/login.html`, `upload.html`, `download.html`, `remoteupload.html` ([pCloud/pcloud-sdk-js](https://github.com/pCloud/pcloud-sdk-js)) | `http://127.0.0.1:8080/oauth.html` | tylko lokalna pętla SDK przykładów; dev-testy wyłącznie z **tym dokładnym** redirectem |
| `3dunsTvYJsu` | ten sam SDK: `examples/listfolder.html` (redirect i wariant `initOauthPollToken`) | `http://127.0.0.1:8080/oauth.html` | jak wyżej; wariant poll nie używa wcale redirectu |
| `mQ35NJTiuQu` | ten sam SDK: `examples/thumbs.html` | `http://127.0.0.1:8080/oauth.html` | jak wyżej |
| `YDVHLm8xYJm` | `lemourin/cloudbrowser` (Qt, zahardkodowany) | `http://localhost:12345/pcloud` | **martwy** — issue #4 „Invalid 'client_id'" bez poprawy; dowód ryzyka |
| (wzorzec) | `tomgross/pcloud` / PyPI „pcloud" | `http://localhost:65432/` | dowód, że appki rejestrują **dowolne** localhost-porty w My Apps |

### Dlaczego nawet na dev-testy to słaby pomysł

1. **`redirect_uri` musi zgadzać się z zarejestrowanym w appce.** Dokumentacja `authorize` (uwaga: `redirect_uri` obowiązkowy dla token flow) nie mówi wprost „whitelist", ale każdy pakiet OSS rejestruje dokładnie jeden swój redirect przy tworzeniu appki — cytaty:
   - SDK `docs/oauth.md`: *„(**Client side only**) Setup a redirect url to which you have access to and can place a static html page."*
   - PyPI `tomgross/pcloud` README: *„To use OAuth 2.0 authentication you need to create an App in pCloud (https://docs.pcloud.com/my_apps/). Add the following redirect URI http://localhost:65432/…"*
   - `cloudbrowser`: redirect `http://localhost:12345/pcloud` własny projektu.
   
   Trafienie z `https://danielmroczek.github.io/music-rater/` przez cudze `client_id` jest zatem **wykluczone**.
2. **Cudze appki umierają bez ostrzeżenia.** Cloudbrowser #4 (2021-08, otwarte):
   > „I have problems connecting to pCloud — **Error: Invalid 'client_id'** — https://my.pcloud.com/oauth2/authorize?client_id=YDVHLm8xYJm&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fpcloud&state=…"
   
   Appka pCloud może zniknąć (usunięcie konta właściciela/polityka), a tokeny wydane przez cudzą appkę widać u siebie jako uprawnienie obcej nazwy — u własnej appki mamy czysty podgląd w portalu „My Apps".
3. **Konto użytkownika pokaże cudzą appkę.** Token z cudzej appki ląduje w panelu użytkownika jako „uprawnienie dla [obcej nazwy]" — dla prywatnej apki do oceniania własnych nagrań to niepotrzebny bałagan i wektor „kto mój token może cofnąć".
4. **Niuanse na dev:** technicznie da się dziś wziąć `3dunsTvYJsu` + SDK `initOauthPollToken` (brak redirectu w ogóle) i zdobyć token lokalnie — ale to dokładnie ta sama klasa ryzyka co punkt 2 i 3; tylko do jednorazowej san-checki, nie do pipeline'u testów.

**Konkluzja:** własna rejestracja jest darmowa i trwa minuty — nie ma ani jednego argumentu za cudzym `client_id` poza ciekawością.

---

## 2. Alternatywa bez OAuth — login/password API (kanał do T3–T6)

### Dokładna mechanika (docs.pcloud.com → „Authentication")

Nie ma metody „login". Cytat:

> „The login parameters are global — they could be passed to every method, so they are not described. This means that every method could be used as login point and there is no method called login. However, a good point for login is **userinfo** method… To receive auth tokens, the parameter **getauth** must be set to any value and upon successful authentication an auth token will be returned." ([authentication](https://docs.pcloud.com/methods/intro/authentication.html))

Dwa warianty podania credentials (cytaty z tej samej strony):

1. **username/password (prosty):** *„This method should only be used over SSL connections."*
2. **username/digest/passworddigest (digest):** *„passworddigest = sha1( password + sha1( lowercase of username ) + digest )"*, a `digest` pochodzi z metody [`getdigest`](https://docs.pcloud.com/methods/general/getdigest.html) (*„Digests are valid for 30 seconds"*).

Odpowiedź w obu wariantach:

> „In both cases the output will contain auth with the AUTHENTICATION_TOKEN. `{"result": 0, "auth": "AUTHENTICATION_TOKEN", …}`"

Przykładowe wywołania (POPRAWNY hostname — konto EU → `eapi.pcloud.com`):

```text
# wariant prosty (jednorazowo, z curl, nie z paska przeglądarki):
https://eapi.pcloud.com/userinfo?getauth=1&logout=1&username=EMAIL&password=HASLO

# wariant digest (hasło nie ma jawnie w URL):
GET https://eapi.pcloud.com/getdigest
GET https://eapi.pcloud.com/userinfo?getauth=1&username=EMAIL&digest=DIGEST&passworddigest=SHA1_HEX
```

Utwardzony token **później** dodajemy do metod jako `auth=…`:

> „To pass these tokens to the API, use the parameter **auth**. … https://api.pcloud.com/{METHOD_NAME}?auth={AUTHENTICATION_TOKEN}&…"

### Życie tokena i sprzątanie

- Tokeny loginowe **expirują**: dokumentacja globalnych parametrów podaje `authexpire` i `authinactiveexpire` (sekundy dodawane do „teraz"); `research/pcloud-api.md` wie już z wcześniejszego researchu: max 2 lata życia i ~62 dni bezczynności.
- Lista tokenów konta: [`listtoken`](https://docs.pcloud.com/methods/auth/listtoken.html) (spis wszystkich tokenów z ich `expire`/`expire_inactive`); usuwanie: [`deletetoken`](https://docs.pcloud.com/methods/auth/deletetoken.html); zakończenie sesji: [`logout`](https://docs.pcloud.com/methods/auth/logout.html) przerywa token bieżącej sesji.
- Bliźniacze błędy na endpointach logowania: `2000 Log in failed`, `4000 Too many login tries from this IP address` ([userinfo](https://docs.pcloud.com/methods/general/userinfo.html)) — ten drugi to realne ryzyko lockoutu przy pomyłkowaniu w haśle.

### Ryzyka — werdykt co do testów T3–T6

| ryzyko | skala | nota |
| --- | --- | --- |
| hasło w URL (wariant prosty) | wysokie | pCloud loguje request; URL może wpaść do historii terminala/paska; **używać tylko z CLI, nie z przeglądarki**; preferować wariant digest |
| lockout `4000` | średnie | nie spamować próbami; odczekać po błędzie |
| token nie-expirujący vs expirujący | niskie | po testach `deletetoken`, żeby nie zostawiać żywego kanału |
| brak `state`/consent ekranu | — | to nie jest OAuth: konto uwierzytelnia się bezpośrednio; **nie osadzać w appce** — to był anty-wzorzec (hasło w query params od przeglądarki) |

**Werdykt: TAK jako jednorazowy awaryjny kanał** (`getauth` na `userinfo`), gdyby rejestracja appki utknęła: token wygenerować raz, używać w T3/T4/T5 przez `auth=`, po testach usunąć. **Nie** budować na tym ścieżki logowania w produkcyjnej aplikacji.

---

## 3. Formularz rejestracji: co wiemy, a czego nie (ograniczenie)

**Ograniczenie zapisane wprost:** `https://docs.pcloud.com/my_apps/` bez zalogowania renderuje tylko panel „Sign in / Register" (potwierdzone pobraniem strony 2026-10-27). Dokumentacji formularza w docs.pcloud.com brak. Poniższe stwierdzenia są rekonstrukcją z kilku źródeł drugiej ręki (SDK, PyPI, issues) i są oznaczone stopniem pewności:

| pytanie | status |
| --- | --- |
| adres portalu | pewne: tylko `docs.pcloud.com/my_apps/` (`developers.pcloud.com` → 404; patrz `research/pcloud-api.md`) |
| wymagane pola: nazwa | pewne pośrednio (SDK mówi „app key in the main page of the application" — appka nazwana; w portalu WSZYSTKIE appki mają nazwę) |
| wymagane pola: redirect_uri | pewne pośrednio (każdy OSS rejestruje swój redirect w trakcie tworzenia) — jak dokładnie wygląda input (lista vs jedno pole), nieznane |
| opis/app description | prawdopodobne, ale niezweryfikowane; opcjonalność nieznana |
| `client_secret` od razu po utworzeniu | pewne pośrednio: node-example SDK wymaga `client_id` + `app_secret` w `app.json` tuż po założeniu appki ([examples/node/token.js](https://github.com/pCloud/pcloud-sdk-js)) |
| czy implicit potrzebuje secret | pewne: **NIE** — token flow (fragment) używa tylko `client_id`+`redirect_uri`; secret potrzebny wyłącznie do wymiany `code` w [`oauth2_token`](https://docs.pcloud.com/methods/oauth_2.0/oauth2_token.html) |
| edycja redirectów po utworzeniu | **prawdopodobne, niezweryfikowane** — PyPI tomgross: *„To see the redirect URI in the settings of pCloud you have to log out and log in again"* — sugeruje, że redirect URI jest widoczny/edytowalny w ustawieniach appki (T6 potwierdzi) |
| limit appalto na koncie | brak danych |

---

## 4. Jak dodać prod i dev redirecty (rekonstrukcja)

Nasze dwie lokalizacje z biletu:

- prod: `https://danielmroczek.github.io/music-rater/`
- dev: `http://localhost:5173/`

Dowody, że oba typy (https-ziemny hosting statyczny i http-localhost) są akceptowanym typem redirectu w pCloud:

- zwykły https-host statyczny: SDK `docs/oauth.md` opisuje redirect jako „a static html page", na której ładujemy SDK `oauth.popup()` — czyli zwykły https-host z jedną stronką odbierającą fragment.
- http-localhost: SDK przykłady `http://127.0.0.1:8080/oauth.html`, PyPI `http://localhost:65432/`, cloudbrowser `http://localhost:12345/pcloud` — dowolność hosta i portu wygląda pełna.

Dwie niepewności (do T6):

1. **Dopasowanie redirectu:** czy dokładne, czy pCloud toleruje prefix/ścieżkę — rekomendacja: rejestrować **dokładnie** z trailing slashem tak, jak ma przylatywać z `initOauthToken` (GitHub Pages kanonicznie kieruje na `music-rater/`).
2. **Ile redirectów na appce:** jeżeli formularz przyjmuje tylko jeden, wariant B: rejestracja dwóch apek („music-rater prod" i „music-rater dev") — czyściej też w podglądzie tokenów — ale do potwierdzenia w portalu.

Extra: alternatywa całkiem **bez redirectu** = `initOauthPollToken` z SDK ([src/oauth/index.js](https://github.com/pCloud/pcloud-sdk-js/blob/master/src/oauth/index.js); polling `oauth2_token` z `response_type=poll_token`) — nadal wymaga własnego `client_id`, redirectu nie potrzebuje. Nieudokumentowane na docs.pcloud.com; traktować jako ciekawostkę/deep-fallback, nie kanał podstawowy.

---

## 5. Co po rejestracji — gdzie zapisać co

- `client_id` → do tego katalogu researchu (`research/`), to publiczna wartość — np. dopisek w `research/pcloud-api.md` sekcji „OAuth";
- `client_secret` → **tylko lokalnie** `.scratch/pcloud-tests/secrets/app.env` (istnieje template `app.env.template`) — nigdy do repo/commita;
- zarejestrowane redirecty i uwagi z portalu → aktualizacja sekcji 3 tego raportu (statusy „do T6" → potwierdzone).

**Gdzie potem podglądać apki i tokeny:**

- **apki**: portal `https://docs.pcloud.com/my_apps/` („My Apps") — po zalogowaniu widać tam `client_id`, app secret i ustawienia redirectów;
- **tokeny w koncie**: panel pCloud (nadane autoryzacje widnieją nazwą appki) oraz metoda **`listtoken`** — z zastrzeżeniem niżej;
- ⚠️ **`listtoken` a tokeny OAuth**: wg znanych problemów biblioteki `tomgross/pcloud` ([issue #61](https://github.com/tomgross/pcloud/issues/61)) metody takie jak `listtokens`/`getzip` **nie działają po uwierzytelnieniu tokenem OAuth2** — zarządzanie tokenami to funkcjonalność sesji loginowych. Praktycznie: apki i nadane autoryzacje sprawdzaj w portalu/panelu konta, a `listtoken` wywołuj tylko z poziomu kanału loginowego (sekcja 2).

---

## 6. Checklista rejestracji krok po kroku (dla człowieka, HITL)

Poniższe jest gotowym skryptem dla biletu `11` (etap 1, rejestracja). Kolejność pewna; pola w nawiasach — z rekonstrukcji (sekcja 3).

1. **Zaloguj się** na docelowym koncie pCloud (na nim będą pliki testowe i z niego pójdą wywołania API w T3–T6). Unikaj zakładania nowego konta pod appkę — jedno konto wystarczy.
2. Otwórz `https://docs.pcloud.com/my_apps/` (po zalogowaniu: menu „My Apps" na docs.pcloud.com).
3. Kliknij akcję tworzenia aplikacji („Create/…").
4. Wypełnij:
    - **Nazwa**: `music-rater` (czytelna; pojawi się na ekranie zgody OAuth i na liście aplikacji w koncie);
   - **redirect_uri** (od razu, jeśli pole dostępne):
     - `https://danielmroczek.github.io/music-rater/`
     - `http://localhost:5173/`
       - (opcjonalnie) `http://127.0.0.1:8080/oauth.html` — gdyby były potrzebne lokalne kroki z przykładami SDK;
    - **opis/description** (o ile pole jest) — to publiczny opis appki: NIE trzymaj tu żadnych sekretów;
5. Po utworzeniu **skopiuj od razu**:
   - `client_id` („app key") ze strony głównej appki — dopisz do `research/pcloud-api.md`;
   - `client_secret` („app secret") — dopisz TYLKO do `.scratch/pcloud-tests/secrets/app.env` (bez commita!).
6. **Sprawdź `/oauth2/authorize` na żywo** (2 min, bez emulatora):
   ```text
   https://my.pcloud.com/oauth2/authorize?client_id=CLIENT_ID&response_type=token&redirect_uri=https%3A%2F%2Fdanielmroczek.github.io%2Fmusic-rater%2F
   ```
   - zielona ścieżka: ekran „Czy dać uprawnienia?" → redirect do naszej domeny z `#access_token=…`;
   - czerwona ścieżka: `Invalid redirect`/`Invalid client id` → wróć do portalu, upewnij się co do redirectu (typografii, trailing slash, protokołu). To jednocześnie test T6 z biletu `11`.
7. Powtórz krok 6 dla `redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F` (dev).
8. Jeśli w portalu redirectów trzeba dodać po fakcie: spróbuj z edycją w ustawieniach appki; jeśli edycja nie jest możliwa, załóż drugą appkę dla drugiego redirectu i odnotuj w raporcie (sekcja 3, status „niezweryfikowane").
9. **Zamknij sesję:** wyloguj z portalu; w panelu pCloud (zabezpieczenia/aplikacje) sprawdź, że appka widnieje zgodnie z oczekiwaniem (autoryzacja pojawi się dopiero po przejściu OAuth); `client_id` zapisane w researchu, secret w lokalnym env.

Po wykonaniu: bilet `11` przejmuje T3–T6 (curl testy) z nowym `client_id`; fallback z sekcji 2 bierzemy **tylko gdyby** krok 2–3 z jakiegoś powodu się nie powiódł.

---

## Dowody mocne vs słabe (skrót)

- SOLID: dokumentacja `authentication.html` (globalne parametry loginu, `getauth`, digest, `auth=`), `getdigest` (30 s), `userinfo` (błędy 2000/4000), token flow (obowiązkowy redirect, fragment), SDK przykłady z `client_id` + redirect, PyPI pcloud (redirect przy rejestracji, localhost-port dowolny), cloudbrowser issue (dowód śmierci cudzego client_id), SDK `initOauthPollToken` (redirect-less).
- SŁABE / do T6: dokładny wygląd i wymagania formularza My Apps (za loginem — ograniczenie zaznaczone), edytowalność redirectów po utworzeniu, dopasowanie redirectu (exact vs prefix), liczba redirectów na appce.
