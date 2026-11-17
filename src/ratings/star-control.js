// Gwiazdki oceny (bilet #8): pięć klikalnych przycisków, FLAT/METRO bez ramek.
// Ten sam komponent w wierszu listy i w playerze; klawiatura 1–5/0 jest w
// widoku biblioteki (dotyczy zaznaczonego Utworu).

/**
 * Ustawia wypełnienie gwiazdek (1–5 albo null) — używane też po odświeżeniu
 * wiersza bez przebudowy DOM (windowing).
 * @param {HTMLElement} el
 * @param {number | null | undefined} rating
 */
export function setStarDisplay(el, rating) {
  const value = typeof rating === "number" && rating >= 1 ? Math.min(5, Math.round(rating)) : null;
  for (const btn of el.querySelectorAll(".star-btn")) {
    const n = Number(/** @type {HTMLElement} */ (btn).dataset.star);
    const on = value != null && n <= value;
    btn.textContent = on ? "★" : "☆";
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(value === n));
  }
  el.classList.toggle("rated", value != null);
}

/**
 * @param {{ doc?: Document, onRate?: (stars: number) => void, label?: string }} [opts]
 */
export function createStarControl({ doc = document, onRate, label = "Rating" } = {}) {
  const el = doc.createElement("div");
  el.className = "row-stars star-rating";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", label);

  for (let n = 1; n <= 5; n++) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "star-btn";
    btn.dataset.star = String(n);
    btn.textContent = "☆";
    const words = `${n} star${n === 1 ? "" : "s"}`;
    btn.title = words;
    btn.setAttribute("aria-label", words);
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // klik gwiazdki nie zaznacza/nie odtwarza wiersza
      onRate?.(n);
    });
    el.append(btn);
  }
  setStarDisplay(el, null);

  return {
    element: el,
    setRating(/** @type {number | null} */ rating) {
      setStarDisplay(el, rating);
    },
  };
}
