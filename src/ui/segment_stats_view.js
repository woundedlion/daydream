// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * SegmentStatsView — the segmented-POV stats overlay: a per-segment table of
 * compute times, scratch high-water marks and persistent usage, plus the spawn and fault
 * states that replace it.
 */
import { SLOW_FRAME_MS } from "../renderer/frame_constants.js";
import { formatKB } from "../shared/kb_format.js";

import { FAULT_RENDER } from "../segments/worker_protocol.js";

/**
 * Write a node's text only when it changed; an unchanged textContent write
 * still dirties layout.
 * @param {HTMLElement} cell - Node to update.
 * @param {string} text - Text the cell should carry.
 * @returns {void}
 */
function setText(cell, text) {
  if (cell.textContent !== text) cell.textContent = text;
}

const STAT_BAR_IDS = ['global-stats-desktop', 'stats-bar'];

/**
 * The controller state one overlay repaint reads. Arrays are indexed by segment
 * and at least `count` long for a ready pool; teardown leaves them empty.
 * @typedef {{
 *   active: boolean,
 *   ready: boolean,
 *   faulted: boolean,
 *   faultInfo: { segId: number, message: string } | null,
 *   count: number,
 *   results: Array<{x0: number, x1: number, y0: number, y1: number} | null>,
 *   timings: number[],
 *   arenas: Array<import('../segments/worker_protocol.js').SegArenaMetrics | null>,
 *   fullFrames: boolean[],
 *   warnings?: Array<string[] | null>,
 *   frameSeen: boolean[],
 *   wallTime: number,
 * }} SegmentStatsState
 */

/**
 * The cells one segment's row repaint writes, plus the node describing its
 * header.
 * @typedef {{
 *   label: HTMLTableCellElement,
 *   notice: HTMLElement,
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
    /** @type {Object<string, HTMLElement>} */
    this.byId = {};
    /** @type {Object<string, string>} */
    this.hiddenStatBars = {};
    /** @type {string | null} */
    this.shownFault = null;
  }

  /**
   * The overlay element of the given id, cached across repaints. A cached node
   * that has left the document is dropped and re-resolved.
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

    // Only a pool that owns the display stands in for the global bars; while one
    // spawns the main engine is still painting and their figures are live.
    if (state.ready || state.faulted) this.hideStatBars();
    else this.showStatBars();
    el.classList.add('visible');

    if (state.faulted) {
      const f = state.faultInfo;
      const fault = JSON.stringify([f?.segId ?? null, f?.message ?? null]);
      if (this.shownFault === fault
          && el.firstElementChild?.getAttribute('role') === 'alert') return;
      this.shownFault = fault;
      const box = this.doc.createElement('div');
      box.setAttribute('role', 'alert');
      box.className = 'seg-status seg-fault';
      const who = !f ? 'worker ?'
        : f.segId === FAULT_RENDER ? 'render pipeline'
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

    // Spawning: the pool has no timings to show yet.
    if (!state.ready) {
      const message = `Spawning ${state.count} workers…`;
      if (el.firstElementChild?.getAttribute('role') === 'status') {
        if (el.firstElementChild.textContent !== message)
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

    let cells = this.statsCells;
    if (!cells || !this.statsTable || this.statsSegCount !== numSegs
        || this.statsTable.parentNode !== el) {
      cells = this.buildStatsTable(numSegs, el);
    }

    let maxTime = 0;
    for (let s = 0; s < numSegs; s++) {
      const r = state.results[s];
      const timing = state.timings[s] || 0;
      if (timing > maxTime) maxTime = timing;
      const c = cells.rows[s];

      const warnings = state.warnings?.[s];
      const diverged = Array.isArray(warnings) && warnings.length > 0;
      setText(c.label, diverged ? `Seg ${s} ⚠` : `Seg ${s}`);
      const labelClass = diverged ? 'seg-label seg-diverged' : 'seg-label';
      if (c.label.className !== labelClass) c.label.className = labelClass;
      setText(c.notice, diverged ? warnings.join('; ') : '');

      setText(c.range, !(state.frameSeen[s] && r) ? '?'
        : state.fullFrames[s] ? 'full frame'
        : `x[${r.x0}–${r.x1}] y[${r.y0}–${r.y1}]`);
      setText(c.compute, `${timing.toFixed(1)} ms`);
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
   * mutates each frame.
   * @param {number} numSegs - Number of segment rows to build.
   * @param {HTMLElement} el - Container element the table is mounted into.
   * @returns {SegmentStatsCells} The cached cell references.
   */
  buildStatsTable(numSegs, el) {
    const table = this.doc.createElement('table');
    const caption = this.doc.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent = 'Per-segment compute time, scratch high-water marks and persistent usage';
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
    const notices = this.doc.createElement('div');
    notices.className = 'visually-hidden';

    mkRow([colHeader(''), colHeader('Range'), colHeader('Compute'),
           colHeader('Scr A KiB'), colHeader('Scr B KiB'), colHeader('Persist KiB')]);

    const rows = [];
    for (let s = 0; s < numSegs; s++) {
      const range = td('', 'seg-range');
      const compute = td('', 'seg-time');
      const scrA = td('-');
      const scrB = td('-');
      const persist = td('-');
      const label = rowHeader(`Seg ${s}`);
      const notice = this.doc.createElement('span');
      notice.id = `seg-notice-${s}`;
      notices.appendChild(notice);
      label.setAttribute('aria-describedby', notice.id);
      mkRow([label, range, compute, scrA, scrB, persist]);
      rows.push({ label, notice, range, compute, scrA, scrB, persist });
    }

    const maxTime = td('', 'seg-time');
    const maxRow = mkRow([rowHeader('max'), td(''), maxTime, spanCell()]);
    maxRow.className = 'seg-total';

    const wallTime = td('', 'seg-time');
    mkRow([rowHeader('round-trip'), td(''), wallTime, spanCell()]);

    el.replaceChildren(table, notices);
    this.statsTable = table;
    this.statsSegCount = numSegs;
    this.statsCells = { rows, maxTime, wallTime };
    return this.statsCells;
  }
}
