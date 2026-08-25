//
// SegmentStatsView — the segmented-POV overlay: which column each per-segment
// metric lands in, which source each fault code names, and the text-node-only
// fault message.
//
// Run: node --test --experimental-test-module-mocks "tests/*.test.js"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeElement } from './fake_dom.js';

import { SLOW_FRAME_MS } from '../frame_constants.js';

const { SegmentStatsView, FAULT_POOL, FAULT_RENDER } =
  await import('../segment_stats_view.js');

test('index provides every container the stats view resolves', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['segment-stats', 'global-stats-desktop', 'stats-bar']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
  }
});

/**
 * An overlay container the page owns, so the view's cache of it stays live the
 * way it does in a browser. The view creates its own nodes through
 * doc.createElement, which are unappended and therefore disconnected.
 * @param {string} tag - Tag name.
 * @returns {Object} Fake element standing in for a node already in the page.
 */
const pageElement = (tag) => fakeElement(tag, { connected: true });

/**
 * Overlay document stand-in: the stats container plus the two global stat bars
 * the overlay hides. Every element it creates throws on an innerHTML write, so
 * a regression from text nodes to markup assignment fails the test rather than
 * passing silently.
 * @returns {{doc: Object, stats: Object, desktop: Object, mobile: Object}} Document and its elements.
 */
function makeDoc() {
  const createElement = (tag) => fakeElement(tag);
  const stats = pageElement('div');
  const desktop = pageElement('div');
  const mobile = pageElement('div');
  const byId = {
    'segment-stats': stats,
    'global-stats-desktop': desktop,
    'stats-bar': mobile,
  };
  return {
    doc: { getElementById: (id) => byId[id] || null, createElement },
    stats,
    desktop,
    mobile,
  };
}

/**
 * A ready, active state whose per-segment values are pairwise distinct, so a
 * metric written into a neighbouring column is visible.
 * @param {number} n - Segment count.
 * @param {Object} [over] - Fields to override.
 * @returns {Object} Snapshot for update().
 */
function readyState(n, over = {}) {
  const results = [];
  const timings = [];
  const arenas = [];
  const frameSeen = [];
  for (let s = 0; s < n; s++) {
    results.push({ x0: s * 10, x1: s * 10 + 9, y0: 100 + s, y1: 200 + s });
    timings.push(s + 1);
    arenas.push({
      scratch_arena_a: { high_water_mark: 1024 * (s + 1) },
      scratch_arena_b: { high_water_mark: 2048 * (s + 1) },
      persistent_arena: { usage: 4096 * (s + 1) },
    });
    frameSeen.push(true);
  }
  return {
    active: true,
    ready: true,
    faulted: false,
    faultInfo: null,
    count: n,
    results,
    timings,
    arenas,
    frameSeen,
    wallTime: 12.5,
    ...over,
  };
}

/**
 * Resolves table cells by header text rather than by index, so an assertion
 * pins the column a value is rendered into. Rows are filtered out of the table's
 * children, which the caption also sits in.
 * @param {Object} stats - The stats container element.
 * @returns {{table: Object, rows: Object[], head: string[], cell: (row: number, column: string) => Object}} Table accessors.
 */
function grid(stats) {
  const table = stats.firstElementChild;
  const rows = table.children.filter((c) => c.tagName === 'TR');
  const head = rows[0].children.map((c) => c.textContent);
  return {
    table,
    rows,
    head,
    cell: (row, column) => rows[row].children[head.indexOf(column)],
  };
}

