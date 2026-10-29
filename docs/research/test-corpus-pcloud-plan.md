# Corpus testowy na konto pCloud — plan (aktualizacja 2026-10-27 po południu)

> **⚠ AKTUALIZACJA (istotna!)**: biblioteka JEST JUŻ zsynchronizowana na konto pCloud przez **auto-sync rclone** — ścieżka `/audio/rec/hi-q-recordings` (3635 MP3, 5,8 GiB + 798 plików `.asd` Rekordboxa, do odfiltrowania w aplikacji). Oznacza to, że:
> 1. Drag&drop staging z §6 i katalog `music-rater-test` są **zbędne** — nie wgramy nic, bo prawdziwe dane już tam są. Decyzja §3 (płaski katalog testowy) **przestarzała**.
> 2. Aplikacja będzie więc obsługiwać **katalog z podfolderami rocznikowymi** („użytkownik wybiera `/audio/rec/hi-q-recordings`”): `listfolder?recursive=true` lub przechodzenie po folderach + filtrowanie `.asd` i `warped/`.
> 3. Corpus z §1 i dopełnienia §2 **pozostają aktualne** — pod ścieżką `/audio/rec/hi-q-recordings/<rocznik>/<plik>`.
> 4. Testy ruszyły szybciej niż planowały: **token rclone działa** (wyekstrahowany do `secrets/token.env`; userinfo result=0 na eapi). IDs: `secrets/test-ids.env` — folderid biblioteki 18335400545, folderid tag-test 18337423647, **fileid T5 = 71496730995** (`rec-2024-12-24_10-27_2373.mp3`, 452829 B, POPM bajt 196), alternatywa T5 = 71496730351 (`rec-2024-08-13_12-35_2151.mp3`, bajt 1).
> 5. `.asd` (798) i `warped/` — aplikacja ma odfiltrować: prototyp listy musi odrzucać rozszerzenie `.asd` i katalog `warped`.

---

**Poniżej oryginalny research (zanim wyszło, że sync już istnieje). Corpus i dopełnienia nadal aktualne; przeterminowane: §3, §4, §6.**

---

