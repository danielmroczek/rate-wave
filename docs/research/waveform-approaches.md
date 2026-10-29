# Waveform: research dróg bez proxy

Data: 2026-10-27 · Ticket: `.scratch/music-rater-target/issues/14-waveform-research.md`
Kontekst: [pCloud API — Testy empiryczne T4](pcloud-api.md) (brak ACAO na serwerach plików), [Model stanu i trwałość (07)](../issues/07-data-model.md) (fingerprint size+modified, IndexedDB).

---

## Werdykt

**MVP i jednocześnie droga docelowa: prekomputowane peaks + cache IndexedDB, liczone opportunistycznie** — przede wszystkim jako „by-product" operacji oceny (przy zapisie ID3 plik i tak jest w całości w pamięci → `decodeAudioData` + min/max do buckietów bez dodatkowego transferu). **Droga A (`AnalyserNode` na żywym `<audio>`) jest martwa dla pCloud z dwóch niezależnych powodów:** (1) CORS-taint — `MediaElementAudioSourceNode` dla cross-origin medium bez ACAO wypisuje same zera, a serwery plików pCloud nie wysyłają ACAO (T4); (2) nie widzi żadnego audio przed odtworzeniem fragmentu, więc nie da scrubowalnego waveformu nawet przy działającym CORS. **Proxy (Cloudflare Worker) dla waveformu: nie warte złożoności** — jedyny zysk to peaks dla utworu przed pierwszą oceną, a użytkownik ratera i tak odsłuchuje przed oceną; koszt (druga ścieżka, deploy, podtrzymanie) nieproporcjonalny. Degradacja mobilna: limit rozmiaru pliku 50 MB + skip przy oszczędzaniu baterii / `Save-Data` — trywialne.

Jeśli szukać jednego zdania: **waveform rysujemy z cache, a wyliczanie peaks przyłączamy tylko do momentu, gdy plik już i tak jest w RAM (zapis oceny); scrubbing działa od pierwszej chwili, bo bazuje na `duration` z `preload=metadata`, nie na peaks.**

---

## 0. Corpus — fakty liczbowe (pomiar lokalny, 2026-10-27)

