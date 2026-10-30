# music-rater — specyfikacja budowalna

**Status:** WERSJA WSTĘPNA (draft v0.1, 2026-10-29) — generowana przez agenta z decyzji mapy; do przeglądu HITL przed budową.
**Źródło prawdy:** bilety w `.scratch/music-rater-target/issues/` + raporty w `research/`. Ta specyfikacja **streszcza** — w razie rozbieżności bilety wygrywają. Glosariusz pojęć: [CONTEXT.md](CONTEXT.md) (Utwór, Źródło, Ocena, Cache ocen, Fingerprint, Walidacja per-odczyt, Sesja, Pełny powrót, LWW, Rocznik, Ostatnio słuchane).

---

## 1. Cel i zakres MVP

Aplikacja vanilla-JS (desktop Chrome + Android Chrome) — playlista ~3635 nagrań dyktafonowych MP3 z ocenianiem 1–5 gwiazdek **zapisywanym w tagu ID3 POPM** ( interoperacyjnym: WMP/foobar2000/MusicBee/Mp3tag/Poweramp), źródło plików: **pCloud** (OAuth implicit) oraz **katalog lokalny FSA**, równa głośność przez ReplayGain track-gain, pełny klikalny waveform, kontynuacja sesji po ponownym wejściu.

**W spisie Bootcamp:**

- **Architektura:** Vite (vanilla-JS, bez frameworka) → czysto statyczny `dist/`; zero backendu; hosting GitHub Pages (publiczne repo) + manifest PWA; `file://` niewspierany (dev localhost, prod Pages); wszystko kompatybilne z Cloudflare Workers na przyszłość [bilet 06].
- **Proxy:** dokładnie jeden — **Cloudflare Worker jako READ-PROXY** (pobranie bajtów pliku do rewrite oceny i/lub waveformu). **Wszystko inne bezpośrednio z przeglądarki** [bilety 06, 11, 14].
- **Interop ocen:** obowiązkowy — standard WMP [bilety 01, 10].
- **Mobile-first z wysokim priorytetem** (ocenianie w pociągu) [bilet 15].
- **Offline w MVP:** brak odtwarzania offline z pCloud (CORS); „Pełny powrót sesji" + **kolejka ocen offline** (`pending-ratings`) [bilet 15].
- **Zmiany startu/pętli, docki:** POST-MVP, nie scope [bilet 18].

### 1a. Faktory empiryczne (badania własne, 2026-10-27/28)

Aplikacja korzysta z tych potwierdzonych faktów (raport `research/pcloud-api.md`):

1. **Blokada `Origin`:** metody streamingu (`getfilelink`/`getaudiolink`) odrzucają żądania z nagłówkiem `Origin` → `result=7010 „Invalid link referer"`. **Cross-origin `fetch()` zawsze wysyła `Origin`** → odczyt bajtów z przeglądarki niemożliwy [T3c].
2. **`<audio src>` nie wysyła `Origin`** → **odtwarzanie ze scrubingiem (Range) działa bez proxy** [T3d, T4].
3. **Zapis i metadata bez blokady `Origin`:** `uploadfile`/`listfolder`/`userinfo` z nagłówkiem `Origin` → `result=0`; **pełny cykl zapisu oceny z przeglądarki PASS** [T7].
4. **`uploadfile` zachowuje `fileid`** przy overwrite → klucz cache `'pcloud|'+fileid` trwały [T5].
5. Hosty plików: `206 Partial Content` + `Accept-Ranges: bytes` (scrubbing OK); **brak ACAO** (fetch bajtów ✗) [T4]. Brak HTTP/2 → limit ~6 równoległych połączeń na host.
6. `listrevisions` → 404 (endpoint nie istnieje na eapi) — historia wersji tylko przez web UI pCloud; nie blokuje niczego [T5].
7. `listfolder` **nie stronicuje** — parametr `limit` ignorowany; rekurencyjny listing całej biblioteki = **1 call, 433 ms, 2,53 MiB** [perf 3000].
8. CORS na `api/eapi.pcloud.com`: `ACAO: *` potwierdzony, **ale preflight nie akceptuje nagłówka `Authorization`** → token zawsze jako `?access_token=` [T1]. Brak `Access-Control-Allow-Headers` — nie wysyłamy dodatkowych nagłówków.

