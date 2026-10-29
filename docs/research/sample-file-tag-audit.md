# Audyt rzeczywistych tagów MP3 — próbki z biblioteki `D:\music\recordings\hi-q-recordings\`

*Audyt empiryczny (read-only, analiza surowych bajtów), 2026-10-26. Pełni rolę faktycznego inputu dla biletlów „Matryca zgodności POPM" i „ReplayGain: tagi i skan w przeglądarce".*

## Podsumowanie

- **Dominuje ID3v2.3** — wszystkie otagowane pliki mają identyczny nagłówek `49 44 33 03 00 00 ...`: `major=3`, `flags=0x00` (bez unsynchronisation, bez extended header, bez footer, bez paddingu-experimental).
- **ReplayGain istnieje wyłącznie jako para ramek `TXXX`** o opisach (description) dokładnie: `replaygain_track_gain` oraz `replaygain_track_peak`, z wartościami tekstowymi typu `-0.02 dB` / `0.479255`. **Zero ramek `RVA2` / `RVAD`**, zero `iTunNORM`/`RGAD`/`MP3GAIN_*`. Format odpowiada zapisowi narzędzia typu MP3Gain: dwie osobne ramki TXXX obok siebie.
- **Każdy plik z ReplayGain ma zawsze *dwie* ramki TXXX** — `replaygain_track_gain` + `replaygain_track_peak` występują w parze (skan markerów widzi 2× `TXXX` i 2× `replaygain` na plik).
- **POPM istnieje w 7/35 plików**: ramka `POPM` z ownerem `"Windows Media Player 9 Series"` (to NIE jest adres e-mail, nie ma `@`), bajt oceny w skali WMP (1, 64, 128, 196), counter = 0. To są **realne, istniejące oceny, których nie wolno nadpisywać** — aplikacja musi rozróżniać zapis do własnego konta (np. `music-rater@local`) od odczytu istniejących.
- **Żaden plik nie ma APEv2** — brak `APETAGEX` nigdzie w pliku (w tym w ostatnich 500 B). **Ale każdy plik z ID3v2 ma na końcu pusty ID3v1** (`TAG` + same zera; bajt 127 = `0xFF`). ID3v1 jest martwy (żadnych danych) — aplikacja może go zignorować lub usunąć, ale nie może na nim polegać.
- **`zoom` i pojedyncze pliki w `2022-02`** (np. `rec_2021-04-05_23-28_708.mp3`) mają **brak jakiegokolwiek tagu**: pierwszy bajt = `FF FB` (sync MPEG-1 L3), 128 kbps, 44.1 kHz, stereo. Zapis oceny do takich plików = budowa tagu ID3v2 od zera.

---

## Tabela per plik

Przeanalizowano 35 plików (z ~45 zaplanowanych; 10 pozycji z wstępnej listy okazało się nieistniejącymi ścieżkami) z folderów: 2017, 2019-2, 2021-2, 2022-02, 2023-01 (+ `wyb`), 2024-01, 2025-01, 2026-01, tag-test, zoom.

Uwaga interpretacyjna: „(brak tagu)" = plik zaczyna się bezpośrednio od audio `FF FB`, bez ID3v2/ID3v1/APEv2. „POPM=`<bajt>`" = wartość bajtu oceny (skala WMP: 0–255, tu: 1 / 64 / 128 / 196).