*Research do ticketu [issues/13-test-corpus-pcloud-plan.md](../issues/13-test-corpus-pcloud-plan.md), 2026-10-27. Dane wejściowe: audyt tagów 35 plików ([sample-file-tag-audit.md](sample-file-tag-audit.md)), census POPM ([popm-census-2026-10-26.json](popm-census-2026-10-26.json)) oraz pomiary PowerShell z 2026-10-27 (wyłącznie odczyt). Biblioteka lokalna zweryfikowana: **3635 plików MP3 / 5494 MB, średnio 1,51 MB/plik**; 16 folderów rocznikowych 2017…2026-01 + `zoom/` (16 plików, bez tagów), `tag-test/` (5), `warped/` (520 — poza zakresem MVP). Wszystkie ścieżki względem `D:\music\recordings\hi-q-recordings\`.*

| plik (relatywnie do `hi-q-recordings\`) | rozmiar | po co |
|---|---|---|
| `2019-2\recording-20190703-232634.mp3` | 0,30 MB | typowy (ID3v2.3 + para TXXX RG, pusty ID3v1); najmniejszy z typowych — najszybszy T3 (`getfilelink` bez Referera) i T4 (206/Content-Range/CORS) |
| `2017\recording-20170603-081145.mp3` | 0,95 MB | typowy, inny rocznik — reprezentant starszego nazewnictwa `recording-YYYY…` |
| `2021-2\rec_2021-07-02_10-50_867.mp3` | 0,63 MB | typowy, rocznik 2021 (nazewnictwo `rec_YYYY-MM-DD_HH-MM_NNN`) |
| `2022-02\rec_2022-07-01_12-50_1333.mp3` | 1,25 MB | typowy, folder `2022-02` (odrębne nazewnictwo `rec-…`) |
| `2026-01\rec-2026-01-02_10-40_2768.mp3` | 0,95 MB | typowy, najnowszy rocznik — profil tagów nowych nagrań |
| `2024-01\rec-2024-01-02_10-48_1872.mp3` | 0,25 MB | typowy z enkoderem `LAME3.99.5` — kontrola różnic nagłówka (`Info`/Xing) przy streamingu |
| `tag-test\rec-2024-12-24_10-27_2373.mp3` | 0,43 MB | **POPM owner `Windows Media Player 9 Series`, bajt 196 (4★) — główny cel T5**: nadpisanie `uploadfile` startuje od niepustego POPM; obserwujemy fileid/rewizję |
| `tag-test\rec-2024-08-13_12-35_2151.mp3` | 0,59 MB | **POPM WMP bajt 1 (1★) — drugi cel T5**: skrajnie przeciwny bajt oceny; para do porównania `listrevisions` |
| `2023-01\rec-2023-01-02_09-50_1511.mp3` | 1,16 MB | EDGE: jedyny znany profil **48 kHz mono** + nietypowy przebieg ramek w tagu (audyt pkt 6.2) — parser nie może się wywalić |
| `zoom\170212-201617.MP3` | 0,30 MB | EDGE: **brak jakiegokolwiek tagu** (audyt: pierwszy bajt = `FF FB`, audio od offsetu 0) — zapis 1★ do pliku beztagowego = budowa tagu ID3v2 od zera; rozszerzenie `.MP3` |

Uzasadnienie kompozycji:

1. **T5 wymaga niepustego POPM** — census (`stats`: 3635 plików, `popm: 157`, `multi_popm: 0`; per_dir: tylko `2024-02`, `2025-01`, `2025-02`, `tag-test`) potwierdza, że oceny WMP istnieją wyłącznie tam. Wybrano **najmniejszy** oceniony plik (0,43 MB, bajt 196) oraz drugi ze skrajnym bajtem 1 (0,59 MB) — oba z `tag-test`, zgodnie z zaleceniem ticketu. Zmiennik: najmniejszy plik WMP spoza `tag-test` wg censusu to `2025-01\rec-2025-02-02_13-33_2431.mp3` (0,22 MB).
2. **„Brak tagów"** — ticket wskazuje case z `zoom/`; audyt potwierdza brak tagów dla 4 przebadanych plików `zoom/`; wybrano najmniejszy (0,30 MB). Drugi znany przypadek beztagowy (`2022-02\rec_2021-04-05_23-28_708.mp3`) ma 31 MB — poza wyborem.
3. **Małe rozmiary** — każdy plik ≤1,25 MB; cała talia waży mniej niż przeciętny pojedynczy plik biblioteki.

## 2. Prototyp UX: warianty MINIMAL i MID

Średnia biblioteki: **1,51 MB/plik**; per rocznik od 0,97 MB (`2020`) do 3,94 MB (`2019-2`) — dlatego MID budujemy z **najmniejszych plików całej biblioteki**, a nie z całych roczników.

| wariant | liczba plików | łączny rozmiar | skład | cel |
|---|---|---|---|---|
| **MINIMAL** | **25** | **~9,66 MB** | corpus T3–T6 (10) + 15 dopełnień — najmniejszy plik ≥150 kB z 15 roczników nieobecnych w corpusie | czucie listy: scroll, wybór, gwiazdki, play; pierwszy realny kontakt z kontem |
| **MID** | **312** | **~89 MB** | 300 najmniejszych plików biblioteki (avg 0,28 MB) + 12 plików z corpusu spoza progu 300 | setki pozycji: wirtualizacja listy, pomiar czasu ładowania metadanych, scrubbing |

Uwagi:

- `listfolder` **nie ma paginacji** ([pcloud-api.md §3](pcloud-api.md)) — 312 pozycji w jednej odpowiedzi jest realne i zarazem zasila cache listingu z biletu 07 (Fingerprint size+modified per plik).
- Proponowany pomiar dla biletu 08: czas `listfolder` + `JSON.parse` dla 312 pozycji; czas parsowania tagów (POPM/RG) przy przewijaniu listy.
- Rekomendacja: **zacznij od MINIMAL (25)**; MID dołóż jednorazowo przed testami wirtualizacji — drag&drop <100 MB jednym rzutem jest realny.

Pliki dopełniające MINIMAL (pomiar 2026-10-27; reguła: najmniejszy ≥150 kB z folderu, bez duplikatów corpusu):

| folder | plik | rozmiar |
|---|---|---|
| 2018 | `recording-20180423-155017.mp3` | 0,24 MB |
| 2019-1 | `recording-20190429-085844.mp3` | 0,16 MB |
| 2020 | `rec_2020-10-28_19-31_582.mp3` | 0,15 MB |
| 2021-1 | `rec_2021-02-06_19-18_661.mp3` | 0,17 MB |
| 2022-1 | `rec_2022-05-30_07-56_1269.mp3` | 0,15 MB |
| 2023-02 | `rec-2023-11-14_20-22_1797.mp3` | 0,16 MB |
| 2024-02 | `rec-2024-09-06_11-48_2196.mp3` | 0,17 MB |
| 2025-02 | `rec-2025-07-09_19-10_2612.mp3` | 0,32 MB |

Pozostałych 7 dopełnień to najmniejsze pliki (≥150 kB) z roczników `2017`, `2019-2`, `2021-2`, `2022-02`, `2023-01`, `2024-01`, `2025-01` — każdorazowo inne niż pozycje corpusu; pełną aktualną listę generuje skrypt z §5.

Warianty rozważane i odrzucone:

- **MINIMAL = sam corpus (10 / 6,81 MB)** — 10 pozycji nie oddaje „czucia listy".
- **MID = cały rocznik 2020** (288 plików / 279 MB) — 3,1× droższy od MID, bez dodatkowych scenariuszy (brak zróżnicowania rozmiarów).
- **Pełna biblioteka** (3635 / 5,5 GB) — poza zakresem mapy.

## 3. Struktura katalogów na koncie pCloud

**Decyzja: jeden płaski katalog `music-rater-test` w korzeniu konta (`folderid 0`), bez podfolderów rocznikowych.**

Argumenty za płaskim (mirror roczników odrzucony):

1. **Model aplikacji = „użytkownik wybiera jeden katalog"** (Źródło = katalog na koncie pCloud; bilet 07 dopuszcza w MVP pCloud jako jedyne źródło). Płaski katalog → jeden wybór folderu i cała testowa biblioteka pod ręką; mirror roczników zmuszałby do życia w jednym roczniku albo do `listfolder?recursive=true`.
2. **`listfolder` nie ma paginacji** — płaski katalog = jeden request, jeden JSON; rekonstrukcja struktury drzewa po stronie klienta to dodatkowy kod bez korzyści w MVP (przeglądanie roczników nie jest funkcją aplikacji).
3. **Telefon**: najmniejsza liczba kroków w pickerze; przy mirrorze każda sesja to wejście `music-rater-test → rocznik`.
4. **Rok i tak jest w nazwie pliku** (`recording-2017…`, `rec_2021…`, `170212…` w zoom), a `2022-02` dowodzi, że folder ≠ rok (miks nagrań 2021/2022 w środku — audyt pkt 6.5); mirror rocznikowy nie wnosi prawdziwej metadanej.
5. **Sprzątanie i bezpieczeństwo**: koniec testów = usunięcie jednego katalogu z korzenia; pomyłka nie może dotknąć prawdziwej biblioteki (konto testowe, nazwa wyodrębnia katalog testowy). Osobnego podfolderu na kopie robocze T5 nie potrzeba — `uploadfile` wersjonuje, `listrevisions` pokazuje rewizje; opcjonalna ręczna kopia typu `…2373-BAK.mp3` może leżeć w tym samym katalogu.

Nazwa i położenie: **`music-rater-test`, korzeń konta**. W razie konfliktu nazwy → `music-rater-test-2` (nazwa jest też punktem odniesienia biletu 11 — zmianę trzeba tam odnotować).

## 4. Kolejność wgrania

1. **Web drag&drop — najpierw, działa od razu, bez tokena**: wgraj MINIMAL (25 plików / 7,18 MB) wg checklisty §6.
2. **T3/T4 nie muszą czekać na „oficjalny" token**: `getfilelink`/Range można testować od razu z tymczasowym tokenem (procedura w [pcloud-api.md §2/§7](pcloud-api.md)); formalna rejestracja appki pozostaje krokiem HITL w bilet 11.
3. **MID (312 / ~89 MB) dosyp w dowolnym momencie** — jedyna twarda zależność: przed testami wirtualizacji listy w bilet 08.
4. **`uploadfile` curl — dopiero po `access_token` z biletu 11**; pierwsze wywołanie zaplanuj jako nadpisanie `tag-test\rec-2024-12-24_10-27_2373.mp3` (plik z POPM 196) — zarazem smoke-test ścieżki uploadu i generalna próba T5 (ten sam fileid? nowa rewizja? POPM nietknięty?); wynik domyka warunkową decyzję o kluczu cache z biletu 07.

## 5. Przykładowy skrypt PowerShell (read-only) — generator listy kandydatów

Skrypt **tylko czyta** `D:\music` (`Get-ChildItem`, rozmiary); jedyny zapis to CSV poza biblioteką. Odtwarza wybory z §1–§2 (corpus deterministycznie + fill-ins regułą „najmniejszy ≥150 kB z rocznika").

```powershell
# generate_pcloud_candidates.ps1 — READ-ONLY dla D:\music (zapis wyłącznie CSV do .scratch)
$Root = 'D:\music\recordings\hi-q-recordings'
$Out  = 'D:\dev\music-rater\.scratch\pcloud-upload-list.csv'

