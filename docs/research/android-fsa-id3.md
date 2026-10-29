# Research: Android (File System Access) + biblioteki ID3 w przeglądarce

- **Ticket:** `03-android-fsa-id3.md` (research; bez zmian kodu)
- **Data badań:** 2026-10-26 (wszystkie cytowane źródła otwarte i przeczytane tego dnia)
- **Pytania:** (A) stan File System Access API na Androidzie w 2025/2026, fallbacki, warunki desktopowe (IndexedDB, uprawnienia, `file://`, PWA); (B) które biblioteki JS czytają/piszą ID3v2.3 z ramką POPM w przeglądarce.
- **Poza zakresem:** dokładne bajty/e-maile POPM (osobny ticket o interopie, 01), pCloud (02), ReplayGain (04).

---

## Podsumowanie

**Fragment kluczowy (Android):** pełny File System Access (wybór katalogu **i zapis w miejscu**) działa w Chrome na Androidzie od **Chrome 132 (styczeń 2025)** — to odpowiedź na stwierdzenie „Android Chrome nie wspierał ani pickera, ani zapisu”: historycznie tak, ale obecnie już **nie**.
Części API bezpieczne do odczytu były na Androidzie dostępne wcześniej: `createWritable` (na plikach OPFS) od **109**, OPFS (`navigator.storage.getDirectory()`) od **109**. Fallbacki dla starszych urządzeń i innych przeglądarek: `webkitdirectory` jest dostępny na Androidzie też dopiero od **132**, więc realny fallback to wybór pojedynczych plików (`<input multiple>`), ewentualnie kopiowanie do OPFS + eksport/„download” (dostępne od Chrome Android 109).

**Rekomendacja trybów:**
- **Desktop Chrome:** tryb w pełni natywny — `showDirectoryPicker` + `createWritable` + persist handle w IndexedDB + `queryPermission`/`requestPermission` po restarcie.
- **Android Chrome:** ten sam tryb natywny (od Chrome 132; od tego roku realne u użytkownika), z **degradacją** dla starszych Androidów/Chrome: bez katalogu — `input[type=file] multiple`, toast „użyj Chrome ≥ 132 albo wybierz pliki ręcznie”.
- **Fallback wspólny:** tryb „import-copy → OPFS → eksport/download” (dostępny od Chrome Android 109, wszystkie desktopowe przeglądarki z OPFS od 111/15.2).

**Biblioteki (konkluzja):** do **odczytu** — `music-metadata` (aktywna, natywne parsowanie POPM v2.3+v2.4, `parseBlob` dla przeglądarki, ESM). Do **zapisu** — `browser-id3-writer` (aktywna, ID3v2.3 jak stara aplikacja) **ale bez obsługi POPM** — POPM trzeba dopisać samodzielnie (prosta ramka); `jamp3` i `node-id3` (obie zapisują POPM) są **Node-only** — nie przeniesiesz ich 1:1 do przeglądarki.

---

## Część A — File System Access API: Android i warunki stacjonarne

### A.1 Zgodność (tabela)

| API / cecha | Chrome desktop | Android Chrome | Firefox (desktop / Android) | Safari (desktop / iOS) | Status |
|---|---|---|---|---|---|
| `showDirectoryPicker()` | 86 | **132** | false / false | false / false | Baseline 2025 (Newly Available) |
| `showOpenFilePicker()` | 86 | **132** | false / false | false / false | Baseline 2025 |
| `showSaveFilePicker()` | 86 | **132** | false / false | false / false | Baseline 2025 |
| `FileSystemHandle.requestPermission()` / `queryPermission()` | 86 | 132 (API udostępnione razem z pickerami) | false | false | non-standard (Chromium-only) |
| `FileSystemFileHandle.createWritable()` | 86 | **109** | 111 / 111 | 26 / 26 | Baseline 2025 |
| OPFS `navigator.storage.getDirectory()` | 86 | **109** | 111 / 111 | 15.2 / 15.2 | stabilne (standard_track) |
| `input type=file` + `webkitdirectory` | 7 | **132** | 50 / 142 | 11.1 / 18.4 | Baseline 2025 |
| `storage.persist()` (trwałość OPFS/IndexedDB) | 55 | mirror | 57 | 15.2 | stabilne |