| plik (relatywnie do hi-q-recordings\) | ID3v2 wersja | ReplayGain markery (dokładne nazwy i przykładowe wartości) | POPM (email, bajt) | APEv2? | ID3v1? | enkoder | bitrate (szac.) | rozmiar |
|---|---|---|---|---|---|---|---|---|
| 2017\recording-20170603-081145.mp3 | 2.3 | `replaygain_track_gain` = `-0.02 dB`; `replaygain_track_peak` (w parze) | — | nie | tak (pusty) | (brak LAME w nagłówku) | 128 kbps / 44.1 kHz / stereo | 999 519 B |
| 2017\recording-20170603-125539.mp3 | 2.3 | `replaygain_track_gain` = `-0.46 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 999 519 B |
| 2017\recording-20170603-130251.mp3 | 2.3 | `replaygain_track_gain` = `-0.63 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 2 310 239 B |
| 2019-2\recording-20190701-212126.mp3 | 2.3 | `replaygain_track_gain` = `-0.71 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 1 933 240 B |
| 2019-2\recording-20190703-232634.mp3 | 2.3 | `replaygain_track_gain` = `+0.37 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 314 484 B |
| 2019-2\recording-20190705-181750.mp3 | 2.3 | `replaygain_track_gain` = `+0.41 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 806 422 B |
| 2019-2\recording-20190714-212520.mp3 | 2.3 | `replaygain_track_gain` = `+0.73 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 1 270 775 B |
| 2019-2\recording-20190715-122933.mp3 | 2.3 | `replaygain_track_gain` = `+0.61 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 27 353 936 B |
| 2021-2\rec_2021-07-02_10-47_866.mp3 | 2.3 | `replaygain_track_gain` = `+0.16 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 806 422 B |
| 2021-2\rec_2021-07-02_10-50_867.mp3 | 2.3 | `replaygain_track_gain` = `-0.60 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 660 972 B |
| 2021-2\rec_2021-07-03_22-13_868.mp3 | 2.3 | `replaygain_track_gain` = `+0.32 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 945 184 B |
| 2021-2\rec_2021-07-03_22-32_870.mp3 | 2.3 | `replaygain_track_gain` = `+0.01 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 1 453 005 B |
| 2022-02\rec_2021-04-05_23-21_707.mp3 | 2.3 | `replaygain_track_gain` = `-0.47 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 3 101 855 B |
| 2022-02\rec_2021-04-05_23-28_708.mp3 | **brak tagu** | — | — | nie | nie | (brak LAME) | 128 / 44.1 / stereo | 31 213 190 B |
| 2022-02\rec_2022-07-01_12-50_1333.mp3 | 2.3 | `replaygain_track_gain` = `+0.50 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 1 306 301 B |
| 2023-01\rec-2023-01-02_09-50_1511.mp3 | 2.3 (⚠ niestandardowy rozmiar tagu — patrz Wnioski) | `replaygain_track_gain` = `-1.16 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | ~128 / 44.1 / stereo | 1 219 365 B |
| 2023-01\rec-2023-01-02_09-56_1513.mp3 | 2.3 | `replaygain_track_gain` = `-1.84 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME), ale w tagu występuje ciąg `Info` (offset ~2178) | 128 / 44.1 / stereo | 1 179 241 B |
| 2023-01\wyb\1-verse rec-2023-01-02_09-50_1511 harmonia-C-C-G-e-C-a-G-D.mp3 | 2.3 | `replaygain_track_gain` = `-1.21 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 1 170 884 B |
| 2023-01\wyb\2-verse rec-2023-02-28_12-01_1567 C-C-F-C.mp3 | 2.3 | `replaygain_track_gain` = `+0.05 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 1 050 929 B |
| 2024-01\rec-2024-01-02_09-04_1870.mp3 | 2.3 | `replaygain_track_gain` = `+10.67 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | `LAME3.99.5` (2 wyst.) | 128 / 44.1 / stereo | 681 453 B |
| 2024-01\rec-2024-01-02_10-48_1872.mp3 | 2.3 | `replaygain_track_gain` = `-2.27 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | `LAME3.99.5` | 128 / 44.1 / stereo | 259 313 B |
| 2025-01\rec-2025-01-01_00-49_2379.mp3 | 2.3 | `replaygain_track_gain` = `+16.33 dB`; `replaygain_track_peak` = `0.479255` | `Windows Media Player 9 Series`, bajt **64** | nie | tak (pusty) | `LAME3.99.5` (2 wyst. w tagu: `LAME3.99.5UU`+`LAME3.98r`) | 128 / 44.1 / stereo | 842 785 B |
| 2025-01\rec-2025-01-01_00-55_2380.mp3 | 2.3 | `replaygain_track_gain` = `+14.34 dB`; `replaygain_track_peak` | `Windows Media Player 9 Series`, bajt **1** | nie | tak (pusty) | `LAME3.99.5` | 128 / 44.1 / stereo | 2 315 674 B |
| 2026-01\rec-2026-01-02_10-40_2768.mp3 | 2.3 | `replaygain_track_gain` = `-2.79 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 996 593 B |
| 2026-01\rec-2026-01-02_22-44_2769.mp3 | 2.3 | `replaygain_track_gain` = `+30.24 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 1 735 128 B |
| 2026-01\rec-2026-01-05_10-33_2770.mp3 | 2.3 | `replaygain_track_gain` = `-6.57 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | (brak LAME) | 128 / 44.1 / stereo | 2 665 922 B |
| tag-test\rec-2024-07-12_16-46_2127.mp3 | 2.3 | `replaygain_track_gain` = `+10.31 dB`; `replaygain_track_peak` | — | nie | tak (pusty) | `LAME3.99.5` | 128 / 44.1 / stereo | 1 277 881 B |
| tag-test\rec-2024-08-02_07-13_2144.mp3 | 2.3 | `replaygain_track_gain` = `+8.55 dB`; `replaygain_track_peak` | `Windows Media Player 9 Series`, bajt **128** | nie | tak (pusty) | `LAME3.99.5` (×2) | 128 / 44.1 / stereo | 1 196 378 B |
| tag-test\rec-2024-08-02_07-23_2146.mp3 | 2.3 | `replaygain_track_gain` = `+18.84 dB`; `replaygain_track_peak` | `Windows Media Player 9 Series`, bajt **64** | nie | tak (pusty) | `LAME3.99.5` (×2) | 128 / 44.1 / stereo | 1 293 763 B |
| tag-test\rec-2024-08-13_12-35_2151.mp3 | 2.3 | `replaygain_track_gain` = `+1.68 dB`; `replaygain_track_peak` | `Windows Media Player 9 Series`, bajt **1** | nie | tak (pusty) | `LAME3.99.5` (×2) | 128 / 44.1 / stereo | 617 504 B |
| tag-test\rec-2024-12-24_10-27_2373.mp3 | 2.3 | `replaygain_track_gain` = `+3.75 dB`; `replaygain_track_peak` | `Windows Media Player 9 Series`, bajt **196** | nie | tak (pusty) | `LAME3.99.5` (×2) | 128 / 44.1 / stereo | 452 829 B |
| zoom\170202-172418.MP3 | **brak tagu** | — | — | nie | nie | (brak; nagłówek = `FF FB 90 60 ...`) | 128 / 44.1 / stereo | 1 461 603 B |
| zoom\170204-150043.MP3 | **brak tagu** | — | — | nie | nie | (brak) | 128 / 44.1 / stereo | 1 105 084 B |
| zoom\170212-201617.MP3 | **brak tagu** | — | — | nie | nie | (brak) | 128 / 44.1 / stereo | 315 559 B |
| zoom\170809-231030.MP3 | **brak tagu** | — | — | nie | nie | (brak) | 128 / 44.1 / stereo | 574 275 B |

