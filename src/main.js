// Boot aplikacji (bilet 01): rejestracja SW, otwarcie bazy, sanity-check schematu,
// podpięcie przycisku „wyczyść wszystkie dane" z potwierdzeniem (spec §4b).
// Bilet 03: OAuth implicit login pCloud + walidacja tokenu przy starcie.
import "./theme.css";
import { openDB, resetAllData } from "./store/db.js";
import { initAuth, handleOAuthReturn, startOAuthLogin, getAuthState } from "./auth/auth-flow.js";
import { loadTokenFromDB } from "./auth/token-store.js";
import { mountLibraryView, unmountLibraryView } from "./library/library-view.js";

/** Pokazuje/ukrywa ekrany na podstawie stanu autoryzacji. */
function renderAuthState(state) {
  const loginScreen = document.getElementById("login-screen");
  const emptyState = document.getElementById("empty-state");
  const toolbar = document.getElementById("toolbar");
  const player = document.getElementById("player");

  if (state === "login") {
    loginScreen.hidden = false;
    emptyState.hidden = true;
    toolbar.hidden = true;
    player.hidden = true;
  } else if (state === "connected") {
    loginScreen.hidden = true;
    emptyState.hidden = false;
    toolbar.hidden = false;
    player.hidden = false;
  }
  // "checking" / "authenticating" — nie zmieniamy widoku
}

async function boot() {
  // 1. Baza — otwieramy raz i trzymamy na całą sesję (LWW, multi-tab bez locków).
  let db;
  try {
    db = await openDB();
    window.__waveRateDB = db;
  } catch (err) {
    console.error("openDB failed", err);
    document.getElementById("count").textContent = "database unavailable";
  }

  // 2. Autoryzacja pCloud — OAuth return (dev) lub walidacja stored token (bilet 03).
  if (db) {
    // Na dev (localhost) redirect_uri = index.html — fragment z tokenem jest w bieżącym URL.
    const wasOAuthReturn = await handleOAuthReturn({ db });
    let connected = false;
    if (!wasOAuthReturn) {
      // Walidacja stored token przez userinfo; fail → ciche czyszczenie + ekran logowania.
      const creds = await initAuth({ db, onStateChange: renderAuthState });
      connected = creds !== null;
    } else {
      // Token z just-completed OAuth — zapisany już w handleOAuthReturn
      console.log("[boot] OAuth return processed — user signed in.");
      renderAuthState("connected");
      connected = true;
    }

    // 2b. Biblioteka (bilet 04 + #17): cache IDB → instant; inaczej listing z
    // wybranego folderu głównego (sources.folderId; default: całe konto).
    if (connected) {
      const creds = await loadTokenFromDB(db);
      mountLibraryView({
        db,
        token: creds?.token,
        hostname: creds?.hostname,
        folderId: creds?.folderId ?? null,
        folderName: creds?.folderName ?? null,
      }).catch((err) => console.warn("[boot] library mount failed", err));
    }
  }

  // Przycisk logowania pCloud
  document.getElementById("btn-pcloud-login")?.addEventListener("click", startOAuthLogin);

  // Jeśli autoryzacja się nie zadziałała (brak db itp.), pokaż login
  if (getAuthState() === "idle") {
    renderAuthState("login");
  }

  // 3. „Wyczyść wszystkie dane": deleteDB + localStorage.clear() z potwierdzeniem.
  const dlg = /** @type {HTMLDialogElement} */ (document.getElementById("dlg-reset"));
  document.getElementById("btn-reset")?.addEventListener("click", () => dlg.showModal());
  document.getElementById("dlg-cancel")?.addEventListener("click", () => dlg.close());
  document.getElementById("dlg-confirm")?.addEventListener("click", async () => {
    dlg.close();
    // Zamknięcie własnego połączenia przed deleteDatabase — bez tego delete
    // może zostać zablokowane (onblocked) przez otwarte conn (review spec pkt 5).
    window.__waveRateDB?.close();
    window.__waveRateDB = undefined;
    unmountLibraryView();
    await resetAllData();
    // LWW i czysty stan: po resecie przeładowanie daje świeży shell + pustą bazę.
    location.reload();
  });

  // 4. PWA — Service Worker tylko na https/localhost (file:// niewspierany, spec §1a).
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    const base = import.meta.env.BASE_URL; // dev '/', prod '/rate-wave/'
    navigator.serviceWorker
      .register(base + "sw.js", { scope: base })
      .catch((err) => console.warn("SW register failed", err));
  }
}

boot();
