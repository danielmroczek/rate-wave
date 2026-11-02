// Punkt wejścia dla oauth.html (bilet 03, spec §3a).
// Prod redirect: pCloud → oauth.html → tę stronę → localStorage + IDB → redirect na index.html.
// Strona parsuje token/hostname/locationid z fragmentu, waliduje state (anty-CSRF),
// przekazuje do appki przez postMessage + localStorage, czyści fragment z URL.

import { verifyState, STATE_KEY } from "./oauth.js";
import { saveToken, LS_TOKEN_KEY, LS_HOSTNAME_KEY, LS_LOCATIONID_KEY } from "./token-store.js";
import { openDB, STORES } from "../store/db.js";

function showError(msg) {
  document.getElementById("msg").textContent = msg;
  document.getElementById("msg").classList.add("error");
  document.getElementById("detail").textContent =
    "You can close this tab and try signing in again from the app.";
}

function cleanFragment() {
  history.replaceState(null, "", location.pathname + location.search);
}

async function handleOAuthFragment() {
  const hash = location.hash;
  if (!hash || hash.length < 2) {
    showError("No authorization data received from pCloud.");
    return;
  }

  // Parsowanie fragmentu: #access_token=…&hostname=…&locationid=…&state=…
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

  // Błąd z pCloud (np. user odmówił)
  if (params.error) {
    showError("pCloud denied access: " + (params.error_description || params.error));
    cleanFragment();
    return;
  }

  const token = params.access_token;
  const hostname = params.hostname || "api.pcloud.com";
  const locationid = Number(params.locationid) || 1;
  const state = params.state;

  if (!token) {
    showError("No access token in the response from pCloud.");
    cleanFragment();
    return;
  }

  // Weryfikacja state (anty-CSRF)
  if (!state || !verifyState(state)) {
    console.error("[oauth] State verification failed — received:", state);
    showError("Security check failed — the sign-in request may have been tampered with.");
    cleanFragment();
    return;
  }

  // Zapis do localStorage + IDB mirror (spec §4: token w obu miejscach — SW nie widzi LS)
  let db = null;
  try {
    db = await openDB();
    await saveToken({ db, token, hostname, locationid });
  } catch (err) {
    // Fallback: zapisz chociaż do localStorage (IDB może być niedostępne)
    console.warn("[oauth] IDB mirror failed, saving to localStorage only:", err);
    localStorage.setItem(LS_TOKEN_KEY, token);
    localStorage.setItem(LS_HOSTNAME_KEY, hostname);
    localStorage.setItem(LS_LOCATIONID_KEY, String(locationid));
  }

  console.log("[oauth] Token saved (%s, locationid=%s).", hostname, locationid);

  // Czyścimy fragment z URL — token nie zostaje w historii przeglądarki
  cleanFragment();

  // UI: sukces
  document.getElementById("msg").textContent = "Signed in to pCloud successfully.";
  document.getElementById("detail").textContent = "Returning to the app…";

  // Przekazanie do appki:
  // Scenariusz 1: appka otworzyła oauth.html w tym samym tabie (prod redirect)
  //   → przekierowujemy z powrotem na index.html.
  // Scenariusz 2: appka otworzyła popup (nie dotyczy MVP, ale na wszzelki wypadek).
  //   → postMessage do opener.
  const base = location.pathname.replace("oauth.html", "");
  const redirectBase = base === "/" ? "/rate-wave/" : base;

  // Krótkie opóźnienie żeby użytkownik zobaczył komunikat sukcesu
  setTimeout(() => {
    if (window.opener) {
      // Popup scenario — wyślij token do opener i zamknij
      window.opener.postMessage(
        { type: "rate-wave-oauth", token, hostname, locationid },
        location.origin,
      );
      window.close();
    } else {
      // Same-tab scenario — przekieruj na stronę główną
      window.location.href = redirectBase;
    }
  }, 800);
}

handleOAuthFragment();
