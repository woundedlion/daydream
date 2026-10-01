import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import createModule from '../generated/holosphere_wasm.js';
import {convertLegacyShaderSnapshot} from '../src/effects/legacy_shader_snapshot.js';
import {callWorkbenchBinding} from '../src/engine/workbench_bindings.js';

const module = await createModule({print: () => {}});
const engine = new module.HolosphereEngine();
const catalog = JSON.parse(module.ShaderChainBindings.getShaderChainCatalog());
const capture = () => callWorkbenchBinding(engine, 'getShaderChainBindings', 'getSnapshot', []);
const restore = (snapshot) => callWorkbenchBinding(engine, 'getShaderChainBindings', 'restoreSnapshot', [snapshot]);
after(() => engine.delete());

const snapshotBytes = readFileSync(new URL('./fixtures/legacy_shader_snapshots.json', import.meta.url));
const presets = JSON.parse(snapshotBytes);
const reference = JSON.parse(readFileSync(new URL('./fixtures/legacy_shader_reference_frames.json', import.meta.url)));
const nativeEndpoints = JSON.parse(readFileSync(new URL('./fixtures/legacy_shader_native_endpoints.json', import.meta.url)));
const backendDiagnosis = JSON.parse(readFileSync(new URL('./fixtures/legacy_shader_wasm_diagnosis.json', import.meta.url)));

test('the legacy rendering oracle names a clean producer and its untouched archive', () => {
  assert.match(reference.sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(reference.wasmSha256, /^[0-9a-f]{64}$/);
  assert.equal(reference.snapshotsSha256, createHash('sha256').update(snapshotBytes).digest('hex'));
  assert.equal(reference.frames.length, 48);
});

test('the recorded WASM backend diagnosis retains the canonical approximation limits', () => {
  assert.equal(backendDiagnosis.baselineSourceCommit, nativeEndpoints.sourceCommit);
  assert.deepEqual(backendDiagnosis.acceptedFramebufferLimits,
    {HUE_ROTATION_AND_NOISE_LUTS: 3066, PEIRCE_FAST_SQUARE: 256});
  assert.equal(backendDiagnosis.comparisons.length, 2);
  for (const comparison of backendDiagnosis.comparisons) {
    assert.equal(comparison.frame_count, 227);
    assert.match(comparison.baseline_sha256, /^[0-9a-f]{64}$/);
    assert.match(comparison.candidate_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(comparison.new_metrics, comparison.old_metrics);
    for (const [kind, metric] of Object.entries(comparison.new_metrics))
      assert.ok(metric.value <= backendDiagnosis.acceptedFramebufferLimits[kind], `${comparison.resolution} ${kind}`);
    assert.ok(comparison.differences.some((entry) => entry.operation === 'case:endpoint_max' && entry.max_delta > 1));
  }
});

for (const row of presets) {
  test(`all 24 converted legacy presets preserve their rendering at ${row.width}x${row.height}`, () => {
    engine.setResolution(row.width, row.height);
    for (const preset of row.presets) {
      assert.equal(engine.setEffect('ShaderChain'), module.EffectSetResult.INSTALLED);
      const converted = convertLegacyShaderSnapshot(preset.snapshot, catalog);
      assert.equal(converted.ok, true, converted.reason);
      assert.equal(restore(converted.snapshot), module.ChainSnapshotRestoreResult.APPLIED, `preset ${preset.index}`);
      const snapshot = capture();
      assert.deepEqual(snapshot.chain, converted.snapshot.chain);
      assert.deepEqual(snapshot.parameters, converted.snapshot.parameters);
      engine.drawFrame();
      const values = Uint16Array.from(engine.getPixels());
      const expected = reference.frames.find((frame) => frame.width === row.width && frame.index === preset.index);
      for (const probe of expected.probes) for (let channel = 0; channel < 3; channel += 1)
        assert.ok(Math.abs(values[probe.pixel * 3 + channel] - probe.rgb[channel]) <= 1,
          `preset ${preset.index}, pixel ${probe.pixel}, channel ${channel}`);
      const totals = [0, 0, 0];
      for (let index = 0; index < values.length; index += 1) totals[index % 3] += values[index];
      for (let channel = 0; channel < 3; channel += 1)
        assert.ok(Math.abs(totals[channel] - expected.channelTotals[channel]) <= row.width * row.height,
          `preset ${preset.index}, channel ${channel} whole-frame total`);
    }
  });
}

test('all frozen native endpoint configurations restore their complete typed state in WASM', () => {
  assert.equal(nativeEndpoints.sourceCommit, 'b6d2c0100e10d57b18f9bd749d5ab28b34574dd8');
  assert.deepEqual(nativeEndpoints.backendSha256, {
    '96x20': '49a88e6ac3373a39d882ee0367b77d48579c6c94f7c90b98a2b6b33b8e6d5c5b',
    '288x144': '9ee251c9f2d058cbfe56c7cd0f964361d5fa43cc90a31dde0f13703f78e98e27',
  });
  assert.equal(nativeEndpoints.frames.length, 96);
  for (const frame of nativeEndpoints.frames) {
    engine.setResolution(frame.width, frame.height);
    engine.setEffect('ShaderChain');
    const converted = convertLegacyShaderSnapshot(frame.snapshot, catalog);
    assert.equal(converted.ok, true, `${frame.preset} ${frame.name}: ${converted.reason}`);
    for (const entry of converted.snapshot.runtime) {
      if (entry.kind === 'spatial-walk-v1')
        entry.state.noiseSeed = frame.walkSeeds[entry.instance === 'camera' ? 1 : 0];
      if (entry.kind === 'spherical-rings-v1') entry.state.walk.noiseSeed = frame.walkSeeds[1];
    }
    converted.snapshot.paletteBank = {chroma: frame.paletteBank.chroma,
      hues: frame.paletteBank.hues,
      cycles: frame.paletteBank.clocks.map((clock) => ({frame: clock.frame,
        nextSequence: clock.nextSequence, fadeActive: clock.fadeActive, displayDirty: false}))};
    assert.equal(restore(converted.snapshot), module.ChainSnapshotRestoreResult.APPLIED);
    const restored = capture();
    assert.deepEqual(restored.chain, converted.snapshot.chain);
    assert.deepEqual(restored.parameters, converted.snapshot.parameters);
    assert.deepEqual(restored.runtime, converted.snapshot.runtime);
    assert.deepEqual(restored.paletteBank, {...converted.snapshot.paletteBank,
      chroma: Math.fround(converted.snapshot.paletteBank.chroma)});
    assert.equal(restored.animationsPaused, true);
    engine.drawFrame();
    const values = engine.getPixels();
    const context = `${frame.width}x${frame.height} preset ${frame.preset} ${frame.name}`;
    assert.equal(values.length, frame.width * frame.height * 3, context);
    assert.equal(frame.probes.length, 128, context);
    assert.equal(values.some((value) => value !== 0), frame.channelTotals.some((value) => value !== 0),
      `${context}: visible output`);
  }
});

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
    (value) => { value.schemaVersion = 2; },
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
