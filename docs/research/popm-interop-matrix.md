# Matryca zgodności POPM (ID3v2 Popularimeter) — badanie interoperacyjności

> Zadanie: `issues/01-popm-interop-matrix.md` (research). Cel: wybrać format zapisu ocen 1–5★ w ~3000 plików MP3 tak, aby oceny były widoczne i spójnie odczytywane przez foobar2000, MusicBee, MediaMonkey, Mp3tag, Picard oraz na Androidzie (Poweramp, Musicolet) — użytkownik pracuje na Android + Windows.
> Status badań: specyfikacje ID3v2.3/v2.4 (id3.org) — zweryfikowane w całości; biblioteki parsujące (music-metadata, TagLib) — zweryfikowane w kodzie źródłowym; Mp3tag — zweryfikowana oficjalna dokumentacja; własne pliki — zmierzone mutagenem 1.47.0. Wiersze dot. Androida oraz foobar2000/MusicBee/MediaMonkey/Picard bazują na wiedzy ogólnej i wymagają testu empirycznego (plan testów na końcu).

---

## Rekomendacja

1. **Zapisuj ID3v2.3** (nie v2.4). Definicja ramki POPM jest identyczna w v2.3 i v2.4, ale v2.3 ma szersze realne wsparcie — m.in. Windows Explorer i Windows Media Player (Wikipedia: „ID3v2.3 is the most widely used version of ID3v2 tags and is widely supported by Windows Explorer and Windows Media Player"). Przejście na v2.4 nie daje żadnej korzyści dla POPM, a grozi problemami ze starszymi parserami.
2. **Mapowanie bajtów 1–5★ (skala WMP — zgodna z posiadaną biblioteką i z ekosystemem Windows):**
   - 1★ = `0x01` (1)
   - 2★ = `0x40` (64)
   - 3★ = `0x80` (128)
   - 4★ = `0xC4` (196)
   - 5★ = `0xFF` (255)
   „Brak oceny" = **brak ramki POPM** (nie zapisuj bajtu 0; per spec 0 = „unknown").
3. **Identyfikator (email) ramki:** `Windows Media Player 9 Series` — dokładnie ta wartość już istnieje w bibliotece (patrz pomiary poniżej) i jest specjalnie rozpoznawana przez Mp3tag (pole `RATING WMP`) oraz parsery. Własny email też jest legalny, ale w narzędziach filtrujących po nazwie tracisz gotową obsługę. **Polityka wielu ramek:** jeśli plik już ma POPM z tym emailem → **nadpisz tylko jego rating**; jeśli ma POPM z innym emailem → **dodaj naszą ramkę obok i nie usuwaj cudzej** (spec pozwala wiele ramek POPM, ale tylko jedną na ten sam email).
4. **Counter:** pomiń całkowicie (ramka = email + NUL + rating) lub zapisz 4 bajty `00 00 00 00` — oba warianty są legalne per spec i poprawnie parsowane (music-metadata: fixture issue-100 POPM bez counter; TagLib: test `testParsePOPMWithoutCounter`).
5. **Kodowanie:** email w ASCII/Latin-1 + terminator NUL + 1 bajt ratingu; **nigdy** nie dodawaj bajtu kodowania tekstu — POPM go nie ma (inaczej niż w ramkach tekstowych TXXX/TIT2).

### Dlaczego nie inne mapowania
- Skala iTunes (0/20/…/100, w bajtach ~51/102/153/204/255) to konwencja baz danych iTunes/iPod, rzadko spotykana w plikach poza ekosystemem Apple; wprowadzałaby konflikt z już posiadanymi bajtami WMP. **Status: do weryfikacji empirycznej, jeśli część biblioteki pochodzi z iTunes.**
- MediaMonkey używa innych wartości bajtów niż WMP (dowód pośredni: Mp3tag ma osobne pole `RATING MM`). Dokładne bajty 1★–4★ nie zostały potwierdzone źródłem — **wymaga testu empirycznego**.

---

## Matryca zgodności

