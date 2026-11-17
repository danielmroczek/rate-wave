/** Czy klawisz trafia w pole tekstowe (skróty aplikacji nie przejmują edycji). */
export function isEditableTarget(e) {
  const t = /** @type {any} */ (e.target);
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}
