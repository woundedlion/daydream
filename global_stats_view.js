// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * GlobalStatsView — the single-engine stats bar: the frame draw duration and,
 * when the effect reports them, each arena's usage|high-water|capacity. Owns the
 * cell ids, the resolve-once latch and the formatting, so the renderer keeps
 * none of them and the overlay is testable without Three.js or a browser.
 */
import { SLOW_FRAME_MS } from "./frame_constants.js";

/** Stats-panel cell element IDs per row, ordered [desktop, mobile]. */
export const STATS_CELL_IDS = {
  perf: ["perf-stats", "perf-stats-mobile"],
  scratchA: ["stat-scratch-a", "stat-scratch-a-m"],
  scratchB: ["stat-scratch-b", "stat-scratch-b-m"],
  persist: ["stat-persistent", "stat-persistent-m"],
  stack: ["stat-stack", "stat-stack-m"],
};

export class GlobalStatsView {
  /**
   * @param {Document} [doc] - Document the overlay reads its cells from; defaults to the global `document`.
   */
  constructor(doc = globalThis.document) {
    this.doc = doc;
    /** @type {Object<string, Array<HTMLElement|null>> | null} */
    this.cells = null;
    this.missLogged = false;
  }

  /**
   * Repaint both stat bars from one frame's measurements.
   * @param {number} duration - Frame draw time in milliseconds.
   * @param {?Object} metrics - Arena metrics for the frame, or null when the
   *   effect publishes none (a worker pool owning the display, say).
   * @returns {void}
   */
  update(duration, metrics) {
    const cells = this.resolveCells();

    const perfText = `${duration.toFixed(3)} ms`;
    const perfColor = duration > SLOW_FRAME_MS ? 'red' : 'grey';
    for (const el of cells.perf) {
      if (el) { el.textContent = perfText; el.style.color = perfColor; }
    }

    if (!metrics) return;

    const fmt = (x) => `${(x.usage / 1024).toFixed(1)}|${(x.high_water_mark / 1024).toFixed(1)}|${(x.capacity / 1024).toFixed(0)}`;
    const updateRow = (row, text) => {
      for (const el of row) if (el) el.textContent = text;
    };

    updateRow(cells.scratchA, fmt(metrics.scratch_arena_a));
    updateRow(cells.scratchB, fmt(metrics.scratch_arena_b));
    updateRow(cells.persist, fmt(metrics.persistent_arena));
    if (metrics.stack) {
      updateRow(cells.stack,
        `${(metrics.stack.high_water_mark / 1024).toFixed(1)}|${(metrics.stack.capacity / 1024).toFixed(0)}`);
    }
  }

  /**
   * Look the stat cells up, latching them only once every row resolved: a row
   * still absent this tick would otherwise stay dead for the session.
   * @returns {Object<string, Array<HTMLElement|null>>} Cell elements per row.
   */
  resolveCells() {
    if (this.cells) return this.cells;

    const cells = {};
    const missing = [];
    for (const [row, ids] of Object.entries(STATS_CELL_IDS)) {
      cells[row] = ids.map(id => {
        const el = this.doc.getElementById(id);
        if (!el) missing.push(id);
        return el;
      });
    }

    if (missing.length === 0) {
      this.cells = cells;
    } else if (!this.missLogged) {
      this.missLogged = true;
      console.warn(
        `Stats cells absent from the document (${missing.join(', ')}); ` +
        `the panel re-queries every frame until they appear.`);
    }
    return cells;
  }
}