Wnioski z tabeli (liczby niżej cytowane):

1. **Popularne twierdzenie „Android nie ma FSA” jest już nieaktualne.** Wybór katalogu (`showDirectoryPicker`) działa w Chrome na Androidzie dopiero od wersji **132** (styczeń 2025), ale to wersja, którą realnie ma już praktycznie każdy wspierany telefon (Chrome dla Androida aktualizuje się automatycznie; wersje <132 to urządzenia bez aktualizacji ~2+ lata).
2. **`createWritable` na plikach rzeczywistych z dysku** wymaga handle z pickera, więc de facto realny zapis plików MP3 „w miejscu” na Androidzie też od **132**; samą metodę (na plikach OPFS) Android zna od **109**.
3. **`webkitdirectory` na Androidzie też jest nowe (132)** — dlatego nie jest to uniwersalny fallback na starsze urządzenia; tam jedyna droga to per-plik `input[type=file][multiple]`.
4. Firefox i Safari (desktop i mobile) **nie mają** FSA pickerów na dziś; mają OPFS — istotne tylko jako plan B.

### A.1.1 Cytaty do tabeli

- MDN `Window.showDirectoryPicker` (tabela zgodności, „Chrome Android – Full support 132”, Samsung Internet 29, WebView Android 132; „Secure context: This feature is available only in secure contexts”; wymagana przejściowa („transient”) aktywacja użytkownika; opcje `mode: 'read'|'readwrite'`, `startIn` — w tym `'music'`): https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker
- BCD `api/Window.json` (`showDirectoryPicker`/`showOpenFilePicker`/`showSaveFilePicker`: `chrome: 86`, `chrome_android: {version_added: "132"}`, `samsunginternet_android: "29"`, `firefox/safari: false`): https://github.com/mdn/browser-compat-data/blob/main/api/Window.json
- MDN `FileSystemFileHandle.createWritable` (Chrome Android 109; Firefox 111; Safari 26; „Secure context”; wymiana pliku po `close()`; opcja `mode: 'exclusive'|'siloed'`; wyjątki `NoModificationAllowedError`/`AbortError` gdy plik zablokowany/malware przez Safe Browsing): https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable
- BCD `api/FileSystemFileHandle.json` (analogiczne 109): https://github.com/mdn/browser-compat-data/blob/main/api/FileSystemFileHandle.json
- BCD `api/StorageManager.json` (`getDirectory`: chrome 86 / chrome_android **109**; Firefox 111; Safari 15.2): https://github.com/mdn/browser-compat-data/blob/main/api/StorageManager.json
- MDN `HTMLInputElement.webkitdirectory` (Chrome Android 132, Samsung 29, Firefox Android 142; Chrome <72 różnice `webkitRelativePath`): https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory
- Omówienie API (Chrome docs; opcje `mode`, `startIn`): https://developer.chrome.com/docs/capabilities/web-apis/file-system-access

### A.2 Android: szczegóły praktyczne

- **Read-only katalog?** `showDirectoryPicker({mode:'read'})` jest na Androidzie od 132 — tak, read-only wybór katalogu istnieje; `mode:'readwrite'` daje od razu zapis (plus `requestPermission` w trakcie, na żądanie UI Chrome).
- **Limit pamięci / kwota:** operacje `createWritable` na plikach z dysku nie podlegają kwocie storage (nie duplikują zawartości w OPFS na trwałe — plik tymczasowy obok, atomowa zamiana po `close()`). Pozostaje ryzyko odrzucenia przez Safe Browsing/skanowanie (rzadkie dla MP3).
- **Uprawnienia.** Po restarcie przeglądarki handle z IndexedDB przechodzi przez `queryPermission()` = `'prompt'` → trzeba wywołać `requestPermission()` (jedno kliknięcie użytkownika). Na desktopie Chrome **122+** ma „persistent permissions” dla FSA (przywraca przyznane uprawnienie bez pytania dla tego samego origin/handle); **brak twardego cytatu, że dotyczy to Androida** — oznaczone jako do empirii (otwarta kwestia, patrz niżej). Blog o tej funkcji był pod `https://developer.chrome.com/blog/persistent-permissions-fsa` (URL 404 w dniu badań; funkcja opisana w changelogu Chrome 122 / MDN `Window.showDirectoryPicker` → sekcja uprawnień).
- **Zapis większych partii (3000 plików):** jedna instancja handle katalogu (w IndexedDB); zapis wielokrotny = kolejne `createWritable` + `close()`; na Androidzie liczy się bateria/pamięć — batch z postępem per plik, bez timeoutów.

