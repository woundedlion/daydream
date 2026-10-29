import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import createModule from '../generated/holosphere_wasm.js';
import {callWorkbenchBinding} from '../src/engine/workbench_bindings.js';

const module = await createModule({print: () => {}});
const engine = new module.HolosphereEngine();
const capture = () => callWorkbenchBinding(engine, 'getSnapshot', []);
const restore = (snapshot) => callWorkbenchBinding(engine, 'restoreSnapshot', [snapshot]);
after(() => engine.delete());

/**
 * Evolves a wandering ShaderChain, snapshots it, and records the frames that follow uninterrupted.
 * @param {boolean} temporal Column-time sampling for every draw.
 * @returns {{snapshot: object, frames: Uint16Array[]}} The snapshot and the next five frames.
 */
function evolve(temporal) {
  engine.setResolution(96, 20);
  engine.setTemporalSampling(temporal);
  const install = () => {
    engine.setEffect('ShaderChain');
    assert.equal(callWorkbenchBinding(engine, 'setShaderChainParameters', [[
      {name: 'camera.wander', value: 0.1}, {name: 'project.projection-wander', value: 0.2},
      {name: 'sample.speed', value: 0.004}, {name: 'colorize.pattern-speed', value: 0.003},
    ]]), module.ParamSetResult.APPLIED);
    engine.setAnimationsPaused(false);
  };
  install();
  for (let frame = 0; frame < 713; frame += 1) engine.drawFrame();
  const snapshot = capture();
  assert.ok(snapshot.runtime.find((entry) => entry.instance === 'camera').state.walkTime > 0);
  assert.ok(snapshot.paletteBank.cycles.some((cycle) => cycle.frame > 0));
  const frames = [];
  for (let frame = 0; frame < 5; frame += 1) { engine.drawFrame(); frames.push(Uint16Array.from(engine.getPixels())); }
  assert.ok(frames.some((pixels) => pixels.some((value) => value !== 0)), 'reference frames are not black');
  install();
  engine.drawFrame();
  assert.notDeepEqual(Uint16Array.from(engine.getPixels()), frames[0],
    'a fresh chain with the same parameters renders differently, so parity needs the restored state');
  return {snapshot, frames};
}

/** Replaces the current effect and restores `snapshot` into a fresh ShaderChain. */
function restoreFresh(snapshot) {
  engine.setEffect('ShaderChain');
  assert.equal(restore(snapshot), module.ChainSnapshotRestoreResult.APPLIED);
}

test('typed snapshots continue flat-sampled rendering exactly across effect replacement', (t) => {
  t.after(() => engine.setTemporalSampling(true));
  const {snapshot, frames} = evolve(false);
  restoreFresh(snapshot);
  for (const expected of frames) { engine.drawFrame(); assert.deepEqual(engine.getPixels(), expected); }
});

test('a restored snapshot draws its first temporal frame at the current endpoint, then continues exactly', (t) => {
  t.after(() => engine.setTemporalSampling(true));
  const {snapshot, frames} = evolve(true);
  engine.setTemporalSampling(false);
  restoreFresh(snapshot);
  engine.drawFrame();
  const endpoint = Uint16Array.from(engine.getPixels());
  assert.notDeepEqual(endpoint, frames[0], 'column history changes the uninterrupted first frame');
  engine.setTemporalSampling(true);
  restoreFresh(snapshot);
  engine.drawFrame();
  assert.deepEqual(engine.getPixels(), endpoint);
  for (const expected of frames.slice(1)) { engine.drawFrame(); assert.deepEqual(engine.getPixels(), expected); }
});

test('snapshot validation refuses malformed state transactionally', () => {
  engine.setEffect('ShaderChain');
  assert.equal(callWorkbenchBinding(engine, 'setShaderChainParameters', [[
    {name: 'camera.wander', value: 0.1}, {name: 'sample.speed', value: 0.004},
  ]]), module.ParamSetResult.APPLIED);
  engine.setAnimationsPaused(false);
  for (let frame = 0; frame < 64; frame += 1) engine.drawFrame();
  const advanced = capture();
  engine.setEffect('ShaderChain');
  engine.setAnimationsPaused(true);
  const previous = capture();
  for (const section of ['parameters', 'runtime', 'paletteBank'])
    assert.notDeepEqual(advanced[section], previous[section], `${section} differ, so a partial apply is observable`);
  const result = module.ChainSnapshotRestoreResult;
  const changes = [
    [(value) => { value.schemaVersion = 1; }, result.UNSUPPORTED_VERSION],
    [(value) => { value.chain = []; }, result.INVALID_LENGTH],
    [(value) => { value.parameters[0].value = NaN; }, result.INVALID_VALUE],
    [(value) => { value.parameters.push({...value.parameters[0]}); }, result.INVALID_VALUE],
    [(value) => { value.runtime.pop(); }, result.INVALID_VALUE],
    [(value) => { value.runtime[0].state.walkTime = -1; }, result.INVALID_VALUE],
    [(value) => { value.paletteBank.cycles[0].frame = -1; }, result.INVALID_VALUE],
  ];
  for (const [change, expected] of changes) {
    const candidate = structuredClone(advanced);
    change(candidate);
    assert.equal(restore(candidate), expected);
    assert.deepEqual(capture(), previous);
  }
});

