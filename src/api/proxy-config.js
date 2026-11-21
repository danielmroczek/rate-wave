// Wspólna konfiguracja READ-PROXY (osobny moduł, aby uniknąć cyklu importów
// między klientem żądań a negocjacją metody).

/** Baza URL READ-PROXY (Vite env, fallback na lokalny wrangler). */
export const PROXY_BASE_URL = import.meta.env?.VITE_RW_PROXY_URL || "http://localhost:8787";
