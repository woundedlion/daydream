// ShaderChain WASM binding contract against FakeChainEngine.

import {chainSnapshot} from './helpers/effect_gui_harness.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import createHolosphereModule from '../generated/holosphere_wasm.js';

import { callWorkbenchBinding } from '../src/engine/workbench_bindings.js';
import { applyChainDocument } from '../src/workbench/shader/chain_apply.js';


import {
  FakeChainEngine, ChainSnapshotRestoreResult, ChainStatus, PALETTE_FADE_FRAMES, PALETTE_HUE_STEP,
} from './helpers/fake_engine.js';

import {resolutionPresets} from '../src/effects/effect_roster.js';



import { deactivatedParameterIds, modulationValueLimits } from '../src/workbench/shader/chain_presentation.js';
import { declarationFromCatalogField } from '../generated/shader/shader_workbench.mjs';

const sink = () => {};
const M = await createHolosphereModule({print: sink, printErr: sink});
const {w: W, h: H} = resolutionPresets['Holosphere (96x20)'];
const engine = new M.HolosphereEngine();
// Both non-rejections leave the requested size active; only RESIZED tears the effect down.
const resolutionOk = r => r === M.ResolutionSetResult.RESIZED || r === M.ResolutionSetResult.ALREADY_ACTIVE;
const chainCall = (target, method, payload) => callWorkbenchBinding(target, method, [payload]);

test('chain numeric ranges expose finite bounds without changing the live snapshot', () => {
  engine.setEffect('ShaderChain');
  const bindings = engine.getShaderChainBindings();
  const before = bindings.getSnapshot();
  const ranges = bindings.getShaderChainParameterRanges();
  assert.ok(ranges.length > 0);
  assert.ok(ranges.some(({name}) => name === 'sample.pattern-freq'));
  for (const range of ranges) {
    assert.deepEqual(Object.keys(range).sort(), ['max', 'min', 'name']);
    assert.equal(typeof range.name, 'string');
    assert.ok(Number.isFinite(range.min) && Number.isFinite(range.max));
    assert.ok(range.min <= range.max);
    const value = before.parameters.find(({name}) => name === range.name).value;
    assert.ok(value >= range.min && value <= range.max);
  }
  assert.deepEqual(bindings.getSnapshot(), before);
  bindings.delete();
});

test('typed authoring handles track effect incarnations and reject unsupported effects', () => {
  engine.setEffect('Comets');
  assert.equal(engine.getShaderChainBindings(), null);
  engine.setEffect('ShaderChain');
  const chain = engine.getShaderChainBindings();
  assert.equal(chain.isValid(), true);
  const program = chain.getProgram();
  assert.equal(chain.setShaderChain(program).code, 'APPLIED');
  assert.equal(chain.isValid(), true, 'schema rebind preserves effect incarnation');
  assert.equal(engine.setEffect('missing'), M.EffectSetResult.UNKNOWN_EFFECT);
  assert.equal(engine.setResolution(W, H), M.ResolutionSetResult.ALREADY_ACTIVE);
  assert.equal(chain.isValid(), true, 'rejected and no-op lifecycle calls preserve handles');
  engine.setEffect('ShaderChain');
  assert.equal(chain.isValid(), false, 'same-type replacement still invalidates handles');
  assert.equal(chain.getProgram(), null);
  assert.equal(chain.setShaderChain(program).code, 'NOT_CHAIN_EFFECT');
  assert.equal(chain.setShaderChainParameters([]), M.ParamSetResult.NO_EFFECT);
  chain.delete();

  engine.setEffect('ShaderChain');
  const bindings = engine.getShaderChainBindings();
  const snapshot = bindings.getSnapshot();
  assert.equal(bindings.restoreSnapshot(snapshot), M.ChainSnapshotRestoreResult.APPLIED);
  engine.setResolution(288, 144);
  assert.equal(engine.getShaderChainBindings(), null, 'resizing leaves no effect');
  assert.equal(bindings.isValid(), false);
  assert.equal(bindings.getSnapshot(), null);
  assert.equal(bindings.restoreSnapshot(snapshot), M.ChainSnapshotRestoreResult.NOT_SHADER_CHAIN);
  bindings.delete();
  engine.setResolution(W, H);
});

test('geometry rebuild invalidates authoring handles while preserving their configuration', () => {
  try {
    engine.setEffect('ShaderChain');
    const before = engine.getShaderChainBindings();
    const program = before.getProgram();
    assert.equal(engine.setDisplayCaps(5, 6), true);
    assert.equal(before.isValid(), false);
    const after = engine.getShaderChainBindings();
    assert.deepEqual(after.getProgram(), program);
    before.delete();
    after.delete();
  } finally {
    engine.setDisplayCaps(0, 0);
  }
});