### A.3 Desktop: uprawnienia, IndexedDB, secure context, PWA

- **Handle w IndexedDB:** `FileSystemHandle` jest strukturalnie klonowalne i serializowalne — przechowywany w IndexedDB między sesjami (to standardowa praktyka; potwierdzone w MDN opisie API/projektach VS Code for Web, Squoosh). Po przywróceniu trzeba ponownie `queryPermission()`/`requestPermission()` (chyba że persistent permissions z A.2 się włączy).
- **Secure context:** `file://` jest **formalnie** „potentially trustworthy origin” → secure context (MDN, tabela: `file:///path` ✅ secure). Czyli statyczna aplikacja odpalona z pliku `.html` **nie jest z automatu „nie-HTTPS”**.
  - **ALE:** praktyczne działanie FSA pickerów z `file://` w obecnych Chrome potwierdzają raporty społeczności, nie dokumentacja produktowa — **oznaczone jako otwartą wątpliwość** (empiria na Chrome ≥132: desktop+Android).
  - Bezpieczny standard: hosting na `https://` (np. GitHub Pages) lub `http://localhost` (VS Code Live Server) — wtedy nie ma niewiadomych i działa IndexedDB/OPFS niezależnie od `file://`.
  - cyt: https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts („Potentially trustworthy origins: scheme https/wss/file, localhost”).
- **PWA:** NIE jest wymagane dla FSA. Instalowalność dzisiaj: manifest (name, icons, display, start_url) + HTTPS; wymóg Service Worker był złagodzony (desktop Chrome bez twardego wymogu; na Androidzie SW dodatkowo poprawi doświadczenie, ale nie blokuje FSA). Niski priorytet — do decyzji w 09-final-spec.
- **`file://` i IndexedDB/OPFS:** działają na desktopie z `file://` w Chrome, ale między `file://` a domeną hostingową istnieją **różne originy** — dane trzymane w OPFS/IndexedDB nie przeniosą się między nimi. Dla v2 (rekomendacja): hosting jako origin docelowy.

### A.4 Fallbacki (wzorce z dużych aplikacji)

| Scenariusz | Wzorzec | Używane API (wersje) |
|---|---|---|
| Android Chrome <132 / Firefox / Safari | edycja w pamięci → plik do pobrania („download”) lub zapis przez `input file → OPFS → download` | OPFS 109+, Blob + `<a download>` / `showSaveFilePicker` 132+ |
| Import bez pickera | wybór plików, skopiowanie zawartości do OPFS jako cache; operacje na kopii | `input[type=file][multiple]` + `createWritable` (109+) |
| Eksport z OPFS po edycji | `showSaveFilePicker` (desktop 86+ / Android 132+) lub download | 86+ / 132+ / Blob download wszędzie |
| Gdy FSA w ogóle nieobecne (zwykłe przeglądarki) | per-file read → tag w pamięci → „pobierz poprawione MP3” — użytkownik nadpisuje sam | Blob + download |
| Duża aplikacja — przewidywalny guard | feature-detect `'showDirectoryPicker' in window` → try/catch `SecurityError`/`AbortError`; komunikat i fallback do `input file` (przykład: VS Code for Web pokazuje „Local File Access”, Squoosh degraduje do downloadu, edytory ffmpeg.wasm: process → download) | dowolne |