test('every per-segment metric renders under its own column header', () => {
  const { doc, stats } = makeDoc();
  new SegmentStatsView(doc).update(readyState(3));

  const { head, cell } = grid(stats);
  assert.deepEqual(head, ['', 'Range', 'Compute', 'Scr A', 'Scr B', 'Persist']);

  for (let s = 0; s < 3; s++) {
    const row = s + 1; // row 0 is the header
    assert.equal(cell(row, '').textContent, `Seg ${s}`);
    assert.equal(cell(row, 'Range').textContent,
      `x[${s * 10}–${s * 10 + 9}] y[${100 + s}–${200 + s}]`);
    assert.equal(cell(row, 'Compute').textContent, `${(s + 1).toFixed(1)} ms`);
    assert.equal(cell(row, 'Scr A').textContent, `${(s + 1).toFixed(1)}`);
    assert.equal(cell(row, 'Scr B').textContent, `${(2 * (s + 1)).toFixed(1)}`);
    assert.equal(cell(row, 'Persist').textContent, `${(4 * (s + 1)).toFixed(1)}`);
  }

  assert.equal(cell(4, '').textContent, 'max');
  assert.equal(cell(4, 'Compute').textContent, '3.0 ms');
  assert.equal(cell(5, '').textContent, 'round-trip');
  assert.equal(cell(5, 'Compute').textContent, '12.5 ms');
});

test('a segment with no frame yet shows ? for its range and - for its arenas', () => {
  const { doc, stats } = makeDoc();
  const state = readyState(2);
  state.frameSeen[1] = false;
  state.arenas[1] = null;
  new SegmentStatsView(doc).update(state);

  const { cell } = grid(stats);
  assert.equal(cell(2, 'Range').textContent, '?');
  assert.equal(cell(2, 'Scr A').textContent, '-');
  assert.equal(cell(2, 'Scr B').textContent, '-');
  assert.equal(cell(2, 'Persist').textContent, '-');
});

test('a worker that shaded the whole canvas is not reported as a band render', () => {
  const { doc, stats } = makeDoc();
  const state = readyState(2);
  state.fullFrames = [true, false];
  new SegmentStatsView(doc).update(state);

  const { cell } = grid(stats);
  assert.equal(cell(1, 'Range').textContent, 'full frame');
  assert.equal(cell(2, 'Range').textContent, 'x[10–19] y[101–201]');
});

test('max time covers the live segments only, ignoring a stale tail entry', () => {
  const { doc, stats } = makeDoc();
  const state = readyState(2);
  state.timings.push(999); // left over from a larger pool
  new SegmentStatsView(doc).update(state);

  assert.equal(grid(stats).cell(3, 'Compute').textContent, '2.0 ms');
});

test('only times past the slow threshold take the slow class', () => {
  const { doc, stats } = makeDoc();
  const state = readyState(2);
  state.timings = [SLOW_FRAME_MS, SLOW_FRAME_MS + 1];
  state.wallTime = SLOW_FRAME_MS + 1;
  new SegmentStatsView(doc).update(state);

  const { cell } = grid(stats);
  assert.equal(cell(1, 'Compute').className, 'seg-time');
  assert.equal(cell(2, 'Compute').className, 'seg-time slow');
  assert.equal(cell(3, 'Compute').className, 'seg-time');   // max is never reclassed
  assert.equal(cell(4, 'Compute').className, 'seg-time slow'); // round-trip is
});

test('the table is mutated in place and rebuilt only on a segment-count change', () => {
  const { doc, stats } = makeDoc();
  const view = new SegmentStatsView(doc);
  view.update(readyState(2));
  const first = stats.firstElementChild;

  view.update(readyState(2, { timings: [9, 9] }));
  assert.equal(stats.firstElementChild, first, 'the steady-state repaint reuses the table');
  assert.equal(grid(stats).cell(1, 'Compute').textContent, '9.0 ms');

  view.update(readyState(3));
  const rebuilt = stats.firstElementChild;
  assert.notEqual(rebuilt, first, 'a segment-count change rebuilds the table');
  assert.equal(grid(stats).rows.length, 3 + 3); // header + 3 segments + max + round-trip
});

test('the generated table names itself and scopes its column headers', () => {
  const { doc, stats } = makeDoc();
  new SegmentStatsView(doc).update(readyState(2));

  const caption = stats.firstElementChild.children[0];
  assert.equal(caption.tagName, 'CAPTION');
  assert.equal(caption.className, 'visually-hidden');
  assert.equal(caption.textContent,
    'Per-segment compute time and arena high-water marks');
  const headers = grid(stats).rows[0].children;
  assert.equal(headers.length, 6);
  for (const header of headers) {
    assert.equal(header.getAttribute('scope'), 'col');
  }
});

