// Boot aplikacji (bilet 01): rejestracja SW, otwarcie bazy, sanity-check schematu,
// podpięcie przycisku „wyczyść wszystkie dane" z potwierdzeniem (spec §4b).
import "./theme.css";
import { openDB, getAllKeys, STORES, resetAllData } from "./store/db.js";

async function boot() {
  // 1. Baza — otwieramy raz i trzymamy na całą sesję (LWW, multi-tab bez locków).
  try {
    const db = await openDB();
    const trackCount = (await getAllKeys(db, STORES.TRACKS)).length;
    document.getElementById("count").textContent = `${trackCount} items`;
    window.__waveRateDB = db; // kolejne bilety (list/player) przejmą to jawnie
  } catch (err) {
    console.error("openDB failed", err);
    document.getElementById("count").textContent = "database unavailable";
  }

  // 2. „Wyczyść wszystkie dane": deleteDB + localStorage.clear() z potwierdzeniem.
  const dlg = /** @type {HTMLDialogElement} */ (document.getElementById("dlg-reset"));
  document.getElementById("btn-reset")?.addEventListener("click", () => dlg.showModal());
  document.getElementById("dlg-cancel")?.addEventListener("click", () => dlg.close());
  document.getElementById("dlg-confirm")?.addEventListener("click", async () => {
    dlg.close();
    // Zamknięcie własnego połączenia przed deleteDatabase — bez tego delete
    // może zostać zablokowane (onblocked) przez otwarte conn (review spec pkt 5).
    window.__waveRateDB?.close();
    window.__waveRateDB = undefined;
    await resetAllData();
    // LWW i czysty stan: po resecie przeładowanie daje świeży shell + pustą bazę.
    location.reload();
  });

  // 3. PWA — Service Worker tylko na https/localhost (file:// niewspierany, spec §1a).
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    const base = import.meta.env.BASE_URL; // dev '/', prod '/rate-wave/'
    navigator.serviceWorker
      .register(base + "sw.js", { scope: base })
      .catch((err) => console.warn("SW register failed", err));
  }
}

boot();
