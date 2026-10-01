import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import createModule from '../generated/holosphere_wasm.js';
import {callWorkbenchBinding} from '../src/engine/workbench_bindings.js';

const module = await createModule({print: () => {}});
const engine = new module.HolosphereEngine();
const capture = () => callWorkbenchBinding(engine, 'getShaderChainBindings', 'getSnapshot', []);
const restore = (snapshot) => callWorkbenchBinding(engine, 'getShaderChainBindings', 'restoreSnapshot', [snapshot]);
after(() => engine.delete());

test('typed snapshots preserve evolving walk, noise, source and palette state across effect replacement', () => {
  engine.setResolution(96, 20);
  engine.setEffect('ShaderChain');
  callWorkbenchBinding(engine, 'getShaderChainBindings', 'setShaderChainParameters', [[
    {name: 'camera.wander', value: 0.1}, {name: 'project.projection-wander', value: 0.2},
    {name: 'sample.speed', value: 0.004}, {name: 'colorize.hue-noise-speed', value: 0.003},
  ]]);
  engine.setAnimationsPaused(false);
  for (let frame = 0; frame < 713; frame += 1) engine.drawFrame();
  const snapshot = capture();
  assert.ok(snapshot.runtime.find((entry) => entry.instance === 'camera').state.walkTime > 0);
  assert.ok(snapshot.paletteBank.cycles.some((cycle) => cycle.frame > 0));
  const frames = [];
  for (let frame = 0; frame < 5; frame += 1) { engine.drawFrame(); frames.push(Uint16Array.from(engine.getPixels())); }
  engine.setEffect('ShaderChain');
  assert.equal(restore(snapshot), module.ChainSnapshotRestoreResult.APPLIED);
  for (const expected of frames) { engine.drawFrame(); assert.deepEqual(engine.getPixels(), expected); }
});

test('snapshot validation refuses malformed state transactionally', () => {
  engine.setEffect('ShaderChain');
  engine.setAnimationsPaused(true);
  const previous = capture();
  const changes = [
    (value) => { value.schemaVersion = 1; },
    (value) => { value.chain = []; },
    (value) => { value.parameters[0].value = NaN; },
    (value) => { value.parameters.push({...value.parameters[0]}); },
    (value) => { value.runtime.pop(); },
    (value) => { value.runtime[0].state.walkTime = -1; },
    (value) => { value.paletteBank.cycles[0].frame = -1; },
  ];
  for (const change of changes) {
    const candidate = structuredClone(previous);
    change(candidate);
    assert.notEqual(restore(candidate), module.ChainSnapshotRestoreResult.APPLIED);
    assert.deepEqual(capture(), previous);
  }
});

test('snapshot capability handles reject stale effect and geometry instances', () => {
  engine.setEffect('ShaderChain');
  const bindings = engine.getShaderChainBindings();
  const snapshot = bindings.getSnapshot();
  engine.setDisplayCaps(3, 4);
  assert.equal(bindings.getSnapshot(), null);
  assert.equal(bindings.restoreSnapshot(snapshot), module.ChainSnapshotRestoreResult.NOT_SHADER_CHAIN);
  bindings.delete();
  engine.setDisplayCaps(0, 0);
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
  assert.notEqual(restore(snapshot), module.ChainSnapshotRestoreResult.APPLIED);
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