# Corpus T3–T6 (10 plikow, rozdz. 1 raportu)
$Core = @(
  '2019-2\recording-20190703-232634.mp3',
  '2017\recording-20170603-081145.mp3',
  '2021-2\rec_2021-07-02_10-50_867.mp3',
  '2022-02\rec_2022-07-01_12-50_1333.mp3',
  '2026-01\rec-2026-01-02_10-40_2768.mp3',
  '2024-01\rec-2024-01-02_10-48_1872.mp3',
  'tag-test\rec-2024-12-24_10-27_2373.mp3',
  'tag-test\rec-2024-08-13_12-35_2151.mp3',
  '2023-01\rec-2023-01-02_09-50_1511.mp3',
  'zoom\170212-201617.MP3'
)
$coreFiles = foreach ($c in $Core) {
  $p = Join-Path $Root $c
  if (-not (Test-Path -LiteralPath $p)) { throw "Brak pliku: $c" }
  Get-Item -LiteralPath $p
}

# Dopolnienie MINIMAL: najmniejszy plik >=150 kB z kazdego rocznika (bez duplikatow corpusu)
$Years = '2017','2018','2019-1','2019-2','2020','2021-1','2021-2','2022-02','2022-1',
         '2023-01','2023-02','2024-01','2024-02','2025-01','2025-02','2026-01'
