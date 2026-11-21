// Negocjacja metody READ-PROXY (#20): `QUERY` (bezpieczna metoda z ciałem —
// draft-ietf-httpbis-safe-method-w-body) albo `POST` (fallback).
//
// Rozpoznanie robimy raz, przy starcie aplikacji, sondując `QUERY /health`;
// wynik trzymamy w pamięci (per sesja — proxy mogło się zmienić, więc nie
// zapisujemy go do IDB). Każde żądanie nadal ma lokalny fallback na POST, gdy
// QUERY okaże się nieobsługiwane (405/501/błąd sieci) — sonda nie musi być
// doskonała, a awaria nie może zablokować odczytu.

import { PROXY_BASE_URL } from "./proxy-config.js";

/** Metody, którymi klient może wysłać token w body. @typedef {"QUERY"|"POST"} BodyMethod */
export const PREFERRED_METHOD = /** @type {const} */ ("QUERY");
export const FALLBACK_METHOD = /** @type {const} */ ("POST");

/** @type {BodyMethod | null} */
let negotiated = null;
/** Czy wynik jest ostateczny (405/501 albo 200) — inaczej warto spróbować ponownie. */
let settled = false;

/**
 * Sondowanie `QUERY /health` — zwraca metodę do użycia.
 *
 * Tylko `200` potwierdza `QUERY`, a `405`/`501` definitywnie je wykluczają.
 * Wszystko inne (błąd sieci, `403`/`429`/`5xx`, WAF, deploy w toku) to awaria
 * przejściowa: używamy `POST`, ale nie zapisujemy tego jako faktu — kolejna
 * sonda (np. po powrocie sieci) może jeszcze wybrać `QUERY`.
 */
export async function detectProxyMethod({ baseUrl = PROXY_BASE_URL, force = false } = {}) {
  if (settled && !force) return /** @type {BodyMethod} */ (negotiated);

  try {
    const res = await fetch(`${baseUrl}/health`, { method: PREFERRED_METHOD });
    if (res.ok) {
      negotiated = PREFERRED_METHOD;
      settled = true;
    } else if (isUnsupportedMethod(res)) {
      negotiated = FALLBACK_METHOD;
      settled = true;
    } else {
      negotiated = FALLBACK_METHOD;
      settled = false;
    }
  } catch {
    negotiated = FALLBACK_METHOD;
    settled = false;
  }
  return negotiated;
}

/**
 * Metoda do użycia bez czekania na sondę — POST, dopóki sonda nie potwierdzi
 * QUERY (`detectProxyMethod` jest wołane przy starcie aplikacji).
 * @returns {BodyMethod}
 */
export function currentProxyMethod() {
  return negotiated ?? FALLBACK_METHOD;
}

/**
 * Trwałe przełączenie na POST — wyłącznie po definitywnej odmowie
 * (`405`/`501`). Wynik jest odtąd ostateczny dla sesji.
 * @param {string} [reason]
 */
export function demoteProxyMethod(reason = "unsupported") {
  if (negotiated === PREFERRED_METHOD) {
    console.warn("[proxy] QUERY unavailable (%s) — falling back to POST", reason);
  }
  negotiated = FALLBACK_METHOD;
  settled = true;
}

/** Reset negocjacji (testy). */
export function resetProxyMethod() {
  negotiated = null;
  settled = false;
}

/**
 * Czy odpowiedź oznacza „metoda nieobsługiwana” (warto ponowić POST-em).
 * @param {Response} res
 */
export function isUnsupportedMethod(res) {
  return res.status === 405 || res.status === 501;
}
