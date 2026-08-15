//
// GlobalStatsView — the single-engine stats bar: which cell each metric lands
// in, the slow-frame colouring, and the resolve-once latch that keeps a panel
// mounted after the first frame from re-querying forever.
//
// Run: node --test --experimental-test-module-mocks "tests/*.test.js"
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './fake_dom.js';

import { SLOW_FRAME_MS } from '../frame_constants.js';
import { GlobalStatsView, STATS_CELL_IDS } from '../global_stats_view.js';

/**
 * Document stand-in holding one element per stats cell id, counting the lookups
 * so the latch is observable.
 * @param {Array<string>} [absent] - Ids the document does NOT contain yet.
 * @returns {{doc: Object, byId: Object, lookups: Array<string>}} Document, its elements, and the lookup log.
 */
function makeDoc(absent = []) {
  const byId = {};
  const lookups = [];
  for (const ids of Object.values(STATS_CELL_IDS)) {
    for (const id of ids) if (!absent.includes(id)) byId[id] = fakeElement('span');
  }
  return {
    doc: {
      getElementById: (id) => { lookups.push(id); return byId[id] || null; },
    },
    byId,
    lookups,
  };
}

/**
 * Arena metrics whose every field is distinct, so a value written into a
 * neighbouring row is visible.
 * @param {Object} [over] - Fields to override.
 * @returns {Object} Metrics for update().
 */
function metrics(over = {}) {
  return {
    scratch_arena_a: { usage: 1024, high_water_mark: 2048, capacity: 4096 },
    scratch_arena_b: { usage: 3072, high_water_mark: 5120, capacity: 8192 },
    persistent_arena: { usage: 6144, high_water_mark: 7168, capacity: 16384 },
    stack: { high_water_mark: 9216, capacity: 32768 },
    ...over,
  };
}

/**
 * Runs `body` with console.warn captured, so the absent-cell diagnostic is
 * asserted instead of printed into the suite output.
 * @param {Function} body - Code to run under the capture.
 * @returns {Array<string>} One joined message per call.
 */
function captureWarnings(body) {
  const messages = [];
  const warn = mock.method(
    console, 'warn', (...args) => messages.push(args.map(String).join(' ')));
  try { body(); } finally { warn.mock.restore(); }
  return messages;
}

test('update writes the frame duration into both perf cells', () => {
  const { doc, byId } = makeDoc();
  new GlobalStatsView(doc).update(1.5, null);

  for (const id of STATS_CELL_IDS.perf) {
    assert.equal(byId[id].textContent, '1.500 ms');
  }
});

test('update reddens the perf cells only past the slow-frame threshold', () => {
  const { doc, byId } = makeDoc();
  const view = new GlobalStatsView(doc);

  view.update(SLOW_FRAME_MS, null);
  assert.equal(byId['perf-stats'].className, 'perf-time');
  assert.equal(byId['perf-stats-mobile'].className, 'perf-time');

  view.update(SLOW_FRAME_MS + 0.001, null);
  assert.equal(byId['perf-stats'].className, 'perf-time slow');
  assert.equal(byId['perf-stats-mobile'].className, 'perf-time slow');
});

test('a steady frame rewrites neither the arena rows nor the perf class', () => {
  const { doc, byId } = makeDoc();
  const view = new GlobalStatsView(doc);
  view.update(1, metrics());

  const writes = [];
  for (const [row, ids] of Object.entries(STATS_CELL_IDS)) {
    for (const id of ids) {
      const el = byId[id];
      let text = el.textContent;
      Object.defineProperty(el, 'textContent', {
        configurable: true,
        get: () => text,
        set(value) { text = value; writes.push(`${row}:text`); },
      });
      let className = el.className;
      Object.defineProperty(el, 'className', {
        configurable: true,
        get: () => className,
        set(value) { className = value; writes.push(`${row}:class`); },
      });
    }
  }

  view.update(1, metrics());

  assert.deepEqual(writes, ['perf:text', 'perf:text'],
    'only the duration moves every frame; the rest costs a layout invalidation '
    + 'per cell per tick unless it is written on a crossing');
});