**Rekomendacja do v2:** jeden wspólny pipeline plikowy (odczyt → wstrzymane zmiany → zapis), dwie strategie wyjścia: (1) „in place” przez FSA handle tam gdzie dostępne, (2) „download/copy” wszędzie indziej. Przycisk „Otwórz katalog” aktywny tylko tam, gdzie feature-detect zejdzie z OK.

---

## Część B — biblioteki ID3 (odczyt + zapis POPM, przeglądarka)

### B.1 Macierz

| Biblioteka | Read POPM (v2.3+v2.4) | Write POPM | ID3v2.3 zapis | Browser-ready | Utrzymanie (stan 2026-10) | Uwagi |
|---|---|---|---|---|---|---|
| **music-metadata** (Borewit) | ✅ pełne (email+rating+counter, mapowanie → `common.rating` 0..1 + eksport `ratingToStars`) | ❌ (read-only) | n/d (czyta 2.3 i 2.4) | ✅ `parseBlob`/`parseWebStream`/`parseBuffer` — „cross-platform”, README: „can also be used in a browser environment when bundled”; czysty ESM ES2023 | ✅ aktywna (CI, wysoka liczba zależnych projektów, dema online) | Najlepszy odczyt; POPM v2.3 testowane (`{email:'no@email', rating:128, counter:0}` w testach repo) |
| ~~music-metadata-browser~~ (legacy) | (to co wyżej) | ❌ | n/d | ✅ (historycznie) | ⚠️ archiwum/legacy — funkcje wcielone do `music-metadata` ≥8 | Nie wybierać — tylko odczyt, nie rozwijane |
| **browser-id3-writer** (egoroof) | ❌ („It can't read the tag”) | ❌ **brak POPM** (pełna lista ramek w README — bez POPM; `tools/id3v2.3.0.txt` to tylko spec) | ✅ zapisuje ID3v2.3 (TYER/TDAT itd.) | ✅ natywnie (ESM, `script type=module`, Node też) | ✅ aktywna (6.4.0, 2026-07; repo żywe, licencja MIT) | ⚠️ **Usuwa cały istniejący tag (v2.2/2.3/2.4)** — aplikacja MUSI sama przekopiować pozostałe ramki (bezpośrednio z odczytu music-metadata), jeśli ma zachować resztę tagów |
| **jamp3** (ffalt) | ✅ (odczyt raw frames, bez zniekształcania) | ✅ (ramki „unknown” zapisywane jako blob → da się też zapisać POPM) | ✅ (parametr `version: 3|4`) | ❌ **Node-only** (fs/streams; deps `iconv-lite`, `memory-stream`) | ✅ 0.6.1 (2026-03) — aktywna | Świetne narzędzie do batch/offline skryptu, nie do przeglądarki |
| **node-id3** | ✅ | ✅ (pole `popularimeter`: email/rating/counter) | ✅ (domyślnie v2.3) | ⚠️ pośrednio — CJS + Node `Buffer`; do przeglądarki tylko przez bundler + polyfill `Buffer` | (nie weryfikowane w tym bilecie) | Realna droga na wyjście awaryjne, ale nie „browser-first” |
| **id3js** | ⚠️ (prawdopodobnie tak — zwraca raw ramki; w v1 aplikacji używane do odczytu) | ❌ read-only | n/d | ✅ lekka, przeglądarkowa | ⚠️ legacy (brak ruchu od lat; do inspekcji) | Opcja, gdyby zależało na minimalnym rozmiarze; do wartości POPM pewniejszy jest music-metadata |
| **jsmediatags** | ⚠️ (raw ramki ID3 v2 z unsynchronisation) | ❌ „Media Tags Reader” — tylko odczyt | n/d | ✅ | ❌ ostatnie wydanie 3.9.7 z 2021-04 — nieutrzymywane | Nie rekomendować do nowych zależności |

### B.1.1 Cytaty do macierzy

**music-metadata**
- README „Compatibility”: „This module requires a Node.js ≥ 22 engine. It can also be used in a browser environment when bundled with a module bundler”; lista tagów: „ID3: ID3v1, ID3v1.1, ID3v2.2, ID3v2.3, ID3v2.4…”; funkcje „Cross-platform”: `parseWebStream`, `parseBlob`, `parseBuffer`, `parseFromTokenizer`; eksporty: `orderTags`, `ratingToStars`, `selectCover`: https://github.com/Borewit/music-metadata (README)
- Mapowanie POPM → rating: `lib/id3v2/ID3v24TagMapper.ts` (`POPM: 'rating'`, `toRating(popm: IPopularimeter)`), parser ramki: `lib/id3v2/FrameParser.ts` (`case 'POPM'` + warning przy braku bajtu ratingu): https://github.com/Borewit/music-metadata/blob/master/lib/id3v2/ID3v24TagMapper.ts , …/FrameParser.ts
- Potwierdzenie odczytu v2.3 i skali 0–255 → 0–1: test `test/test-file-mpeg.ts` (`idv23.POPM[0] = { email: 'no@email', rating: 128, counter: 0 }`), `test/test-id3v2.3.ts` (przypadki Winamp 0–5 gwiazdek): https://github.com/Borewit/music-metadata/blob/master/test/test-id3v2.3.ts
- Współpraca z foobar2000 (`POPULARIMETER`-ASF) wskazuje dojrzałość modelu ratingu: `lib/asf/AsfTagMapper.ts`

**browser-id3-writer**
- README: „JavaScript library for writing ID3 (v2.3) tag to MP3 files… It can't read the tag so use another lib to do it.”; „Note: the library removes existing ID3 tag (v2.2, v2.3 and v2.4).”; „Supported frames” (pełna lista bez POPM); instalacja/ESM/`script type=module`): https://github.com/egoroof/browser-id3-writer
- npm (ostatnie 6.4.0, 2026-07-30): https://www.npmjs.com/package/browser-id3-writer
- Licencja MIT.

**jamp3**
- npm: opis „mp3, id3v1, id3v2 - reader & writer”, Node-only (keywords `nodejs, cli`; `bin/*`; deps `iconv-lite`, `commander`, `memory-stream`); wydanie 0.6.1 z 2026-03-10: https://www.npmjs.com/package/jamp3
- README (z npm): „Write support… ID3v2/ID3v1 can be updated, removed or written… For ID3v2.4 an easy-to-use build helper… deal with unknown/not implemented ID3v2 frames… binary blobs… can be also written”; użycie: `id3v2.write(filename, tag, version, 0, options)` z `version: 3|4` (2.3/2.4).

**node-id3 / jsmediatags / id3js**
- node-id3: npm https://www.npmjs.com/package/node-id3 (tag writer, Buffer-based; POPM — do twardego potwierdzenia w tickecie 01)
- jsmediatags: npm „Media Tags Reader (ID3, MP4)” (read-only; ostatnie wydanie 2021-04): https://www.npmjs.com/package/jsmediatags
- id3js: lekki reader (dowód użycia: stary music-rater; status npm do inspekcji)

### B.2 Rekomendowana para (odczyt + zapis)

| Rola | Wybór | Dlaczego |
|---|---|---|
| **Odczyt** (POPM + tagi) | **`music-metadata`** (`parseBlob`) | Jedyna aktywnie utrzymywana przeglądarkowa biblioteka z pełnym, testowanym parsowaniem POPM v2.3 **i** v2.4; zwraca surowe `{email, rating(0–255), counter}` w `metadata.native['ID3v2.3']` (po `orderTags`), plus pomocnik `ratingToStars`; czysty ESM — odnośnie „vanilla, bez bundlera”: można ładować z CDN jako moduł ESM (import map / jsDelivr esm.run), ale bezpieczniejsza droga to lekki pre-bundle; 3000 plików obsłuży przez sekwencyjne wywołania `parseBlob` |
| **Zapis** (tag + reszta ramek) | **`browser-id3-writer`** + **własna ramka POPM** | Identyczny bufor-AB model pracy (ArrayBuffer in → ArrayBuffer out) jak v1 aplikacji; zapis ID3v2.3 zweryfikowany praktyką; wadą jest brak POPM i fakt „usuwa cały istniejący tag”. Ramka POPM jest prosta (`owner\0` + `rating` 1 bajt + counter 4–8 bajtów) — dopisanie ~40–60 linijek w kodzie aplikacji (bajty zdefiniuje ticket 01) jest mniejszym ryzykiem niż monkey-patch. **Alternatywnie:** fork/PR do browser-id3-writer dodający POPM (repo żyje, owner odpowiada) |
| Awaryjnie: gotowy write POPM out-of-the-box | **`node-id3`** + polyfill `Buffer` (tylko z bundlerem), lub **`jamp3`** w skrypcie Node offline (batch migration) | Nie browser-first; traktować jako plan B/narzędzie CLI, nie bibliotekę UI |

**Zastrzeżenie „preserve rest of tags”:** z `browser-id3-writer` aplikacja jest odpowiedzialna za przekopiowanie wszystkich poprzednich ramek (tekstowych i binarnych/APIC) z odczytu music-metadata do `setFrame(...)`. To dodatkowa praca, ale zysk: pełna kontrola i czytelna migawka tagu przed zapisem. (v1 aplikacji tego nie robiła — v2 tak powinna, inaczej za każdym zapisem tracimy np. okładki.)

### B.3 Co się weryfikuje w innych ticketach (nie tu)

- Dokładne bajty POPM, wybór ownera (email) i skalowanie gwiazdek 0–255 ↔ 1–5 → ticket **01-popm-interop-matrix** (z odnotowanym faktem z music-metadata: testy używają `rating: 128` ↔ `0.5`, czyli skala 0–255 z binarnym „half” jako 128).
- Architektura build/bundler czy CDN ESM → ticket **06-stack-hosting**.
- Foldery testowe (3000 rekordów, pomijanie `.asd`) → ticket **05-sample-tag-audit**.

---

## Otwarte wątpliwości (do empirii przed spec)

1. **FSA z `file://` w praktyce:** pickery w Chrome na `file://` — znane z paru raportów, ale brak cytatu produktowego; przetestować ręcznie (desktop + Android lub hosting w Live Server jako B plan).
2. **Persistent permissions na Androidzie:** Chrome 122+ przywraca uprawnienia FSA na desktop; na Androidzie zapewne każda sesja = `requestPermission()` — do potwierdzenia empirycznie na Chrome ≥132 (jeśli nie działa: akceptowalne UX — jedno kliknięcie „Zezwól” przy starcie).
3. **node-id3 POPM write i utrzymanie** — zaznaczone „nie weryfikowane w tym bilecie”; doprecyzować tylko w razie wyboru wariantu awaryjnego.
4. **id3js: czy zwraca wartość POPM w przystępnej formie** (vs music-metadata natywnie) — dopiero gdyby decyzja padła na ZERO-zależności od music-metadata.

---

## Spis źródeł (ujęte dnia 2026-10-26)

- MDN / BCD:
  - https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker
  - https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable
  - https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory
  - https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts
  - https://developer.mozilla.org/en-US/docs/Web/API/StorageManager (persist/estimate/getDirectory)
  - https://github.com/mdn/browser-compat-data (`api/Window.json`, `api/FileSystemFileHandle.json`, `api/StorageManager.json`)
- Chrome:
  - https://developer.chrome.com/docs/capabilities/web-apis/file-system-access
- Biblioteki:
  - https://github.com/Borewit/music-metadata (+ `lib/id3v2/ID3v24TagMapper.ts`, `lib/id3v2/FrameParser.ts`, `test/test-id3v2.3.ts`)
  - https://github.com/egoroof/browser-id3-writer , https://www.npmjs.com/package/browser-id3-writer
  - https://www.npmjs.com/package/jamp3 (repo: https://github.com/ffalt/jamp3)
  - https://www.npmjs.com/package/jsmediatags , https://www.npmjs.com/package/node-id3 , https://www.npmjs.com/package/id3js (legacy)

*Plik wytworzony przez research-agent; nie modyfikuje map.md ani issues/*.*