test('authoring handles outlive deleted engines safely and cannot bind a successor', async () => {
  const module = await createHolosphereModule({ print: sink, printErr: sink });
  const owner = new module.HolosphereEngine();
  owner.setEffect('ShaderChain');
  const chain = owner.getShaderChainBindings();
  const program = chain.getProgram();
  owner.delete();
  assert.equal(chain.isValid(), false);
  assert.equal(chain.setShaderChain(program).code, 'NOT_CHAIN_EFFECT');
  const successor = new module.HolosphereEngine();
  successor.setEffect('ShaderChain');
  assert.equal(chain.isValid(), false);
  chain.delete();
  successor.delete();
});

test('adapter payload getters cannot commit to replaced or resized effects', () => {
  try {
    for (const replace of [() => engine.setEffect('ShaderChain'),
      () => engine.setResolution(288, 144),
      () => engine.setDisplayCaps(7, 8)]) {
      engine.setResolution(W, H);
      engine.setEffect('ShaderChain');
      const chain = engine.getShaderChainBindings();
      const program = chain.getProgram();
      Object.defineProperty(program[0], 'instance', {
        enumerable: true,
        get() { replace(); return 'stale'; },
      });
      assert.equal(chain.setShaderChain(program).code, 'NOT_CHAIN_EFFECT');
      assert.equal(chain.isValid(), false);
      chain.delete();
    }
  } finally {
    engine.setResolution(W, H);
    engine.setDisplayCaps(0, 0);
  }
});

test('marked-dead modules reject capability acquisition and calls', async () => {
  const module = await createHolosphereModule({ print: sink, printErr: sink });
  const owner = new module.HolosphereEngine();
  owner.setEffect('ShaderChain');
  const chain = owner.getShaderChainBindings();
  module.HS_MODULE_DEAD = true;
  assert.equal(chain.isValid(), false);
  assert.equal(chain.getProgram(), null);
  assert.equal(owner.getShaderChainBindings(), null);
  module.HS_MODULE_DEAD = false;
  chain.delete();
  owner.delete();
});

test('snapshot adapters reject getter-driven replacement without touching the new effect', () => {
  engine.setEffect('ShaderChain');
  const bindings = engine.getShaderChainBindings();
  const snapshot = bindings.getSnapshot();
  let replacementDefinitions;
  let replacementPaused;
  Object.defineProperty(snapshot, 'parameters', {
    enumerable: true,
    get() {
      engine.setEffect('Comets');
      replacementDefinitions = engine.getParameterDefinitions();
      replacementPaused = engine.getAnimationsPaused();
      return [];
    },
  });
  assert.notEqual(bindings.restoreSnapshot(snapshot), M.ChainSnapshotRestoreResult.APPLIED);
  assert.equal(bindings.isValid(), false);
  assert.ok(replacementDefinitions);
  assert.deepEqual(engine.getParameterDefinitions(), replacementDefinitions);
  assert.equal(engine.getAnimationsPaused(), replacementPaused);
  bindings.delete();
});

test('adapter decode rejects nested authoring and deletion from getters', async () => {
  for (const action of ['delete', 'nested']) {
    const module = await createHolosphereModule({ print: sink, printErr: sink });
    const owner = new module.HolosphereEngine();
    owner.setEffect('ShaderChain');
    const chain = owner.getShaderChainBindings();
    const program = chain.getProgram();
    Object.defineProperty(program[0], 'instance', {
      enumerable: true,
      get() {
        if (action === 'delete') owner.delete();
        else chain.setShaderChainParameters([]);
        return 'camera';
      },
    });
    assert.throws(() => chain.setShaderChain(program), WebAssembly.RuntimeError);
    assert.equal(module.HS_MODULE_DEAD, true);
  }
});


const DEFAULT_CHAIN = [
  { instance: 'camera', operator: 'sphere.rotate.v2' },
  { instance: 'project', operator: 'project.stereographic.v2' },
  { instance: 'sample', operator: 'sample.grid.v4' },
  { instance: 'colorize', operator: 'colorize.generated-palette.v4' },
];

test('setShaderChain applies a chain, registers label.field params and bumps the generation', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('ShaderChain'), M.EffectSetResult.INSTALLED,
    'the chain interpreter effect must be registered in the WASM build');

  const before = engine.getParamGeneration();
  const applied = chainCall(engine, 'setShaderChain', DEFAULT_CHAIN);
  assert.equal(applied.status, M.ChainStatus.OK);
  assert.equal(applied.code, 'APPLIED', 'the default chain must compile');
  assert.equal(applied.entryIndex, -1, 'APPLIED blames no entry');
  assert.notEqual(engine.getParamGeneration(), before,
    'an APPLIED setShaderChain must bump the param generation, or a stale '
    + 'definitions snapshot cannot be detected');

  const defs = engine.getParameterDefinitions();
  assert.ok(defs.length > 0, 'the applied chain must register parameters');
  const misnamed = Array.from(defs, (d) => d.name)
    .filter((name) => !/^[a-z][a-z0-9-]*\.[a-z0-9-]+$/.test(name));
  assert.deepEqual(misnamed.slice(0, 5), [],
    `${misnamed.length} chain params are not instance.field names`);
  assert.ok(defs.some((d) => d.name === 'camera.wander'),
    'the camera instance must register its wander field');
  const coverage = defs.find((d) => d.name === 'sample.coverage-mode');
  assert.ok(coverage, 'the sample instance must register its topology enum');
  const catalog = JSON.parse(M.ShaderChainBindings.getShaderChainCatalog());
  const field = catalog.operators.find((op) => op.id === 'sample.grid.v4')
    .params.find((p) => p.id === 'coverage-mode');
  assert.deepEqual(Array.from(coverage.options), field.values,
    'a topology enum must offer the catalog values as its options, in order');

  assert.equal(engine.setParameter('sample.pattern-freq', 3),
    M.ParamSetResult.APPLIED, 'a chain param must be writable by its id');
  assert.equal(engine.setClip(0, W, 0, H), M.ClipSetResult.APPLIED);
  engine.drawFrame();
  assert.ok(engine.getPixels().some((v) => v !== 0),
    'the applied chain must render a nonzero frame');
});

