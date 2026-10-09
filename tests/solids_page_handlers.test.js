import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHandlers } from './helpers/page_handlers.js';
import { savedChainShapeError, savedSolidExportError } from '../src/workbench/solids/solid_codegen.js';
import { createPointerDrag } from '../src/shared/pointer_drag.js';
import { fakeElement } from './helpers/fake_dom.js';

const handler = pageHandlers(new URL('../src/workbench/solids/solids_page.js', import.meta.url));

test('star thumbnails are load buttons while base solids retain radio selection', () => {
  const state = { base: 'cube' };
  const configure = handler('configureBaseSolidThumbnail', {
    state, islamicStarPatterns: ['cube_hankin'], handleBaseSolidKeyDown() {}, selectBaseSolid() {},
  });
  const cube = fakeElement('button');
  const tetrahedron = fakeElement('button');
  const star = fakeElement('button');
  configure(cube, 'cube');
  configure(tetrahedron, 'tetrahedron');
  configure(star, 'cube_hankin');
  assert.equal(cube.getAttribute('role'), 'radio');
  assert.equal(cube.getAttribute('aria-checked'), 'true');
  assert.equal(tetrahedron.getAttribute('aria-checked'), 'false');
  assert.equal(star.getAttribute('role'), null);
  assert.equal(star.getAttribute('aria-checked'), null);
  assert.equal(star.tabIndex, 0);
  state.base = 'tetrahedron';
  handler('highlightBaseSolid', {
    state, document: { querySelectorAll(selector) {
      assert.equal(selector, '.thumb-btn[role="radio"]');
      return [cube, tetrahedron];
    } },
  })();
  assert.equal(cube.getAttribute('aria-checked'), 'false');
  assert.equal(tetrahedron.getAttribute('aria-checked'), 'true');
  assert.equal(star.getAttribute('aria-checked'), null);
});

test('status messages retain failures and clear confirmations', () => {
  const status = { innerText: '' };
  const timers = new Map();
  let nextTimer = 0;
  const showGateMsg = handler('showGateMsg', {
    gateMsgTimer: null,
    document: { getElementById: id => id === 'opGateMsg' ? status : null },
    setTimeout: (callback, delay) => {
      assert.equal(delay, 3000);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: id => timers.delete(id),
  });

  showGateMsg('moved op', { persist: false });
  assert.equal(timers.size, 1);
  showGateMsg('import rejected: long failure reason');
  assert.equal(timers.size, 0);
  assert.equal(status.innerText, 'import rejected: long failure reason');

  showGateMsg('imported 1 solid', { persist: false });
  assert.equal(timers.size, 1);
  timers.values().next().value();
  assert.equal(status.innerText, '');
});

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
    savedChainShapeError: () => null,
    registrySolidNames: new Set(['star']),
    islamicStarPatterns: ['star'],
    meshOpsWasm: { getRecipe() { throw error; } },
    engineTrapped: (caught) => { traps.push(caught); return halted; },
    showCopyFailure: (button, message) => failures.push(message),
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
    const rows = () => state.ops.map((op, i) => ({
      querySelector: (selector) => {
        assert.equal(selector, '.remove-op-btn');
        return { focus: () => { focused = i; } };
      },
    }));
    const removeOp = handler('removeOp', {
      state, opsRevision: 1, queueCommit: (fn) => { pending = fn(); },
      chainIsValid: async () => ({ ok: true }), setOps: (ops) => { state.ops = ops; },
      renderOps() {}, update() {},
      document: {
        getElementById: (id) => {
          assert.equal(id, 'opsList');
          return { children: rows() };
        },
        querySelector: (selector) => {
          assert.equal(selector, '#addOpGrid [data-op]:not(:disabled)');
          return { focus: () => { focused = 'add'; } };
        },
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
    document: { getElementById: (id) => {
      if (id === 'saveBtn') return { focus: () => { focused = 'save'; } };
      assert.equal(id, 'savedList');
      return { children: savedSolids.map((item, i) => ({
        querySelector: (selector) => {
          assert.equal(selector, '.del-btn');
          return { focus: () => { focused = i; } };
        },
      })) };
    } },
  });
  deleteSolid(2);
  assert.equal(focused, 0);
  deleteSolid(0);
  assert.equal(focused, 0);
  deleteSolid(0);
  assert.equal(focused, 'save');
});