Z `D:\music\recordings\hi-q-recordings\` (bez `*.asd`, 19 podfolderów rocznikowych):

| miara | wartość |
| --- | --- |
| liczba MP3 | **3635** (spójne z censusem POPM z biletu 10) |
| suma | **5,37 GB** |
| średni plik | 1548 KB |
| mediana (p50) | 948 KB |
| p90 | 1911 KB |
| max | 402 MB (outlier — całe nagranie sesji, nie pojedynczy utwór) |
| ID3v2 tag (przykład tag-test) | ~2,1 KB na początku pliku |

---

## 1. Droga A — `AnalyserNode` na żywym `<audio>`: odrzucona (dwa niezależne powody)

### 1a. CORS-taint → cisza (fundamentalny blocker dla pCloud)

`MediaElementAudioSourceNode` podłącza element `<audio>` do grafu Web Audio. [Spec Web Audio](https://webaudio.github.io/web-audio-api/#MediaElementAudioSourceNode) i [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaElementAudioSourceNode): jeżeli media pochodzą z innego originu bez nagłówków CORS (**CORS-cross-origin** — element bez `crossOrigin="anonymous"` albo serwer bez ACAO), node **wypisuje same zera** — dane nie wydostają się z taintu do `getFloatTimeDomainData`. Z [testu T4](pcloud-api.md) wiemy, że serwery plików pCloud (`evie1.pcloud.com`) **nie wysyłają `Access-Control-Allow-Origin`** — ustawienie `crossOrigin="anonymous"` dodatkowo **zepsułoby sam playback** (żądanie bez zezwolenia CORS zostanie odrzucone). Praktyczna implikacja:

- dla plików pCloud: `AnalyserNode` nie da żadnych danych (0 dB wszędzie), a jedyny tryb, w którym dziś działa nasz `<audio src=…>`, to tryb **bez** `crossOrigin`, czyli bez Web Audio.
- dla plików lokalnych FSA (object URL, źródło same-origin) droga działa — ale to obejmuje tylko przyszłe, drugie źródło aplikacji.

### 1b. Brak danych „przedsłuchowych" (nawet gdyby CORS działał)

`AnalyserNode.getFloatTimeDomainData` zwraca tylko ostatnie ~2048 sampli (przy 44,1 kHz ≈ 46 ms) bieżącej chwili odtwarzania. Scrub **przed** odtworzeniem fragmentu nie ma żadnej podstawy — peaks musiałyby się „nabierać" podczas słuchania. Dla use-case „pokaż dynamiczny przebieg nagrania, którego jeszcze nie odsłuchałem" to zamysł nierealny: to droga do wizualizacji reaktywnej, nie do waveformu interaktywnego.

**Wniosek pkt 1:** droga pełni jedynie rolę uboczną (opcjonalny „live meter" podczas odtwarzania, tylko dla źródeł bez taintu). Nie rozwiązuje problemu dla pCloud i nie jest MVP.

---

## 2. Droga B — precompute peaks + IndexedDB: wybrana

### Rozmiar danych

Rekomendacja: **400 buckietów × (min + max) × `Uint8`** — 2 bajty na buckiet, wartości przemapowane na 0–255. Format zgodny z oczekiwaniem wavesurfer.js (tablice `min`/`max` podawane wprost do `load(url, peaks, duration)` — patrz pkt 4). Uwaga na założenie z biletu: 400 buckietów × 1 B ≈ 400 B/utwór dotyczyło tylko `max` bez `min` — do rysowania pełnego słupa (min–max) potrzebne są obie wartości; stąd realnie **~800 B/utwór**:

| wariant | B/utwór | 3635 utworów |
| --- | --- | --- |
| 400 × min/max × `Uint8` (rekomendowany) | 800 B | **~2,9 MB** |
| 400 × max × `Uint8` | 400 B | ~1,5 MB |
| 400 × min/max × `Float32` | 3,2 KB | ~11,6 MB |

**Wniosek: cache < 3 MB w IndexedDB — pomijalny** wobec danych biblioteki już trzymanych w bazie (listing 3635 rekordów to porównywalna, porządkowa wielkość). Pełny pierwszy skan nie istnieje jako pojęcie, bo przebiega **lazily** (pkt 2b) — nigdy nie pobieramy 5,37 GB „na zapas".

### 2a. Koszt CPU: `decodeAudioData` per utwór

`decodeAudioData` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)) dekoduje cały plik do PCM; AudioBuffer jest resamplowany do sample-rate kontekstu. Dokumentacja jawnie pisze: *„works only on complete file data"* — dekodowania „po kawałku" ze strumienia nie ma. Benchmarki literaturowe: dekodowanie MP3 to ok. **50–150× realtime na desktopie** i ok. **10–40× realtime na średnim Androidzie**. Przy bitrate ~128 kbps (~1 min audio ≈ 1 MB):

| plik | czas audio | desktop (100×) | mid Android (20×) |
| --- | --- | --- | --- |
| p50 948 KB | ~1 min | **<1 s** | **~3 s** |
| p90 1911 KB | ~2 min | ~1,2 s | ~6 s |
| max 402 MB | ~4,4 h | — degradacja: **skip** (limit, np. >50 MB) |

Pamięć chwilowa (istotne na Androidzie): AudioBuffer ≈ `duration × 44100 × 4 B × 2 kanały` ≈ **10,6 MB/min stereo** — dla p50 ~21 MB; AudioBuffer trzeba zwolnić (usunąć referencję) natychmiast po wyliczeniu buckietów. Samo wyliczenie min/max po 10,6 M sampli to <100 ms.

`OfflineAudioContext` potrzebny tylko do renderu DSP; do peaks wystarczy zwykły `AudioContext` w Workerze (OfflineAudioContext bywa droższy) — wsparcie Web Audio w Workerach w Chrome Android do weryfikacji w prototypie; fallback: `requestIdleCallback` na main thread.

### 2b. Kiedy liczyć peaks (kluczowy wybór UX — „opportunistic")

Plik jest **w całości w RAM** dokładnie w jednym naturalnym momencie pracy aplikacji: **przy zapisie oceny** (modyfikacja ID3 POPM + `uploadfile`). W tym momencie:

1. bierzemy ten sam `ArrayBuffer` przed modyfikacją tagów,
2. `decodeAudioData` → min/max 400 buckietów,
3. zapis do IndexedDB pod kluczem `'pcloud|'+fileid` z fingerprintem `size+modified` ([bilet 07](../issues/07-data-model.md)).
4. koszt marginalny: zero dodatkowego transferu, 1–6 s CPU w tle (Worker) — użytkownik już czeka na upload, więc ta dopłata czasowa jest maskowana.

Przycisk per-track „pokaż waveform od razu": dla pCloud **nie ma jak pobrać bajtów** (`fetch` bez ACAO nie działa — T4), więc nie pokazujemy go dla pCloud; liczymy tylko z okazji oceny. Dla lokalnych FSA dostęp do bajtów jest darmowy — tam przycisk może istnieć.

⚠️ **Kaskada istotna dla całej aplikacji:** zapis ID3 też robi po stronie klienta `fetch(fileURL)` + `uploadfile`. Skoro T4 pokazuje brak ACAO na serwerze plików, `fetch` bajtów z domeny aplikacji najpewniej nie zadziała **również dla zapisu oceny** — to jest **otwarte ryzyko krytyczne wykraczające poza waveform** (patrz pkt 6.3 i zaproponowany test T7).

### 2c. Klucz i unieważnianie cache

Zgodnie z [bilet 07](../issues/07-data-model.md):
- klucz `'pcloud|'+fileid` (T5 potwierdziło trwałość fileid przy overwrite) / `'local|'+relpath`;
- fingerprint `size + modified` trzymany **w rekordzie peaks**; walidacja per-odczyt z listingów (`listfolder`), bez TTL;
- overwrite pliku przez `uploadfile` zmienia size/hash/modified → fingerprint się rozjeżdża → peaks liczone od nowa przy następnej okazji (kolejna ocena tego pliku — naturalna pętla).

---

## 3. Droga C — proxy / hybrydy: świadomie odrzucona (na teraz i docelowo)

**Mini-proxy Cloudflare Worker „tylko dla waveformu"** — passthrough URL pliku z doklejonym ACAO — technicznie trywialny (~30 linii, zero sekretów, bo link z `getfilelink` jest podpisany i ma `expires`).

Co to właściwie „kupuje": peaks dla nienotowanego utworu natychmiast, bez czekania na pierwszą ocenę. Ale:

1. **Użytkownik ratera słucha zanim oceni** — a odsłuch i tak idzie przez `<audio>` bez proxy. Waveform „wypełnia się" w drodze B przy pierwszym odsłuchaniu z oceną. Różnica UX: waveform-przed-pierwszą-oceną vs waveform-po-pierwszej-ocenie — marginalna w raterze (grilling 2026-10-26: waveform dla ratera, nie archiwisty).
2. **Koszt architektoniczny:** druga ścieżka dostępowa (CORS), deploy, podtrzymanie usługi (bilet 06: „wszystko kompatybilne z Cloudflare Workers — decyzja o proxy audio warunkowa"). T3/T4 pozytywne — warunek odpadł; przywracanie go dla waveformu to krok wstecz.
3. **Ryzyko sekretu 0 — ale i zysku 0**; proxy włączałby się do przepływu tylko po to, by obejść własną decyzję „nie pobieramy pliku na waveform".

**Hybryda live-peaks-during-play** (droga A jako uzupełnienie drogi B) — ma sens wyłącznie dla źródeł bez CORS-taintu (lokalne FSA); dla pCloud nie istnieje (pkt 1a). Traktować wyłącznie jako degradację, nie jako uzasadnienie drogi A.

---

## 4. Ecosystem bibliotek — potwierdzenie wzorca „precomputed peaks"

- **wavesurfer.js** (v7, [docs](https://github.com/katspaugh/wavesurfer.js)): natywna ścieżka ładowania z **pre-decoded peaks** — `wavesurfer.load(url, peaks: number[][], duration)` „skips network fetch entirely"; `exportPeaks({channels, maxLength, precision})` potwierdza, że format tablic min-max jest jego modelem domyślnym. Wniosek: wspiera dokładnie architekturę z pkt 2 („audio gra przez element, grafikę rysujesz z tablic").
- **waveform-data.js** (BBC, [repo](https://github.com/bbc/waveform-data.js)): od początku zbudowane wokół **gotowych JSON-ów z peaks** (format `WAVEFORM: 1`) — dowód, że „precomputed peaks as the primary interface" to standard branżowy, nie hack.
- Własny renderer: 400 prostokątów na `<canvas>` — ~80 linii, zero zależności, działa na desktopie i Androidzie; wavesurfer.js tylko jeśli drag-scrub/zoom „z pudełka" ma spinać się z naszym `<audio>`.

---

## 5. Mobile: CPU, pamięć, bateria

Z grillingu 2026-10-26: aplikacja działa w pociągu, na Androidzie, na średnim sprzęcie; degradacja wymagana.

| aspekt | decyzja |
| --- | --- |
| CPU przy zdarzeniu oceny | +3–6 s w Workerze na mid-Androidzie dla p50/p90, maskowane przez upload; nieblokujące UI |
| pamięć chwilowa | ~21 MB AudioBuffer dla p50; **obowiązkowo** zwalniane natychmiast po wyliczeniu buckietów; bez batchowania (1 plik naraz) |
| bateria | koszt jednorazowy per utwór; po nagrzaniu cache zero kosztu; pełny skan 3635 plików nigdy nie wykonuje się hurtowo (pkt 2b) |
| degradacja | próg `< 50 MB` (max w corpus to 402 MB outlier — skip z pustym placeholderem), oszczędzanie baterii / `Save-Data` → skip; opcja „waveform off" w ustawieniach |
| offline | peaks w IndexedDB — waveform działa offline dla ocenionych utworów (bonus w pociągu) |

---

## 6. Punkty zasilające prototyp UX i spec

1. **Spec — model danych peaks:** rekord w IDB store `tracks` (bilet 07): `{fingerprint: {size, modified}, peaks: Uint8Array(800) /* 2×400 min/max */, buckets: 400, source: 'rating-write'}`.
2. **Spec — scrubbing nie zależy od peaks:** klik/tap po wstążce działa od startu na podstawie `duration` z `<audio preload="metadata">` (`getfilelink` + Range potwierdzone T4). Peaks to wyłącznie warstwa wizualna — brak peaks = prosty placeholder-bar, nie utrata scrubowania.
3. **🚨 Otwarte ryzyko krytyczne — zaproponowany test T7:** czy `fetch()` bajtów z serwera plików pCloud z domeny aplikacji (https, z Origin) jest możliwy; najpewniej nie (brak ACAO z T4), a wtedy **nie tylko waveform przez fetch, ale też zapis ID3 (`uploadfile`) wymaga innego przepływu** — proxy wraca na stół jako **konieczność dla ZAPISU OCEN** (nie waveformu). To jedyny scenariusz, w którym proxy wraca do architektury. Doprecyzowanie testu dodać do [pcloud-api.md](pcloud-api.md) po zaksięgowaniu raportu przez operatora.
4. **Prototyp UX:** trzy stany waveformu — (a) brak (placeholder + „pojawi się po pierwszej ocenie"), (b) generowanie (spinner na wstążce), (c) gotowy (400 kolumn, tap = seek). Eliminuje złudę „waveform jest zawsze".
5. **Droga docelowa = MVP:** bez zmian. Ewentualne rozbudowy później: (i) cudzy host/proxy dla „waveform przed oceną" — odrzucone na dziś; (ii) peaks zapisywane do ID3 TXXX w pliku dla przenośności między urządzeniami — osobny bilet (+2,1 KB tag overhead per plik, sprawdzić z matrycą POPM).

---

## 7. Kluczowe liczby (ściąga)

- Corpus: **3635 MP3 / 5,37 GB / p50 948 KB / p90 1,9 MB / max 402 MB**.
- Peaks: **800 B/utwór** (400 buckietów × min/max × Uint8) → **~2,9 MB całości** w IndexedDB.
- `decodeAudioData`: **<1 s desktop / ~3 s mid-Android** dla p50 (50–150× / 10–40× realtime); degradacja: limit 50 MB.
- AudioBuffer w pamięci: **10,6 MB/min stereo** → obowiązkowe natychmiastowe zwolnienie.
- `AnalyserNode` z pCloud: **zawsze zera** (CORS-taint) + zero danych przed odsłuchem → droga martwa dla głównego źródła.
- Scrubbing: niezależny od peaks (T4: `Accept-Ranges: bytes` + `preload=metadata` wystarcza).
- Cache: klucz `'pcloud|'+fileid` + fingerprint `size+modified` (T5 potwierdził trwałość fileid); unieważnianie per-odczyt, bez TTL.

## Źródła

- [MDN — BaseAudioContext.decodeAudioData()](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)
- [MDN — MediaElementAudioSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/MediaElementAudioSourceNode) (CORS-taint → zeros)
- [Spec Web Audio — MediaElementAudioSourceNode, CORS behavior](https://webaudio.github.io/web-audio-api/#MediaElementAudioSourceNode)
- [MDN — AudioBufferSourceNode / AudioBuffer](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode) (charakterystyka in-memory)
- [wavesurfer.js — load() z pre-decoded peaks, exportPeaks()](https://github.com/katspaugh/wavesurfer.js)
- [BBC waveform-data.js — precomputed peaks format](https://github.com/bbc/waveform-data.js)
- Lokalny research: [pcloud-api.md — T3/T4/T5](pcloud-api.md), [bilet 07 — Model stanu i trwałość](../issues/07-data-model.md), [bilet 10 — census POPM (3635 plików)](../issues/10-owner-frame.md)
