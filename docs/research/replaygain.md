# ReplayGain w MP3 — track gain dla music-rater: tagi, skan w przeglądarce, GainNode, cache

Data: 2026-10-26 · Ticket: [`.scratch/music-rater-target/issues/04-replaygain.md`](../issues/04-replaygain.md) · Pokrewne: [`research/pcloud-api.md`](pcloud-api.md)

Źródła: [loudgain README (Moonbase59)](https://github.com/Moonbase59/loudgain), [Wikipedia: ReplayGain](https://en.wikipedia.org/wiki/ReplayGain), [id3.org/id3v2.4.0-frames](https://id3.org/id3v2.4.0-frames), [id3.org/id3v2.3.0](https://id3.org/id3v2.3.0), MDN ([decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData), [MediaElementAudioSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/MediaElementAudioSourceNode)), [npm ebur128-wasm](https://www.npmjs.com/package/ebur128-wasm), [ffmpeg-filters](https://ffmpeg.org/ffmpeg-filters.html), [BTR AMP docs (SoundCheck)](https://btrlabs.com/btr-amp-v13-volume-normalization-replaygain-and-sound-check/).

---

## Podsumowanie

**Werdykt: TAK — track-gain jest w pełni wykonalny w czystym JS bez backendu.** Użytkownik potwierdza, że pliki są już przeskanowane ReplayGain-em, więc główną ścieżką jest **odczyt tagów**, a skan w przeglądarce to tylko awaryjne uzupełnienie dla plików bez tagów.

- **Odczyt tagów** — kolejność (od najwyższego priorytetu): `TXXX REPLAYGAIN_TRACK_GAIN` (ID3v2.3/v2.4, porównanie case-insensitive) → `RVA2` (v2.4) / `RVAD` (v2.3) → APEv2 `REPLAYGAIN_*` (mp3gain). Nagłówek LAME i `iTunNORM` (SoundCheck) **ignorujemy**. Dokładnie taka drabinka priorytetów jest w README loudgain — `TXXX` zawsze wygrywa.
- **Skan awaryjny** — `fetch` (wymaga CORS na serwerach plików pCloud!) → `decodeAudioData` (tylko cały plik; ~106 MB RAM dla 5 min stereo) → `ebur128-wasm` **w Web Workerze** (wywołania biblioteki są blokujące). Miernik: **prawdziwy BS.1770** (integrated loudness + true peak), nie surowy RMS — tylko wtedy wyniki skanu są zgodne z tagami z realnych skanerów.
- **Poziom odniesienia skanu: −18 LUFS** (`gainDb = −18 − measuredLUFS`) — bo tyle zakłada ReplayGain 2.0 / loudgain („89 dB" ≈ −18 LUFS) i wówczas pliki skanowane trafiają na ten sam poziom co otagowane. Streamingowy −14 LUFS utworzyłby stały 4 dB rozjazd między tymi dwiema grupami.
- **Odtwarzanie** — `<audio crossOrigin="anonymous">` → `MediaElementAudioSourceNode` → `GainNode` → destination (strumieniowanie z URL, scrubbing na HTTP Range, mało RAM). Bez CORS cross-origin węzeł elementu gra **ciszę** — wtedy fallback: `fetch` + `URL.createObjectURL(blob)` (blob jest same-origin) albo pełne `decodeAudioData` + `AudioBufferSourceNode`. Zawsze stosować **clamp przed clippingiem**: gdy `finalGain + peak > −1 dB`, zmniejszyć gain.
- **Cache** — IndexedDB, klucz tożsamości pliku: pCloud `fileid` (+ zapisane `size`/`modified` do walidacji) albo `local|path|size|lastModified`; payload `{ gainDb, peakDb?, source: 'tag'|'scan'|'estimate', subSource, scannedAt }`; zmiana tożsamości pliku → unieważnienie wpisu.

---

## 1. Gdzie w MP3 siedzą dane ReplayGain — identyfikatory i formaty wartości

| Skaner | Gdzie zapisuje | Identyfikatory i format wartości |
| --- | --- | --- |
| **loudgain** (ReplayGain 2.0) | **Wyłącznie TXXX** w ID3v2.4 (domyślnie; `-I 3` → ID3v2.3) | TXXX description `REPLAYGAIN_TRACK_GAIN`, value `[-]a.bb dB`; obok `REPLAYGAIN_TRACK_PEAK`, value `c.dddddd` (ratio względem 0 dBFS, **bez jednostki**). Tryb albumowy (`-a`) dodaje `REPLAYGAIN_ALBUM_GAIN/PEAK`; `-s e` dodaje `REPLAYGAIN_TRACK_RANGE`, `REPLAYGAIN_ALBUM_RANGE` (`a.bb dB`) i `REPLAYGAIN_REFERENCE_LOUDNESS` (`[-]a.bb LUFS`); tryb `-s l` używa `LU` zamiast `dB`. Domyślnie WIELKIE litery, `-L` → małe (spec mówi o wielkich, ale w praktyce częste są małe — stąd konieczność porównania case-insensitive). ID3 pisany w ISO-8859-1. **True peak** mierzony przez libebur128 (4× nadpróbkowanie dla < 96 kHz). **Usuwa** wszystkie inne postaci RG z pliku (APEv2, RVA*, LAME header). Ignoruje SoundCheck. Cel: −18 LUFS |
| **foobar2000** (RG 1.0; od wersji 1.1.6 skan BS.1770/LUFS) | TXXX (typowo ID3v2.3) | Ta sama rodzina `REPLAYGAIN_*`; w praktyce w plikach foobar2000 częsty **małe litery** (`replaygain_track_gain`) — apka musi porównywać case-insensitive (VLC historycznie czytało tylko wielkie, IDJC/KODI tylko małe) |
| **mp3gain** | **APEv2** na końcu pliku + bezpośrednia, odwracalna amplifikacja danych MP3 (undo info w tagu) | Klucze APE m.in. `REPLAYGAIN_TRACK_GAIN` (`[-]a.bb dB`), `REPLAYGAIN_TRACK_PEAK`, `MP3GAIN_MINMAX`. README loudgain ocenia to krytycznie: APEv2 „hides ReplayGain data from normal ID3 taggers — a bad idea". Skala klasycznego RG (89 dB SPL) |
| **iTunes SoundCheck** | Własne pole `iTunNORM` w ID3 | Format **niedokumentowany** (dziesięć długich liczb, wewnętrzna skala Apple); loudgain zostawia bez zmian, playerzy spoza Apple zwykle ignorują. Zawiera **tylko track-level** (BTR AMP: *„SC only contains track specific data"*) — pasuje do track-only, ale nie parsujemy |
| **Klasyczne RG 1.0 w ID3** | `RVA` (v2.2), `TXX` (v2.2), `RVAD` (v2.3) | RVAD: bity inc/dec per kanał, „bits used for volume description" typowo `$10` (16), zmiany głośności P/L + opcjonalny peak; max jedna ramka RVAD na tag |
| **Nagłówek LAME** | side info kontenera MP3 (nie tag) | `RGAD_TRACK/ALBUM` w LAME header — README loudgain: **brak znanego playera, który to czyta** → ignorować |

Te uwagi dotyczą **track gain** — album-gain jest poza zakresem (tagi albumowe mogą istnieć, nie decydują o głośności).

### Formaty wartości — parser

- `REPLAYGAIN_TRACK_GAIN` — wartość stringiem `[-]a.bb dB` (np. `-7.89 dB`, `+3.20 dB`); regex `/^([+-]?\d+(?:\.\d+)?)\s*dB$/i` (tryb `-s l` loudgain pisze `LU` — liczba taka sama).
- `REPLAYGAIN_TRACK_PEAK` — liczba `c.dddddd` (ratio względem 0 dBFS, bez jednostki); na dB: `20·log10(ratio)`.
- `TXXX` (v2.3 i v2.4 identycznie): **byte kodowania + description (terminated string) + null + value**; opis porównywać po `toLowerCase()`.
- `RVA2` (ID3v2.4): string identyfikacji (zwykle `track`) + typ kanału (*$00 Other, $01 Master volume, $02 Front right, $03 Front left, …*) + **korekcja głośności jako 16-bit signed stałoprzecinkowe; wartość w dB = raw / 512** (precyzja 0,001953125 dB, zakres ±64 dB; spec: zapis = adjustment×512; +2 dB = `$04 00`, −2 dB = `$FC 00`); potem „bits representing peak" — zwykle 0 = brak peaka. Czytać typ `$01` (master), fallback typu `$00` (Other).
- `RVAD` (ID3v2.3), starszy i mniej wygodny format — fallback tylko w braku RVA2.

## 2. Rekomendowana kolejność odczytu tagów

Loudgain README podaje drabinkę priorytetów (od najniższego do najwyższego):

**LAME header < APEv2 `REPLAYGAIN_*` < RVA (v2.2) < TXX (v2.2) < RVAD (v2.3) < RVA2 (v2.4) < TXXX `REPLAYGAIN_*` (v2.3 i v2.4)**

Praktyczny algorytm:

1. Range-fetch nagłówka ID3v2 (~64–256 kB pierwszych pliku); obsłużyć v2.3 i v2.4.
2. **TXXX z opisem `REPLAYGAIN_TRACK_GAIN`** (case-insensitive): jeśli jest → wynik i koniec szukania; dokładać `REPLAYGAIN_TRACK_PEAK`, gdy istnieje (potem do clamp).
3. Brak TXXX → **`RVA2`** (v2.4; raw/512 dB per kanał, typ `$01`/`$00`), ewent. `RVAD` (v2.3). Peak zwykle nieobecny („bits representing peak" = 0).
4. Brak ramki RG w ID3 → parsować **APEv2** z końca pliku (Range-request ostatnich ~32 kB) — tak zapisuje mp3gain.
5. Nadal nic → plik leci do skanu (pkt. 3).
6. **Nie parsujemy** LAME header ani `iTunNORM`; jeśli tylko one obecne — UI może to zaznaczyć, plik i tak idzie do skanu.
7. Fakt praktyczny: loudgain przy tagowaniu usuwa wszystkie inne formy RG — więc w pliku z tagiem loudgain TXXX jest jedynym źródłem; w starszych plikach mp3gain/foobar2000 kolejność i tak rozstrzyga.

## 3. Szybki skan w przeglądarce dla plików bez tagów

### Pipeline

`fetch (CORS!) → ArrayBuffer → decodeAudioData [main thread: prepared context] → AudioBuffer (resampled do rate kontekstu) → kanały (Float32Array) → ebur128-wasm [Web Worker] → integrated LUFS + true peak`

- `decodeAudioData` przyjmuje **tylko pełny plik** (`ArrayBuffer`) i zwraca AudioBuffer zresamplowany do sample rate kontekstu; dekodowanie strumieniowe niemożliwe. Koszt RAM: 300 s · 44 100 · 2 kanały · 4 B = **≈ 106 MB** stereo (mono ≈ 53 MB). **Zwalniać** AudioBuffer po skanie; równoległość skanów ograniczyć do 1–2; `ArrayBuffer` przekazywać do Workera przez transfer.
- Biblioteka pomiarowa: **[`ebur128-wasm`](https://www.npmjs.com/package/ebur128-wasm)** (npm, streamonkey, Apache-2.0; Rustowy `ebur128` skompilowany do WASM):
  - **v2.x działa bez bundlera** (plain JS/HTML) — dopasowane do statycznej strony vanilla-JS; v3.x wymaga narzędzi typu Vite/webpack;
  - README: *„the calls are blocking … calling this from a Web Worker is advised"* — **Worker jest koniecznością**; główny wątek by się mroził na sekundy;
  - API: `ebur128_integrated_mono(sample_rate, samples)`, `ebur128_integrated_stereo(sample_rate, left, right)`, oraz true peak: `ebur128_true_peak_mono/…stereo(...) : Float64Array`.
- **Dlaczego prawdziwy BS.1770, nie surowy RMS** — ReplayGain RG1 i RG2 liczą **K-ważoną głośność, okno 400 ms, bramkowanie (gating) i percentyl statystyczny** (BS.1770); RMS nie ma ważenia ani bramkowania, więc wynik byłby rozbieżny względem tagów (różnice rzędu kilku dB). Jeśli uproszczona implementacja liczyłaby RMS, mogłaby być tylko flagą `estimate` (przybliżenie), a nie zamiennikiem pełnego skanu.
- Wydajność: loudgain (natywny) → ~2,3 s/plik; dekodowanie MP3 w przeglądarce dla 5-min nagrania → rzędy jedn. sekund (CPU). Dla 3000 plików robić **leniwie**: skanować tylko pliki, do których user faktycznie wraca (i cache-ować), a nie „całą bibliotekę na starcie". Pasek progresu + limit równoległość.
- **Opcjonalny tryb estimate**: fragment pliku (np. 60–120 s obcięty do granicy ramki MP3) → wcześniejsza luźna wartość, flaga zezwalająca na późniejsze przeskanowanie w pełni. Uwaga na pliki z ciszą na początku nagrania; domyślnie pełny skan.
- Alternatywy z research (bez wdrażania): `dsp-audio-metrics` (BS.1770-4, zero deps), `loudness-audio-kit`, `@audio/loudness-lra`, `normalize-audio-loudness-loader` (webpack). Po stronie natywnej: ffmpeg `loudnorm` / `ebur128` / `replaygain` — dobre odniesienie dla logiki, nie do przeglądarki.

### WARUNEK: CORS na serwerach plików pCloud

Skany (i fallback blobu) wymagają `fetch` z `Access-Control-Allow-Origin`. Research pCloud (`research/pcloud-api.md`) potwierdził CORS na `api.pcloud.com` (ACAO `*`), ale **serwery zawartości `cXX.pcloud.com` nie zostały jeszcze przetestowane (testy T2/T4)**, a `getfilelink`/`getaudiolink` mają w docs zastrzeżenie o ograniczeniu referera. Bez ACAO na serwerach plików nie zadziała ani skan, ani strumieniowanie Web Audio — wspólny warunek z pkt. 4; ewentualne rozwiązanie: proxy.

## 4. Nakładanie gainu w playerze

### Graf Web Audio (wariant docelowy)

```
<audio crossOrigin="anonymous"> → createMediaElementSource → GainNode → destination
```

- `MediaElementAudioSourceNode` (Baseline; 0 wejść / 1 wyjście, `channelCount` = 2): strumieniowanie MP3 z URL, scrubbing na HTTP Range „za darmo", mało RAM. Przy tworzeniu węzła ustawić **`crossOrigin = "anonymous"`**.
- ⚠️ Cross-origin bez CORS w tym węźle → **wyjście wypełnione zerami (cisza)** — spec. Trzeba umieć wykryć ciszę przy pierwszym `play` (np. `AnalyserNode`) i w razie czego przełączyć się na fallback.
- **Fallback**: `fetch` pliku → `audio.src = URL.createObjectURL(blob)` — blob URL jest same-origin, więc graf Web Audio działa; koszt: plik w RAM (nie cache-ować blobów, tylko bieżący). Wariant bardziej pamięciożerny: `decodeAudioData` + `AudioBufferSourceNode`.
- Gain: `finalGainDb = gainDb (tag lub skan) + preampDb (użytkownika)`; konwersja `linear = 10^(finalGainDb / 20)`; ustawianie przez `gainNode.gain.value` z `linearRampToValueAtTime`, bo skokowa zmiana słychać jako „klik".
- **Pre-gain clamp (ochrona przed clippingiem)**: jeśli `finalGainDb + peakDb > −1 dB`, to `finalGainDb = −1 − peakDb`. Odniesienie: loudgain `-k` (prevent clipping, −1 dBTP) i ffmpeg `volume: replaygain_noclip=1`. Peak z `REPLAYGAIN_TRACK_PEAK` (ratio → dB: `20·log10`) albo z wyniku skanu (`ebur128_true_peak_*`). Gdy peaka brak (np. tylko RVA2 bez peaka): nie podbijać powyżej ~−3 dB bez pomiaru, albo skanować plik by peak zdobyć. Dla dyktafonowych nagrań (głos/gitara z mikrofonu) peaky są zwykle wyraźnie poniżej 0 dBFS — clamp będzie rzadki, ale istnieć musi.
- Preamp użytkownika: opcjonalny suwak w UI (np. +0…+6 dB, domyślnie 0 dB — pliki grające na −18 LUFS mogą być cichsze niż streaming; precedent: ffmpeg `volume: replaygain_preamp`).

## 5. Poziom odniesienia: 89 dB vs −18 LUFS vs −14 LUFS

- **Klasyczny ReplayGain 1.0**: cel = różowy szum odtwarzany przy 89 dB SPL (odpowiednik ≈ −14 dBFS różowego szumu; konwencja SMPTE RP 200). Tagi mp3gain i starszych narzędzi są w tej skali.
- **ReplayGain 2.0** (loudgain, foobar2000 ≥ 1.1.6): oparte na BS.1770 / EBU R128; cel **−18 LUFS**; README loudgain: *„−18 LUFS is estimated to be equal to the old 89 dB reference loudness"* — w praktyce RG1 i RG2 dają podobny poziom odtwarzania.
- **Streaming** (Spotify i in.): −14 LUFS — **to nie jest ReplayGain**. Mieszanie obu celów da stały ~4 dB rozjazd między plikami otagowanymi (−18) i skanowanymi, gdyby skan robić do −14.

**Rekomendacja — reguła spójności:** skan zawsze do **−18 LUFS** (`gainDb = −18 − measuredLUFS`), niezależnie od tego, jak stare są tagi w pliku. Za cicho → preamp w UI, nie zmiana poziomu odniesienia (inaczej spójność tag/skan staje się niemożliwa).

## 6. Cache wyników — IndexedDB

- **Baza:** np. `music-rater-rg`, object store `gains` (keyPath `key`). Możliwe włączenie do istniejącej bazy aplikacji.
- **Klucz tożsamości pliku:**
  - pCloud: `'pcloud|' + fileid` — dodatkowo przechowywać `path`, `size`, `modified` do walidacji (reupload tego samego pliku pod tą nazwą: `uploadfile` nadpisuje i powstaje rewizja; czy `fileid` przy tym zostaje — **do przetestowania**; bezpieczniej walidować rozmiar+modyfikację);
  - pliki lokalne (FSA): `'local|' + path + '|' + size + '|' + lastModified`.
- **Payload:** `{ key, provider, gainDb, peakDb?, source: 'tag' | 'scan' | 'estimate', subSource: 'txxx' | 'rva2' | 'rvad' | 'ape' | 'ebur128', durationSec?, scannedAt }`.
- **Unieważnianie:** zmiana `fileid`/`size`/`mtime` → rekord wyrzucony, kod liczy od nowa. Wpisy `source='scan'` i `source='estimate'` trzymać do zmiany pliku (skan jest drogi), z przyciskiem „przeskanuj" w UI na wymuszenie. Wpisy `source='tag'` są tanie do odczytu (nagłówek ID3 z Range-requestu) i mogą być z automatu odświeżane przy listingu — to pewniejsza ścieżka.
- **Kolizja źródeł:** nowy wynik nadpisuje stary tylko **lepszym** źródłem (tag > scan > estimate); skan nie powinien nadpisać tagu dostępnego później.

## Rekomendowany przepływ

1. Listing plików (pCloud `listfolder` / FSA): lista MP3 z identyfikatorami (`fileid` lub `path|size|mtime`).
2. Cache: sprawdź klucz; unieważnij rekord przy zmianie `fileid`/`size`/`mtime`.
3. **Odczyt tagów** (Range-request nagłówka ID3, optional tail dla APEv2): TXXX `REPLAYGAIN_TRACK_GAIN` (case-insensitive) → RVA2/RVAD → APEv2; plus `REPLAYGAIN_TRACK_PEAK` jeśli jest. Zapis `source='tag'`.
4. Brak tagu → **skan w tle** (kolejka w Web Workerze, 1–2 równolegle): `fetch` → `decodeAudioData` → `ebur128-wasm` (integrated LUFS + true peak) → `gainDb = −18 − LUFS` → zapis `source='scan'` (opcja: tryb `estimate` z krótszego fragmentu).
5. **Odtwarzanie:** `<audio crossOrigin="anonymous">` → `MediaElementAudioSourceNode` → `GainNode` → destination; `finalGainDb = gainDb + preampDb`; clamp tak, by `finalGain + peak ≤ −1 dB` (≈ −1 dBTP); gain w formie linear z rampą. Player gra od razu z gain = 0 dB, po szybkim odczycie/skanie wartość jest nakładana z rampą.
6. **Inwalidacja**: porównanie tożsamości pliku przy każdym listingu; rozjazdy kasują rekordy; przycisk „przeskanuj” w UI.
7. **Test empiryczny przed implementacją:** czy serwery `cXX.pcloud.com` (getfilelink/getaudiolink) wysyłają `Access-Control-Allow-Origin` — bez tego padnie i skan, i fallback (T2/T4 z research pCloud); jeśli nie — decyzja o proxy.

## Otwarte pytania / ryzyka

- **CORS na `cXX.pcloud.com`** (T2/T4) — warunek skanów i Web-Audio fallbacku; do rozstrzygnięcia testem; plan B: proxy.
- **`crossOrigin="anonymous"` + referer-restriction pCloud** — czy odtwarzanie przez `<audio>` z `getaudiolink`/`getfilelink` w ogóle zagra (zastrzeżenie w docs o refererze; możliwa konieczność `Referrer-Policy: no-referrer` albo blob/proxy).
- **Stabilność `fileid` przy reuploadzie** (uploadfile nadpisuje plik) — do przetestowania (research pCloud, rewizje).
- Wydajność skanu na słabszych urządzeniach mobilnych (dekodowanie 5-min MP3 + WASM) — wprowadzić leniwe skanowanie i limit równoległości.

## Źródła

- [loudgain (Moonbase59) — README](https://github.com/Moonbase59/loudgain) — formaty tagów RG2 (`REPLAYGAIN_TRACK_GAIN/PEAK/RANGE/REFERENCE_LOUDNESS`), tryby `-s i/e/l`, `-L`, `-I 3`, `-S`, drabinka priorytetów (LAME < APEv2 < RVA/TXX v2.2 < RVAD v2.3 < RVA2 v2.4 < TXXX), „reads and writes only TXXX", ignorowanie SoundCheck, krytyka APEv2 (mp3gain), clipping prevention `-k` → −1 dBTP, ~2,3 s/plik, „−18 LUFS equal to the old 89 dB", true peak via libebur128.
- [Wikipedia — ReplayGain](https://en.wikipedia.org/wiki/ReplayGain) — metadata RG w tagach (ID3v2 dla MP3), cel 89 dB SPL = −14 dBFS (SMPTE RP 200), track vs album, mp3gain zmieniający dane, SoundCheck jako własnościowy, foobar2000 1.1.6+ → BS.1770.
- [ID3v2.4.0 — frames](https://id3.org/id3v2.4.0-frames) — **RVA2** (id string, typy kanałów, korekcja = 16-bit signed fixed point ×512, „bits representing peak"), **TXXX** (byte encodingu + description + value); [ID3v2.3.0](https://id3.org/id3v2.3.0) — **RVAD** (inc/dec per kanał, „bits used for volume description" typowo $10).
- MDN — [BaseAudioContext.decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData) — tylko pełny `ArrayBuffer`, resampling do rate kontekstu; [MediaElementAudioSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/MediaElementAudioSourceNode) — baseline, 1 wyjście, cross-origin bez CORS = wyjście to cisza.
- [npm — ebur128-wasm](https://www.npmjs.com/package/ebur128-wasm) — streamonkey, Apache-2.0; Rust `ebur128` → WASM; *„the calls are blocking … calling this from a Web Worker is advised"*; v2.x bez bundlera; API `ebur128_integrated_mono/_stereo`, `ebur128_true_peak_mono/_stereo`.
- [ffmpeg — filters](https://ffmpeg.org/ffmpeg-filters.html) — filtr `replaygain` (eksponuje `track_gain`/`track_peak`), opcje `volume`: `replaygain=track`, `replaygain_preamp`, `replaygain_noclip` (clipping prevention analogiczny do naszej reguły clamp).
- [BTR AMP — Volume Normalization (ReplayGain & Sound Check)](https://btrlabs.com/btr-amp-v13-volume-normalization-replaygain-and-sound-check/) — SoundCheck tylko track-level; ręczny preamp jako uzupełnienie RG/SC.
- Research własny: [`research/pcloud-api.md`](pcloud-api.md) — CORS na `api.pcloud.com` potwierdzony (ACAO `*`); serwery zawartości `cXX.pcloud.com` i ograniczenie referera w `getfilelink`/`getaudiolink` — **do przetestowania** (T2/T4).