test('applied chain definitions and parameter pause behavior match the fake engine', () => {
  const fake = new FakeChainEngine();
  engine.setAnimationsPaused(true);
  fake.setAnimationsPaused(true);
  engine.setEffect('ShaderChain');
  fake.setEffect('ShaderChain');
  assert.equal(engine.getAnimationsPaused(), true);
  assert.equal(fake.getAnimationsPaused(), true);
  assert.deepEqual(fake.getParameterDefinitions(), engine.getParameterDefinitions());
  assert.equal(chainCall(engine, 'setShaderChain', DEFAULT_CHAIN).code, 'APPLIED');
  assert.equal(chainCall(fake, 'setShaderChain', DEFAULT_CHAIN).code, 'APPLIED');
  assert.deepEqual(fake.getParameterDefinitions(), engine.getParameterDefinitions());
  for (const [method, args] of [
    ['setParameter', ['camera.wander', 0.2]],
    ['setParameter', ['sample.coverage-mode', 2]],
    ['setParameter', ['sample.coverage-mode', 1.6]],
    ['setShaderChainParameters', [[{ name: 'sample.coverage-mode', value: 0.6 }]]],
    ['setShaderChainParameters', [[{ name: 'sample.pattern-freq', value: 1.3 }]]],
  ]) {
    engine.setAnimationsPaused(false);
    fake.setAnimationsPaused(false);
    const write = (target) => method === 'setParameter' ? target[method](...args)
      : callWorkbenchBinding(target, method, args);
    assert.equal(write(fake).value, write(engine).value);
    assert.equal(engine.getAnimationsPaused(), true);
    assert.equal(fake.getAnimationsPaused(), engine.getAnimationsPaused());
    assert.deepEqual(fake.getParameterDefinitions(), engine.getParameterDefinitions());
  }
  for (const target of [engine, fake]) {
    target.setAnimationsPaused(false);
    target.setParameter('missing', 1);
    assert.equal(target.getAnimationsPaused(), false);
  }
});

test('modulation writes and batches match the engine admission and atomicity', () => {
  const fake = new FakeChainEngine();
  for (const target of [engine, fake]) {
    target.setEffect('ShaderChain');
    assert.equal(chainCall(target, 'setShaderChain', [...DEFAULT_CHAIN,
      {instance: 'modulation', operator: 'color.modulate.v1'}]).code, 'APPLIED');
    target.setAnimationsPaused(false);
    const before = chainCall(target, 'getSnapshot');
    for (const [field, value] of [['modulation-source', 1], ['pattern-scale', 9],
      ['pattern-noise-basis', 1], ['pattern-contrast', 1]]) {
      assert.equal(target.setParameter(`modulation.${field}`, value).value,
        M.ParamSetResult.INADMISSIBLE.value, field);
      assert.deepEqual(chainCall(target, 'getSnapshot'), before, field);
    }
    assert.equal(chainCall(target, 'setShaderChainParameters', [
      {name: 'camera.wander', value: 0.4}, {name: 'modulation.pattern-scale', value: 9},
    ]).value, M.ParamSetResult.INADMISSIBLE.value);
    assert.deepEqual(chainCall(target, 'getSnapshot'), before);
    assert.equal(chainCall(target, 'setShaderChainParameters', [
      {name: 'modulation.modulation-source', value: 1},
      {name: 'modulation.modulation-evaluation', value: 0},
    ]).value, M.ParamSetResult.APPLIED.value);
    const recipe = chainCall(target, 'getSnapshot').modulation[0].recipe;
    assert.equal(recipe.source, 1);
    assert.equal(recipe.evaluation, 0);
    assert.equal(target.getAnimationsPaused(), true);
  }
  assert.deepEqual(fake.getParameterDefinitions(), engine.getParameterDefinitions());
});

