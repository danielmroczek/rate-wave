# rate-wave

Słuchaj i oceniaj ~3635 nagrań dyktafonowych MP3; oceny (1–5★) zapisywane **w tagach ID3v2.3 POPM** (konwencja Windows Media Player — interoperacyjne z WMP/foobar2000/MusicBee/Mp3tag/Poweramp). Źródła plików: **pCloud** (OAuth implicit) i katalog lokalny (FSA). Statyczna PWA: **zero backendu**, hosting GitHub Pages; wszystkie pobrania bajtów przez READ-PROXY (Cloudflare Worker — bilet 06).

Specyfikacja: [`docs/spec.md`](docs/spec.md) · Glosariusz: [`docs/CONTEXT.md`](docs/CONTEXT.md) · Bilety: GitHub Issues #1–#16.

## Stack

**Vite+** ([viteplus.dev](https://viteplus.dev)) — ujednolicony toolchain: Vite (v8, Rolldown), Vitest, oxlint, oxfmt w jednym devDependency (`vite-plus`). Vanilla-JS ES modules, bez frameworka.

## Komendy

| komenda                        | co robi                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `npm run dev`                  | dev server (Vite+, HMR)                                             |
| `npm run build`                | build produkcyjny → `dist/` (czysto statyczny, `base: /rate-wave/`) |
| `npm run preview`              | podgląd buildu                                                      |
| `npm test`                     | testy (Vitest; schemat IDB na `fake-indexeddb`)                     |
| `npm run check`                | fmt + lint + type-check (oxfmt/oxlint)                              |
| `npm run fmt` / `npm run lint` | pojedyncze kroki                                                    |

> `vp` globalne CLI opcjonalne — lokalne `vite-plus` w `node_modules` obsługuje te same komendy przez npm scripts.

## Struktura (fundament — bilet 01)

```
index.html            — shell FLAT/METRO (topbar/toolbar/viewport/player)
oauth.html            — statyczna strona-docelowa OAuth pCloud (stub; logika: bilet 03)
public/
  manifest.webmanifest — PWA (standalone, ikony 192/512 maskable)
  sw.js               — Service Worker app-shell (precache build-time: HTML+manifest+hashowane assets)
  icons/              — SVG + PNG (generator: scripts/make-icons.mjs)
src/
  main.js             — boot: openDB, licznik, reset danych, rejestracja SW
  theme.css           — FLAT/METRO: warstwy tła, zebra, zero ramek, focus=outline
  store/db.js         — baza `rate-wave` v1: 6 store'ów wg spec §4a + reset (deleteDB + localStorage.clear)
  store/db.test.js    — testy schematu i resetu
vite.config.js        — base /rate-wave/, MPA (index+oauth), wtyczka injectPrecache (lista assetów → sw.js)
```

## Baza IndexedDB `rate-wave` v1 (spec §4a)

Store'y (klucze out-of-line): `settings`, `sources`, `library`, `tracks` (`'pcloud|<fileid>'` / `'local|<relpath>'`), `pending-ratings`, `session` (singleton `'current'`).

**„Wyczyść wszystkie dane"** = `deleteDB('rate-wave')` + `localStorage.clear()` z potwierdzeniem `<dialog>`; plików na pCloud nie dotyka.

## Deploy (GitHub Pages)

Build-output `dist/` z `base: '/rate-wave/'` → katalog `docs` nie; docelowo GitHub Actions `vp build` → Pages. (Konfiguracja Actions: osobny krok.)

⚠ **Konflikt redirect_uri do rozstrzygnięcia (HITL, przed biletem 03):** whitelist pCloud (zweryfikowana T6) ma zarejestrowany prod `https://danielmroczek.github.io/rate-wave/oauth.html` (exact string match), a Pages tego repo servuje `/rate-wave/`. W portalu pCloud trzeba dodać `…/rate-wave/oauth.html` do whitelist (badania: `docs/research/pcloud-register-app.md`).