// The overlay repaints on every composited frame, so the steady-state path has
// to touch the document only where something changed.
test('a steady-state repaint re-queries nothing and rewrites no class', () => {
  const { doc, stats } = makeDoc();
  const lookup = doc.getElementById;
  let lookups = 0;
  doc.getElementById = (id) => { lookups++; return lookup(id); };
  const view = new SegmentStatsView(doc);

  view.update(readyState(2));
  assert.equal(lookups, 3, 'the first repaint resolves the three overlay elements');

  // Counting wrapper over the fake element's className accessor, so an
  // unconditional write is visible even when the value is unchanged.
  const compute = grid(stats).cell(1, 'Compute');
  const accessor = Object.getOwnPropertyDescriptor(compute, 'className');
  let classWrites = 0;
  Object.defineProperty(compute, 'className', {
    enumerable: true,
    get: accessor.get,
    set(value) { classWrites++; accessor.set.call(compute, value); },
  });

  view.update(readyState(2, { timings: [5, 6] }));
  view.update(readyState(2, { timings: [7, 8] }));
  assert.equal(lookups, 3, 'later repaints reuse the resolved elements');
  assert.equal(classWrites, 0, 'an unchanged compute class is not rewritten');

  view.update(readyState(2, { timings: [SLOW_FRAME_MS + 1, 1] }));
  assert.equal(classWrites, 1, 'crossing the slow threshold writes it once');
  assert.equal(compute.className, 'seg-time slow');
});

test('an inactive pool hides the overlay and hands the stat bars back', () => {
  const { doc, stats, desktop, mobile } = makeDoc();
  const view = new SegmentStatsView(doc);

  view.update(readyState(2));
  assert.equal(stats.style.display, '');
  assert.equal(desktop.style.display, 'none');
  assert.equal(mobile.style.display, 'none');

  view.update(readyState(2, { active: false }));
  assert.equal(stats.style.display, 'none');
  assert.equal(desktop.style.display, '');
  assert.equal(mobile.style.display, '');
});

test('an inactive pool hands stat bars back when the overlay is missing', () => {
  const { doc, desktop, mobile } = makeDoc();
  const getElementById = doc.getElementById;
  let overlayPresent = true;
  doc.getElementById = (id) => id === 'segment-stats' && !overlayPresent
    ? null : getElementById(id);
  const view = new SegmentStatsView(doc);

  view.update(readyState(2));
  overlayPresent = false;
  view.update(readyState(2, { active: false }));

  assert.equal(desktop.style.display, '');
  assert.equal(mobile.style.display, '');
});

// The overlay does not create its containers, so the page can replace one under
// it. A cached detached node takes writes nobody sees, and the hand-back would
// restore the bar that left while the live one stays hidden.
test('a replaced overlay element is re-resolved instead of written detached', () => {
  const createElement = (tag) => fakeElement(tag);
  const byId = {
    'segment-stats': pageElement('div'),
    'global-stats-desktop': pageElement('div'),
    'stats-bar': pageElement('div'),
  };
  const doc = { getElementById: (id) => byId[id] ?? null, createElement };
  const view = new SegmentStatsView(doc);

  view.update(readyState(2));
  const retired = byId['global-stats-desktop'];
  assert.equal(retired.style.display, 'none');

  retired.remove();
  const replacement = pageElement('div');
  byId['global-stats-desktop'] = replacement;

  view.update(readyState(2));
  assert.equal(replacement.style.display, 'none', 'the live bar is the one hidden');

  view.update(readyState(2, { active: false }));
  assert.equal(replacement.style.display, '', 'the live bar is the one handed back');
});