test('modulation value limits are the bounds the engine admits', () => {
  engine.setEffect('ShaderChain');
  assert.equal(chainCall(engine, 'setShaderChain', [...DEFAULT_CHAIN,
    {instance: 'modulation', operator: 'color.modulate.v1'}]).code, 'APPLIED');
  const definition = (field) => engine.getParameterDefinitions()
    .find((d) => d.name === `modulation.${field}`);
  const value = (field) => {
    const d = definition(field);
    return d.options ? d.options[d.value] : d.value;
  };
  const select = (field, option) => assert.equal(engine.setParameter(`modulation.${field}`,
    definition(field).options.indexOf(option)), M.ParamSetResult.APPLIED, `${field}=${option}`);
  const admits = (field, candidate) => {
    const before = chainCall(engine, 'getSnapshot');
    const result = engine.setParameter(`modulation.${field}`, candidate);
    if (result === M.ParamSetResult.APPLIED) assert.equal(chainCall(engine, 'restoreSnapshot', before),
      M.ChainSnapshotRestoreResult.APPLIED);
    return result === M.ParamSetResult.APPLIED;
  };
  const probe = (field) => {
    const limits = modulationValueLimits(field, value);
    assert.ok(limits, field);
    const { min, max } = definition(field);
    if (Number.isFinite(limits.min)) {
      assert.equal(admits(field, limits.min), true, `${field} at its lower limit`);
      if (limits.min > min) assert.equal(admits(field, limits.min - 0.01), false, `${field} below its limit`);
    }
    assert.equal(admits(field, limits.max), true, `${field} at its upper limit`);
    assert.ok(limits.max < max, `${field} limit lies inside its declared range`);
    assert.equal(admits(field, limits.max + 0.01), false, `${field} above its limit`);
  };
  select('modulation-evaluation', 'baked-cube');
  probe('pattern-scale');
  select('modulation-mechanic', definition('modulation-mechanic').options
    .find((option) => option !== 'hue-rotation'));
  probe('modulation-amount');
});

test('chain refusal statuses match the fake engine payload contracts', () => {
  const fake = new FakeChainEngine();
  fake.setEffect('ShaderChain');
  assert.equal(engine.setEffect('ShaderChain'), M.EffectSetResult.INSTALLED);
  const max = JSON.parse(M.ShaderChainBindings.getShaderChainCatalog()).budgets.max_chain_ops;
  const duplicate = { instance: 'same', operator: 'sphere.rotate.v2' };
  const payloads = [null, [null], [duplicate, null], [],
    Array.from({ length: max + 1 }, () => ({})), [duplicate, duplicate]];
  const plain = ({ status, code, entryIndex }) => ({ status: status.value, code, entryIndex });
  for (const payload of payloads) {
    const refused = plain(chainCall(engine, 'setShaderChain', payload));
    assert.equal(typeof refused.status, 'number');
    assert.notEqual(refused.status, ChainStatus.OK.value);
    assert.equal(refused.code, Object.keys(ChainStatus).find((name) => ChainStatus[name].value === refused.status));
    assert.deepEqual(refused, plain(chainCall(fake, 'setShaderChain', payload)));
  }
  assert.equal(engine.setEffect('Comets'), M.EffectSetResult.INSTALLED);
  fake.setEffect('Comets');
  assert.equal(engine.getShaderChainBindings(), null);
  assert.equal(fake.getShaderChainBindings(), null);
});

function chainFixture() {
  const fake = new FakeChainEngine();
  fake.setEffect('ShaderChain');
  engine.setEffect('ShaderChain');
  for (const target of [engine, fake])
    assert.equal(chainCall(target, 'setShaderChain', [...DEFAULT_CHAIN,
      {instance: 'modulation', operator: 'color.modulate.v1'}]).code, 'APPLIED');
  const saved = chainCall(engine, 'getSnapshot');
  return {fake, saved};
}

test('chain snapshots expose matching fake and engine key sets', () => {
  const {fake, saved} = chainFixture();
  assert.deepEqual(Object.keys(chainCall(fake, 'getSnapshot')).sort(), Object.keys(saved).sort());
});

test('chain snapshot decoders refuse malformed payload shapes', () => {
  const {fake, saved} = chainFixture();
  const missingPause = structuredClone(saved);
  delete missingPause.animationsPaused;
  const max = fake.catalog.budgets;
  for (const snapshot of [null, { schemaVersion: 3 }, missingPause,
    { ...saved, chain: [] }, { ...saved, chain: null }, { ...saved, parameters: null },
    { ...saved, chain: [null] }, { ...saved, chain: [{instance: 1, operator: 'sphere.rotate.v2'}] },
    { ...saved, chain: [{instance: 'camera', operator: 1}] },
    { ...saved, chain: [{instance: 'camera'}] },
    { ...saved, parameters: [null] }, { ...saved, parameters: [{name: 1, value: 0}] },
    { ...saved, parameters: [{name: 'camera.wander', value: '0.5'}] },
    { ...saved, runtime: null }, { ...saved, paletteBank: {} },
    { ...saved, chain: Array(max.max_chain_ops + 1).fill(null) },
    { ...saved, parameters: Array(max.max_params + 1).fill(null) },
    { ...saved, runtime: Array(max.max_chain_ops + 1).fill(null) },
    { ...saved, paletteBank: { ...saved.paletteBank, hues: null } },
    { ...saved, paletteBank: { ...saved.paletteBank, cycles: null } },
    { ...saved, paletteBank: { ...saved.paletteBank, hues: [] } },
    { ...saved, paletteBank: { ...saved.paletteBank, cycles: [] } }]) {
    const refused = chainCall(engine, 'restoreSnapshot', snapshot).value;
    assert.equal(typeof refused, 'number');
    assert.notEqual(refused, ChainSnapshotRestoreResult.APPLIED.value);
    assert.equal(chainCall(fake, 'restoreSnapshot', snapshot).value, refused);
  }
});