---

## 2. Format tagu ID3 (źródło prawdy ocen)

### 2a. Zapis oceny

| Cecha | Koniec-wartość | Źródło |
|---|---|---|
| Wersja ID3 | **v2.3** (nigdy v2.4) — zwykły big-endian w polu `Size` | [bilet 01] |
| Ramka | **POPM** — dokładnie **jedna** w konwencji WMP na plik | [bilet 10] |
| Owner | `Windows Media Player 9 Series` (Latin-1, NUL-terminated, **bez `@`**) | [bilety 01, 10] |
| Rating bajt | **1★=1, 2★=64, 3★=128, 4★=196, 5★=255** | [bilet 01] |
| „brak oceny" | **usunięcie ramki WMP** (nigdy bajt 0) | [bilety 01, 10] |
| Counter | pomijany lub 4×`00` (obie legalne) | [bilet 01] |
| Cudze ramki | **nie ruszamy** — dopisane przez inne programy zostają | [bilet 10] |

**Układ bajtów ramki:** frame id `POPM` (4 B) + size (4 B BE, v2.3 — nie synchsafe) + flags (2 B) + owner (Latin-1) + NUL + rating (1 B) + counter (0/4 B).

### 2b. Odczyt oceny (hierarchia)

1. Ramka **WMP wygrywa** (gdyby inny program dopisał własną) → bajt z kraty {1,64,128,196,255}.
2. Gdy brak WMP — **maksymalna bajtowa** z pozostałych ramek POPM; bajty spoza kraty → progi: 1–63→1★, 64–127→2★, 128–195→3★, 196–254→4★, 255→5★.
3. Brak wszystkich ramek → **brak oceny** (nie 0 gwiazdek).
4. **UI: zawsze dokładnie jedna ocena** — bez badge'ów o cudzych ocenach [bilet 10].

### 2c. ReplayGain (tylko track-gain)

- **Odczyt** (kolejność): `TXXX replaygain_track_gain` (case-insensitive — w tej bibliotece to jedyny format, małe litery) → `RVA2` (v2.4, raw/512 dB) → `RVAD` (v2.3) → APEv2; LAME header i `iTunNORM` ignorujemy; wartość regexem `/^([+-]?\d+(?:\.\d+)?)\s*dB$/i`, peak ratio→dB przez `20·log10(ratio)` [bilet 04].
- **Skan awaryjny** (brak tagów): `decodeAudioData` → `ebur128-wasm` **w Web Workerze** (BS.1770, nie RMS), poziom odniesienia **−18 LUFS** (`gainDb = −18 − LUFS`) — spójne z RG 2.0/loudgain; skan nie nadpisuje tagu [bilet 04].
- **Odtwarzanie:** `MediaElementSourceNode` → `GainNode` → destination; `finalGainDb = gainDb + preampDb(użytkownika)`; **clamp:** gdy `finalGainDb + peakDb > −1 dB` → obcięcie_gaina; zmiany gaina przez `linearRampToValueAtTime` (bez klików, domyślnie `preamp=0`).
- ⚠ **Korekta empiryczna (T3c/T7)** — research RG zakładał `crossOrigin="anonymous"` dla Web Audio; **to nie zadziała dla pCloud** (serwery plików bez ACAO → plus taint przy `MediaElementSourceNode` bez CORS = cisza), a z `crossOrigin` playback w ogóle upadnie. **MVP dla pCloud: graf Web Audio DEGRADUJE się do zwykłego `<audio>` bez gaina** (jednakowy audio → poziom robi plik, ale z plikami siedzącymi w pCloud nie da się w MVP nakładać gaina z `MediaElementSourceNode`), LUB **przepływ przez READ-PROXY** (pobranie bajtów przez Worker → object URL → pełna graf Web Audio). Domyślnie: **WARIANT B — przez READ-PROXY**, bo i tak plik przelatuje przez Worker przy zapisie oceny; fallback A gdyby Worker zawodził.
- ⚠ **Cache RG:** IndexedDB, klucz `'pcloud|'+fileid` / `'local|'+relpath`, walidacja per-odczyt (Fingerprint size+modified); payload `{gainDb, peakDb?, source: 'tag'|'scan'|'estimate', subSource, scannedAt}`.