// The page swaps its overlay by rebuilding the container the bar sits in, which
// never names the cached node itself.
test('an overlay element retired with its container is re-resolved', () => {
  const createElement = (tag) => fakeElement(tag);
  const container = pageElement('div');
  const byId = {
    'segment-stats': pageElement('div'),
    'global-stats-desktop': createElement('div'),
    'stats-bar': pageElement('div'),
  };
  container.append(byId['global-stats-desktop']);
  const doc = { getElementById: (id) => byId[id] ?? null, createElement };
  const view = new SegmentStatsView(doc);

  view.update(readyState(2));
  const retired = byId['global-stats-desktop'];
  assert.equal(retired.style.display, 'none');

  const replacement = createElement('div');
  container.replaceChildren(replacement);
  byId['global-stats-desktop'] = replacement;

  view.update(readyState(2));
  assert.equal(replacement.style.display, 'none', 'the live bar is the one hidden');

  view.update(readyState(2, { active: false }));
  assert.equal(replacement.style.display, '', 'the live bar is the one handed back');
  assert.equal(retired.style.display, 'none', 'the retired bar took the hand-back');
});

// The bars belong to the page, so an inline display the page set on one is a
// value the overlay is borrowing, not the stylesheet's to overwrite.
test('a stat bar is handed back at the inline display it was hidden with', () => {
  const { doc, desktop, mobile } = makeDoc();
  const view = new SegmentStatsView(doc);
  desktop.style.display = 'flex';

  view.update(readyState(2));
  assert.equal(desktop.style.display, 'none');
  assert.equal(mobile.style.display, 'none');

  view.update(readyState(2, { active: false }));
  assert.equal(desktop.style.display, 'flex', 'the borrowed value was overwritten');
  assert.equal(mobile.style.display, '', 'a bar with no inline display keeps none');
});

test('repeated repaints do not overwrite the remembered stat-bar display', () => {
  const { doc, desktop } = makeDoc();
  const view = new SegmentStatsView(doc);
  desktop.style.display = 'grid';

  view.update(readyState(2));
  view.update(readyState(2));
  view.update(readyState(2, { active: false }));

  assert.equal(desktop.style.display, 'grid',
    'a second hide remembered the hidden value as the one to restore');

  // Nothing is held after the hand-back, so a later restore invents no value.
  desktop.style.display = 'block';
  view.update(readyState(2, { active: false }));
  assert.equal(desktop.style.display, 'block');
});

test('repeated repaints write stat-bar visibility only when it changes', () => {
  const { doc, desktop, mobile } = makeDoc();
  const view = new SegmentStatsView(doc);
  let displayWrites = 0;
  for (const bar of [desktop, mobile]) {
    bar.style = new Proxy(bar.style, {
      set(target, key, value) {
        if (key === 'display') displayWrites++;
        target[key] = value;
        return true;
      },
    });
  }

  view.update(readyState(2));
  assert.equal(displayWrites, 2);
  assert.equal(desktop.style.display, 'none');
  assert.equal(mobile.style.display, 'none');

  for (let frame = 1; frame < 60; frame++) view.update(readyState(2));
  assert.equal(displayWrites, 2, 'steady-state repaints do not rewrite none');

  view.update(readyState(2, { active: false }));
  assert.equal(displayWrites, 4);
  assert.equal(desktop.style.display, '');
  assert.equal(mobile.style.display, '');

  view.update(readyState(2, { active: false }));
  assert.equal(displayWrites, 4, 'an inactive repaint has nothing left to restore');
});

test('a spawning pool reports the worker count instead of a table', () => {
  const { doc, stats } = makeDoc();
  const view = new SegmentStatsView(doc);
  view.update(readyState(4, { ready: false }));

  const box = stats.firstElementChild;
  assert.equal(box.getAttribute('role'), 'status');
  assert.deepEqual(box.childNodes, ['Spawning 4 workers…']);
  assert.deepEqual(box.children, [], 'the count is a text node, not an element');

  view.update(readyState(8, { ready: false }));
  assert.equal(stats.firstElementChild, box);
  assert.deepEqual(box.childNodes, ['Spawning 8 workers…']);
});