test('chain snapshot restores reject invalid parameter and runtime values', () => {
  const {fake, saved} = chainFixture();
  const [write] = saved.parameters;
  const enumName = fake.definitions.find((definition) => definition.options)?.name;
  assert.ok(enumName, 'the default chain exposes an enum parameter');
  const [entry] = saved.runtime;
  for (const snapshot of [
    { ...saved, parameters: [{ ...write, value: NaN }] },
    { ...saved, parameters: [write, write] },
    { ...saved, parameters: [{ name: 'unknown', value: 0 }] },
    { ...saved, parameters: [{ ...write, value: 1e9 }] },
    { ...saved, parameters: [{ name: enumName, value: 0.5 }] },
    { ...saved, runtime: [] },
    { ...saved, runtime: [...saved.runtime, entry] },
    { ...saved, runtime: [...saved.runtime, { ...entry, instance: 'unknown' }] },
    { ...saved, runtime: saved.runtime.map((item, index) => index ? item : { ...item, kind: 'phase-clock-v1', state: { phase: 0 } }) },
    { ...saved, runtime: saved.runtime.map((item) => item.kind !== 'modulation-clock-v1' ? item
      : {...item, state: {...item.state, initialized: false, phaseTurns: 0.5}}) },
  ]) {
    assert.equal(chainCall(engine, 'restoreSnapshot', snapshot).value, ChainSnapshotRestoreResult.INVALID_VALUE.value);
    assert.equal(chainCall(fake, 'restoreSnapshot', snapshot).value, ChainSnapshotRestoreResult.INVALID_VALUE.value);
  }
});

test('fake chain snapshots round-trip runtime and palette state', () => {
  const {fake, saved} = chainFixture();
  assert.equal(chainCall(fake, 'restoreSnapshot', saved), ChainSnapshotRestoreResult.APPLIED);
  assert.deepEqual(chainCall(fake, 'getSnapshot').runtime, saved.runtime);
  assert.deepEqual(chainCall(fake, 'getSnapshot').paletteBank, saved.paletteBank);

});

test('recipe snapshot restores preserve admitted modulation variants', () => {
  const {fake, saved} = chainFixture();
  chainCall(fake, 'restoreSnapshot', saved);
  const fakeDefault = chainCall(fake, 'getSnapshot');
  assert.equal(chainCall(engine, 'restoreSnapshot', fakeDefault).value, ChainSnapshotRestoreResult.APPLIED.value);
  for (const change of [
    (recipe) => { recipe.evaluation = 0; recipe.noise.variant = 1; },
    (recipe) => { recipe.noise.variant = 1; recipe.mechanic.kind = 1; },
  ]) {
    const snapshot = structuredClone(saved);
    change(snapshot.modulation[0].recipe);
    for (const target of [engine, fake]) {
      assert.equal(chainCall(target, 'restoreSnapshot', snapshot).value,
        ChainSnapshotRestoreResult.APPLIED.value);
      assert.deepEqual(chainCall(target, 'getSnapshot').modulation, snapshot.modulation);
    }
  }
});

test('chain snapshot seeds respect signed 32-bit bounds', () => {
  const {fake, saved} = chainFixture();
  for (const seed of [-0x80000000, -1, 0x7fffffff, -0x80000001, 0x80000000, 3e9]) {
    for (const field of ['recipe', 'spatial', 'noise']) {
      const snapshot = structuredClone(saved);
      if (field === 'recipe') snapshot.modulation[0].recipe.seed = seed;
      else if (field === 'spatial') snapshot.runtime.find(({kind}) => kind === 'spatial-walk-v2').state.noiseSeed = seed;
      else {
        const noise = {instance: 'noise', operator: 'warp.vector-noise.v2'};
        const chain = [...DEFAULT_CHAIN.slice(0, 2), noise, ...DEFAULT_CHAIN.slice(2)];
        for (const target of [engine, fake])
          assert.equal(chainCall(target, 'setShaderChain', chain).code, 'APPLIED');
        Object.assign(snapshot, chainCall(engine, 'getSnapshot'));
        snapshot.runtime.find(({kind}) => kind === 'noise-clock-v1').state.noiseSeed = seed;
      }
      const expected = seed >= -0x80000000 && seed <= 0x7fffffff
        ? ChainSnapshotRestoreResult.APPLIED : ChainSnapshotRestoreResult.INVALID_VALUE;
      assert.equal(chainCall(engine, 'restoreSnapshot', snapshot).value, expected.value, `${field}: ${seed}`);
      assert.equal(chainCall(fake, 'restoreSnapshot', snapshot), expected, `${field}: ${seed}`);
    }
  }
});