test('snapshot capability handles reject stale effect and geometry instances', () => {
  engine.setEffect('ShaderChain');
  const bindings = engine.getShaderChainBindings();
  const snapshot = bindings.getSnapshot();
  engine.setDisplayCaps(3, 4);
  try {
    assert.equal(bindings.getSnapshot(), null);
    assert.equal(bindings.restoreSnapshot(snapshot), module.ChainSnapshotRestoreResult.NOT_SHADER_CHAIN);
  } finally {
    bindings.delete();
    engine.setDisplayCaps(0, 0);
  }
  engine.setEffect('Comets');
  assert.equal(engine.getShaderChainBindings(), null);
});

test('a retained snapshot handle safely rejects engine deletion', async () => {
  const isolated = await createModule({print: () => {}});
  const temporary = new isolated.HolosphereEngine();
  temporary.setEffect('ShaderChain');
  const bindings = temporary.getShaderChainBindings();
  const snapshot = bindings.getSnapshot();
  temporary.delete();
  assert.equal(bindings.isValid(), false);
  assert.equal(bindings.getSnapshot(), null);
  assert.equal(bindings.restoreSnapshot(snapshot), isolated.ChainSnapshotRestoreResult.NOT_SHADER_CHAIN);
  bindings.delete();
});

test('engine deletion from a snapshot accessor traps and marks the module unusable', async () => {
  const isolated = await createModule({print: () => {}, printErr: () => {}});
  const temporary = new isolated.HolosphereEngine();
  temporary.setEffect('ShaderChain');
  const bindings = temporary.getShaderChainBindings();
  const snapshot = bindings.getSnapshot();
  const parameters = snapshot.parameters;
  Object.defineProperty(snapshot, 'parameters', {
    enumerable: true, get() { temporary.delete(); return parameters; },
  });
  assert.throws(() => bindings.restoreSnapshot(snapshot), WebAssembly.RuntimeError);
  assert.equal(isolated.HS_MODULE_DEAD, true);
});

test('a payload getter cannot restore into the effect it replaced', () => {
  engine.setEffect('ShaderChain');
  const snapshot = capture();
  const parameters = snapshot.parameters;
  Object.defineProperty(snapshot, 'parameters', {
    enumerable: true, get() { engine.setEffect('Comets'); return parameters; },
  });
  assert.equal(restore(snapshot), module.ChainSnapshotRestoreResult.NOT_SHADER_CHAIN);
  assert.equal(engine.getShaderChainBindings(), null);
  assert.ok(engine.getPresetCount() > 0);
});

test('a throwing snapshot accessor leaves the current program usable', () => {
  engine.setEffect('ShaderChain');
  const previous = capture();
  const payload = structuredClone(previous);
  Object.defineProperty(payload, 'parameters', {
    enumerable: true, get() { throw new Error('broken snapshot accessor'); },
  });
  assert.equal(restore(payload), module.ChainSnapshotRestoreResult.INVALID_VALUE);
  assert.deepEqual(capture(), previous);
  assert.equal(restore(previous), module.ChainSnapshotRestoreResult.APPLIED);
});

test('chain handle deletion from a snapshot accessor traps and marks the module unusable', async () => {
  const isolated = await createModule({print: () => {}, printErr: () => {}});
  const temporary = new isolated.HolosphereEngine();
  temporary.setEffect('ShaderChain');
  const bindings = temporary.getShaderChainBindings();
  const snapshot = bindings.getSnapshot();
  const parameters = snapshot.parameters;
  Object.defineProperty(snapshot, 'parameters', {
    enumerable: true, get() { bindings.delete(); return parameters; },
  });
  assert.throws(() => bindings.restoreSnapshot(snapshot), WebAssembly.RuntimeError);
  assert.equal(isolated.HS_MODULE_DEAD, true);
});

test('a snapshot accessor may rebuild geometry without trapping internal handles', () => {
  engine.setEffect('ShaderChain');
  const bindings = engine.getShaderChainBindings();
  const snapshot = bindings.getSnapshot();
  const parameters = snapshot.parameters;
  Object.defineProperty(snapshot, 'parameters', {
    enumerable: true, get() { engine.setDisplayCaps(3, 4); return parameters; },
  });
  try {
    assert.equal(bindings.restoreSnapshot(snapshot), module.ChainSnapshotRestoreResult.NOT_SHADER_CHAIN);
  } finally {
    bindings.delete();
    engine.setDisplayCaps(0, 0);
  }
});
