import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import createModule from '../generated/holosphere_wasm.js';
import {callWorkbenchBinding} from '../src/engine/workbench_bindings.js';
import {readFileSync} from 'node:fs';
import {bakedTopologyFields, compileShaderDocument, documentModulationBinding, fixedDerivedBinding} from '../generated/shader/shader_workbench.mjs';
import {documentFromChainSnapshot, scratchChainDocument} from '../src/workbench/shader/chain_document_store.js';
import {applyChainDocument} from '../src/workbench/shader/chain_apply.js';
import {applyFixedShaderDocument} from '../src/workbench/shader/shader_documents.js';
import {currentChainSnapshot} from './helpers/chain_snapshot.js';
import {CHAIN_SNAPSHOT_SCHEMA_VERSION} from '../src/workbench/shader/shader_deeplink.js';

const catalog = JSON.parse(readFileSync(new URL('../generated/shader/engine_catalog.json', import.meta.url), 'utf8'));

const module = await createModule({print: () => {}});
const engine = new module.HolosphereEngine();
const capture = () => callWorkbenchBinding(engine, 'getSnapshot', []);
const restore = (snapshot) => callWorkbenchBinding(engine, 'restoreSnapshot', [snapshot]);
after(() => engine.delete());

test('the shared current snapshot fixture restores on the compiled engine', () => {
  engine.setEffect('ShaderChain');
  assert.equal(capture().schemaVersion, CHAIN_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(restore(currentChainSnapshot()), module.ChainSnapshotRestoreResult.APPLIED);
});

test('every catalog document preset applies to its compiled engine', () => {
  const patterns = new URL('../generated/shader/patterns/', import.meta.url);
  const patternsCatalog = JSON.parse(readFileSync(new URL('catalog.json', patterns), 'utf8'));
  const sources = patternsCatalog.source_documents;
  let applied = 0;
  for (const [effectId, filename] of Object.entries(sources)) {
    const compiled = compileShaderDocument(readFileSync(new URL(filename, patterns), 'utf8'), {catalog});
    assert.equal(compiled.status, 'VALID', effectId);
    assert.equal(engine.setEffect(effectId), module.EffectSetResult.INSTALLED, effectId);
    const referenceIds = engine.getPresetIds();
    for (const preset of compiled.document.preset_bank.presets) {
      assert.equal(applyFixedShaderDocument(engine, module, compiled, preset.preset_id,
        referenceIds, bakedTopologyFields(catalog), fixedDerivedBinding, catalog), null,
      `${effectId}/${preset.preset_id}`);
      applied += 1;
    }
  }
  assert.deepEqual(Object.keys(sources).sort(),
    patternsCatalog.product_group.children.map(({effect_id}) => effect_id).sort());
  assert.ok(applied > 0);
});

test('Ash Cloud applies its real compiled controls and validates unregistered readonly fields', () => {
  const compiled = compileShaderDocument(readFileSync(new URL('../generated/shader/patterns/ash_cloud.shader.json', import.meta.url), 'utf8'), {catalog});
  engine.setEffect('ash-cloud');
  const preset = compiled.document.preset_bank.presets[0];
  const referenceIds = engine.getPresetIds();
  const apply = () => applyFixedShaderDocument(engine, module, compiled, preset.preset_id,
    referenceIds, bakedTopologyFields(catalog), fixedDerivedBinding, catalog);
  assert.equal(apply(), null);
  const id = 'modulate.grid-axis-b-x';
  const binding = documentModulationBinding(compiled.document.descriptor, id);
  assert.ok(binding);
  assert.equal(engine.getParameterDefinitions().some(({name}) => name.endsWith('grid-axis-b-x')), false);
  const definition = engine.getDocumentParameterDefinitions().find(entry =>
    entry.resource === binding.resource && entry.id === binding.id);
  assert.equal(definition.readonly, true);
  assert.equal(Math.fround(preset.values[id]), Math.fround(definition.value));
  preset.values[id] += 1;
  assert.match(apply(), /grid-axis-b-x.*must match the fixed build/);
});

function installModulatedChain() {
  engine.setEffect('ShaderChain');
  const chain = callWorkbenchBinding(engine, 'getProgram', []);
  assert.equal(callWorkbenchBinding(engine, 'setShaderChain', [[...chain,
    {instance: 'modulation', operator: 'color.modulate.v1'}]]).code, 'APPLIED');
}

/**
 * Evolves a wandering ShaderChain, snapshots it, and records the frames that follow uninterrupted.
 * @param {boolean} temporal Column-time sampling for every draw.
 * @returns {{snapshot: object, frames: Uint16Array[]}} The snapshot and the next five frames.
 */
function evolve(temporal) {
  engine.setResolution(96, 20);
  engine.setTemporalSampling(temporal);
  const install = () => {
    installModulatedChain();
    assert.equal(callWorkbenchBinding(engine, 'setShaderChainParameters', [[
      {name: 'camera.wander', value: 0.1}, {name: 'project.projection-wander', value: 0.2},
      {name: 'sample.speed', value: 0.004}, {name: 'modulation.pattern-speed', value: 0.0003},
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
  installModulatedChain();
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
  installModulatedChain();
  assert.equal(callWorkbenchBinding(engine, 'setShaderChainParameters', [[
    {name: 'camera.wander', value: 0.1}, {name: 'sample.speed', value: 0.004},
    {name: 'modulation.modulation-amount', value: 0.5},
  ]]), module.ParamSetResult.APPLIED);
  engine.setAnimationsPaused(false);
  for (let frame = 0; frame < 64; frame += 1) engine.drawFrame();
  const advanced = capture();
  installModulatedChain();
  engine.setAnimationsPaused(true);
  const previous = capture();
  for (const section of ['parameters', 'modulation', 'runtime', 'paletteBank'])
    assert.notDeepEqual(advanced[section], previous[section], `${section} differ, so a partial apply is observable`);
  const result = module.ChainSnapshotRestoreResult;
  const changes = [
    [(value) => { value.schemaVersion = 1; }, result.UNSUPPORTED_VERSION],
    [(value) => { value.chain = []; }, result.INVALID_LENGTH],
    [(value) => { value.parameters[0].value = NaN; }, result.INVALID_VALUE],
    [(value) => { value.parameters.push({...value.parameters[0]}); }, result.INVALID_VALUE],
    [(value) => { delete value.modulation; }, result.INVALID_VALUE],
    [(value) => { value.modulation[0].recipe.source = 5; }, result.INVALID_VALUE],
    [(value) => { value.modulation[0].recipe.mechanic.amount = NaN; }, result.INVALID_VALUE],
    [(value) => { value.modulation[0].recipe.mechanic.amount = 10; }, result.INVALID_VALUE],
    [(value) => { value.modulation[0].recipe.noise.speed = 100; }, result.INVALID_VALUE],
    [(value) => { value.modulation[0].recipe.sine.offset = 1000; }, result.INVALID_VALUE],
    [(value) => { value.modulation[0].recipe.sine.axis = [100, 0, 0]; }, result.INVALID_VALUE],
    [(value) => { value.modulation[0].recipe.noise.variant = 7; }, result.INVALID_VALUE],
    [(value) => { value.modulation = Array(catalog.budgets.max_chain_ops + 1).fill(value.modulation[0]); }, result.INVALID_LENGTH],
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
  const accepted = structuredClone(previous);
  accepted.modulation[0].recipe.mechanic.amount = 3;
  assert.equal(restore(accepted), result.APPLIED);
  assert.equal(capture().modulation[0].recipe.mechanic.amount, 3);
});

test('snapshot restore requires the current version and preserves the running chain on refusal', () => {
  installModulatedChain();
  const current = capture();
  assert.equal(restore(current), module.ChainSnapshotRestoreResult.APPLIED);
  for (const schemaVersion of [current.schemaVersion - 1, current.schemaVersion + 1]) {
    assert.equal(restore({...current, schemaVersion}), module.ChainSnapshotRestoreResult.UNSUPPORTED_VERSION);
    assert.deepEqual(capture(), current);
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

test('real modulation snapshots import every authored preset field', () => {
  const document = scratchChainDocument(catalog, [
    {label: 'project', operator: 'project.stereographic.v2'},
    {label: 'sample', operator: 'sample.grid.v4'},
    {label: 'colorize', operator: 'colorize.generated-palette.v4'},
    {label: 'ink', operator: 'color.modulate.v1'},
  ]);
  const preset = document.preset_bank.presets[0];
  Object.assign(preset.values, {
    'ink.modulation-source': 'sphere-smooth-grid',
    'ink.modulation-evaluation': 'direct',
    'ink.modulation-mechanic': 'opacity',
    'ink.modulation-amount': 0.375,
    'ink.pattern-noise-basis': 'ridged3',
    'ink.pattern-noise-variant': 'octave-contour',
    'ink.pattern-scale': 2.5,
    'ink.pattern-speed': -0.000125,
    'ink.pattern-contrast': 1.25,
    'ink.grid-frequency': 3.5,
    'ink.grid-offset': 0.25,
    'ink.grid-speed': -0.03125,
  });
  const compiled = compileShaderDocument(JSON.stringify(document), {catalog});
  assert.equal(compiled.status, 'VALID', JSON.stringify(compiled.diagnostics));
  engine.setEffect('ShaderChain');
  assert.equal(applyChainDocument({engine, module, compiled, presetId: preset.preset_id,
    syncEffectGui() {}, invalidate() {}}), null);
  const snapshot = capture();
  assert.ok(snapshot.modulation.some(({instance}) => instance === 'ink'));
  const imported = documentFromChainSnapshot(snapshot, catalog);
  const checked = compileShaderDocument(JSON.stringify(imported), {catalog});
  assert.equal(checked.status, 'VALID', JSON.stringify(checked.diagnostics));
  const actual = checked.document.preset_bank.presets[0].values;
  for (const [name, value] of Object.entries(preset.values)) {
    assert.equal(typeof actual[name] === 'number' ? Math.fround(actual[name]) : actual[name],
      typeof value === 'number' ? Math.fround(value) : value, name);
  }
});