test('palette snapshot restores retain active fade state', () => {
  const {fake, saved} = chainFixture();
  const advanced = structuredClone(saved);
  const nextSequence = 3;
  advanced.paletteBank.hues.fill((nextSequence - 1) * PALETTE_HUE_STEP);
  for (const cycle of advanced.paletteBank.cycles) {
    cycle.nextSequence = nextSequence;
    cycle.fadeActive = true;
    cycle.frame = 1;
  }
  for (const target of [engine, fake]) {
    assert.equal(chainCall(target, 'restoreSnapshot', advanced).value, ChainSnapshotRestoreResult.APPLIED.value);
    assert.deepEqual(chainCall(target, 'getSnapshot').paletteBank, advanced.paletteBank);
  }
});

test('palette snapshot restores reject inconsistent fade state', () => {
  const {fake, saved} = chainFixture();
  const advanced = structuredClone(saved);
  const nextSequence = 3;
  advanced.paletteBank.hues.fill((nextSequence - 1) * PALETTE_HUE_STEP);
  for (const cycle of advanced.paletteBank.cycles) {
    cycle.nextSequence = nextSequence;
    cycle.fadeActive = true;
    cycle.frame = 1;
  }
  for (const target of [engine, fake]) {
    assert.equal(chainCall(target, 'restoreSnapshot', advanced).value, ChainSnapshotRestoreResult.APPLIED.value);
    assert.deepEqual(chainCall(target, 'getSnapshot').paletteBank, advanced.paletteBank);
  }
  for (const change of [
    (snapshot) => { snapshot.paletteBank.chroma = -0.1; },
    (snapshot) => { snapshot.paletteBank.chroma = 1.1; },
    (snapshot) => { snapshot.paletteBank.cycles[0].nextSequence = 1; },
    (snapshot) => { snapshot.paletteBank.hues[0] += 1; },
    (snapshot) => { snapshot.paletteBank.cycles[0].frame = PALETTE_FADE_FRAMES; },
    (snapshot) => { snapshot.paletteBank.cycles[0].fadeActive = false; },
  ]) {
    const snapshot = structuredClone(advanced);
    change(snapshot);
    for (const target of [engine, fake])
      assert.equal(chainCall(target, 'restoreSnapshot', snapshot).value, ChainSnapshotRestoreResult.INVALID_VALUE.value);
  }
});

test('a null ripple snapshot wave is refused without throwing or mutating either engine', () => {
  const fake = new FakeChainEngine();
  for (const target of [engine, fake]) {
    target.setEffect('ShaderChain');
    assert.equal(chainCall(target, 'setShaderChain', [DEFAULT_CHAIN[0],
      {instance: 'ripple', operator: 'sphere.displace.ripple.v2'}, ...DEFAULT_CHAIN.slice(1)]).code,
    'APPLIED');
    const before = chainCall(target, 'getSnapshot');
    const invalid = structuredClone(before);
    invalid.runtime.find(({kind}) => kind === 'ripple-burst-v1').state.waves[0] = null;
    assert.equal(chainCall(target, 'restoreSnapshot', invalid).value,
      ChainSnapshotRestoreResult.INVALID_VALUE.value);
    assert.deepEqual(chainCall(target, 'getSnapshot'), before);
  }
});

test('every catalog operator matches fake snapshot runtime kinds and state keys', () => {
  const fake = new FakeChainEngine();
  fake.setEffect('ShaderChain');
  engine.setEffect('ShaderChain');
  for (const operator of fake.catalog.operators) {
    const chain = [];
    if (operator.input !== 'sphere') chain.push(DEFAULT_CHAIN[1]);
    if (operator.input === 'field' || operator.input === 'color') chain.push(DEFAULT_CHAIN[2]);
    if (operator.input === 'color') chain.push(DEFAULT_CHAIN[3]);
    chain.push({ instance: 'target', operator: operator.id });
    if (operator.output === 'sphere') chain.push(DEFAULT_CHAIN[1]);
    if (operator.output === 'sphere' || operator.output === 'plane') chain.push(DEFAULT_CHAIN[2]);
    if (operator.output !== 'color') chain.push(DEFAULT_CHAIN[3]);
    for (const target of [engine, fake])
      assert.equal(chainCall(target, 'setShaderChain', chain).code, 'APPLIED', operator.id);
    const shape = (target) => {
      const entry = chainCall(target, 'getSnapshot').runtime.find(({ instance }) => instance === 'target');
      return { kind: entry?.kind ?? 'none', keys: Object.keys(entry?.state ?? {}).sort() };
    };
    assert.deepEqual(shape(fake), shape(engine), operator.id);
    const snapshot = JSON.parse(JSON.stringify(chainCall(engine, 'getSnapshot')));
    assert.equal(chainCall(engine, 'restoreSnapshot', snapshot), M.ChainSnapshotRestoreResult.APPLIED,
      operator.id);
    assert.deepEqual(chainCall(engine, 'getSnapshot').runtime, snapshot.runtime, operator.id);
  }
});