test('update lands each arena in its own row as usage|high-water|capacity KiB', () => {
  const { doc, byId } = makeDoc();
  new GlobalStatsView(doc).update(1, metrics());

  assert.equal(byId['stat-scratch-a'].textContent, '1.0|2.0|4');
  assert.equal(byId['stat-scratch-b'].textContent, '3.0|5.0|8');
  assert.equal(byId['stat-persistent'].textContent, '6.0|7.0|16');
  // The stack reports no usage, only its high-water mark and capacity.
  assert.equal(byId['stat-stack'].textContent, '9.0|32');
});

test('update mirrors every arena row into the mobile cells', () => {
  const { doc, byId } = makeDoc();
  new GlobalStatsView(doc).update(1, metrics());

  for (const [desktop, mobile] of Object.values(STATS_CELL_IDS)) {
    assert.equal(byId[mobile].textContent, byId[desktop].textContent);
  }
});

test('update leaves the arena rows untouched when the effect reports none', () => {
  const { doc, byId } = makeDoc();
  const view = new GlobalStatsView(doc);
  view.update(1, metrics());
  view.update(2, null);

  assert.equal(byId['perf-stats'].textContent, '2.000 ms');
  assert.equal(byId['stat-scratch-a'].textContent, '1.0|2.0|4',
    'a metric-less frame blanked the last known arena usage');
});

test('update omits the stack row when the metrics carry no stack', () => {
  const { doc, byId } = makeDoc();
  new GlobalStatsView(doc).update(1, metrics({ stack: undefined }));

  assert.equal(byId['stat-stack'].textContent, '');
  assert.equal(byId['stat-persistent'].textContent, '6.0|7.0|16');
});

test('update omits an arena row the metrics do not carry', () => {
  const { doc, byId } = makeDoc();
  const view = new GlobalStatsView(doc);
  view.update(1, metrics());

  assert.doesNotThrow(() => view.update(2, metrics({ scratch_arena_b: undefined })));
  assert.equal(byId['stat-scratch-b'].textContent, '3.0|5.0|8',
    'a partial metrics object blanked the last known arena usage');
  assert.equal(byId['stat-persistent'].textContent, '6.0|7.0|16');
});

test('a fully resolved panel is looked up once, not every frame', () => {
  const { doc, lookups } = makeDoc();
  const view = new GlobalStatsView(doc);

  view.update(1, null);
  const first = lookups.length;
  view.update(2, null);

  assert.equal(first, 10, 'expected one lookup per desktop/mobile cell');
  assert.equal(lookups.length, first, 'the resolved panel was re-queried');
});

test('a partially mounted panel keeps re-querying and warns once', () => {
  const { doc, byId, lookups } = makeDoc(['stat-stack-m']);
  const view = new GlobalStatsView(doc);

  const messages = captureWarnings(() => { view.update(1, null); view.update(2, null); });

  assert.ok(lookups.length > 10, 'gave up on a cell that had not mounted yet');
  assert.equal(messages.length, 1, 'the absent-cell warning repeats every frame');
  assert.match(messages[0], /stat-stack-m/);
  // The cells that did resolve still repaint while the missing one is awaited.
  assert.equal(byId['perf-stats'].textContent, '2.000 ms');
});

test('a cell that mounts later is picked up and latched', () => {
  const { doc, byId, lookups } = makeDoc(['stat-stack-m']);
  const view = new GlobalStatsView(doc);
  captureWarnings(() => view.update(1, null));

  byId['stat-stack-m'] = fakeElement('span');
  view.update(2, metrics());
  assert.equal(byId['stat-stack-m'].textContent, '9.0|32');

  const settled = lookups.length;
  view.update(3, metrics());
  assert.equal(lookups.length, settled, 'the now-complete panel was re-queried');
});

test('the view reads only the injected document', () => {
  const { doc, byId } = makeDoc();
  const saved = globalThis.document;
  globalThis.document = { getElementById: () => { throw new Error('global document read'); } };
  try {
    new GlobalStatsView(doc).update(1, null);
  } finally {
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }

  assert.equal(byId['perf-stats'].textContent, '1.000 ms');
});