Legenda: ✅ potwierdzone źródłem (link w „Szczegóły i źródła"), ⚠️ prawdopodobne / wiedza ogólna — **wymaga testu empirycznego**.

| Narzędzie | Czyta POPM | Zapisuje POPM | Mapowanie bajtu 1–255 → ★ | Uwagi / konflikty |
|---|---|---|---|---|
| **ID3v2.3 / ID3v2.4 (spec)** | ✅ | ✅ | Rating 1–255 (1=worst, 255=best); 0 = „unknown"; counter opcjonalny, rośnie przez wstawianie bajtów z przodu; wiele ramek POPM dozwolone, tylko jedna na ten sam email | Definicja identyczna w v2.3 i v2.4; POPM nie ma bajtu encodingu |
| **music-metadata (JS; parser dla aplikacji web)** | ✅ | — | `(rating − 1) / 254` → 0..1; 128 → 0.5 → 3★; rating 0 → `undefined` (brak oceny) | POPM bez counter parsowany poprawnie; ASF `POPULARIMETER` (`email\|rating\|counter`) mapowany tą samą skalą |
| **TagLib (C++; silnik tagów wielu playerów, w tym mobilnych)** | ✅ | ✅ | Zwraca surowy bajt (1–255) bez mapowania; player interpretuje sam (konwencje 1/64/128/196/255) | Parsuje POPM bez counter; przy zapisie zawsze renderuje 4-bajtowy counter; w ASF `WM/SharedUserRating` (0–99!) ma pierwszeństwo przed POPM — dotyczy WMA, nie MP3 |
| **Mp3tag** | ✅ | ✅ | Pola abstrakcyjne: `RATING WMP` (konwencja Windows Media Player) i `RATING MM` (konwencja MediaMonkey); ocena 1–5 lub gwiazdki `*`; `POPULARIMETER` = surowy `Email\|Rating\|Playcounter` | Dokumentacja: „Rating is an integer between 1 (worst) and 255 (best)"; playcounter opcjonalny; opcja Options → Tags → Advanced pokazuje surowe wartości |
| **Windows Media Player / Windows Explorer** | ✅ | ✅ | 1★=1, 2★=64, 3★=128, 4★=196, 5★=255; email = `Windows Media Player 9 Series` | Potwierdzone na własnych plikach (pomiary niżej). De facto standard bajtów dla Windows/Android |
| **foobar2000** | ✅ ⚠️ | ✅ ⚠️ | Konwencja zgodna z WMP (1★=1 … 5★=255) — ⚠️ **wymaga testu** | foo_playcount zapisuje **osobną** ramkę POPM z emailem `foo_playcount` (licznik odtworzeń, nie rating) — dwie ramki POPM współistnieją bez kolizji |
| **MusicBee** | ✅ ⚠️ | ✅ ⚠️ | Fixture w music-metadata: email `MusicBee`, rating 255 (=5★); pełna skala ⚠️ **wymaga testu** | MusicBee pisze jako email dosłowny string `MusicBee` (nie adres e-mail) — legalne |
| **MediaMonkey** | ✅ ⚠️ | ✅ ⚠️ | 5★=255 wg zgłoszeń; dokładne bajty 1★–4★ ⚠️ **wymagają testu** | Mp3tag dostarcza osobne pole `RATING MM` — pośredni dowód, że MediaMonkey używa innych wartości i innego emaila niż WMP |
| **MusicBrainz Picard** | ✅ ⚠️ (opcja/tag plugin) | ✅ ⚠️ (opcja/tag plugin) | Zapisywany rating z MusicBrainz lub ręczny; konwencja bajtów ⚠️ **wymaga testu** | Dokumentacja przeniesiona (stare linki 404); sprawdzić opcje w UI i zweryfikować wynik mutagenem |
| **Poweramp (Android)** | ✅ ⚠️ | ✅ ⚠️ | Czyta POPM niezależnie od emaila; dokładne wartości ⚠️ **wymagają testu** | Po ustawieniu oceny w Powerampie odczytać plik mutagenem, jaki email/bajt zapisuje — określi politykę konfliktów |
| **Musicolet (Android)** | ⚠️ | ❌ (brak edytora tagów) | Czyta rating z POPM wg relacji użytkowników — ⚠️ **wymaga testu** | Nie nadpisze zapisanych ocen; jedynie wyświetla. Nie stanowi zagrożenia dla danych |

Kluczowy wniosek: **skala WMP (1/64/128/196/255) to wartości, które naprawdę występują w realnych plikach** — rozpoznawane przez Mp3tag, music-metadata i TagLib bez konfiguracji, a biblioteka już jest w tej skali. Migracja nic nie kosztuje, odchylenie od niej wymusza konwersje istniejących ocen.

---

## Pomiary na własnych plikach (empiria, mutagen 1.47.0)

Katalog: `D:\music\recordings\hi-q-recordings\tag-test\`

| Plik | Email | Rating (bajt) | Counter |
|---|---|---|---|
| rec-2024-07-12_16-46_2127.mp3 | — (brak ramki POPM) | — | — |
| rec-2024-08-02_07-13_2144.mp3 | Windows Media Player 9 Series | 128 | 0 |
| rec-2024-08-02_07-23_2146.mp3 | Windows Media Player 9 Series | 64 | 0 |
| rec-2024-08-13_12-35_2151.mp3 | Windows Media Player 9 Series | 1 | 0 |
| rec-2024-12-24_10-27_2373.mp3 | Windows Media Player 9 Series | 196 | 0 |

Wniosek: biblioteka jest już w **skali WMP** z identyfikatorem `Windows Media Player 9 Series`. Naturalne jest kontynuowanie tego schematu (nadpisywanie tej ramki, zachowując pozostałe).

Interpretacja bajtów przez music-metadata (`(rating − 1) / 254`):

| Bajt | ★ wg skali WMP | music-metadata → 0..1 |
|---|---|---|
| 1 | 1★ | 0.0 |
| 64 | 2★ | 0.248 |
| 128 | 3★ | 0.5 |
| 196 | 4★ | 0.767 |
| 255 | 5★ | 1.0 |

---

## Szczegóły i źródła

### Spec ID3 — źródło prawdy
- **ID3v2.3.0 §4.18 Popularimeter** — <http://id3.org/id3v2.3.0>:
  - układ: `Email to user <text string> $00; Rating $xx; Counter $xx xx xx xx (xx ...)`;
  - „The rating is 1-255 where 1 is worst and 255 is best. 0 is unknown. If no personal counter is wanted it may be omitted. When the counter reaches all one's, one byte is inserted in front of the counter thus making the counter eight bits bigger";
  - „There may be more than one 'POPM' frame in each tag, but only one with the same email address";
  - domyślne flagi: POPM w kategorii 3 (zachowywana przy zmianie tagu, odrzucana przy zmianie audio).
- **ID3v2.4.0 §4.17 Popularimeter** — <https://id3.org/id3v2.4.0-frames>: definicja **tekstowo identyczna** z v2.3 (skala 1–255, 0=unknown, opcjonalny counter, jeden POPM na email). POPM nadal nie ma bajtu encodingu.
- **ID3v2.4.0 structure** — <https://id3.org/id3v2.4.0-structure>: różnice v2.4 to synchsafe inty, opcjonalny footer `3DI`, unsynchronizacja per-frame, UTF-8 — nie zmieniają POPM jako ramki.

### Parsery / biblioteki (weryfikacja „kto jak czyta")
- **music-metadata** — <https://github.com/Borewit/music-metadata>:
  - `lib/id3v2/ID3v24TagMapper.ts`, metoda `toRating(popm)`: `popm.rating > 0 ? ((popm.rating - 1) / 254) * maxRatingScore : undefined` (rating 0 → brak oceny);
  - testy `test/test-file-mpeg.ts`: `{email: 'no@email', rating: 128, counter: 0}` → rating 0.5 (3★ przez `ratingToStars()`); `{email: 'Windows Media Player 9 Series', rating: 255}` (POPM **bez** counter — fixture issue-100.mp3); `{email: 'MusicBee', rating: 255, counter: 0}`;
  - mapper ASF parsuje tagi `POPULARIMETER` w formacie `email|rating|counter` (komentarz w kodzie: „written by e.g. foobar2000") i ostrzega przy błędnych wartościach (`-1`, `256`, `999`, `''`, `abc`, `128abc`, `1.5`).
- **TagLib** — <https://github.com/taglib/taglib> (silnik tagów wielu playerów desktopowych i mobilnych):
  - `taglib/mpeg/id3v2/frames/popularimeterframe.cpp` — `parseFields()`: email w Latin-1, potem 1 bajt ratingu, potem opcjonalny counter; brakujący counter → 0 (test `testParsePOPMWithoutCounter`); przy niepełnych danych rating=0 i counter=0;
  - `renderFields()`: zapis zawsze z 4-bajtowym counterem (test `testRenderPOPM` potwierdza dokładny układ bajtów ramki);
  - `taglib/asf/asftag.cpp`: w plikach ASF `WM/SharedUserRating` (DWORD 0–99) ma pierwszeństwo przed `POPULARIMETER` (string `email|rating|counter`, skala 0–255) — inna skala, dotyczy tylko WMA.
- **Mp3tag** — oficjalna dokumentacja mapowań: <https://docs.mp3tag.de/mapping/>:
  - `POPULARIMETER`: ID3v2.3 → `POPM`, ID3v2.4 → `POPM`; „The playcounter is an optional value. The Rating is an integer between 1 (worst) and 255 (best). Syntax: Email|Rating|Playcounter";
  - `RATING WMP` — abstrakcja nad POPM w konwencji Windows Media Player (ocena 1–5 lub gwiazdki; odpowiednik ASF: `WM/SharedUserRating`);
  - `RATING MM` — abstrakcja nad POPM w konwencji MediaMonkey;
  - opcja „Options → Tags → Advanced" pozwala zawsze wyświetlać surowe wartości POPULARIMETER.
- **Wikipedia „ID3"** — <https://en.wikipedia.org/wiki/ID3>: „ID3v2.3 is the most widely used version of ID3v2 tags and is widely supported by Windows Explorer and Windows Media Player".

### Empiryka własna
- Pliki `tag-test/*.mp3` — wyniki odczytu mutagenem (tabela wyżej).
- Skala 1/64/128/196/255 z emailem `Windows Media Player 9 Series` potwierdzona na własnych plikach; spójne wartości (bajt `255`, email WMP) występują też w test fixtures music-metadata.

### Uwaga o counterze
- Spec (v2.3 §4.18 i v2.4 §4.17): counter opcjonalny; przy przepełnieniu rośnie przez wstawianie bajtów z przodu (analogicznie do ramki PCNT).
- music-metadata i TagLib poprawnie czytają POPM bez counter; TagLib przy zapisie zawsze tworzy 4-bajtowy counter.
- **Praktyka:** zapisuj bez counter (najkrócej, w pełni legalne); wariant `00 00 00 00` równie poprawny, jeśli zależy nam na kształcie ramki jak u WMP.

---

## Ramka POPM: dokładny układ bajtów (dla implementacji)

```
Frame ID:   "POPM"                                    (4 bajty)
Size:       rozmiar zawartości ramki                  (4 bajty big-endian w v2.3)
Flags:      2 bajty (zwykle 00 00)

Zawartość:
  Email:    Latin-1 (ASCII), np. "Windows Media Player 9 Series"
  NUL:      0x00 (terminator emaila)
  Rating:   1 bajt  (1..255; 0 = unknown — nie zapisywać, zamiast tego usunąć ramkę)
  Counter:  (OPCJONALNIE) 4 bajty big-endian, np. 00 00 00 00
```

Uwaga: w v2.3 `Size` jest zwykłym big-endian; w v2.4 — synchsafe (7 bitów na bajt). Writer piszący v2.3 nie stosuje synchsafe.

---

## Plan weryfikacji empirycznej (do wykonania przed decyzją architektoniczną)

Test „gold file": weź 1 kopię MP3, zapisz przez przyszły writer oceny 1★/3★/5★ (skala WMP), następnie:

1. **Mp3tag**: otwórz plik → pole `RATING WMP` powinno pokazać 1★/3★/5★; opcjonalnie włącz surowy podgląd POPULARIMETER i zweryfikuj bajt. ✅/❌
2. **Windows Explorer**: Właściwości → Szczegóły → Ocena: powinny pokazać się gwiazdki. ✅/❌
3. **foobar2000**: Properties → Popularimeter: zgodność wartości i gwiazdek; sprawdź równolegle, czy foo_playcount tworzy osobną ramkę. ✅/❌
4. **Poweramp (Android)**: skopiuj plik, sprawdź wyświetlane oceny; następnie ustaw ocenę w Powerampie i zaczytaj plik mutagenem — poznamy email/bajt zapisywany przez Powerampa (określi politykę konfliktów). ✅/❌
5. **Musicolet (Android)**: czy wyświetla oceny z POPM; czy traktuje 1/64/128/196/255 jak gwiazdki. ✅/❌
6. **MediaMonkey / MusicBee** (jeśli dostępne): otwórz gold file — czy skala WMP mapuje się na 1/3/5★; zapisz ocenę w programie i odczytaj bajty — rozwiąże ⚠️ z matrycy. ✅/❌
7. **Picard** (jeśli używany): zapisz rating i odczytaj bajty mutagenem. ✅/❌

Test „konfliktu ramek": do pliku z POPM `Windows Media Player 9 Series` dodaj drugi POPM z innym emailem (np. `ratings@local`). Sprawdź w Mp3tag/foobar2000/Powerampie, czy oba są widoczne i który wygrywa w UI. To zadecyduje, czy w razie sprzecznych ocen usuwać cudzą ramkę, czy zawsze tylko dopisywać własną.

---

## Ryzyka i pułapki dla writera

1. **Nie zapisuj rating = 0.** Per spec 0 = „unknown"; music-metadata zwróci `undefined`, część narzędzi pokaże brak oceny. „Brak oceny" implementuj jako usunięcie całej ramki POPM z naszym emailem (cudzych ramek nie ruszając).
2. **Email zawsze Latin-1.** TagLib renderuje email jako Latin1; wstawienie bajtów UTF-8 czy znaków sterujących spowoduje różne odczyty u różnych czytelników.
3. **Nie duplikuj ramek o tym samym emailu.** Spec: „only one with the same email address" — przed zapisem usuń starą ramkę z naszym emailem, potem dodaj nową.
4. **Nie upgrade'uj całego tagu do v2.4** przy okazji oceniania — korzyść zerowa dla POPM, realne ryzyko dla playerów ze słabym wsparciem v2.4.
5. **Nie myl skali ASF `WM/SharedUserRating` (0–99)** ze skalą POPM (1–255); dotyczy wyłącznie plików WMA/ASF — w MP3 nie występuje.
