// Wspólna walidacja/parsowanie BPM (bilet 13, spec §5f/§12.1) — jeden format
// dla parsera headów, writera ID3 i kontrolera zapisu.
// TXXX `bpm` niesie liczbę całkowitą; wartość tekstowa może mieć dopisek „BPM”.

export const MAX_BPM = 999;

const BPM_VALUE_RE = /^([+-]?\d+(?:\.\d+)?)\s*(?:bpm)?$/i;

/**
 * Tekst → BPM (zaokrąglony int) albo null.
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseBpmValue(text) {
  const match = BPM_VALUE_RE.exec(String(text ?? "").trim());
  if (!match) return null;
  const value = Math.round(Number(match[1]));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Czy wartość nadaje się do zapisu jako BPM.
 * @param {unknown} value
 * @returns {value is number}
 */
export function isValidBpm(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_BPM;
}