---

## Wnioski dla aplikacji

### 1. Format ID3v2: pisz WYŁĄCZNIE v2.3

- Katalog jest 100% zgodny z **ID3v2.3** (major=3, flags=`0x00`, brak extended header, brak footer, brak unsynchronisation).
- v2.3 używa **zwykłego big-endian 32-bit** dla rozmiaru tagu (nie synchsafe — to różnica względem v2.4). Zmierzony rozmiar tagu to zawsze 4190 lub 4191 B, a strumień audio zaczyna się w okolicy offsetu 4191–4231.
- Konkretny nagłówek: `49 44 33 03 00 00 00 00 10 54` → size `0x001054` = 4180 B, tag całkowity = 4180+10 = 4190 B. Wariant `...10 55` → 4191 B; różnica wynika z długości wartości peak (np. `0.479255` ma 8 znaków).

### 2. ReplayGain — czytać/wykrywać parę TXXX w ID3v2.3

- **Dokładne identyfikatory do szukania**: ramka `TXXX` z description (dopasowanie **rozróżniające wielkość liter**, małe litery + podkreślenia):
  - `replaygain_track_gain` ⟶ wartość typu `-0.02 dB`, `+10.67 dB`
  - `replaygain_track_peak` ⟶ wartość typu `0.479255`
