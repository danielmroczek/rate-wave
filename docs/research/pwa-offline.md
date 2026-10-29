# PWA/offline: czy i ile MP3 cache'ować do pociągu

Typ: research (bilet [15-pwa-offline-budget](../issues/15-pwa-offline-budget.md))
Data: 2026-10-27
Powiązania: [Model stanu i trwałości (07)](../issues/07-data-model.md), [pCloud API (02)](../issues/02-pcloud-api.md) + [Testy empiryczne T1–T5](pcloud-api.md), [Stack i hosting (06)](../issues/06-stack-hosting.md)

## TL;DR werdykt

1. **Offline odtwarzanie MP3 ze źródła pCloud = NIE dla MVP** — i to nie przez budżety, a przez **CORS**: serwery plików pCloud (`cXX.pcloud.com`/hosts z `getfilelink`) **nie zwracają `Access-Control-Allow-Origin`** (potwierdzone testem T4, 2026-10-27). Bez ACAO `fetch()` nie da aplikacji bajtów pliku → nie ma czego zapisać w OPFS/Cache Storage/IndexedDB. Caching wymagałby mini-proxy (nowa decyzja, sprzeczna z duchem „architektura bez proxy") albo wsparcia CORS po stronie pCloud (nic nie zwiastuje).
2. **Offline działa z natury dla źródła lokalnego FSA** — pliki leżą na urządzeniu, `<audio>` z `File`/`createObjectURL` odtwarza bez sieci. Gdyby FSA było w MVP (bilet 07: pCloud może być jedynym źródłem MVP), scenariusz „pociąg" pokryłby się bez żadnego cache'u.
3. **Kolejka ocen offline = TAK i prosta** („ręczna kolejka", bez twardego uzależnienia od Background Sync): ocena offline → zapis lokalny w IndexedDB (cache ocen z biletu 07 + wpis w kolejce `pending-ratings`) → wywóz (flush) przy starcie aplikacji i na zdarzeniu `online`. **Background sync (one-shot) jako progressive enhancement**: działa w Chrome Android od 49, **nie wymaga zainstalowanej PWA** — wystarczy zarejestrowany service worker i otwarte okno w chwili rejestracji; jest niegwarantowany, gdy przeglądarka jest zamknięta, ale kolejka IDB i tak przetrwa i wyjedzie przy następnym otwarciu.
4. **Domyślne MVP = „tylko ostatnia sesja" + kolejka ocen offline** (stan sesji z biletu 07 + kolejka). Cache MP3: projektujemy interfejs (badge „offline-ready", fingerprint), ale wpuszczamy dopiero, gdy powstanie droga fetch-a bajtów.

---

## 1. Budżety pamięci Chrome (Android)

Źródła: [web.dev — Storage for the web](https://web.dev/articles/storage-for-the-web), [MDN — Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

- **Quota per origin w Chromium: 60% całkowitego rozmiaru dysku** (przeglądarka łącznie do 80%). Przy telefonicznych 64–256 GiB to teoretycznie **38–154 GiB** na jedno origin. Chrome **nie uwzględnia wolnego miejsca** przy raportowaniu quoty (liczy od rozmiaru dysku — anty-fingerprinting), więc quota może być wyższa niż realnie dostępne miejsce — stąd obowiązkowa obsługa `QuotaExceededError` przy każdym zapisie.
- Wtryśnięcie/incognito: ~5% dysku; opcja „czyść dane przy zamykaniu": ~300 MB.
- **`navigator.storage.estimate()`** → `{usage, quota}` (liczby szacunkowe); to jedyne oficjalne okno na budżet. Sprawdzać przed dużym cache'owaniem i po drodze.
- **Wspólna pula**: OPFS, Cache Storage i IndexedDB liczą się do **jednej quoty origin** (żadna technologia nie ma osobnego, większego limitu); wybór technologii to wybór ergonomii API, nie budżetu.
- **`persist()`**: prośba o ochronę przed eviction; Chrome (Android też) **nie pokazuje promptu** — przyznaje automatycznie wg heurystyk (wysoka engagement, zainstalowana/zakładkowa strona, zgoda na notifications). Badania Chrome: automatyczne czyszczenie danych praktycznie nie występuje przy regularnych wizytach. Wniosek: prosić o `persist()` przy pierwszym cache'owaniu (user gesture, nie na starcie).
- **Eviction (best-effort)**: przy presji miejsca Chrome usuwa dane **całego originu LRU** (nie wyrywa pojedynczych plików!). Skutek dla nas: przepełnienie quoty → błąd zapisu (traktujemy sami: usuwamy najstarsze z własnego cache'u); dopiero katastrofa urządzeniowa może zabrać cache originu w całości. Tryb persistent wyłącza ten mechanizm.
- (Opcja przyszłościowa: [Storage Buckets API](https://developer.chrome.com/docs/web-platform/storage-buckets) — niezależne kubełki z własnym TTL/priorytetem eviction; nie dla MVP.)

**Ile realnie mieści się w kwocie**: biblioteka w całości (5,8 GiB / 3635 MP3) spokojnie mieści się w 60% dysku telefonu 64 GiB+. Limit nie jest barierą — barierą są (a) CORS, (b) czas/przepustowość pobierania 5,8 GiB, (c) ergonomia. Sensowne budżety cache'u: **100 utworów ≈ 45 MB** (jedno zajęcie pociągu), **cały rocznik (~300 plików) ≈ 135 MB**, bezpieczny domyślny limit **250–500 MB (~550–1100 MP3)** z możliwością zmiany w ustawieniach.

## 2. OPFS vs Cache Storage vs IndexedDB dla MP3 (~450 KB/plik)

Źródła: [MDN — Origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system), [web.dev — Storage for the web](https://web.dev/articles/storage-for-the-web), [web.dev — OPFS](https://web.dev/articles/origin-private-file-system).

| Kryterium | OPFS | Cache Storage | IndexedDB (Blobs) |
|---|---|---|---|
| Zalecane przez web.dev dla treści plikowych | ✅ („for file-based content") | dla zasobów sieciowych appki | dla danych |
| Odczyt do `<audio>` | `getFile()` → `File` (Blob) → `URL.createObjectURL()` — bez kopii do pamięci JS | trzeba owinąć Response w Blob | `Blob` wprost z rekordu |
| Zapis pliku 450 KB | asynchroniczny `createWritable()` na main thread (przeciętnie kilka–kilkadziesiąt ms przy tym rozmiarze); prekursorski `createSyncAccessHandle()` tylko w Workerze | `cache.put(Request, Response)` — tanie | put Blob — tanie |
| Trwałość i quota | wspólna quota origin, `estimate()` pokazuje zużycie | j.w. | j.w. |
| Dostęp z Service Workera | ✅ | ✅ | ✅ |
| Wsparcie Chrome Android | **109+** (`getDirectory`) | szerokie | szerokie |
| Metadane/pestki obok plików | nie — osobno IDB | nie | tylko blob-y w rekordach |

**Werdykt technologiczny (do czasu, gdy temat wróci): OPFS na pliki MP3 + IndexedDB na indeks** (fingerprint `size+modified` z biletu 07, kolejność w roczniku, znacznik ostatniego użycia, rozmiar). To zgodne z rekomendacją web.dev i naturalnie pasuje do bazy `music-rater` (Nowy magazyn, np. `mp3-cache`, w tej samej bazie). Blob URL z `File` z OPFS jest pierwszorzędny dla `<audio>` (`preload="metadata"` + scrubbing działa lokalnie, bez Range bo plik jest cały). Cache Storage zostawiamy na to, do czego jest stworzony: **asset-y PWA** (app shell: HTML/JS/CSS), mimo że URL-e pCloud wygasają — kluczowanie po syntetycznych Requestach byłoby sztuczne.

## 3. Strategia doboru utworów do cache'u

Przy przyjęciu, że cache kiedyś powstanie (po rozwiązaniu CORS):

- **Rekomendowany mix**: (a) **ręczne zaznaczenie** „do pobrania offline" w liście (toggle + badge „offline-ready", licznik MB w nagłówku rocznika) — pełna kontrola; (b) **auto-dodatek**: ostatnio odtwarzanych N utworów (N=50 ≈ 22 MB) trzyma się w cache przez rolling window.
- **Całe roczniki** jako opcja drugiego rzędu (135 MB/rocznik jest tanie pod względem quoty, ale kosztuje download przy pierwszym pobraniu — robić na Wi-Fi, np. przycisk „pobierz rocznik przy następnym Wi-Fi").
- **Rozmiar targetu**: domyślny limit 500 MB; UI pokazuje `usage/quota` z `estimate()` i zużycie własnego cache'u.
- **Eviction własny, przewidywalny**: cache'ujemy tylko to, co sami; kasujemy od najstarszego dostęp (`lastUsedAt`) gdy limit osiągnięty lub zapis zwróci `QuotaExceededError` — **zanim** dojdzie do browserowego LRU-origin, które mogłoby zabrać inne dane originu (również kolejkę ocen — choć ta i tak flush-uje się przy każdej sieci).
- **Unieważnienie**: przy cache'owaniu zapisujemy fingerprint `size+modified` (dla pCloud: fileid + te pola). Walidacja per-odczyt z listingów będzie darmowa — dokładnie ta sama decyzja co w bilecie 07. Rozbieżność → plik re-download.
- **Opis stanu cache w liście**: badge ⭳/☁ przy utworze + suma MB per rocznik; w trybie offline pozycje niecache'owane są jasno wygaszone (nie da się ich odtworzyć).

## 4. Kolejka ocen offline (zapis POPM po powrocie sieci)

### Fakt geometryczny, który ułatwia sprawę

Zapis oceny (bilety 01/10: `browser-id3-writer` + ramka POPM WMP) wymaga **całych bajtów pliku** (przebudowa ramki ID3v2.3 w buforze). Skoro oceniamy utwór, to go właśnie słuchamy → **mamy go w cache'u / z lokalnego FSA**. Kolejka offline jest więc możliwa dokładnie dla tych utworów, które da się ocenić offline; nie trzeba jej projektować dla reszty.

### Projekt kolejki (MVP — „ręczna", niezależna od Background Sync)

1. Ocena offline → trzymanie w IDB bazy `music-rater`:
   - `tracks`: aktualizacja cache ocen natychmiast (UI reaguje, stan „ocena oczekuje na wysłanie" ⏳).
   - `pending-ratings`: `{key: 'pcloud|<fileid>'|'local|<path>', fingerprint, ratingBytes: 1|64|128|196|255|null(usuń), createdAt}`.
2. **Flush** wyzwalany: (a) przy starcie aplikacji (po walidacji tokenu `userinfo` z biletu 07), (b) na `window.addEventListener('online', …)`, (c) po każdym udanym zapisie online (kolejka prawie zawsze pusta).
3. Flush = po kolei: odtwórz bajty pliku (z cache'u OPFS/IDB lub FSA) → przebuduj tag → `uploadfile` overwrite (potwierdzone T5: fileid trwały; a regime LWW z biletu 07 — bez ostrzeżeń). Po sukcesie usuń z kolejki; po porażce (throttle/błąd) zostaw wpis, kolejna próba przy następnym flushu.
4. Kolejka rośnie tylko wtedy, gdy tracisz sieć — w pociągu realnie kilka–kilkadziesiąt wpisów; rozmiar nie jest problemem.

### Background Sync — status wsparcia 2025/2026 i czy wystarczy bez PWA

Źródła: [MDN — Background Synchronization API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API), [MDN — SyncManager (compat)](https://developer.mozilla.org/en-US/docs/Web/API/SyncManager), [Chrome — Introducing Background Sync](https://developer.chrome.com/blog/background-sync/).

- **One-shot sync** (`SyncManager.register()` + event `sync`): **Chrome/Edge/Opera + Chrome Android + Samsung Internet, od dawna stabilny (49+), wciąż oznaczony „Baseline Limited availability" ** — **Firefox i Safari (również iOS) NIE wspierają do dziś**. W naszym kodzie tylko progressive enhancement (patrz niżej), więc brak w Firefox/Safari nie boli.
- **Czy działa bez zainstalowanej PWA?** Zasadniczo TAK — warunki z dokumentacji Chrome to: (1) service worker zarejestrowany i aktywny, (2) rejestracja następuje przy **otwartym oknie na witrynie**, (3) żadne uprawnienie nie jest wymagane. To **nie jest** feature rezerwowana dla PWA. ALE: Chrome Android **nie daje gwarancji**, że wybudzi przeglądarkę, gdy jest całkowicie zamknięta i strona nie jest zainstalowana — wtedy sync event trafia dopiero przy następnym uruchomieniu. Dla nas to akceptowalne: kolejka IDB i tak przeżyje i wyjedzie na starcie; sync tryb przyspiesza wywóz, gdy przeglądarka żyje.
- **Retry z exponential backoff wbudowany**: jeśli promise w `event.waitUntil()` rzuci błąd, sync wróci. Tag kooalescuje rejestracje (jedna rejestracja = jeden flush całego outboxa — dokładnie nasz model).
- **Pułapka implementacyjna SW**: service worker **nie ma dostępu do `localStorage`** — token pCloud (bilet 07 trzyma go tam) musi być **mirrored w IndexedDB** (lub cały w IDB ze świeżo-synchronicznym lustrem na starcie strony dla szybkiego checka). Bez tego SW nie uzupełni `uploadfile`.
- `periodicBackgroundSync` — wymaga instalacji PWA; nie potrzebujemy go (flush przy otwarciu starczy).

**Wniosek**: MVP używa prostej kolejki IDB + flush przy starcie/`online`; rejestracja `sync` (tag `flush-ratings`) jako gratis przy każdym ocenie zrobionej offline, z pełnym fallbackiem. Nic w decyzjach nie zależy od bardziej egzotycznych części API.

## 5. Scenariusz „pociąg" z perspektywy MVP

- **pCloud-jako-jedyne-źródło (deklaratywny kierunek z biletu 07)**: bez sieci **nic się nie odtworzy** (CORS nie pozwala nawet pobrać bajtów do cache). Aplikacja wspierana offline: lista z cache'u IDB, stan sesji, **stawianie ocen tylko dla utworów, które da się odtworzyć** — a więc de facto **zero ocen offline**, dopóki nie ma cache'u.
- Z tego wynika opcja minimalna na MVP: **offline = „ostatnia sesja" (bilet 07) + kolejka ocen (przydatna realnie dopiero z cache'em albo ze źródłem FSA)**. Bilet może zostać zamknięty decyzją „cache MP3: nie dla pCloud bez proxy; droga otwarta od strony FSA".
- **Jeśli dodamy w MVP lokalne FSA jako drugie źródło**: odtwarzanie offline działa z natury (pliki lokalne), kolejka ocen offline staje się realnie pikowana (oceny z FSA flush-ują po powrocie sieci), a OPFS-cache zostaje ścieżką rozwoju dla długu „kilkanaście roczników na telefon".

## Decyzje przekazane do specyfikacji

1. **Offline w MVP = „ostatnia sesja" + kolejka ocen offline**; brak cache'u MP3 z pCloud w MVP (CORS T4). Jeżeli FSA wejdzie do MVP, odtwarzanie offline z FSA działa bez dodatkowej pracy.
2. **Technologia cache (gdy wróci temat): OPFS na MP3 + IndexedDB na indeks/fingerprint/kolejkę**, w tej samej bazie `music-rater`; Cache Storage tylko na app shell PWA.
3. **Strategia cache**: ręczne zaznaczenie + rolling window ostatnio odtwarzanych (N≈50); opcja „pobierz rocznik na Wi-Fi"; domyślny limit 500 MB; własne LRU-eviction zanim dojdzie do eviction originu; `persist()` przy pierwszym cache'owaniu (user gesture).
4. **Kolejka ocen**: IDB `pending-ratings`, flush na starcie + `online` + po każdym zapisie; Background Sync one-shot (tag `flush-ratings`) jako progressive enhancement; **token pCloud do mirrorowania w IDB** (SW nie widzi `localStorage`) — dopis do decyzji magazynowych z biletu 07.
5. Badge „offline-ready" (⭳/☁) i licznik MB w liście utworów — element do biletu [Prototyp UX playera (08)](../issues/08-player-ux-prototype.md) / [Perf 3000 (16)](../issues/16-performance-3000.md).

## Źródła

- [web.dev — Storage for the web](https://web.dev/articles/storage-for-the-web) — quota 60% dysku (Chromium), eviction best-effort LRU, wybór magazynów (OPFS/Cache/IDB), `estimate()`, `QuotaExceededError`.
- [MDN — Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) — quota per origin, persistent vs best-effort, lista technologii w jednej puli, atomic eviction całego originu.
- [web.dev — Persistent storage](https://web.dev/articles/persistent-storage) — heurystyki przyznawania `persist()` w Chrome (brak promptu), co jest chronione.
- [MDN — Origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) — OPFS: main-thread async + worker-only sync handles, quota współdzielona, compat (Chrome Android 109+).
- [web.dev — OPFS](https://web.dev/articles/origin-private-file-system) — benchmark-owe odczucia zapisu/odczytu, wzorce użycia.
- [MDN — StorageManager.estimate()](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate) — semantyka `usage/quota`.
- [MDN — Background Synchronization API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API) + [MDN — SyncManager (compat)](https://developer.mozilla.org/en-US/docs/Web/API/SyncManager) — wsparcie (Chrome 49+/Chrome Android 49+, Safari/Firefox: brak), model tagów.
- [Chrome — Introducing Background Sync](https://developer.chrome.com/blog/background-sync/) — wymogi rejestracji (otwarte okno, brak uprawnień), retry z backoff, koleskowanie tagów, wzorzec outbox z IDB.
- [developer.chrome.com — Storage Buckets](https://developer.chrome.com/docs/web-platform/storage-buckets) — opcja przyszłościowa.
- Wewnętrzne: [pcloud-api.md — testy T3/T4/T5](pcloud-api.md) (brak ACAO na hostach plików = blokada fetch bajtów), [07-data-model](../issues/07-data-model.md) (magazyny, fingerprint, LWW).
