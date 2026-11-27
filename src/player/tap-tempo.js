// TAP tempo (bilet 13, spec §5f) — czysta logika bez DOM.
// tick = tapnięcie; od 3 ticków BPM = 60000 / średni interwał, zaokrąglone
// do całego (dokładność ±1 BPM). Pauza > 2 s albo reset() zaczyna od zera.

/** Minimalna liczba ticków, od której liczymy BPM. */
export const MIN_TAPS = 3;

/** Pauza między tickami, po której traktujemy tap jako nową próbę. */
export const RESET_AFTER_MS = 2000;

/**
 * BPM ze znaczników czasu (ms) — średnia interwału, zaokrąglona.
 * @param {number[]} times
 * @returns {number | null}
 */
export function bpmFromTaps(times) {
  if (!Array.isArray(times) || times.length < MIN_TAPS) return null;
  const intervals = [];
  for (let i = 1; i < times.length; i++) {
    const delta = times[i] - times[i - 1];
    if (delta > 0) intervals.push(delta);
  }
  if (intervals.length === 0) return null;
  const mean = intervals.reduce((sum, ms) => sum + ms, 0) / intervals.length;
  const bpm = Math.round(60000 / mean);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
}

/**
 * @param {{ now?: () => number, resetAfterMs?: number }} [opts]
 */
export function createTapTempo({
  now = () => performance.now(),
  resetAfterMs = RESET_AFTER_MS,
} = {}) {
  /** @type {number[]} */
  let times = [];

  return {
    /**
     * Rejestruje tick. Zwraca aktualne BPM (null przed 3. tickiem).
     * @returns {{ bpm: number | null, taps: number }}
     */
    tap() {
      const at = now();
      if (times.length > 0 && at - times[times.length - 1] > resetAfterMs) times = [];
      times.push(at);
      return { bpm: bpmFromTaps(times), taps: times.length };
    },
    /** Restart od zera (retry). */
    reset() {
      times = [];
    },
    get bpm() {
      return bpmFromTaps(times);
    },
    get taps() {
      return times.length;
    },
  };
}