- **Nie ma** `RVA2`, `RVAD`, `iTunNORM`, `RGAD`, `MP3GAIN_MINMAX`, ani gainu albumowego. **Nie ma też APEv2** (`APETAGEX` nie występuje nigdzie). Format wartości: tekst w dB z dwoma miejscami po przecinku (separator dziesiętny — **kropka**), wzorzec `±%.2f dB`; peak jako liczba dziesiętna bez jednostki.
- Zapis w stylu MP3Gain: dwie osobne ramki TXXX obok siebie (gain + peak). Przy zapisie własnych wartości RG aplikacja powinna podtrzymać ten sam układ zamiast wprowadzać `RVA2`.
- Wartości wahają się od `-6.57 dB` do `+30.24 dB` (w tym podejrzane +16/+30 dB — prawdopodobnie skan bardzo cichego materiału). Parser musi tolerować wartości wyraźnie poza typowym zakresem.

### 3. POPM — realne oceny istnieją i trzeba je przechować

- 7/35 ma ramkę POPM: owner = **`Windows Media Player 9 Series`** (hex: `57 69 6E 64 6F 77 73 20 4D 65 64 69 61 ...` — to NIE jest adres e-mail; nigdy nie zakładaj `@` w ownerze POPM).
- Bajty oceny w skali WMP: **1 = 1 gwiazdka (20%); 64 = 2 gwiazdki, 128 = 3 gwiazdki, 196 = 4 gwiazdki** (standard WMP9: 1/64/128/196/255). Counter = 0 (4 bajty, 0 w wszystkich).
- **CRITICAL**: aplikacja przy zapisie własnej oceny musi:
  1. **zachować istniejącą ramkę** `Windows Media Player 9 Series` (nie nadpisywać jej),
  2. **zapisać/zaktualizować własną ramkę POPM** z odrębnym emailem (np. `music-rater@local`),
  3. przy odczycie **preferować własną ramkę**, a WMP–owę pokazywać jako „ocena z WMP".