$fill = foreach ($y in $Years) {
  Get-ChildItem -LiteralPath (Join-Path $Root $y) -Recurse -File -Filter *.mp3 |
    Where-Object Length -ge 150KB |
    Where-Object { $coreFiles.FullName -notcontains $_.FullName } |
    Sort-Object Length | Select-Object -First 1
}

# MID: 300 najmniejszych plikow calej biblioteki
$mid = Get-ChildItem $Root -Recurse -File -Filter *.mp3 | Sort-Object Length | Select-Object -First 300

# CSV z podzialem na zestawy (MINIMAL = core+fill; MID = 300 najmniejszych + reszta corpusu)
$rows = @(
  $coreFiles | ForEach-Object { [pscustomobject]@{ set='core'; rel=$_.FullName.Substring($Root.Length+1); MB=[math]::Round($_.Length/1MB,2) } }
  $fill      | ForEach-Object { [pscustomobject]@{ set='fill'; rel=$_.FullName.Substring($Root.Length+1); MB=[math]::Round($_.Length/1MB,2) } }
  $mid       | ForEach-Object { [pscustomobject]@{ set='mid';  rel=$_.FullName.Substring($Root.Length+1); MB=[math]::Round($_.Length/1MB,2) } }
) | Sort-Object rel -Unique
$rows | Export-Csv -NoTypeInformation -Encoding UTF8 $Out
"rows=$($rows.Count) (core+fill = MINIMAL; unikalne rel dla MID ~312)"
```

Opcjonalny, ręczny krok staging (zapis **poza** `D:\music`): skopiuj wyselekcjonowane pliki do `D:\dev\music-rater\.scratch\pcloud-upload\music-rater-test\` i cały taki folder przerzuć drag&dropem — wtedy kroki 3–4 checklisty sprowadzają się do jednego przeciągnięcia.

## 6. Checklist: „Jak wgrać przez web pCloud" (bez tokena)

> **Stan 2026-10-27: staging WYKONANY** — 25 plików / 9,66 MB czeka w `D:\dev\music-rater\.scratch\pcloud-upload\music-rater-test\` (kontrolny CSV: `upload-verify.csv` obok). Zostaje krok wgrywania.

1. **Staging**: ✅ zrobione (25 plików; weryfikacja: `Get-ChildItem .scratch\pcloud-upload\music-rater-test | Measure-Object` → Count=25, suma 9,66 MB).
2. **Zaloguj się** na files.pcloud.com → **Moje pliki** (korzeń konta = `folderid 0`).
3. **Przeciągnij folder `music-rater-test`** z Eksploratora na panel plików web pCloud — web utworzy katalog o tej nazwie w korzeniu (od razu załatwia nazwę i położenie z §3).
4. **Zweryfikuj**: komunikat o przesłaniu, liczba pozycji w katalogu (25) i suma ~7,18 MB zgodna z CSV z §5.
5. **Próbka**: odtwórz 1–2 pliki w web pCloud, potem testy T3/T4 wg [pcloud-api.md](pcloud-api.md); MID dołóż tym samym sposobem; `uploadfile` zostaw na etap „po tokenie" (bilet 11).

## 7. Uzasadnienia zbiorcze

- **Dwa pliki WMP zamiast jednego** (+0,16 MB): T5 ma odpowiedzieć nie tylko „czy fileid przetrwa", ale też „czy rewizja zachowuje POPM niezależnie od bajtu oceny" — pokryte skrajności 1 i 196. Ewentualna pełna skala (dobranie z `tag-test` `…2144` bajt 128 i `…2146` bajt 64) to +2,37 MB — **nie na start**, tylko gdyby T5 wykazała zależność od bajtu.
- **Wybór minimalnych rozmiarów w klasach**: upload i testy mieszczą się w kilka minut; semantyka tagów identyczna jak w pełnej bibliotece.
- **`warped/` (520 plików) celowo poza wyborem** — nie wchodzi do MVP (mapa), tylko powiększyłby corpus.
- **Spójność z biletami**: nazwa `music-rater-test` implementuje „katalog testowy w pCloud" z biletu 11; MINIMAL/MID zasilają bilet 08 bez ponownego researchu; wynik T5 (§4 pkt 4) domyka decyzję klucza cache z biletu 07.