test('each fault code names its own source in the headline', () => {
  const cases = [
    [{ segId: 0, message: 'boom' }, 'worker 0'],
    [{ segId: 3, message: 'boom' }, 'worker 3'],
    [{ segId: FAULT_POOL, message: 'boom' }, 'pool init'],
    [{ segId: FAULT_RENDER, message: 'boom' }, 'render timeout'],
    [{ segId: -7, message: 'boom' }, 'pool init'],
    [null, 'worker ?'],
  ];
  for (const [faultInfo, who] of cases) {
    const { doc, stats } = makeDoc();
    new SegmentStatsView(doc).update(readyState(2, { faulted: true, faultInfo }));

    const box = stats.firstElementChild;
    assert.equal(box.getAttribute('role'), 'alert');
    assert.equal(box.tabIndex, -1);
    assert.equal(box.focusCalls, 0, 'the live region announces without taking focus');
    assert.equal(box.childNodes[0],
      `⚠ Segment ${who} faulted — segmented render halted.`);
    assert.equal(box.childNodes[2].textContent, faultInfo ? 'boom' : 'see console');
    assert.equal(box.childNodes[4].textContent,
      'Change resolution or toggle segmented mode to restart.');
  }
});

test('the fault message is a text node, never markup', () => {
  const hostile = '<img src=x onerror="alert(1)"><script>steal()</script>';
  const { doc, stats } = makeDoc();
  new SegmentStatsView(doc).update(
    readyState(2, { faulted: true, faultInfo: { segId: 1, message: hostile } }));

  const box = stats.firstElementChild;
  const msg = box.childNodes[2];
  assert.equal(msg.tagName, 'SPAN');
  assert.equal(msg.textContent, hostile, 'the message is carried verbatim as text');
  assert.deepEqual(msg.childNodes, [hostile], 'the message remains one text node');
  assert.deepEqual(msg.children, [], 'nothing was parsed out of the message');
  // The headline is appended as a string, so it too becomes a text node.
  assert.equal(typeof box.childNodes[0], 'string');
  assert.deepEqual(box.childNodes.map((c) => typeof c === 'string' ? 'text' : c.tagName),
    ['text', 'BR', 'SPAN', 'BR', 'SPAN']);
  assert.deepEqual(box.children.map((c) => c.tagName), ['BR', 'SPAN', 'BR', 'SPAN'],
    'the elements-only view drops the text nodes');
});

test('the fault overlay is painted once and torn down on recovery', () => {
  const { doc, stats } = makeDoc();
  const view = new SegmentStatsView(doc);
  const faulted = readyState(2, { faulted: true, faultInfo: { segId: 1, message: 'boom' } });

  view.update(faulted);
  const box = stats.firstElementChild;
  view.update(faulted);
  assert.equal(stats.firstElementChild, box, 'a standing fault is not repainted');
  assert.equal(box.focusCalls, 0, 'focus is never stolen');

  view.update(readyState(2));
  const table = stats.firstElementChild;
  assert.equal(table.tagName, 'TABLE', 'recovery rebuilds the table the fault tore down');
  assert.equal(grid(stats).cell(1, 'Compute').textContent, '1.0 ms');
});

test('a steady frame rewrites no cell of the table', () => {
  const { doc, stats } = makeDoc();
  const view = new SegmentStatsView(doc);
  const state = readyState(3);
  view.update(state);

  const writes = [];
  const { rows } = grid(stats);
  for (const row of rows) {
    for (const cell of row.children) {
      let text = cell.textContent;
      Object.defineProperty(cell, 'textContent', {
        configurable: true,
        get: () => text,
        set(value) { text = value; writes.push(value); },
      });
    }
  }

  view.update(state);

  assert.deepEqual(writes, [],
    'the ranges and arena marks hold still across frames; writing them anyway '
    + 'costs a layout invalidation per cell per composited frame');
});
