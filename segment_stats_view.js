// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * SegmentStatsView — the segmented-POV stats overlay: a per-segment table of
 * compute times and arena high-water marks, plus the spawn and fault
 * states that replace it. Reads the per-segment arrays SegmentController
 * publishes each frame and owns nothing of the pipeline, so the overlay is
 * testable without a Worker and the controller without a DOM.
 */
import { SLOW_FRAME_MS } from "./frame_constants.js";
import { formatKB } from "./tools/kb_format.js";

// Sentinel segIds for pool-wide faults with no single worker to blame:
// FAULT_POOL for a module-load/init timeout, FAULT_RENDER for a render-watchdog
// timeout. The overlay headline distinguishes them.
export const FAULT_POOL = -1;
export const FAULT_RENDER = -2;

/**
 * Write a cell's text only when it moved: an unchanged textContent write
 * dirties layout anyway, and most of these figures hold still across frames.
 * @param {HTMLTableCellElement} cell - Cell to update.
 * @param {string} text - Text the cell should carry.
 * @returns {void}
 */
function setText(cell, text) {
  if (cell.textContent !== text) cell.textContent = text;
}

// The global stat bars this overlay stands in for while segmented mode is on.
// They belong to the page, so what is hidden here is handed back as it was.
const STAT_BAR_IDS = ['global-stats-desktop', 'stats-bar'];

/**
 * The controller state one overlay repaint reads. Every array is indexed by
 * segment and at least `count` long.
 * @typedef {{
 *   active: boolean,
 *   ready: boolean,
 *   faulted: boolean,
 *   faultInfo: { segId: number, message: string } | null,
 *   count: number,
 *   results: Array<{x0: number, x1: number, y0: number, y1: number} | null>,
 *   timings: number[],
 *   arenas: Array<import('./worker_protocol.js').SegArenaMetrics | null>,
 *   fullFrames?: boolean[],
 *   frameSeen: boolean[],
 *   wallTime: number,
 * }} SegmentStatsState
 */

/**
 * The cells one segment's row repaint writes.
 * @typedef {{
 *   range: HTMLTableCellElement,
 *   compute: HTMLTableCellElement,
 *   scrA: HTMLTableCellElement,
 *   scrB: HTMLTableCellElement,
 *   persist: HTMLTableCellElement,
 * }} SegmentRowCells
 */

/**
 * Every cell a repaint mutates, cached from the built table.
 * @typedef {{
 *   rows: SegmentRowCells[],
 *   maxTime: HTMLTableCellElement,
 *   wallTime: HTMLTableCellElement,
 * }} SegmentStatsCells
 */

export class SegmentStatsView {
  /**
   * @param {Document} [doc] - Document the overlay renders into; defaults to the global `document`.
   */
  constructor(doc = globalThis.document) {
    this.doc = doc;
    /** @type {HTMLTableElement | null} */
    this.statsTable = null;
    this.statsSegCount = 0;   // segment count the cached table was built for
    /** @type {SegmentStatsCells | null} */
    this.statsCells = null;
    // Overlay containers, resolved once and re-resolved when one leaves the
    // document. An id the document does not carry yet is left uncached, so a
    // repaint before the page is built re-queries.
    /** @type {Object<string, HTMLElement>} */
    this.byId = {};
    // Inline display each hidden stat bar carried, keyed by id; an entry exists
    // only while this overlay is the one hiding that bar.
    /** @type {Object<string, string>} */
    this.hiddenStatBars = {};
    // Identity of the fault the standing alert box was built from, so a fault
    // raised while an earlier one is still on screen repaints rather than
    // leaving the old message up.
    /** @type {string | null} */
    this.shownFault = null;
  }

  /**
   * The overlay element of the given id, cached across repaints. These are
   * page-owned containers this view does not create, so a cached node that has
   * left the document is dropped and re-resolved: writing into a detached node
   * stops the overlay updating in silence, and showStatBars() would hand the
   * display back to the detached bar and leave the live one hidden.
   * @param {string} id - Element id to resolve.
   * @returns {HTMLElement | null} The element, or null while it is absent.
   */
  element(id) {
    const cached = this.byId[id];
    if (cached?.isConnected) return cached;
    const found = this.doc.getElementById(id);
    if (found) this.byId[id] = found;
    else delete this.byId[id];
    return found;
  }

