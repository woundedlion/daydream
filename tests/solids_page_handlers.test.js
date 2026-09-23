import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'espree';

const source = readFileSync(new URL('../tools/solids_page.js', import.meta.url), 'utf8');
const parsed = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });
function handler(name, context) {
  let declaration;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) declaration = node;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(parsed);
  assert.ok(declaration, `missing handler ${name}`);
  return runInNewContext(`(${source.slice(...declaration.range)})`, context);
}

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