for (const op of ['ambo', 'meta']) test(`${op} gate preserves authored descriptions`, async () => {
  const authored = op === 'meta' ? 'tip-meta' : '';
  const reason = 'Would exceed an engine mesh limit from the shared description';
  const attributes = new Map(authored ? [['aria-describedby', authored]] : []);
  const button = {
    dataset: { op }, disabled: false,
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: (key) => attributes.get(key),
    removeAttribute: (key) => attributes.delete(key),
  };
  const messages = [];
  const added = [];
  const context = {
    wasmModule: {}, state: { base: 'cube', ops: [] }, currentMesh: {}, currentMeshIsCurrent: true,
    document: {
      querySelectorAll: () => [button],
      getElementById: (id) => { assert.equal(id, 'opBlockedReason'); return { textContent: reason }; },
    },
    opGate: { refresh: async () => ({ blocked: new Set([op]), complete: true }) },
    showGateMsg: (message) => messages.push(message), addOp: (op) => added.push(op),
  };
  await handler('refreshOpGating', context)();
  assert.equal(button.disabled, false);
  assert.equal(attributes.get('aria-disabled'), 'true');
  assert.equal(button.title, reason);
  assert.equal(attributes.get('aria-describedby'), [authored, 'opBlockedReason'].filter(Boolean).join(' '));
  handler('activateAddOp', context)({ target: { closest: () => button } });
  assert.equal(added.length, 0);
  assert.match(messages[0], /exceed an engine mesh limit/);
  handler('openOpGate', context)('validator unavailable');
  assert.equal(attributes.has('aria-disabled'), false);
  assert.equal(attributes.get('aria-describedby') ?? '', authored);
  handler('activateAddOp', context)({ target: { closest: () => button } });
  assert.deepEqual(added, [op]);
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

test('persistence failure is reported and clears after a later successful write', () => {
  const status = { textContent: '' };
  let failing = true;
  const persist = handler('persistSavedSolids', { savedSolids: [], savedStorage: { rejected: [], notice: '' }, SAVED_SOLIDS_KEY: 'saved',
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
    state, opsRevision: 1, OP_DEFS: {}, structuredClone, parameterEdits: new Map(),
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

test('an accepted topology tick keeps the focused input and publishes after validation', async () => {
  let queued;
  let resolveCheck;
  const state = { base: 'cube', ops: [{ op: 'truncate', params: { t: 0.4 } }] };
  const painted = [];
  const context = {
    state, opsRevision: 1, OP_DEFS: {}, structuredClone, parameterEdits: new Map(),
    document: { getElementById: () => ({ children: [] }) },
    opTopologyKey: (entry) => entry.params.t === 0.5,
    scheduleUpdate: { cancel() {} }, queueCommit: (fn) => { queued = fn; },
    chainIsValid: async (base, ops) => {
      assert.equal(ops[0].params.t, 0.5);
      return new Promise((resolve) => { resolveCheck = resolve; });
    },
    showGateMsg() {}, renderOps() { assert.fail('accepted parameter edits must retain the control nodes'); }, update: () => painted.push(state.ops[0].params.t),
  };
  handler('updateOpParam', context)(0, 't', '0.5', 1);
  const pending = queued();
  context.update();
  assert.deepEqual(painted, [0.4]);
  resolveCheck({ ok: true });
  await pending;
  assert.deepEqual(painted, [0.4, 0.5]);
});

test('a topology commit cannot overwrite an edit returning to the same value', async () => {
  let queued;
  let resolveCheck;
  const state = { base: 'cube', ops: [{ op: 'truncate', params: { t: 0.49 } }] };
  const context = {
    state, opsRevision: 1, OP_DEFS: {}, structuredClone, parameterEdits: new Map(),
    document: { getElementById: () => ({ children: [] }) },
    opTopologyKey: (entry) => entry.params.t === 0.5,
    scheduleUpdate: Object.assign(() => {}, { cancel() {} }),
    queueCommit: (fn) => { queued = fn; },
    chainIsValid: () => new Promise((resolve) => { resolveCheck = resolve; }),
    showGateMsg() {}, renderOps() {}, update() {},
  };
  const edit = handler('updateOpParam', context);
  edit(0, 't', '0.5', 1);
  const pending = queued();
  edit(0, 't', '0.49', 1);
  resolveCheck({ ok: true });
  await pending;
  assert.equal(state.ops[0].params.t, 0.49);
});

test('saved solids discard non-object entries', () => {
  const load = handler('loadSavedSolids', { SAVED_SOLIDS_KEY: 'saved',
    savedSolidExportError,
    localStorage: { getItem: () => '[null, 1, false, "bad", [], {"base":"cube","ops":[]}, {"base":"cube","ops":[{"op":"dual","params":{}}]}]' },
  });
  const result = load();
  assert.equal(JSON.stringify(result.entries), '[{"base":"cube","ops":[{"op":"dual","params":{}}]}]');
  assert.equal(result.rejected.length, 6);
  assert.match(result.notice, /6 saved solids could not be loaded: not a saved-solid object/);
});

test('a failed rebuild invalidates cached mesh metadata and prevents saving', () => {
  const messages = [];
  const previous = { vertices: [], faces: [] };
  const context = {
    currentMesh: previous, currentMeshIsCurrent: true,
    wasmModule: {}, meshOpsWasm: {}, state: { base: 'cube', ops: [{ op: 'dual' }] },
    buildContext: () => ({}), buildChainMesh: () => null,
    showGateMsg: message => messages.push(message),
  };
  handler('update', context)();
  assert.equal(context.currentMeshIsCurrent, false);
  assert.equal(context.currentMesh, previous);
  handler('saveSolid', context)();
  assert.match(messages[0], /no successful preview/);
});

test('saved code export refuses off-grid parameters before generating code', async () => {
  const failures = [];
  const copyCode = handler('copyCode', {
    savedSolids: [{ base: 'cube', ops: [{ op: 'truncate', params: { t: 0.334 } }] }],
    savedChainShapeError,
    showCopyFailure: (button, message) => failures.push(message),
    registrySolidNames: new Set(['cube']),
    generateRecipeCpp: () => assert.fail('generated before the shape gate'),
  });
  await copyCode(0, 'recipe_cpp', {});
  assert.equal(failures.length, 1);
  assert.match(failures[0], /export failed:.*grid/);
});

test('a refused topology tick restores focus to the same parameter input', async () => {
  for (const type of ['range', 'number']) {
    let queued;
    const state = {base: 'cube', ops: [{op: 'truncate', params: {t: 0.4}}]};
    const oldInput = fakeElement('input');
    oldInput.type = type;
    const oldRow = fakeElement('div');
    oldRow.dataset.key = 't';
    oldRow.appendChild(oldInput);
    oldRow.querySelector = (selector) => selector === `input[type="${type}"]` ? oldInput : null;
    const newInput = {focus() { focused = true; }};
    let focused = false;
    let rows = [oldRow];
    const context = {state, opsRevision: 1, OP_DEFS: {}, structuredClone, parameterEdits: new Map(),
      document: {activeElement: oldInput, getElementById: () => ({children: [{querySelectorAll: () => rows}]})},
      opTopologyKey: (op) => op.params.t === 0.5, formatParamValue: String, syncSweepWarning() {},
      scheduleUpdate: {cancel() {}}, queueCommit: (fn) => { queued = fn; },
      chainIsValid: async () => ({ok: false, message: 'refused'}), showGateMsg() {}, update() {},
      renderOps() { rows = [{dataset: {key: 't'}, querySelector(selector) { assert.equal(selector, `input[type="${type}"]`); return newInput; }}]; }};
    handler('updateOpParam', context)(0, 't', '0.5', 1);
    await queued();
    assert.ok(focused, type);
    assert.equal(state.ops[0].params.t, 0.4);
  }
});


test('a row drag retains its grab offset across scrolling and clears on cancellation', () => {
  let drag;
  const context = { wasmModule: {}, DRAG_SLOP_PX: 4,
    createPointerDrag: (options) => { drag = options; },
    dropSlotGen: 0, dropSlotChecks: new Map(),
    getDragTargetIndex: () => 2, checkDropSlot: async () => {},
    reorderPreviewShift: () => -1, console };
  const grip = fakeElement('div');
  const row = fakeElement('div');
  const neighbor = fakeElement('div');
  row.offsetHeight = 30;
  const rect = { top: 120, left: 20 };
  const list = { children: [row, neighbor], scrollTop: 0, scrollLeft: 0,
    getBoundingClientRect: () => rect };
  handler('wireRowDrag', context)(grip, 0, row, list, 1);
  drag.onStart({ clientX: 30, clientY: 160 });
  drag.onMove({ clientX: 35, clientY: 170 });
  assert.equal(row.style.transform, 'translate(5px, 10px)');
  assert.equal(neighbor.style.transform, 'translateY(-34px)');

  rect.top = 100;
  rect.left = 18;
  list.scrollTop = 7;
  list.scrollLeft = 2;
  context.dropSlotChecks.set(2, { ok: false });
  drag.onMove({ clientX: 40, clientY: 190 });
  assert.equal(row.style.transform, 'translate(14px, 57px)');
  assert.equal(neighbor.style.transform, '');
  assert.equal(grip.classList.contains('drop-blocked'), true);

  drag.onCancel();
  assert.equal(row.style.transform, '');
  assert.equal(row.classList.contains('dragging'), false);
  assert.equal(grip.classList.contains('drop-blocked'), false);
  context.wasmModule = null;
  assert.equal(drag.onStart({ clientX: 30, clientY: 160 }), false);
});

test('a row drag cannot rebuild controls after the engine stands down', () => {
  let drag;
  const context = { wasmModule: {}, DRAG_SLOP_PX: 4,
    createPointerDrag: (options) => { drag = options; },
    dropSlotGen: 0, dropSlotChecks: new Map(),
    getDragTargetIndex: () => 0, checkDropSlot: async () => ({ok: true}),
    reorderPreviewShift: () => 0, console,
    renderOps: () => assert.fail('rebuilt controls without an engine') };
  const grip = fakeElement('div');
  const row = fakeElement('div');
  row.offsetHeight = 10;
  const list = {children: [row], scrollTop: 0, scrollLeft: 0,
    getBoundingClientRect: () => ({top: 0, left: 0})};
  handler('wireRowDrag', context)(grip, 0, row, list, 1);
  drag.onStart({clientY: 0});
  drag.onMove({clientY: 10});
  context.wasmModule = null;
  drag.onEnd({clientY: 10});
  assert.equal(row.classList.contains('dragging'), false);
  drag.onStart({clientY: 0});
  drag.onMove({clientY: 10});
  assert.equal(row.classList.contains('dragging'), false);
  drag.onEnd({clientY: 10});
  assert.equal(row.classList.contains('dragging'), false);
});

test('saved-solid imports name invalid entries and the first refusal reason', () => {
  for (const [entries, reason] of [[ [null, {}], /not a saved-solid object/ ],
    [ [{base: 'cube', ops: [{op: 'truncate', params: {t: 50}}]}], /out-of-range/ ]]) {
    const messages = [];
    handler('importSavedSolids', { savedSolids: [], SAVED_SOLIDS_MAX: 100,
      savedSolidExportError, showGateMsg: (message) => messages.push(message),
    })(JSON.stringify(entries));
    assert.match(messages[0], /invalid entries/);
    assert.match(messages[0], reason);
    assert.doesNotMatch(messages[0], /op table does not recognize/);
  }
});


test('saved-solid imports reject bare seeds while accepting an exportable recipe', () => {
  const savedSolids = [];
  const messages = [];
  const persistence = [];
  const importSavedSolids = handler('importSavedSolids', { savedSolids, SAVED_SOLIDS_MAX: 100,
    savedSolidExportError, importedSavedSolid: entry => entry,
    persistSavedSolids() {}, renderSavedList() {},
    showGateMsg: (message, options) => { messages.push(message); persistence.push(options.persist); },
  });
  importSavedSolids(JSON.stringify([{ base: 'cube', ops: [] },
    { base: 'cube', ops: [{ op: 'dual', params: {} }] }]));
  assert.equal(savedSolids.length, 1);
  assert.equal(JSON.stringify(savedSolids[0].ops), '[{"op":"dual","params":{}}]');
  assert.match(messages[0], /imported 1 solid.*op chain is empty/);
  assert.deepEqual(persistence, [true]);
  importSavedSolids(JSON.stringify([{ base: 'cube', ops: [{ op: 'dual', params: {} }] }]));
  assert.deepEqual(persistence, [true, false]);
});


test('stale saved cards are reported and backed up before the live list is overwritten', () => {
  const valid = {base: 'cube', ops: [{op: 'dual', params: {}}]};
  const stale = {base: 'cube', ops: [{op: 'truncate', params: {t: 50}}]};
  const storage = new Map([['saved', JSON.stringify([valid, stale])], ['rejected', '[{"older":true}]']]);
  const writes = [];
  let refusingBackup = true;
  const localStorage = {getItem: key => storage.get(key), setItem(key, value) {
    writes.push(key);
    if (key === 'rejected' && refusingBackup) throw new Error('quota');
    storage.set(key, value);
  }};
  const savedStorage = handler('loadSavedSolids', {localStorage, SAVED_SOLIDS_KEY: 'saved', savedSolidExportError})();
  assert.equal(savedStorage.entries.length, 1);
  assert.equal(savedStorage.rejected.length, 1);
  assert.match(savedStorage.notice, /1 saved solids.*out-of-range/);
  const status = {textContent: savedStorage.notice};
  const persist = handler('persistSavedSolids', {savedStorage, savedSolids: savedStorage.entries,
    localStorage, SAVED_SOLIDS_KEY: 'saved', REJECTED_SOLIDS_KEY: 'rejected',
    document: {getElementById: () => status}, console: {warn() {}}});
  persist();
  assert.deepEqual(JSON.parse(storage.get('saved')), [valid, stale]);
  assert.deepEqual(writes, ['rejected']);
  assert.match(status.textContent, /Changes apply to this session only/);
  assert.equal(savedStorage.rejected.length, 1);
  refusingBackup = false;
  persist();
  assert.deepEqual(writes, ['rejected', 'rejected', 'saved']);
  assert.deepEqual(JSON.parse(storage.get('saved')), [valid]);
  assert.deepEqual(JSON.parse(storage.get('rejected')), [{older: true}, stale]);
  assert.equal(savedStorage.rejected.length, 0);
  assert.equal(status.textContent, savedStorage.notice);
  persist();
  assert.deepEqual(JSON.parse(storage.get('rejected')), [{older: true}, stale], 'later writes do not duplicate the backup');
});

test('a fully valid saved list needs no recovery notice or rejected backup', () => {
  const localStorage = {getItem: () => '[{"base":"cube","ops":[{"op":"dual","params":{}}]}]'};
  const loaded = handler('loadSavedSolids', {localStorage, SAVED_SOLIDS_KEY: 'saved', savedSolidExportError})();
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.rejected.length, 0);
  assert.equal(loaded.notice, '');
});

test('two adds queued at one below the op cap commit only the first', async () => {
  const state = { base: 'cube', ops: Array.from({ length: 254 }, () => ({ op: 'dual', params: {} })) };
  const queued = [];
  const messages = [];
  let validations = 0;
  const addOp = handler('addOp', {
    state, MAX_RECIPE_STEPS: 255, currentMeshIsCurrent: false, currentMesh: null,
    seedOpParams: () => ({}), queueCommit: (fn) => queued.push(fn),
    chainIsValid: async () => { validations++; return { ok: true }; },
    setOps: (ops) => { state.ops = ops; }, renderOps() {}, update() {},
    showGateMsg: (message) => messages.push(message),
  });
  addOp('dual');
  addOp('dual');
  assert.equal(queued.length, 2);
  for (const task of queued) await task();
  assert.equal(state.ops.length, 255);
  assert.equal(validations, 1);
  assert.deepEqual(messages, ['rejected: a chain carries at most 255 ops']);
  assert.equal(savedChainShapeError(state.base, state.ops), null);
});

test('saving refuses a chain that restore would refuse', () => {
  const messages = [];
  const savedSolids = [];
  const ops = Array.from({ length: 256 }, () => ({ op: 'dual', params: {} }));
  handler('saveSolid', {
    currentMesh: { vertices: [], faces: [] }, currentMeshIsCurrent: true,
    state: { base: 'cube', ops }, savedSolids, savedChainShapeError,
    captureSavedSolidThumbnail: () => assert.fail('captured an unrestorable card'),
    showGateMsg: (message) => messages.push(message),
  })();
  assert.equal(savedSolids.length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0],
    `rejected: the loaded or edited chain cannot be saved: ${savedChainShapeError('cube', ops)}; `
    + "pattern values may fall outside the editor's save grid");
});

function baseSelectContext(overrides = {}) {
  const calls = [];
  const queued = [];
  const context = {
    state: { base: 'cube', ops: [{ op: 'dual', params: {} }] },
    islamicStarPatterns: ['star'],
    meshOpsWasm: { getRecipe: () => ({ seed: 'dodecahedron', ops: [{ op: 'hankin', param: 1, twist: 0 }] }) },
    opsFromRecipe: (steps) => steps.map(({ op }) => ({ op, params: { angle: 57 } })),
    formatSolidName: (name) => name,
    queueCommit: (fn) => queued.push(fn),
    chainIsValid: async () => ({ ok: true }),
    showGateMsg: (message) => calls.push(['msg', message]),
    setOps: (ops) => { context.state.ops = ops; calls.push(['setOps']); },
    renderOps: () => calls.push(['renderOps']),
    update: () => calls.push(['update']),
    renderBaseSolid() {}, highlightBaseSolid() {},
    document: { activeElement: null, querySelector: () => null },
    ...overrides,
  };
  return { context, calls, run: async () => { for (const task of queued.splice(0)) await task(); } };
}

test('a simple base keeps the op stack and clears an earlier rejection', async () => {
  const { context, calls, run } = baseSelectContext();
  const select = handler('selectBaseSolid', context);
  context.chainIsValid = async () => ({ ok: false, message: 'overflow' });
  select('tetrahedron', {});
  await run();
  assert.equal(context.state.base, 'cube');
  assert.match(calls.at(-1)[1], /^rejected: the op stack fails on this solid/);

  context.chainIsValid = async () => ({ ok: true });
  select('octahedron', {});
  await run();
  assert.equal(context.state.base, 'octahedron');
  assert.deepEqual(context.state.ops, [{ op: 'dual', params: {} }]);
  assert.ok(calls.some(([kind, message]) => kind === 'msg' && message === ''));
  assert.ok(!calls.some(([kind]) => kind === 'setOps'));
});

test('a star pattern replaces the base and op stack with its authored chain', async () => {
  const { context, calls, run } = baseSelectContext();
  const validated = [];
  context.chainIsValid = async (base, ops) => { validated.push([base, ops]); return { ok: true }; };
  handler('selectBaseSolid', context)('star', {});
  await run();
  assert.equal(context.state.base, 'dodecahedron');
  assert.deepEqual(context.state.ops, [{ op: 'hankin', params: { angle: 57 } }]);
  assert.deepEqual(validated, [['dodecahedron', context.state.ops]]);
  assert.ok(calls.some(([kind]) => kind === 'renderOps'));
});

test('a star pattern without a recipe leaves the chain alone', async () => {
  const { context, calls, run } = baseSelectContext({ meshOpsWasm: { getRecipe: () => null } });
  handler('selectBaseSolid', context)('star', {});
  await run();
  assert.equal(context.state.base, 'cube');
  assert.match(calls.at(-1)[1], /no authored chain/);
});

test('base-solid arrows move focus without replacing the authored chain', () => {
  const choices = ['cube', 'tetrahedron', 'star'].map(solid => ({
    dataset: { solid }, tabIndex: solid === 'cube' ? 0 : -1,
    focus() { focused = solid; }, click: () => assert.fail('arrow activated a solid'),
  }));
  let focused;
  let prevented = 0;
  const keydown = handler('handleBaseSolidKeyDown', {
    document: { querySelectorAll: () => choices },
  });
  keydown({ key: 'ArrowLeft', currentTarget: choices[0], preventDefault() { prevented++; } });
  assert.equal(focused, 'star');
  assert.deepEqual(choices.map(choice => choice.tabIndex), [-1, -1, 0]);
  keydown({ key: 'ArrowRight', currentTarget: choices[2], preventDefault() { prevented++; } });
  assert.equal(focused, 'cube');
  assert.deepEqual(choices.map(choice => choice.tabIndex), [0, -1, -1]);
  keydown({ key: 'Enter', currentTarget: choices[0], preventDefault: assert.fail });
  assert.equal(prevented, 2);
});
