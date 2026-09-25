import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHandlers } from './helpers/page_handlers.js';
import { createPointerDrag } from '../src/shared/pointer_drag.js';
import { fakeElement } from './helpers/fake_dom.js';

const handler = pageHandlers(new URL('../src/workbench/solids/solids_page.js', import.meta.url));

test('parameter changes from removed or reordered rows cannot edit the replacement', () => {
  const state = { ops: [] };
  const updateOpParam = handler('updateOpParam', { state, opsRevision: 2 });
  assert.doesNotThrow(() => updateOpParam(3, 't', '0.5', 1));
  state.ops.push({ op: 'truncate', params: { t: 0.1 } });
  updateOpParam(0, 't', '0.5', 1);
  assert.equal(state.ops[0].params.t, 0.1);
  assert.doesNotThrow(() => updateOpParam(3, 't', '0.5', 2));
});

test('arena polling retries ordinary failures and stops cleanly on an engine halt', () => {
  const error = new Error('bridge refused');
  const scheduled = [];
  const warnings = [];
  let halted = false;
  const context = {
    arenaMetricsTimer: 5,
    meshOpsWasm: { getArenaMetrics() { throw error; } },
    engineTrapped: (caught) => { assert.equal(caught, error); return halted; },
    console: { warn: (...args) => warnings.push(args) },
    setTimeout: (callback, delay) => { scheduled.push([callback, delay]); return 6; },
  };
  const poll = handler('updateArenaMetrics', context);
  assert.doesNotThrow(poll);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0][1], 500);
  assert.equal(warnings.length, 1);
  halted = true;
  assert.doesNotThrow(poll);
  assert.equal(scheduled.length, 1);
  assert.equal(context.arenaMetricsTimer, null);
});

test('copying a star recipe contains bridge errors and reports engine halts', async () => {
  const error = new Error('recipe unavailable');
  const failures = [];
  const traps = [];
  let halted = false;
  const copyCode = handler('copyCode', {
    savedSolids: [{ base: 'star' }],
    registrySolidNames: new Set(['star']),
    islamicStarPatterns: ['star'],
    meshOpsWasm: { getRecipe() { throw error; } },
    engineTrapped: (caught) => { traps.push(caught); return halted; },
    showCopyFailure: (_button, message) => failures.push(message),
  });
  await copyCode(0, 'registry', {});
  assert.deepEqual(failures, ['export failed: recipe unavailable']);
  assert.deepEqual(traps, [error]);
  halted = true;
  await copyCode(0, 'registry', {});
  assert.equal(failures.length, 1);
  assert.equal(traps.length, 2);
});

for (const [count, index, expected] of [[3, 1, 1], [3, 2, 1], [1, 0, 'add']]) {
  test(`removing op ${index} of ${count} restores keyboard focus`, async () => {
    const state = { ops: Array.from({ length: count }, () => ({ op: 'ambo', params: {} })) };
    let pending;
    let focused;
    const rows = () => state.ops.map((_op, i) => ({
      querySelector: () => ({ focus: () => { focused = i; } }),
    }));
    const removeOp = handler('removeOp', {
      state, opsRevision: 1, queueCommit: (fn) => { pending = fn(); },
      chainIsValid: async () => ({ ok: true }), setOps: (ops) => { state.ops = ops; },
      renderOps() {}, update() {},
      document: {
        getElementById: () => ({ children: rows() }),
        querySelector: () => ({ focus: () => { focused = 'add'; } }),
      },
    });
    removeOp(index, 1);
    await pending;
    assert.equal(state.ops.length, count - 1);
    assert.equal(focused, expected);
  });
}

test('deleting saved solids preserves focus in reverse display order or on save', () => {
  const savedSolids = [{}, {}, {}];
  let focused;
  const deleteSolid = handler('deleteSolid', {
    savedSolids, persistSavedSolids() {}, renderSavedList() {},
    document: { getElementById: (id) => id === 'saveBtn'
      ? { focus: () => { focused = 'save'; } }
      : { children: savedSolids.map((_item, i) => ({
        querySelector: () => ({ focus: () => { focused = i; } }),
      })) } },
  });
  deleteSolid(2);
  assert.equal(focused, 0);
  deleteSolid(0);
  assert.equal(focused, 0);
  deleteSolid(0);
  assert.equal(focused, 'save');
});

test('blocked add-op buttons remain focusable and explain their refusal on activation', async () => {
  const attributes = new Map();
  const button = {
    dataset: { op: 'ambo' }, disabled: false,
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: (key) => attributes.get(key),
    removeAttribute: (key) => attributes.delete(key),
  };
  const messages = [];
  const added = [];
  const context = {
    wasmModule: {}, state: { base: 'cube', ops: [] }, currentMesh: {},
    document: { querySelectorAll: () => [button] },
    opGate: { refresh: async () => ({ blocked: new Set(['ambo']), complete: true }) },
    showGateMsg: (message) => messages.push(message), addOp: (op) => added.push(op),
  };
  await handler('refreshOpGating', context)();
  assert.equal(button.disabled, false);
  assert.equal(attributes.get('aria-disabled'), 'true');
  handler('activateAddOp', context)({ target: { closest: () => button } });
  assert.equal(added.length, 0);
  assert.match(messages[0], /exceed an engine mesh limit/);
  handler('openOpGate', context)('validator unavailable');
  assert.equal(attributes.has('aria-disabled'), false);
  assert.equal(attributes.has('aria-describedby'), false);
  handler('activateAddOp', context)({ target: { closest: () => button } });
  assert.deepEqual(added, ['ambo']);
});