test('effect-panel snapshot fixtures restore on the real engine and conformant fake', () => {
  for (const target of [engine, new FakeChainEngine()]) {
    target.setEffect('ShaderChain');
    for (const value of [0, 0.5, 1]) {
      assert.equal(chainCall(target, 'restoreSnapshot', chainSnapshot(value)).value,
        ChainSnapshotRestoreResult.APPLIED.value);
    }
  }
});

test('field integer dropdowns and mode gates follow the real engine catalog', () => {
  engine.setEffect('ShaderChain');
  const bindings = engine.getShaderChainBindings();
  try {
    assert.equal(bindings.setShaderChain([
      {instance: 'field', operator: 'sphere.displace.potential.v1'},
      {instance: 'wave', operator: 'sphere.displace.rossby-haurwitz.v1'},
      ...DEFAULT_CHAIN.slice(1),
    ]).code, 'APPLIED');
    const definitions = () => engine.getParameterDefinitions();
    const catalog = JSON.parse(M.ShaderChainBindings.getShaderChainCatalog());
    const operator = catalog.operators.find((entry) => entry.id === 'sphere.displace.potential.v1');
    const catalogField = (operatorId, field) => catalog.operators
      .find((entry) => entry.id === operatorId).params.find((param) => param.id === field);
    for (const field of ['term-1-l', 'term-1-m']) {
      const control = definitions().find((entry) => entry.name === `field.${field}`);
      assert.deepEqual(control.options, catalogField(operator.id, field).values);
      assert.equal(control.step, 1);
    }
    const order = definitions().find((entry) => entry.name === 'wave.order');
    const orderField = catalogField('sphere.displace.rossby-haurwitz.v1', 'order');
    assert.deepEqual(order.options, orderField.values);
    assert.equal(order.step, 1);
    assert.equal(order.requestedValue, orderField.values.indexOf(orderField.default));
    assert.equal(engine.setParameter('field.term-1-l', 2), M.ParamSetResult.APPLIED);
    assert.equal(engine.setParameter('field.term-1-m', 3), M.ParamSetResult.INADMISSIBLE);
    const degree = catalogField(operator.id, 'term-1-m');
    assert.equal(definitions().find((entry) => entry.name === 'field.term-1-m').requestedValue,
      degree.values.indexOf(degree.default));

    const declarations = operator.params.map((field) => declarationFromCatalogField('field', field, operator.id));
    const chain = [{label: 'field', operator: operator.id}];
    const inactive = () => deactivatedParameterIds(declarations,
      Object.fromEntries(definitions().map((definition) => [definition.name,
        definition.options ? definition.options[definition.requestedValue] : definition.requestedValue])),
      chain, catalog);
    for (const field of ['l', 'm', 'phase']) assert.equal(inactive().has(`field.term-1-${field}`), false);
    assert.equal(engine.setParameter('field.term-1-type', 2), M.ParamSetResult.APPLIED);
    for (const field of ['l', 'm', 'phase']) assert.equal(inactive().has(`field.term-1-${field}`), true);
    assert.equal(inactive().has('field.term-1-amplitude'), false);
    assert.equal(inactive().has('field.term-1-kind'), false);
    assert.equal(engine.setParameter('field.term-1-type', 0), M.ParamSetResult.APPLIED);
    for (const field of ['l', 'm', 'phase']) assert.equal(inactive().has(`field.term-1-${field}`), false);
  } finally { bindings.delete(); }
});

test('chain preset batches restore Mobius generators and refuse nonfinite edits transactionally', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)));
  assert.equal(engine.setEffect('ShaderChain'), M.EffectSetResult.INSTALLED);
  const chain = [DEFAULT_CHAIN[0],
    {instance: 'lens', operator: 'sphere.lens.mobius.v3'}, ...DEFAULT_CHAIN.slice(1)];
  const values = {'lens.spin-x': 1, 'lens.spin-y': 0, 'lens.spin-z': -1,
    'lens.push-x': 0.5, 'lens.push-y': -0.25, 'lens.push-z': 0};
  const compiled = {document: {
    descriptor: {chain: chain.map(({instance, operator}) => ({label: instance, operator}))},
    preset_bank: {presets: [{preset_id: 'generator', values}]},
  }};
  const apply = () => applyChainDocument({engine, module: M, compiled, presetId: 'generator',
    syncEffectGui() {}, invalidate() {}});
  assert.equal(apply(), null);
  const snapshot = () => Object.fromEntries(engine.getParameterDefinitions()
    .filter(({name}) => name.startsWith('lens.')).map(({name, value}) => [name, value]));
  assert.deepEqual(snapshot(), values);
  assert.equal(engine.setParameter('lens.spin-x', NaN), M.ParamSetResult.NON_FINITE);
  assert.deepEqual(snapshot(), values);
  assert.equal(chainCall(engine, 'setShaderChainParameters', [
    {name: 'lens.spin-x', value: 2}, {name: 'lens.push-x', value: NaN},
  ]), M.ParamSetResult.NON_FINITE);
  assert.deepEqual(snapshot(), values);
  const invalid = chainCall(engine, 'getSnapshot');
  invalid.parameters.find(({name}) => name === 'lens.push-x').value = 7;
  assert.equal(chainCall(engine, 'restoreSnapshot', invalid), M.ChainSnapshotRestoreResult.INVALID_VALUE);
  assert.deepEqual(snapshot(), values);
  assert.equal(chainCall(engine, 'setShaderChainParameters',
    Object.keys(values).map((name) => ({name, value: 0}))), M.ParamSetResult.APPLIED);
  assert.deepEqual(snapshot(), Object.fromEntries(Object.keys(values).map((name) => [name, 0])));
  assert.equal(apply(), null);
  assert.deepEqual(snapshot(), values);
});

