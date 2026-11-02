// Kontroler autoryzacji — łączy UI logowania z OAuth flow (bilet 03).
// Odpowiada za: pokazanie/ukrycie ekranu logowania, rozpoczęcie OAuth,
// obsługę powrotu z OAuth (token z localStorage po redirect).

import { buildAuthUrl, verifyState } from "./oauth.js";
import { loadTokenFromLS, saveToken, clearToken } from "./token-store.js";
import { validateToken } from "./pcloud-api.js";

/** @typedef {"idle"|"checking"|"login"|"authenticating"|"connected"} AuthState */

let currentAuthState = /** @type {AuthState} */ ("idle");

/**
 * Zwraca bieżący stan autoryzacji.
 */
export function getAuthState() {
  return currentAuthState;
}

/**
 * Rozpoczyna OAuth implicit flow — przekierowuje przeglądarkę do pCloud.
 * Wywoływane po kliknięciu "Sign in with pCloud".
 */
export function startOAuthLogin() {
  currentAuthState = "authenticating";
  const url = buildAuthUrl();
  console.log("[auth] Redirecting to pCloud OAuth…");
  globalThis.location.href = url;
}

/**
 * Główna funkcja autoryzacji przy starcie aplikacji:
 * 1. Sprawdza token w localStorage
 * 2. Waliduje przez userinfo
 * 3. Zapisuje do IDB (mirror)
 * 4. Fail → ciche czyszczenie + ekran logowania
 *
 * @param {{ db: IDBDatabase, onStateChange?: (state: AuthState) => void }} opts
 * @returns {Promise<{ token: string, hostname: string, locationid: number } | null>}
 */
export async function initAuth({ db, onStateChange } = {}) {
  const change = (s) => {
    currentAuthState = s;
    onStateChange?.(s);
  };

  change("checking");

  const stored = loadTokenFromLS();
  if (!stored?.token) {
    console.log("[auth] No stored token — showing login screen.");
    change("login");
    return null;
  }
  console.log("[auth] Found stored token, validating via userinfo…");

  try {
    await validateToken({ token: stored.token, hostname: stored.hostname });

    // Token OK — mirror w IDB (SW + Background Sync)
    await saveToken({
      db,
      token: stored.token,
      hostname: stored.hostname,
      locationid: stored.locationid,
    });

    change("connected");
    console.log("[auth] Token validated — connected to pCloud (%s).", stored.hostname);
    return stored;
  } catch (err) {
    if (err.isNetworkError) {
      // Błąd sieci — nie czyścimy tokenu, trzymamy stan „checking" (app nie miała szansy
      // zweryfikować; użytkownik może spróbować ponownie po odzyskaniu połączenia).
      console.warn("[auth] Network error during token validation — keeping token:", err.message);
      change("connected"); // token prawdopodobnie OK,只是 sieć padła
      return stored;
    }
    // Token nieważny (auth error) — ciche czyszczenie + ekran logowania
    console.warn("[auth] Token invalid:", err.message);
    await clearToken({ db });
    change("login");
    return null;
  }
}

/**
 * Obsługuje powrót z OAuth na dev (localhost:5173).
 * Na dev redirect_uri = `http://localhost:5173/` — trafia na index.html,
 * a fragment z tokenem trzeba wyciągnąć z bieżącego URL.
 *
 * @param {{ db: IDBDatabase }} opts
 * @returns {Promise<boolean>} true jeśli token został przetworzony
 */
export async function handleOAuthReturn({ db }) {
  currentAuthState = "checking";
  const hash = globalThis.location.hash;
  if (!hash || hash.length < 2) return false;

  // Szybki test: wygląda na fragment OAuth?
  if (!hash.includes("access_token=")) return false;

  const params = {};
  hash
    .substring(1)
    .split("&")
    .forEach((pair) => {
      const idx = pair.indexOf("=");
      if (idx === -1) return;
      const key = decodeURIComponent(pair.substring(0, idx));
      const val = decodeURIComponent(pair.substring(idx + 1));
      params[key] = val;
    });

  if (params.error || !params.access_token) {
    if (params.error) console.warn("[auth] OAuth error from pCloud:", params.error);
    // Czyścimy fragment — nie chcemy re-parsować błędu przy reload
    history.replaceState(null, "", globalThis.location.pathname + globalThis.location.search);
    currentAuthState = "idle";
    return false;
  }

  // Weryfikacja state (anty-CSRF) — anty-CSRF
  if (!verifyState(params.state)) {
    console.error("OAuth state verification failed — possible CSRF attack.");
    // Czyścimy fragment — #access_token=… nie może zostać w URL (security)
    history.replaceState(null, "", globalThis.location.pathname + globalThis.location.search);
    currentAuthState = "idle";
    return false;
  }

  const token = params.access_token;
  const hostname = params.hostname || "api.pcloud.com";
  const locationid = Number(params.locationid) || 1;

  await saveToken({ db, token, hostname, locationid });

  // Czyścimy fragment z URL
  history.replaceState(null, "", globalThis.location.pathname + globalThis.location.search);

  console.log("[auth] OAuth return processed — token saved (%s).", hostname);
  currentAuthState = "connected";
  return true;
}