test('thumbnail build errors stay in the thumbnail status area', () => {
  const status = { textContent: '' };
  const show = handler('showThumbnailError', { console: { error() {} },
    document: { getElementById: (id) => { assert.equal(id, 'thumbnailStatus'); return status; } } });
  show('Thumbnail for cube failed');
  assert.equal(status.textContent, 'Thumbnail for cube failed');
});


test('index cap notice changes only on entry and exit without touching gate feedback', () => {
  let value = '';
  const writes = [];
  const notice = { get textContent() { return value; },
    set textContent(text) { writes.push(text); value = text; } };
  const update = handler('updateIndexLabelNotice', { MAX_INDEX_LABELS: 1000,
    document: { getElementById: (id) => { assert.equal(id, 'indexLabelNotice'); return notice; } } });
  update(true);
  update(true);
  update(false);
  assert.deepEqual(writes, ['Vertex indices require fewer than 1000 vertices.', '']);
});


test('persistence failure retains collision feedback and clears after a later successful write', () => {
  const status = { textContent: '' };
  let failing = true;
  const persist = handler('persistSavedSolids', { savedSolids: [], SAVED_SOLIDS_KEY: 'saved',
    console: { warn() {} }, document: { getElementById: () => status },
    localStorage: { setItem() { if (failing) throw new Error('quota'); } } });
  persist();
  assert.match(status.textContent, /Changes apply to this session only/);
  failing = false;
  persist();
  assert.equal(status.textContent, '');
});


test('canvas tap cancels interrupted gestures and detaches on teardown', () => {
  const canvas = fakeElement('canvas');
  let teardown;
  let toggles = 0;
  handler('wireCanvasTap', { createPointerDrag, state: { autoRotate: false },
    setAutoRotate: () => toggles++, onPageTeardown: (fn) => { teardown = fn; } })(canvas);
  const pointer = { pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 10 };
  canvas.dispatch('pointerdown', pointer);
  canvas.dispatch('pointercancel', pointer);
  canvas.dispatch('pointerup', pointer);
  assert.equal(toggles, 0);
  canvas.dispatch('pointerdown', pointer);
  canvas.dispatch('pointermove', { ...pointer, clientX: 30 });
  canvas.dispatch('pointerup', pointer);
  assert.equal(toggles, 0);
  canvas.dispatch('pointerdown', pointer);
  canvas.dispatch('pointerup', pointer);
  assert.equal(toggles, 1);
  teardown();
  assert.deepEqual(canvas.listeners, []);
});

test('clearing saved solids requires confirmation and preserves cancelled cards', () => {
  const savedSolids = [{ title: 'one' }, { title: 'two' }];
  let confirmed = false;
  const calls = [];
  const clear = handler('clearSavedSolids', { savedSolids,
    window: { confirm: (message) => { calls.push(message); return confirmed; } },
    persistSavedSolids: () => calls.push('persist'), renderSavedList: () => calls.push('render') });
  clear();
  assert.equal(savedSolids.length, 2);
  assert.equal(calls.length, 1);
  confirmed = true;
  clear();
  assert.equal(savedSolids.length, 0);
  assert.deepEqual(calls.slice(-2), ['persist', 'render']);
  clear();
  assert.equal(calls.length, 4);
});

test('a refused topology tick repaints the restored chain', async () => {
  let queued;
  const painted = [];
  const state = { base: 'cube', ops: [{ op: 'truncate', params: { t: 0.4 } }] };
  const context = {
    state, opsRevision: 1, OP_DEFS: {}, structuredClone,
    document: { getElementById: () => ({ children: [] }) },
    opTopologyKey: (entry) => entry.params.t === 0.5,
    scheduleUpdate: { cancel() {} }, queueCommit: (fn) => { queued = fn; },
    chainIsValid: async () => ({ ok: false, message: 'too large' }),
    showGateMsg() {}, renderOps() {}, update: () => painted.push(state.ops[0].params.t),
  };
  handler('updateOpParam', context)(0, 't', '0.5', 1);
  assert.equal(state.ops[0].params.t, 0.4, 'pending topology never reaches live state');
  await queued();
  assert.equal(state.ops[0].params.t, 0.4);
  assert.deepEqual(painted, [0.4]);
});

test('an accepted topology tick publishes only after validation', async () => {
  let queued;
  let resolveCheck;
  const state = { base: 'cube', ops: [{ op: 'truncate', params: { t: 0.4 } }] };
  const painted = [];
  const context = {
    state, opsRevision: 1, OP_DEFS: {}, structuredClone,
    document: { getElementById: () => ({ children: [] }) },
    opTopologyKey: (entry) => entry.params.t === 0.5,
    scheduleUpdate: { cancel() {} }, queueCommit: (fn) => { queued = fn; },
    chainIsValid: async (_base, ops) => {
      assert.equal(ops[0].params.t, 0.5);
      return new Promise((resolve) => { resolveCheck = resolve; });
    },
    showGateMsg() {}, renderOps() {}, update: () => painted.push(state.ops[0].params.t),
  };
  handler('updateOpParam', context)(0, 't', '0.5', 1);
  const pending = queued();
  context.update();
  assert.deepEqual(painted, [0.4]);
  resolveCheck({ ok: true });
  await pending;
  assert.deepEqual(painted, [0.4, 0.5]);
});

test('saved solids discard non-object entries', () => {
  const load = handler('loadSavedSolids', { SAVED_SOLIDS_KEY: 'saved',
    localStorage: { getItem: () => '[null, 1, false, "bad", [], {"base":"cube"}]' },
  });
  assert.equal(JSON.stringify(load()), '[{"base":"cube"}]');
});