test('chain parameter batch boundary reports malformed and oversized payloads', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)));
  assert.equal(engine.setEffect('ShaderChain'), M.EffectSetResult.INSTALLED);
  assert.equal(chainCall(engine, 'setShaderChain', DEFAULT_CHAIN).code, 'APPLIED');
  const before = engine.getParameterDefinitions();
  const name = before[0].name;
  for (const payload of [null, undefined, {}, [null], [undefined],
    [{ name: 1, value: 0 }], [{ name }], [{ name, value: '0.5' }]]) {
    const writes = Array.isArray(payload) ? [{ name, value: 0.5 }, ...payload] : payload;
    assert.equal(chainCall(engine, 'setShaderChainParameters', writes), M.ParamSetResult.MALFORMED_PAYLOAD);
  }
  const catalog = JSON.parse(M.ShaderChainBindings.getShaderChainCatalog());
  assert.equal(chainCall(engine, 'setShaderChainParameters',
    Array(catalog.budgets.max_params + 1).fill({ name, value: 0 })),
  M.ParamSetResult.TOO_LONG);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(chainCall(engine, 'setShaderChainParameters', [{ name, value }]), M.ParamSetResult.NON_FINITE);
  }
  assert.deepEqual(engine.getParameterDefinitions(), before);
});

test('setShaderChain refuses transactionally and names the offending entry', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('ShaderChain'), M.EffectSetResult.INSTALLED);
  assert.equal(chainCall(engine, 'setShaderChain', DEFAULT_CHAIN).code, 'APPLIED');
  const generation = engine.getParamGeneration();
  const names = Array.from(engine.getParameterDefinitions(), (d) => d.name);

  const unknown = chainCall(engine, 'setShaderChain', [
    { instance: 'camera', operator: 'sphere.rotate.v2' },
    { instance: 'project', operator: 'project.unknown.v9' },
    { instance: 'sample', operator: 'sample.grid.v4' },
    { instance: 'colorize', operator: 'colorize.generated-palette.v4' },
  ]);
  assert.equal(unknown.status, M.ChainStatus.UNKNOWN_OPERATOR);
  assert.equal(unknown.code, 'UNKNOWN_OPERATOR');
  assert.equal(unknown.entryIndex, 1,
    'the refusal must name the entry that failed the lookup');
  assert.equal(engine.getParamGeneration(), generation,
    'a refused chain must not bump the generation');
  assert.deepEqual(Array.from(engine.getParameterDefinitions(), (d) => d.name),
    names, 'a refused chain must leave the active program registered');

  assert.equal(chainCall(engine, 'setShaderChain', 'nonsense').status, M.ChainStatus.MALFORMED_PAYLOAD);
  assert.equal(chainCall(engine, 'setShaderChain', 'nonsense').code, 'MALFORMED_PAYLOAD',
    'a non-array payload is refused at the boundary, never a trap');
});

test('retired chain operators are absent and refuse without changing the live program', () => {
  engine.setEffect('ShaderChain');
  assert.equal(chainCall(engine, 'setShaderChain', DEFAULT_CHAIN).code, 'APPLIED');
  const before = chainCall(engine, 'getSnapshot');
  const catalog = JSON.parse(M.ShaderChainBindings.getShaderChainCatalog());
  for (const operator of [
    'colorize.generated-palette.v2', 'project.airocean.v2', 'project.bonne.v2',
    'project.peirce-square-fast.v2', 'project.peirce.v2', 'sample.grid.v2',
    'sample.twin-wave.v2', 'warp.affine.v2', 'warp.affine.v3',
    'warp.affine-periodic.v1', 'sphere.lens.mobius.v2',
  ]) {
    assert.equal(catalog.operators.some((entry) => entry.id === operator), false);
    const result = chainCall(engine, 'setShaderChain', [{instance: 'retired', operator}]);
    assert.equal(result.status, M.ChainStatus.UNKNOWN_OPERATOR);
    assert.equal(result.code, 'UNKNOWN_OPERATOR');
    assert.deepEqual(chainCall(engine, 'getSnapshot'), before);
  }
});
