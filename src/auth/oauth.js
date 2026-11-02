// OAuth implicit flow dla pCloud (bilet 03, spec §3a).
// Buduje URL autoryzacji, generuje i weryfikuje `state` (anty-CSRF).

const CLIENT_ID = "8imNt7HXdPm";

// Redirect URI — dokładne stringi zarejestrowane w pCloud My Apps (T6 PASS).
const REDIRECT_DEV = "http://localhost:5173/";
const REDIRECT_PROD = "https://danielmroczek.github.io/rate-wave/oauth.html";

/** Klucz localStorage pod którym trzymamy wygenerowany state do weryfikacji po powrocie. */
export const STATE_KEY = "rate-wave.oauth.state";

/** Czas życia state w localStorage (ms) — 10 min na dokończenie logowania. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Zwraca redirect_uri zależnie od bieżącego origin — musi zgadzać się z whitelistą pCloud.
 * Dev (localhost) → REDIRECT_DEV, prod (GitHub Pages) → REDIRECT_PROD.
 */
export function getRedirectUri(loc = globalThis.location) {
  if (loc.hostname === "localhost" || loc.hostname === "127.0.0.1") {
    return REDIRECT_DEV;
  }
  return REDIRECT_PROD;
}

/**
 * Generuje losowy `state` (anty-CSRF), zapisuje go w localStorage z timestampem
 * i zwraca. Wywoływane przed przekierowaniem na pCloud authorize.
 * @param {Storage} [ls] — injectable dla testów
 * @returns {string}
 */
export function generateState(ls) {
  const storage = ls ?? globalThis.localStorage;
  const state = crypto
    .getRandomValues(new Uint8Array(16))
    .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  const payload = JSON.stringify({ v: state, t: Date.now() });
  storage.setItem(STATE_KEY, payload);
  return state;
}

/**
 * Weryfikuje `state` z URL-fragmentu przeciwko zapisanemu w localStorage.
 * Zwraca true jeśli:
 *  - state w localStorage istnieje,
 *  - wartość `v` się zgadza,
 *  - nie minęło więcej niż STATE_TTL_MS od wygenerowania.
 * Po weryfikacji (sukces lub fail) state jest czyszczony z localStorage (jednorazowy).
 * @param {string} receivedState
 * @param {Storage} [ls] — injectable dla testów
 * @returns {boolean}
 */
export function verifyState(receivedState, ls) {
  const storage = ls ?? globalThis.localStorage;
  const raw = storage.getItem(STATE_KEY);
  storage.removeItem(STATE_KEY);
  if (!raw) return false;
  try {
    const { v, t } = JSON.parse(raw);
    if (typeof v !== "string" || typeof t !== "number") return false;
    if (Date.now() - t > STATE_TTL_MS) return false;
    return v === receivedState;
  } catch {
    return false;
  }
}

/**
 * Buduje pełny URL autoryzacji OAuth implicit do przekierowania.
 * @param {{ redirectUri?: string, state?: string, localStorage?: Storage }} [options]
 * @returns {string}
 */
export function buildAuthUrl({ redirectUri, state, localStorage: ls } = {}) {
  const uri = redirectUri ?? getRedirectUri();
  const s = state ?? generateState(ls);
  const url = new URL("https://my.pcloud.com/oauth2/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("redirect_uri", uri);
  url.searchParams.set("state", s);
  return url.href;
}

/** Eksportujemy CLIENT_ID dla oauth.html (też statycznego, poza bundlerem). */
export { CLIENT_ID };