---

## 3. Źródła plików

### 3a. pCloud (primary)

- **OAuth:** implicit `response_type=token` na `https://my.pcloud.com/oauth2/authorize`; `client_id=8imNt7HXdPm` (appka „rate-wave", zarejestrowana 2026-10-30); whitelist redirectów pCloud to **exact string match** — zarejestrowane i zweryfikowane (T6 PASS): dev `http://localhost:5173/` + prod `https://danielmroczek.github.io/rate-wave/oauth.html`; `state` anty-CSRF; `hostname`/`locationid` z fragmentu → używamy przez całą sesję (konta EU → `eapi.pcloud.com`); token **nie wygasa** → `localStorage`; walidacja `userinfo` przy każdym starcie [bilety 02, 07].
- **Rejestracja appki:** bilet [20-pcloud-app-registration-t6](issues/20-pcloud-app-registration-t6.md) — faza build; HITL wg checklisty w `research/pcloud-register-app.md` §6; ⚠ backup `secrets/token.env` przed wizardem `.scratch/pcloud-tests/wizard.sh`.
- **Listing:** 1× rekurencyjny `listfolder?folderid=0&recursive=1&timeformat=timestamp` (433 ms desktop, 2–5 s mobile) → drzewo; filtrowanie `.asd`, `warped/`, nie-MP3 po stronie klienta; **obsługa podfolderów rocznikowych** — Rocznik = 1. poziom podfolderów [bilety 13, 16].
- **Audio `<audio src>`:** `getfilelink` (API-side request — **z serwera, nie fetch z przeglądarki**; z przeglądarki → 7010) → `<audio src="https://{hosts[0]}{path}" preload="metadata">`; parametr `contenttype=audio/mpeg`; regeneracja linku przy `onerror` (pole `expires` — linki ważą ~6 h); cache linki w IDB per sesja [bilety 02, 11, 16].
- **Zapis oceny:** `fetch(fileURL)` przez READ-PROXY (jedyny powód tworzenia Workerów) → ID3 rewrite w RAM → `POST uploadfile` multipart (`access_token=`, `folderid=`, `nopartial=1`), **`filename` wyłącznie w `Content-Disposition` pola plikowego** (zwykłe pole `filename=` jest ignorowane — pułapka z T5) → overwrite z zachowaniem fileid [T5, T7].

### 3b. Katalog lokalny (FSA)

- `showDirectoryPicker({mode:'readwrite'})`; serwis po **Chrome 132/Android 132** (styczeń 2025); `createWritable()` zapis w miejscu; handle w IndexedDB; `requestPermission()` po przywróceniu; fallback: `input[type=file][multiple]` + import [bilet 03].

---

## 4. Model stanu i trwałość (IndexedDB + localStorage)

**Walidacja per-odczyt bez TTL.** Token pCloud w `localStorage` **i** mirror w IDB (żeby Service Worker / flush mógł działać — SW nie widzi localStorage) [bilet 15].

### 4a. Baza `music-rater` (version 1)

| store | klucz | payload | uwagi |
|---|---|---|---|
| `settings` | string | JSON | per urządzenie: sort, rocznik, szukajka, ustawienia paska, preamp |
| `sources` | `pcloud` / `local` | token mirror, folderid, hostname/locationid; handle FSA + stan zgód | |
| `library` | source-id | listing per Źródło + Fingerprint | 1× recursive listing; my, całe drzewo |
| `tracks` | `'pcloud|'+fileid` / `'local|'+relpath` | `{ fingerprint{size, modified}, rating: 1–5\|~~null~~, gain, peak, RG-source, peaks (Uint8Array 800), lastPlayed, pendingUpload? }` | **ocena jako pochodna tagu**; `lastPlayed` **przeżywa** unieważnienie (usuwa się tylko pola tagowe) [bilet 17 suplement] |
| `pending-ratings` | `'pcloud\|'+fileid` / `'local\|'+relpath` | `{ fingerprint, ratingByte, action: set\|remove, createdAt }` | kolejka ocen offline [bilet 15] |
| `session` | singleton | `{ source, trackKey, positionSec }` | odtwarzane na starcie (Pełny powrót) |

### 4b. Zachowania

- **Pełny powrót** [bilet 07]: Źródło + biblioteka z cache + ostatni Utwór + pozycja; degradacja: Utwór zniknął → zaznaczenie listy → brak zaznaczenia.
- **LWW wszędzie:** ostatni zapis wygrywa, bez ostrzeżeń i blokad; multi-tab bez locków; sesja per urządzenie; sync między urządzeniami wyłącznie przez pliki w pCloud [bilet 07].
- **Unieważnienie rekordu** (rozbieżność Fingerprintu): czyścimy pola tagowe; **`lastPlayed` zostaje** [bilet 17 suplement].
- **Przycisk „wyczyść wszystkie dane"** = `deleteDB` + `localStorage.clear()` [bilet 07].
- **Brak synka stanu przez chmurę** poza plikami [bilet 07].

---

## 5. UI/UX (FLAT/METRO bez ramek)

**Dyrektywa graficzna:** hierarchia wyłącznie **tłem** (warstwy, hover, zebra listy, zaznaczenie pełnym tłem); **żadnych ramek 1 px**; focus = dopełnienie (outline), nie ramka; toolbar mobile **zawija się**.

### 5a. Layout

- **Drzewko Roczników po lewej** (desktop; mobile zawinięte/pionowe): klik = filtr, wariant „wszystkie"; aktywny podświetlony pełnym tłem; roczniki widoczne zawsze, nawet puste [bilet 17].
- **Lista główna:** wiersz = nazwa + gwiazdki + BPM (jeśli jest) + badge offline (⭳/☁ — docelowo, gdyby cache MP3 kiedyś powstał); **virtualizacja manualna** (windowing ~30 rzędów, stała wysokość, rAF-throttled scroll, `translateY`); zero bibliotek [bilet 16].
- **Licznik:** „N pozycji … M bez oceny" — aktualizowany po każdej ocenie [bilet 17].
- **Player przyklejony na dole** (z prototypu `.scratch/prototypes/player-ux/index.html`): tytuł, gwiazdki, waveform, przyciski transport, szukajka, sort, licznik.

### 5b. Odtwarzanie

- **Start:** klik/tap na wierszu → wybór Utworu → **waveform generuje się od razu** (nie dopiero po ocenie) [bilet 08 fz. 3].
- **„→ ☆" (następny nieoceniony):** przycisk w playerze + **klawisz `U`**; skacze po **bieżącej liście** (uwzględnia sort/filtr/szukajkę). **N**/`P` = kolejny/poprzedni. **Auto-advance po ocenie: WYPADA** [bilety 08, 17].
- **Filter rocznika**: **wszystkie** + pojedyncze roczniki; okno „N bez oceny" liczone w ramach filtra.
- **POST-MVP (bilet 18):** marker startu/konca (TXXX), Loop A–B — wypada z MVP.

### 5c. Skróty klawiaturowe (desktop)

- Następny nieoceniony: `U`; następny/poprzedni: `N`/`P`
- Space: play/pause
- Gwiazdki: `1`…`5`; „wyczyść ocenę": `0`
- Flow: strzałki na liście, Enter = wybierz/odtwórz
- Scrub: klik/tap/drag po waveformie (seek na `duration` z `preload="metadata"` — działa niezależnie od peaks)

### 5d. Sortowanie

**Menu sortuj:**

1. **Nazwa A→Z / Z→A** (default A→Z)
2. **Ocena ↓ / ↑** (brak oceny na końcu; przy ↑ nieocenione też na końcu, bo „do zrobienia" wygląda inaczej)
3. **Tempo ↑ / ↓** (BPM; utwory bez BPM na końcu, potem alfabetycznie)
4. **Ostatnio słuchane** (malejąco po `lastPlayed`; reszta wg nazwy)

**Filtr:** tylko Rocznik (drzewko). **Filtr „bez oceny" i sort „bez oceny na górę": ODPADAJĄ** — lista stabilna podczas oceniania [bilet 17].

### 5e. Szukajka

- substring po **nazwie pliku** (tagów artysty brak), debounce ~200 ms — ogranicza sort i jazdę po nieocenionych [bilet 17].

### 5f. TAP tempo (BPM) — MVP

- **Przycisk w playerze** „wystukaj tempo": tap = tick; 3+ ticki → BPM = amerykańska intuicja (średnia interwału, zaokrąglenie do ±1 BPM; retry restart).
- **Zapis BPM do pliku:** ID3 **TXXX** (details: description `bpm`; wartość jako int — format dopasować do normy — patrz **pkt 12: otwarte szczegóły**). Wpływ na cache: zmiana size/modified → unieważnienie rekordu `tracks` (naturalne — zapis tagu i tak następuje).
- BPM widoczne w liście + sortowalne [bilet 08 fz. 5].

---

## 6. Waveform

**Wariant docelowy i MVP: precomputed peaks + cache IndexedDB** [bilet 14].

- **Format:** 400 buckietów × min/max × `Uint8` = 800 B/Utwór ≈ ~2,9 MB całości.
- **Kiedy liczone (opportunistic):** przy zapisie oceny — plik i tak jest w RAM; `decodeAudioData` → buckiety → IDB pod `'pcloud|'+fileid` (+ Fingerprint). **Nie skaluje się na 3000 plików na starcie** — nie ma pełnego skanu.
- **3 stany waveformu:** (a) brak peaks → placeholder „pojawi się po pierwszej ocenie"; (b) generowanie → spinner na wstążce; (c) gotowy → 400 kolumn, tap/drag = seek.
- **Scrubbing od startu** nie wymaga peaks (duration z `preload=metadata` + HTTP Range).
- **Degradacja:** pliki > 50 MB skip; tryb oszczędzania baterii/`Save-Data` skip; widget można wyłączyć.
- `AnalyserNode` na live `<audio>` **martwy** (CORS-taint dla pCloud); mini-proxy tylko dla waveformu **nie warte złożoności** — NIE budujemy.

---

## 7. PWA i offline

- **PWA:** manifest + instalacja na ekranie telefonu; Service Worker: **app shell cache** (HTML/JS/CSS) — budowa build-time.
- **Offline w MVP [bilet 15]:** „Pełny powrót sesji" (4a) + **kolejka ocen offline**:
  - ocena offline → zapis do `pending-ratings` + natychmiastowa aktualizacja cache ocen (UI widzi gwiazdki ⏳ „oczekuje na wysłanie");
  - **flush:** przy starcie aplikacji (po walidacji tokenu), na `window.online`, po każdym udanym zapisie online;
  - Background Sync (`sync` tag `flush-ratings`) = **progressive enhancement** (Chrome Android działa bez zainstalowanej PWA; fallback to flush na starcie);
  - token pCloud mirrorowany w IDB (SW nie widzi localStorage).
- **Cache MP3 (OPFS): NIE w MVP** — pCloud nie pozwoli (CORS/fetch bajtów wymaga proxy a to nie zakres MVP; „pociąg" 50 scenario: offline działa tylko dla źródła FSA). Interfejs badge'a ⭳ przewidujemy w liście, ale nie implementujemy.
- **Cache Storage:** tylko asset-y PWA. **OPFS:** zarezerwowane — gdyby kiedyś dodano offline z pCloud: OPFS na MP3 + IDB na indeks; strategy: ręczne zaznaczenie + rolling window (50 ostatnich ≈ 22 MB), limit 500 MB, własne LRU-eviction, `persist()` przy pierwszym cache'owaniu (user gesture) [bilet 15].

---

## 8. Odtwarzanie i ReplayGain — przepływ

1. Wybór Utworu → `<audio>` `<meta name="referrer" content="no-referrer">` globalnie na stronie; `<audio src>` przez `getfilelink` pobrany z API (curl-side od Worker / wewnętrznie aplikacja wywołuje API host przez fetch — to OK, bo `getfilelink` to metoda API, a blokad jest na **metodach streamingowych wywoływanych z przeglądarki**; stosujemy **warstwę wywołania getfilelink z poziomu Worker**).
2. `<audio preload="metadata">` → duration+scrubbing OK.
3. Gain (przez Worker/Web Audio wg 2c): `finalGainDb = RG gain + preamp`, clamp na peak.
4. `lastPlayed` dla Utworu przy każdym starcie odtwarzania (cache `tracks`). **Sesja (Pozycja) zapisywana throttle (np. 5 s + przy pause).**
5. Identyfikacja numeru: klucz `'pcloud|'+fileid`.

---

## 9. Architektura modułów

Vanilla ES modules; struktura:

```
src/
  main.js              — boot: walidacja tokenu, przywrócenie sesji, PWA register
  api/pcloud.js        — cienki klient fetch: listfolder, getfilelink, uploadfile, userinfo (token w URL)
  api/worker-proxy.js  — punkt kontaktu z READ-PROXY (Cloudflare Worker)
  sources/pcloud.js    — adapter źródła pCloud (listing → lista Utworów, upload, api URLs)
  sources/local.js     — adapter FSA (fallback input[file]) [odroczony do fazy 2]
  tags/id3-read.js     — odczyt ID3v2.3 (POPM, TXXX, RVA2/RVAD, APE) — music-metadata w Workerze
  tags/id3-write.js    — twarde przepisanie buforu: ramka WMP POPM (1/64/128/196/255), usuwanie ramki, TXXX BPM
  ratings.js           — polityka oceny (2b), mapowanie bajt⇄★, update tag + cache + pending-ratings
  rg.js                — odczyt tagów RG, skan ebur128 (Worker), GainNode pipeline, clamp
  waveform.js          — buckiety min/max, renderer canvas, scrub/seek (bez wavesurfer)
  list/windowing.js    — manualny windowing (serie 30, spacers, rAF)
  list/filterSort.js   — sort (4 tryby), filtr rocznik, szukajka, licznik bez oceny
  player.js            — <audio>, transport, skróty, lastPlayed, pozycja, „U/N/P"
  store/db.js          — IDB schema (4a), helpers, reset
  store/session.js     — pełny powrót, degradacja
  pwa/sw.js            — app-shell cache + Background Sync (progressive enhancement)
  ui/*                 — componenty FLAT/METRO (toolbar, sidebar, list-row, player)
workers/
  id3-worker.js        — fetch Range 64 KB → music-metadata → POPM/RG → wynik
  rg-worker.js         — decodeAudioData → ebur128-wasm → gainDb/peakDb
  waveform-worker.js   — decodeAudioData → 400 × min/max → Uint8Array
```

**Zależności (jedyny npm):** `music-metadata` (odczyt), `browser-id3-writer` (zapis ID3v2.3 — **bez POPM; ramkę WMP dopisujemy własnym ~50-line słowem**) [bilet 03], `ebur128-wasm` (skan RG), Vite. Przyszłe: brak. backendu. `wavesurfer.js` nie — własny renderer canvas ~80 linii.

---

## 10. Przepływy krytyczne

### 10a. Zapis oceny (najważniejszy przepływ)

**Keep it simple — kolejka serializująca (max 1 upload naraz), nopartial=1:**

1. fetch bajtów pliku → **READ-PROXY** (Worker: `getfilelink` passthrough + stream z ACAO)
2. ID3 rewrite: zachowaj WMP POPM byte, zachowaj TXXX replaygain/BPM, ustaw/`usuń` własny POPM [2a/2b] (T7: pełna weryfikacja bajtów przeszła)
3. peaks opportunistically z tego samego ArrayBuffer (7)
4. `POST uploadfile` (`access_token=`, `folderid=`, `nopartial=1`, filename w Content-Disposition)
5. server → `metadata` → update cache `tracks` + `lastPlayed` nietykany; flush `pending-ratings` jeśli z kolejki
6. UI: gwiazdki natychmiast (optimistic), ⏳ znika po sukcesie

**Offline:** steps 1–5 opóźnione → zapisz `pending-ratings` + gwiazdka ⏳; flush przy starcie/online.

### 10b. Pierwsze uruchomienie (onboarding)

1. PWA start → brak tokena → **login pCloud** (OAuth popup/redirect) → wybór konta.
2. `listfolder(recursive)` (1–5 s) → biblioteka; `.asd`/`warped/` odfiltrowane.
3. Rozkład Roczników w sidebar (z nazw podfolderów).
4. Lista renderuje się; oceny wchodzą stopniowo („stopniowe dochodzenie”): gwiazdki po zapisie do IDB przez lazy workerów per-screen [bilet 16: ~1 s na ekran cold].
5. Zaznaczony pierwszy Utwór? — nie: pusty stan, podpowiedź klik.

### 10c. Zwykły start (Pełny powrót)

1. Walidacja tokenu (`userinfo`) → fail: ciche czyszczenie + OAuth.
2. IDB `library` → biblioteka instant (0 requestów listing).
3. IDB `tracks` → oceny/gain/peaks/lastPlayed instant.
4. Odtwórz sesję (source → track → pozycja); degradacja jeśli utwór zniknął.
5. Lazy tagi per-screen jak w 10b-4 — tylko dla Utworów bez cache'owanego stanu oceny.

---

## 11. Wydajność (budgety)

| metryka | cel/limit | źródło |
|---|---|---|
| Start z cache | < 1 s do listy (0 requestów listing) | [16] |
| Pierwszy listing | 433 ms desktop / 2–5 s mobile (1× recursive) | [16] |
| Lazy tagi | ~1 s na ekran cold (20 plików × 318 ms / 6 koneksji) | [16] |
| Scroll | 60 FPS (windowing 30, rAF, passive) | [16] |
| Ocena | optimistic UI < 50 ms; upload ~250 ms; +3–6 s peaks (maskowane) | [11, 14, 16] |
| Cache IDB | peaks ~2,9 MB całości; listing ~1–1,5 MiB heap | [14, 16] |
| Zapis | kolejka serializująca 1 upload naraz; `nopartial=1` | [02] |
| Równoległość API | max 6 fetchy contentowo, min. nie mierz > 10 na `getfilelink` (rate-limit risk) | [16] |

---

## 12. Otwarte szczegóły (do rozstrzygnięcia w fazie build, nie blokują)

1. **TXXX BPM:** description (`bpm` vs `fBPM` vs `TAP-bpm`) i format wartości (int vs `a.bb`) — przyjmujemy match na najczęsty format; konsistency z TXXX replaygain (małe litery).
2. **Cloudflare Worker dokładna lokalizacja/passthrough** — routing do `getfilelink` passthrough i stream; hosta workera (workers.dev vs custom subdomain) zależnie od pierwszej próby. Tylko read-no-token? (getfilelink wymaga auth — Worker trzyma token server-side LUB passthrough z URL-worker + auth w query — bezpieczne, bo to jego efemeryczny link).
3. **Odtwarzanie w tle na Androidzie** — Media Session API (metadane na lockscreen, sterowanie z powiadomienia) jako nice-to-have; brak blokady dla MVP.
4. **Gold-file testy interopu** (Mp3tag/Explorer/foobar2000/Poweramp/Musicolet) — przed pierwszym realnym uploadem; plan w `research/popm-interop-matrix.md` §"Plan weryfikacji empirycznej".
5. **Format `fingerprint.modified`** w pCloud: RFC 2822 vs unix ts (`timeformat=timestamp`) — bierzemy `timeformat=timestamp`.

---

## 13. Kolejność prac wykonawczych (plan budowy)

Propozycja fazy; każdą fazę domyka działające `dist/` (deploy debug na Pages bezopszynowo):

1. **F0 — fundament:** Vite scaffold, IDB schema, „wyczyść dane", FLAT/METRO them base, PWA manifest.
2. **F1 — rejestracja appki pCloud + OAuth** ([bilet 20](issues/20-pcloud-app-registration-t6.md)): wizard HITL, T6 (redirect_uri), `oauth.html`, token, `userinfo` walidacja.
3. **F2 — biblioteka pCloud:** listfolder live/cache IDB, filtrowanie `.asd`/`warped/`, windowing, Rocznik, licznik, brak ocen (tylko placeholder).
4. **F3 — odczyt tagów lazy:** Worker 64 KB Range → POPM/RG → cache `tracks` → gwiazdki na liście; read hierarchie (POPM WMP/max) wg 2b.
5. **F4 — odtwarzanie:** `<audio>` + getfilelink + `no-referrer` + scrubbing; transport; pozycja/Pełny powrót; `lastPlayed`.
6. **F5 — zapis oceny (kluczowy):** READ-PROXY Worker (getfilelink passthrough), ID3 rewrite WMP POPM (vanilla, wg T7), uploadfile, optimistic UI + ⏳, kolejka serializująca.
7. **F6 — ReplayGain:** odczyt tagów → graf Web Audio przez object URL (przez proxy); clamp na peak; ustawienia preamp; skan fallback (Worker ebur128) dla plików bez tagów.
8. **F7 — sort/szukajka/filtr:** 4 tryby sorta, debound search, drzewko Roczników, „→ ☆"/U/N/P.
9. **F8 — peaks/waveform:** generacja przy zapisie (7a-3), renderer, 3 stany, scrubbing.
10. **F9 — TAP tempo BPM:** obsługa tapowania, zapis TXXX BPM, sort po tempie.
11. **F10 — offline:** pending-ratings + flush; Background Sync; Mobile polish, Screen Polish, naprawy z mobile testów (Chrome Android 132).
12. **F11 — lokalne FSA (krok odroczony):** drugie Źródło — pickery, handle w IDB, requestPermission, fallback input; elastycznie: na koniec MVP albo post-MVP, w zależności od czasu.
13. **F12 — budowa soft:** gold-file interop testy, próba wydajnościowa 3635 plików, finalna dokumentacja, bump wersji PWA.

**Kryterium połowu:** pierwsza pełna User Story dostarczana w F5 (zapis oceny); wszystko przed = czytelny start (F2/F4 bez ocen już gra), wszystko po = quality/polish.

---

## 14. Co jest świadomie POZA MVP (post-MVP)

- **Zmiana startu nagrania (trim marker) i pętla A–B** [bilet 18] — TXXX marker, UX ustawiania.
- **Cache MP3 offline z pCloud (OPFS)** — wróci, gdy READ-PROXY dojrzeje; wtedy strategia z biletu 15 (limit 500 MB, LRU, badge ⭳).
- **Oceny połówkowe, status „odrzucone", playlisty/M3U, formaty inne niż MP3** [destynacja mapy].
- **Rec2Pcloud (nagrywarka Android z uploadem)** [bilet 19] — osobny wysiłek, gotowy spec z grillingu; label `ready-for-agent`.
- **Synchronizacja urządzeń ponad pliki w pCloud** [bilet 07].
- **Backend/serwer własny** — nigdy; architektura 'static+worker-proxy' domyka.

---

## 15. Referencje do szczegółów

| Temat | Bilet | Raport |
|---|---|---|
| Format POPM + skala | [01](issues/01-popm-interop-matrix.md) | [popm-interop-matrix.md](research/popm-interop-matrix.md) |
| Polityka ownera WMP / jedna ocena | [10](issues/10-popm-owner-policy.md) | [popm-census-2026-10-26.json](research/popm-census-2026-10-26.json) |
| pCloud API + OAuth + zapis | [02](issues/02-pcloud-api.md) | [pcloud-api.md](research/pcloud-api.md) |
| Testy empiryczne T1–T7 | [11](issues/11-pcloud-empirical-tests.md) | [pcloud-api.md § Testy empiryczne](research/pcloud-api.md) |
| Stack/hosting | [06](issues/06-stack-hosting.md) | — |
| Model stanu | [07](issues/07-data-model.md) | — |
| FSA/ID3 biblioteki | [03](issues/03-android-fsa-id3.md) | [android-fsa-id3.md](research/android-fsa-id3.md) |
| ReplayGain | [04](issues/04-replaygain.md) | [replaygain.md](research/replaygain.md) |
| Audyt plików | [05](issues/05-sample-tag-audit.md) | [sample-file-tag-audit.md](research/sample-file-tag-audit.md) |
| Waveform | [14](issues/14-waveform-research.md) | [waveform-approaches.md](research/waveform-approaches.md) |
| PWA/offline | [15](issues/15-pwa-offline-budget.md) | [pwa-offline.md](research/pwa-offline.md) |
| Perf 3000 | [16](issues/16-performance-3000.md) | [perf-3000.md](research/perf-3000.md) |
| Sort/filtr UX | [17](issues/17-sorting-filtering.md) | — |
| Prototyp UX | [08](issues/08-player-ux-prototype.md) | artefakt `.scratch/prototypes/player-ux/` |
| Rejestracja appki + T6 | [20](issues/20-pcloud-app-registration-t6.md) | [pcloud-register-app.md](research/pcloud-register-app.md) |
| Trim/loop post-MVP | [18](issues/18-trim-loop.md) | — |
| Rec2Pcloud post-MVP | [19](issues/19-rec2pcloud-recorder-app.md) | — |
| Glosariusz | — | [CONTEXT.md](CONTEXT.md) |