  /**
   * Hide the global stat bars this overlay stands in for, remembering the inline
   * display each carried. Repeat calls keep the first remembered value.
   * @returns {void}
   */
  hideStatBars() {
    for (const id of STAT_BAR_IDS) {
      const bar = this.element(id);
      if (!bar) continue;
      if (!(id in this.hiddenStatBars))
        this.hiddenStatBars[id] = bar.style.display ?? '';
      if (bar.style.display !== 'none') bar.style.display = 'none';
    }
  }

  /**
   * Hand back every stat bar this overlay hid, at the inline display it had.
   * @returns {void}
   */
  showStatBars() {
    for (const [id, display] of Object.entries(this.hiddenStatBars)) {
      const bar = this.element(id);
      if (bar) bar.style.display = display;
    }
    this.hiddenStatBars = {};
  }

  /**
   * Repaint the overlay from one snapshot of the controller's published state.
   * @param {SegmentStatsState} state - Current pool and per-segment state.
   * @returns {void}
   */
  update(state) {
    const el = this.element('segment-stats');
    if (!state.active) {
      if (el) el.classList.remove('visible');
      this.showStatBars();
      return;
    }
    if (!el) return;

    this.hideStatBars();
    el.classList.add('visible');

    if (state.faulted) {
      const f = state.faultInfo;
      const fault = JSON.stringify([f?.segId ?? null, f?.message ?? null]);
      if (this.shownFault === fault
          && el.firstElementChild?.getAttribute('role') === 'alert') return;
      this.shownFault = fault;
      // Build via text nodes, not innerHTML: the fault message is arbitrary text
      // and must never be parsed as markup.
      const box = this.doc.createElement('div');
      box.setAttribute('role', 'alert');
      box.className = 'seg-status seg-fault';
      // segId < 0 is a pool-wide fault, not one worker; FAULT_RENDER is a render
      // timeout, other negatives are pool init/module load.
      const who = !f ? 'worker ?'
        : f.segId === FAULT_RENDER ? 'render timeout'
        : f.segId < 0 ? 'pool init'
        : `worker ${f.segId}`;
      box.append(`⚠ Segment ${who} faulted — segmented render halted.`);
      box.appendChild(this.doc.createElement('br'));
      const msg = this.doc.createElement('span');
      msg.className = 'seg-detail';
      msg.textContent = (f && f.message) || 'see console';
      box.appendChild(msg);
      box.appendChild(this.doc.createElement('br'));
      const hint = this.doc.createElement('span');
      hint.className = 'seg-detail';
      hint.textContent = 'Change resolution or toggle segmented mode to restart.';
      box.appendChild(hint);
      el.replaceChildren(box);
      this.statsTable = null; // force a rebuild on recovery
      return;
    }

    // Spawning: the pool has no timings to show yet, and the warm + per-worker
    // WASM instantiate window runs to the controller's init watchdog.
    if (!state.ready) {
      const message = `Spawning ${state.count} workers…`;
      if (el.firstElementChild?.getAttribute('role') === 'status') {
        el.firstElementChild.replaceChildren(message);
        return;
      }
      const box = this.doc.createElement('div');
      box.setAttribute('role', 'status');
      box.className = 'seg-status';
      box.append(message);
      el.replaceChildren(box);
      this.statsTable = null; // force a rebuild once the pool reports ready
      return;
    }

    const numSegs = state.count;

    // Build the table once; rebuild only on a segment-count change or after the
    // fault overlay tore it down.
    let cells = this.statsCells;
    if (!cells || !this.statsTable || this.statsSegCount !== numSegs
        || this.statsTable.parentNode !== el) {
      cells = this.buildStatsTable(numSegs, el);
    }

    // Derive maxTime over numSegs, not the whole timings array, so a stale tail
    // entry can't outrank the live segments.
    let maxTime = 0;
    for (let s = 0; s < numSegs; s++) {
      const r = state.results[s];
      const timing = state.timings[s] || 0;
      if (timing > maxTime) maxTime = timing;
      const c = cells.rows[s];

      // A needs_full_frame() effect shades the whole canvas in every worker and
      // the rectangle is only what was sliced out of it, so naming the rect
      // there would claim a segmented render the pool never did.
      setText(c.range, !(state.frameSeen[s] && r) ? '?'
        : state.fullFrames?.[s] ? 'full frame'
        : `x[${r.x0}–${r.x1}] y[${r.y0}–${r.y1}]`);
      setText(c.compute, `${timing.toFixed(1)} ms`);
      // Written only on a crossing: an unchanged class attribute still costs a
      // style invalidation per row per composited frame.
      const computeClass = timing > SLOW_FRAME_MS ? 'seg-time slow' : 'seg-time';
      if (c.compute.className !== computeClass) c.compute.className = computeClass;

      const a = state.arenas[s];
      setText(c.scrA, a ? formatKB(a.scratch_arena_a.high_water_mark) : '-');
      setText(c.scrB, a ? formatKB(a.scratch_arena_b.high_water_mark) : '-');
      setText(c.persist, a ? formatKB(a.persistent_arena.usage) : '-');
    }

    setText(cells.maxTime, `${maxTime.toFixed(1)} ms`);
    setText(cells.wallTime, `${state.wallTime.toFixed(1)} ms`);
    const wallClass = state.wallTime > SLOW_FRAME_MS ? 'seg-time slow' : 'seg-time';
    if (cells.wallTime.className !== wallClass) cells.wallTime.className = wallClass;
  }

