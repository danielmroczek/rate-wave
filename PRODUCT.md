# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite+ (v8, Rolldown) — vanilla-JS ES modules, no framework; Vitest + oxlint/oxfmt in one `vite-plus` devDependency. Static MPA build (`index.html` + `oauth.html`), `base: /rate-wave/`, deployed to GitHub Pages; one Cloudflare Worker as READ-PROXY. Existing codebase — stack already decided.

## Users

Single user: the project owner personally. Primary job: listening to and rating ~3,000 (target ~3,635) personal dictaphone recordings (MP3, year folders 2017–2026), mainly on desktop Chrome and Android Chrome — deliberately mobile-first because rating happens in transit (e.g. on a train). No other audience is confirmed.

## Product Purpose

rate-wave is a fully static PWA (zero backend) for listening to and rating music recordings on a 1–5 star scale. The defining mechanism: ratings live **in the files themselves** — written into the MP3's ID3v2.3 `POPM` tag (Windows Media Player convention) — so they survive any player, any move, any device. Success = a smooth loop of: connect a source → browse/filter/sort → play (waveform, tempo tap, ReplayGain) → rate → file patched and uploaded back to the source → return later and everything (sources, library, last track, playback position) is restored ("Full Restore").

## Positioning

Most players lock ratings inside their library database. rate-wave does the opposite: the file's own tag is the source of truth for ratings, and the whole app is a static browser app — nothing to install, nothing to run. An adjacent product could not truthfully copy "ratings written back into the files themselves as standard WMP-interop POPM tags, from a zero-backend static PWA".

## Operating Context

- Personal archive of dictaphone recordings, ~3,600 MP3s organized in **Year folders** (2017–2026) — the only list filter, shown as a tree on desktop / wrapped vertically on mobile.
- Sources (pol. **Źródło**): a pCloud folder (primary, OAuth implicit) or a local folder via the File System Access API (Chrome 132+); MVP permits a single source.
- Usage scene: briefly open the app, jump to the next unrated track ("→ ☆" button / `U` key), listen, rate, close. Session state belongs to the device.
- Offline: no pCloud playback offline (CORS); ratings made offline are queued (`pending-ratings`) and flushed when back online.
- Terminology decisions live in `docs/CONTEXT.md` (Utwór, Źródło, Ocena, Fingerprint, Walidacja per-odczyt, Sesja, Pełny powrót, LWW, Rocznik, Ostatnio słuchane). Specification `docs/spec.md` summarizes; GitHub Issues tickets are the source of truth.

## Capabilities and Constraints

Confirmed (from spec + research, empirically verified 2026-10-27/28):

- **Rating storage:** ID3v2.3 POPM, owner `Windows Media Player 9 Series`, byte lattice 1★=1 … 5★=255; "no rating" = remove the WMP frame; other programs' frames are never touched. Read hierarchy: WMP frame wins, else highest other POPM, else no rating; UI always shows exactly one rating.
- **BPM tap:** tempo tapped by the user, saved into the file as a tag too.
- **Waveform:** clickable waveform per track, generated immediately on track selection (peaks cached in IndexedDB, ~800 samples).
- **ReplayGain (track-gain):** read from tags (TXXX→RVA2→RVAD→APEv2), fallback ebur128 BS.1770 scan at −18 LUFS in a Web Worker; for pCloud, audio plays through the READ-PROXY so Web Audio gain is possible; MVP fallback is plain `<audio>` without gain.
- **pCloud empirics:** `<audio src>` streaming with Range scrubbing works without a proxy; cross-origin `fetch()` of file bytes is blocked (result 7010) — the single Cloudflare READ-PROXY exists for byte access (rating rewrites, RG); `listfolder` recursive = 1 call, no pagination; `uploadfile` preserves `fileid`; token never expires → `localStorage` + IDB mirror for the service worker.
- **Data model:** IndexedDB `rate-wave` v1 (6 stores: settings, sources, library, tracks, pending-ratings, session); per-read validation by Fingerprint (size+modified), no TTL; LWW everywhere, no conflict warnings, no cloud sync beyond files.
- **States:** Full Restore (sources, library, last track, position) with defined degradation if the last track disappeared; "Clear all data" = deleteDB + `localStorage.clear()`.
- **pCloud OAuth redirect whitelist is exact-match:** dev `http://localhost:5173/`, prod `https://danielmroczek.github.io/rate-wave/oauth.html`. Names frozen in reality that must NOT be renamed: POPM owner `music-rater@local` already written into test files (new owner for the final version: `rate-wave@local`), `music-rater-test` folder on pCloud.
- **Explicitly undecided / post-MVP:** start/loop markers (TXXX), Loop A–B (ticket 18, out of scope); MP3 offline cache ("⭳/☁" badge is placeholder); Player-adjacent refinements from prototypes.

## Brand Commitments

- Name: **rate-wave** (pCloud app registered under it, `client_id=8imNt7HXdPm`, 2026-10-30). Working predecessor name "music-rater" survives only in the frozen artifacts listed above.
- UI language for MVP: **English** — all labels, placeholders, dialogs, messages, `aria-*`, PWA metadata; project docs stay Polish.
- Visual directive from spec §5: **FLAT/METRO, borderless** — hierarchy exclusively by background layers, hover, list zebra, full-background selection; no 1 px borders; focus = outline fill.

## Evidence on Hand

- Working prototype: `.scratch/prototypes/player-ux/index.html` (gitignored fixture; source of the sticky bottom player layout).
- Real recorded test reports: `docs/research/` (pcloud-api.md, perf-3000.md, popm-interop-matrix.md, sample-file-tag-audit.md, waveform-approaches.md, replaygain.md, pwa-offline.md, android-fsa-id3.md).
- Test corpus exists on the user's pCloud account (`music-rater-test` folder); tag audit artifacts referenced from `research/sample-file-tag-audit.md`.
- Absence that must not be fabricated: no testimonials, no customer data, no press, no third-party benchmarks.

## Product Principles

1. **The file is the truth.** Ratings and tempo are stored in the music files' ID3 tags; the cache is always subordinate and invalidated by fingerprint mismatch.
2. **Zero backend.** The whole app is static; the single Cloudflare Worker exists only to carry file bytes that browsers can't fetch cross-origin.
3. **Never disturbing.** Other programs' ID3 frames and the user's pCloud files are never deleted or rewritten beyond rating-related tags; LWW means no nagging, no lock dialogs.
4. **Rating loop first.** Every screen optimizes the seconds between "open app" and "next unrated track rated" — especially one-handed on Android in motion.
5. **Silent persistence.** Between visits everything comes back on its own (Full Restore) with graceful degradation, never asking the user to rebuild their context.

## Accessibility & Inclusion

Baseline WCAG-AA-ish for this MVP: contrast on the FLAT/METRO background-layer system, visible focus (outline fill, not borders), keyboard shortcuts for the core loop where sensible (`U`, `N`, `P`), and generous touch targets — the app must stay operable one-handed on a moving train.
