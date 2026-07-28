// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * SegmentStatsView — the segmented-POV stats overlay: a per-segment table of
 * compute/render times and arena high-water marks, plus the spawn and fault
 * states that replace it. Reads the per-segment arrays SegmentController
 * publishes each frame and owns nothing of the pipeline, so the overlay is
 * testable without a Worker and the controller without a DOM.
 */
import { SLOW_FRAME_MS } from "./driver.js";

// Sentinel segIds for pool-wide faults with no single worker to blame:
// FAULT_POOL for a module-load/init timeout, FAULT_RENDER for a render-watchdog
// timeout. The overlay headline distinguishes them.
export const FAULT_POOL = -1;
export const FAULT_RENDER = -2;

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
 *   renderUs: number[],
 *   arenas: Array<import('./worker_protocol.js').SegArenaMetrics | null>,
 *   frameSeen: boolean[],
 *   wallTime: number,
 * }} SegmentStatsState
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
    /** @type {{ rows: any[], maxTime: HTMLElement, wallTime: HTMLElement } | null} */
    this.statsCells = null;
  }

  /**
   * Repaint the overlay from one snapshot of the controller's published state.
   * @param {SegmentStatsState} state - Current pool and per-segment state.
   * @returns {void}
   */
  update(state) {
    const el = this.doc.getElementById('segment-stats');
    if (!el) return;

    const globalStatsDesktop = this.doc.getElementById('global-stats-desktop');
    const globalStatsMobile = this.doc.getElementById('stats-bar');

    if (!state.active) {
      el.style.display = 'none';
      if (globalStatsDesktop) globalStatsDesktop.style.display = '';
      if (globalStatsMobile) globalStatsMobile.style.display = '';
      return;
    }

    if (globalStatsDesktop) globalStatsDesktop.style.display = 'none';
    if (globalStatsMobile) globalStatsMobile.style.display = 'none';
    el.style.display = '';

    if (state.faulted) {
      if (el.firstElementChild?.getAttribute('role') === 'alert') return;
      const f = state.faultInfo;
      // Build via text nodes, not innerHTML: the fault message is arbitrary text
      // and must never be parsed as markup.
      const box = this.doc.createElement('div');
      box.setAttribute('role', 'alert');
      box.tabIndex = -1;
      box.style.cssText = 'color:#ff5252;padding:6px;font-size:0.85em';
      // segId < 0 is a pool-wide fault, not one worker; FAULT_RENDER is a render
      // timeout, other negatives are pool init/module load.
      const who = !f ? 'worker ?'
        : f.segId === FAULT_RENDER ? 'render timeout'
        : f.segId < 0 ? 'pool init'
        : `worker ${f.segId}`;
      box.append(`⚠ Segment ${who} faulted — segmented render halted.`);
      box.appendChild(this.doc.createElement('br'));
      const msg = this.doc.createElement('span');
      msg.style.color = '#999';
      msg.textContent = (f && f.message) || 'see console';
      box.appendChild(msg);
      box.appendChild(this.doc.createElement('br'));
      const hint = this.doc.createElement('span');
      hint.style.color = '#999';
      hint.textContent = 'Change resolution or toggle segmented mode to restart.';
      box.appendChild(hint);
      el.replaceChildren(box);
      this.statsTable = null; // force a rebuild on recovery
      box.focus({ preventScroll: true });
      return;
    }

    // Spawning: the pool has no timings to show yet, and the warm + per-worker
    // WASM instantiate window runs to the controller's init watchdog.
    if (!state.ready) {
      if (el.firstElementChild?.getAttribute('role') === 'status') return;
      const box = this.doc.createElement('div');
      box.setAttribute('role', 'status');
      box.style.cssText = 'color:#999;padding:6px;font-size:0.85em';
      box.append(`Spawning ${state.count} workers…`);
      el.replaceChildren(box);
      this.statsTable = null; // force a rebuild once the pool reports ready
      return;
    }

    const fmtKB = (x) => (x / 1024).toFixed(1);
    const numSegs = state.count;

    // Build the table once; rebuild only on a segment-count change or after the
    // fault overlay tore it down.
    if (!this.statsTable || this.statsSegCount !== numSegs
        || this.statsTable.parentNode !== el) {
      this.buildStatsTable(numSegs, el);
    }

    const cells = this.statsCells;
    // Derive maxTime over numSegs, not the whole timings array, so a stale tail
    // entry can't outrank the live segments.
    let maxTime = 0;
    for (let s = 0; s < numSegs; s++) {
      const r = state.results[s];
      const timing = state.timings[s] || 0;
      if (timing > maxTime) maxTime = timing;
      const c = cells.rows[s];

      c.range.textContent = state.frameSeen[s] && r ? `x[${r.x0}–${r.x1}] y[${r.y0}–${r.y1}]` : '?';
      c.compute.textContent = `${timing.toFixed(1)} ms`;
      c.compute.className = timing > SLOW_FRAME_MS ? 'seg-time slow' : 'seg-time';
      c.render.textContent = `${((state.renderUs[s] || 0) / 1000).toFixed(1)} ms`;

      const a = state.arenas[s];
      c.scrA.textContent = a ? fmtKB(a.scratch_arena_a.high_water_mark) : '-';
      c.scrB.textContent = a ? fmtKB(a.scratch_arena_b.high_water_mark) : '-';
      c.persist.textContent = a ? fmtKB(a.persistent_arena.usage) : '-';
    }

    cells.maxTime.textContent = `${maxTime.toFixed(1)} ms`;
    cells.wallTime.textContent = `${state.wallTime.toFixed(1)} ms`;
    cells.wallTime.className = state.wallTime > SLOW_FRAME_MS ? 'seg-time slow' : 'seg-time';
  }

  /**
   * (Re)build the stats-table DOM and cache references to the cells update()
   * mutates each frame, so the steady-state path is textContent writes rather
   * than an innerHTML re-parse.
   * @param {number} numSegs - Number of segment rows to build.
   * @param {HTMLElement} el - Container element the table is mounted into.
   * @returns {void}
   */
  buildStatsTable(numSegs, el) {
    const table = this.doc.createElement('table');
    const th = (text) => { const e = this.doc.createElement('th'); e.textContent = text; return e; };
    const td = (text, className) => {
      const e = this.doc.createElement('td');
      if (className) e.className = className;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const mkRow = (cells) => {
      const tr = this.doc.createElement('tr');
      for (const c of cells) tr.appendChild(c);
      table.appendChild(tr);
      return tr;
    };
    const spanCell = () => { const e = td(''); e.colSpan = 3; return e; };

    mkRow([th(''), th('Range'), th('Compute'), th('Render'),
           th('Scr A'), th('Scr B'), th('Persist')]);

    const rows = [];
    for (let s = 0; s < numSegs; s++) {
      const range = td('');
      range.style.cssText = 'color:#555;font-size:0.8em';
      const compute = td('', 'seg-time');
      const render = td('', 'seg-time');
      const scrA = td('-');
      const scrB = td('-');
      const persist = td('-');
      mkRow([td(`Seg ${s}`, 'seg-label'), range, compute, render, scrA, scrB, persist]);
      rows.push({ range, compute, render, scrA, scrB, persist });
    }

    const maxTime = td('', 'seg-time');
    const maxRow = mkRow([td('max', 'seg-label'), td(''), maxTime, td(''), spanCell()]);
    maxRow.style.borderTop = '1px solid #333';

    const wallTime = td('', 'seg-time');
    mkRow([td('wall', 'seg-label'), td(''), wallTime, td(''), spanCell()]);

    el.replaceChildren(table);
    this.statsTable = table;
    this.statsSegCount = numSegs;
    this.statsCells = { rows, maxTime, wallTime };
  }
}
