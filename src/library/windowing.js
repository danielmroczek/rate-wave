// Manualny windowing listy (bilet 04): ~30 rzędów, stała wysokość, rAF, translateY.
// Logika czysta (windowRange) dla testów w Node; klasa WindowedList wiąże DOM.

/** Wysokość rzędu listy w px (stała, CSS --row-h derivates; zmiana = resize). */
export const ROW_HEIGHT = 44;

/** Zapas rzędów renderowanych poza viewportem (płynność scrolla). */
export const OVERSCAN = 6;

/**
 * Czyste obliczenie okna widocznych rzędów.
 * @param {{ totalRows: number, viewportHeight: number, scrollTop: number, rowHeight?: number, overscan?: number }} opts
 * @returns {{ first: number, last: number, offset: number }} last esclusivo;
 *          offset = translateY pierwszego widocznego rzędu w px
 */
export function windowRange({
  totalRows,
  viewportHeight,
  scrollTop,
  rowHeight = ROW_HEIGHT,
  overscan = OVERSCAN,
}) {
  if (totalRows <= 0 || viewportHeight <= 0) {
    return { first: 0, last: 0, offset: 0 };
  }
  const maxScroll = Math.max(0, totalRows * rowHeight - viewportHeight);
  const st = Math.max(0, Math.min(scrollTop, maxScroll));
  const first = Math.max(0, Math.floor(st / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan;
  const last = Math.min(totalRows, first + visible);
  return { first, last, offset: first * rowHeight };
}

/**
 * Windowed list — stało-wysokościowe rzędy w kontenerze o pełnej sumarycznej
 * wysokości; widoczne ~30 rzędów przymocowane translateY(offset). Scroll throttled rAF.
 */
export class WindowedList {
  /**
   * @param {{ viewport: HTMLElement, rowHeight?: number, renderRow: (row: { index: number, trackElement: HTMLElement | undefined }) => HTMLElement, onVisibleChange?: (range: { first: number, last: number }) => void }} opts
   *   `renderRow(index)` zwraca element rzędu — wywoływane tylko dla nowo-widocznych.
   */
  constructor({ viewport, rowHeight = ROW_HEIGHT, renderRow, onVisibleChange }) {
    this.viewport = viewport;
    this.rowHeight = rowHeight;
    this.renderRow = renderRow;
    this.onVisibleChange = onVisibleChange;
    this.rows = [];
    this.visible = new Map(); // index → HTMLElement
    this.first = 0;
    this.last = 0;
    this.raf = 0;

    this.windowEl = document.createElement("div");
    this.windowEl.style.position = "relative";
    this.viewport.append(this.windowEl);

    this._onScroll = () => {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.update();
      });
    };
    this.viewport.addEventListener("scroll", this._onScroll, { passive: true });
  }

  /**
   * Podmienia zbiór rzędów (filtr Rocznika itp.) i resetuje widoko i cache.
   * @param {number} totalRows
   */
  setRows(totalRows) {
    for (const [, el] of this.visible) el.remove();
    this.visible.clear();
    this.rows = Array.from({ length: totalRows });
    this.first = 0;
    this.last = 0;
    this.windowEl.style.height = `${totalRows * this.rowHeight}px`;
    this.viewport.scrollTop = 0;
    this.update();
  }

  /** Recomputuje zakres i dogasza niedawno ukryte rzędy. */
  update() {
    if (!this.rows.length) {
      this._renderRange(0, 0);
      return;
    }
    const range = windowRange({
      totalRows: this.rows.length,
      viewportHeight: this.viewport.clientHeight,
      scrollTop: this.viewport.scrollTop,
      rowHeight: this.rowHeight,
    });
    this._renderRange(range.first, range.last);
  }

  /** @private */
  _renderRange(first, last) {
    this.first = first;
    this.last = last;

    for (const [index, el] of this.visible) {
      if (index < first || index >= last) {
        el.remove();
        this.visible.delete(index);
      }
    }
    for (let i = first; i < last; i++) {
      if (this.visible.has(i)) continue;
      const el = this.renderRow({ index: i });
      el.style.height = `${this.rowHeight}px`;
      el.style.position = "absolute";
      el.style.top = "0";
      el.style.left = "0";
      el.style.right = "0";
      el.style.transform = `translateY(${i * this.rowHeight}px)`;
      this.windowEl.append(el);
      this.visible.set(i, el);
    }
    this.onVisibleChange?.({ first, last });
  }

  root() {
    return this.viewport;
  }
}