- Format POPM w v2.3: `owner (latin-1) 00 rating(1B) counter(4B)`.
- Brak części plików POPM (28/35) — aplikacja musi tolerować brak ramki (semantika „brak oceny" ≠ 0 gwiazdek).

### 4. zoom i pliki nieotagowane (2022-02)

- `zoom\*.MP3` (nagrywarka Zoom) i `2022-02\rec_2021-04-05_23-28_708.mp3` — **całkowity brak tagów**; strumień audio zaczyna się od `FF FB 90 …` (MPEG-1 L3, 128 kbps, 44.1 kHz, stereo). Nazwy plików zoom mają format `YYMMDD-HHMMSS.MP3`, bez polskich znaków. Aplikacja musi umieć obsłużyć plik bez ID3v2 (brak ocen, brak RG) — zapis oceny do takiego pliku = wstawienie kompletnego tagu od zera (osobna ścieżka testowa).
- `2022-02\rec_2022-07-01_13-03_1334.mp3` i `rec_2022-07-01_13-06_1335.mp3` — niezweryfikowane (nie istniały w FS; wstępna lista). Folder `2022-02` zawiera pliki z 2021 i 2022 — miks roczników w jednym folderze.
- **`tag-test`** zawiera mieszankę: 4/5 z POPM (bajty 1/64/128/196) i wszystkie z RG (do +18.84 dB) — idealny zestaw do testów end-to-end odczytu. **`wyb`** ma nazwy z opisami i spacjami („1-verse rec-… harmonia-C-C-G-e-C-a-G-D.mp3") — uważaj na parsowanie ścieżek. **`zoom`** — całkowicie nieotagowane (test „brak tagu").

### 5. Enkoder / bitrate / czas trwania

- Ciąg `LAME3.99.5` występuje w okolicach offsetów ~2595–2850 od początku pliku (przy ramce `Info`/Xing wewnątrz tagu) tylko w części plików (2024+, tag-test, 2025-01). Starsze pliki (2017–2023-01) nie mają rozpoznawalnego nagłówka LAME w pierwszych 4 KB.
- **Xing/`Info` występuje tylko w niektórych plikach** — nie można polegać na nagłówku VBR przy liczeniu długości.
- Zdecydowana większość (34/35) to **CBR 128 kbps / 44.1 kHz / stereo**; wyjątek: `rec-2023-01-02_09-50_1511.mp3` (48 kHz, mono — odrębny profil nagrywania).
- Przy braku Xing najbezpieczniej liczyć czas z rozmiaru strumienia audio i bitrate'u pierwszej ramki: `duration ≈ (size − tagEnd) / (bitrate / 8)`; traktować jako wartość przybliżoną (pasek postępu).

### 6. Rzeczy dziwne (edge cases dla parsera)

1. **Pusty ID3v1 na końcu** (`TAG` + 125×0x00 + 0xFF na końcu): jest w każdym pliku z ID3v2. Aplikacja przy zapisie v2.3:
  - **nic nie zmienia** w ID3v1 (jest pusty — pozostaje nieszkodliwy), LUB
  - **usuwa** 128 B, jeśli dodamy opcję „clean v1" (nie jako default).
2. **Plik z nietypowym przebiegiem iteracji ramek** (`2023-01\rec-2023-01-02_09-50_1511.mp3`): standardowa iteracja ramek zatrzymuje się na pierwszym `00 00 00 00` już przy bajcie ~94 (reszta tagu = padding), mimo że skan binarny znajduje w obszarze tagu dodatkowe ciągi `replaygain`/`Info` (offset ~2178) — czyli w tagu (~4190 B) mogą siedzieć dodatkowe ramki, których standardowy parser nie pokaże. Audio zaczyna się tu przy 4198–4230 zależnie od zaokrąglenia — **pierwszego sync `FF FB`/`FF FA` trzeba szukać skanem (do ~4 KB za końcem deklarowanego tagu), nie stałym offsetem**.
3. Iteracja ramek ma się zatrzymywać na **pierwszej „nieważnej" pozycji** (fid nie A-Z0-9) = standard; parser powinien wtedy traktować resztę tagu jako padding — tak postępuje większość bibliotek.
4. **zoom (brak tagu)**: dane audio zaczynają się `FF FB` na bajcie 0 — wystarczy prosty skan synchronizacji od początku.
5. **Część plików w `2022-02`** pochodzi z 2021 (nazwy `rec_2021-…`) — miks roczników w jednym folderze: sortowanie po folderze ≠ sortowanie po roku nagrania (rok wypisuj z nazwy pliku).
6. `*.asd` (Rekordbox) — ignorować całkowicie (wg zadania).

### 7. Bezpieczna ścieżka zapisu tagu (przepis dla aplikacji)

1. Odczytaj ID3v2.3 (subparser: `ID3` + major=3 + flags=0x00; bez extended header/footer).
2. Zbuduj nową listę ramek = zachowaj istniejące (TXXX–RG pair, POPM WMP) + zmień/dodaj TXXX/POPM własne.
3. Zapisz z odpowiednim paddingiem (target: 4190/4191 B jak w bibliotece — wystarcza na TXXX + POPM + duży margines).
4. **Nie ruszaj** strumienia audio (offset-tag-end do EOF) ani ID3v1 (zostaw jak jest).
5. Weryfikacja end-to-end: testuj na plikach z **tag-test** (POPM=128/196 do symulacji odczytu istniejących ocen) oraz na jednym **zoom** (zapis tagu do pliku beztagowego).
