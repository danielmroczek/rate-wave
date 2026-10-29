# music-rater — kontekst aplikacji oceniania

Aplikacja służy do słuchania i oceniania jednej bazy nagrań dyktafonowych (ok. 3000 MP3). Katalog terminów używanych w decyzjach i specyfikacji.

## Język

**Utwór (Track)**:
Pojedynczy plik MP3 rozpoznawalny niezależnie od urządzenia — przez klucz `'local|' + ścieżka względna` albo `'pcloud|' + fileid`. Kolejki odtwarzania, cache, sortowanie — wszystko odnosi się do Utworu.
_Avoid_: plik, MP3 (w dyskusji pojęciowej)

**Źródło (Source)**:
Skąd pochodzą Utwory: katalog lokalny FSA albo katalog na koncie pCloud. W MVP dopuszczalne, by istniało tylko jedno Źródło — pCloud.
_Avoid_: backend, magazyn, katalog (tamto oznacza folder)

**Ocena (Rating)**:
Wartość 1–5 gwiazdek; zapisywana w tagu ID3v2.3 POPM zawsze do ramki w konwencji Windows Media Player (owner „Windows Media Player 9 Series"); brak oceny = brak ramki. Źródłem prawdy Oceny zawsze jest tag w pliku. Przy odczycie z wielu ramek ramka WMP wygrywa, a gdy jej brak — najwyższa z ocen cudzych programów; w UI zawsze pokazywana jest dokładnie jedna Ocena.
_Avoid_: gwiazdka, like, punktacja, druga ocena

**Cache ocen (Rating Cache)**:
Wartość pochodna Oceny w IndexedDB (per Utwór: 1–5 albo null) — służy listowaniu, filtrowaniu i sortowaniu bez parsowania tysięcy tagów. Podporządkowany tagowi; aktualizowany razem z tagiem; unieważniany przez walidację Fingerprintu.
_Avoid_: baza ocen, źródło ocen

**Fingerprint**:
Tani zestaw metadanych pliku (`size + lastModified` lokalnie; `size + modified` w pCloud) służący do testu tożsamości Utworu; rozbieżność unieważnia rekord cache (oceny i ReplayGain).
_Avoid_: hash, sygnatura

**Walidacja per-odczyt (Read-time Validation)**:
Sprawdzanie świeżości przy każdym sięgnięciu do rekordu (porównanie Fingerprintu), bez globalnego TTL. Model unieważniania dla listingu, cache ocen i cache ReplayGain.
_Avoid_: timeout cache, TTL

**Sesja (Session State)**:
Stan kontynuacji między wizytami na jednym urządzeniu: otwarte Źródło, ostatni Utwór, pozycja odtwarzania. Należy do urządzenia; nie jest synchronizowana ponad to, co żyje w plikach pCloud.
_Avoid_: login, konfiguracja

**Pełny powrót (Full Restore)**:
Po ponownym wejściu aplikacja przywraca wszystko: Źródła, bibliotekę z cache, ostatni Utwór i pozycję. Gdy ostatni Utwór zniknął — degradacja: zaznaczenie listy, potem brak zaznaczenia.
_Avoid_: resume, restore

**LWW (Last-Write-Wins)**:
Polityka konfliktów, także między kartami: wygrywa ostatni zapis, bez ostrzeżeń. Historię w pCloud niesie rewizja pliku; w IndexedDB kopii nie ma.
_Avoid_: merge, rozwiązywanie konfliktów

**Rocznik (Year folder)**:
Podfolder Źródła nazywany od roku nagrania (2017–2026); jedyny filtr listy — drzewko po lewej: klik = filtr, „wszystkie" = reset, aktywny podświetlony pełnym tłem. Wszystkie Roczniki widoczne zawsze (nawet przy pustych wynikach — lista ma nie zaskakiwać).
_Avoid_: katalog, folder (w UI), tagowanie dat

**Ostatnio słuchane (Last Played)**:
Tryb sortowania: malejąco po dacie-czasu ostatniego odtwarzania Utworu (reszta wg nazwy). Zasilane polem `lastPlayed` w Cache ocen, ustawianym w chwili startu odtwarzania.
_Avoid_: historia odtwarzania, kolejka