  /**
   * (Re)build the stats-table DOM and cache references to the cells update()
   * mutates each frame, so the steady-state path is textContent writes rather
   * than an innerHTML re-parse.
   * @param {number} numSegs - Number of segment rows to build.
   * @param {HTMLElement} el - Container element the table is mounted into.
   * @returns {SegmentStatsCells} The cached cell references.
   */
  buildStatsTable(numSegs, el) {
    const table = this.doc.createElement('table');
    const caption = this.doc.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent = 'Per-segment compute time and arena high-water marks';
    table.appendChild(caption);
    /** @param {string} text - Column header label. */
    const colHeader = (text) => {
      const e = this.doc.createElement('th');
      e.setAttribute('scope', 'col');
      e.textContent = text;
      return e;
    };
    /** @param {string} text - Row header label. */
    const rowHeader = (text) => {
      const e = this.doc.createElement('th');
      e.setAttribute('scope', 'row');
      e.className = 'seg-label';
      e.textContent = text;
      return e;
    };
    /**
     * @param {string} [text] - Cell text; left untouched when omitted.
     * @param {string} [className] - Class to set when non-empty.
     */
    const td = (text, className) => {
      const e = this.doc.createElement('td');
      if (className) e.className = className;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    /** @param {HTMLTableCellElement[]} cells - Cells of the new row, in order. */
    const mkRow = (cells) => {
      const tr = this.doc.createElement('tr');
      for (const c of cells) tr.appendChild(c);
      table.appendChild(tr);
      return tr;
    };
    const spanCell = () => { const e = td(''); e.colSpan = 3; return e; };

    mkRow([colHeader(''), colHeader('Range'), colHeader('Compute'),
           colHeader('Scr A'), colHeader('Scr B'), colHeader('Persist')]);

    const rows = [];
    for (let s = 0; s < numSegs; s++) {
      const range = td('', 'seg-range');
      const compute = td('', 'seg-time');
      const scrA = td('-');
      const scrB = td('-');
      const persist = td('-');
      mkRow([rowHeader(`Seg ${s}`), range, compute, scrA, scrB, persist]);
      rows.push({ range, compute, scrA, scrB, persist });
    }

    const maxTime = td('', 'seg-time');
    const maxRow = mkRow([rowHeader('max'), td(''), maxTime, spanCell()]);
    maxRow.className = 'seg-total';

    // round-trip spans dispatch to last worker response, so it carries the
    // structured clone, buffer transfer and event-loop latency that `max` — the
    // slowest worker's own drawFrame() — excludes.
    const wallTime = td('', 'seg-time');
    mkRow([rowHeader('round-trip'), td(''), wallTime, spanCell()]);

    el.replaceChildren(table);
    this.statsTable = table;
    this.statsSegCount = numSegs;
    this.statsCells = { rows, maxTime, wallTime };
    return this.statsCells;
  }
}
