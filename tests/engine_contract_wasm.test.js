//
// Real-engine contract pin for the WASM surface. segment_worker and
// segment_controller run against a hand-written FakeEngine; this test loads the
// REAL shipped module and exercises exactly the methods and return shapes the
// worker/controller rely on, so a divergence between the FakeEngine contract and
// the engine fails here. It also pins MeshOps and PaletteOps, the classes the
// standalone tools (solids.html, palettes.html) run on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import createHolosphereModule from '../holosphere_wasm.js';
import { KNOWN_OPS, OP_DEFS, PLATONIC_SOLIDS, CATALAN_BASES, applyOp } from '../tools/solid_codegen.js';
import { ENGINE_METHODS, ParamSetResult } from './fake_engine.js';
import { isViewLive, refreshPixelView } from '../pixel_view.js';

// The module's stdout, captured rather than dropped: the WASM bridge answers an
// out-of-domain op argument by clamping it and logging, so this is the only
// channel that reports one.
const moduleLogs = [];
const sink = (line) => moduleLogs.push(line);
const M = await createHolosphereModule({ print: sink, printErr: sink });

// A resolution the WASM factory is built for (mirrors daydream.js's
// "Holosphere (96x20)" preset). Used to pin getPixels()'s length below.
const W = 96, H = 20;

// One shared engine: the engine owns a single global arena, so a second
// instantiation traps (the app itself only ever makes one).
const engine = new M.HolosphereEngine();

test('HolosphereEngine exposes the method surface the FakeEngines mock', () => {
  for (const name of ENGINE_METHODS) {
    assert.equal(typeof engine[name], 'function',
      `HolosphereEngine is missing method ${name} (FakeEngine implements it)`);
  }
});

test('the module ParamSetResult enum matches the fake_engine.js mirror', () => {
  assert.ok(M.ParamSetResult, 'the module must export ParamSetResult');
  // Embind exposes the enum as a constructor whose value names sit beside
  // plumbing properties (values, argCount); the values themselves are the
  // instanceof-filtered keys.
  const moduleNames = Object.keys(M.ParamSetResult)
    .filter((k) => M.ParamSetResult[k] instanceof M.ParamSetResult);
  assert.deepEqual(moduleNames.sort(), Object.keys(ParamSetResult).sort(),
    'fake_engine.js ParamSetResult must mirror the module enum roster');
  for (const name of Object.keys(ParamSetResult)) {
    assert.equal(M.ParamSetResult[name].value, ParamSetResult[name].value,
      `fake_engine.js ParamSetResult.${name}.value must match the module`);
  }
});

test('getSupportedResolutions reports buildable [w, h] rows', () => {
  const rows = M.HolosphereEngine.getSupportedResolutions();
  assert.ok(Array.isArray(rows), 'getSupportedResolutions must return an array');
  assert.ok(rows.length > 0, 'the engine must report at least one resolution');
  for (const row of rows) {
    assert.ok(Array.isArray(row) && row.length === 2,
      'each reported resolution must be a [w, h] pair');
    const [w, h] = row;
    assert.equal(typeof w, 'number', 'reported width must be a number');
    assert.equal(typeof h, 'number', 'reported height must be a number');
    assert.equal(engine.setResolution(w, h), true,
      `the engine must build the ${w}x${h} row it reports`);
  }
  // daydream.js narrows its preset table to these rows; a preset it offers must
  // stay reachable.
  assert.ok(rows.some(([w, h]) => w === W && h === H),
    `the ${W}x${H} preset must be a reported resolution`);
});

test('HolosphereEngine return shapes match what the segmented path consumes', () => {
  // Strict boolean: segment_worker gates on `=== false`.
  const ok = engine.setResolution(W, H);
  assert.equal(typeof ok, 'boolean', 'setResolution must return a boolean');
  assert.equal(ok, true, `the ${W}x${H} preset must be a buildable resolution`);

  // DisplacementField is the C++ bootstrap default, so it is guaranteed registered.
  const effectOk = engine.setEffect('DisplacementField');
  assert.equal(typeof effectOk, 'boolean', 'setEffect must return a boolean');
  assert.equal(effectOk, true, 'setEffect must succeed for a registered effect');

  const defs = engine.getParameterDefinitions();
  assert.equal(typeof defs.length, 'number',
    'getParameterDefinitions must return an array-like value');
  assert.ok(defs.length > 0,
    'the bootstrap effect (DisplacementField) must expose at least one parameter');
  const p = defs[0];
  assert.equal(typeof p.name, 'string', 'param def must carry a string name');
  assert.ok(typeof p.value === 'number' || typeof p.value === 'boolean',
    'param def value must be a number or boolean');
  // Controller flattens bools to 1/0 before calling setParameter.
  const paramResult = engine.setParameter(
    p.name, typeof p.value === 'boolean' ? (p.value ? 1 : 0) : p.value);
  assert.equal(paramResult, M.ParamSetResult.APPLIED,
    'setParameter must report APPLIED for a known param name');

  engine.setAnimationsPaused(false);
  engine.setClip(0, W, 0, H);
  engine.drawFrame();

  const px = engine.getPixels();
  assert.ok(px instanceof Uint16Array, 'getPixels must return a Uint16Array');
  assert.equal(px.length, W * H * 3, 'getPixels length must be W*H*3');

  // Segment 0 streams these post-frame; the worker does Array.from() on the view.
  const paramValues = engine.getParamValues();
  assert.equal(typeof paramValues.length, 'number',
    'getParamValues must return an array-like value');
  for (const v of paramValues) {
    assert.equal(typeof v, 'number', 'getParamValues elements must be numbers');
  }

  const m = engine.getArenaMetrics();
  for (const arena of ['scratch_arena_a', 'scratch_arena_b', 'persistent_arena']) {
    assert.ok(m[arena], `getArenaMetrics must expose ${arena}`);
    for (const field of ['usage', 'high_water_mark', 'capacity']) {
      assert.equal(typeof m[arena][field], 'number',
        `getArenaMetrics().${arena}.${field} must be a number`);
    }
    assert.ok(m[arena].capacity > 0, `${arena}.capacity must be > 0`);
    assert.ok(m[arena].usage <= m[arena].capacity,
      `${arena}.usage must not exceed capacity`);
  }
});

const paramNames = (defs) => Array.from(defs, (d) => d.name);

test('an unknown effect name is rejected and leaves the prior effect renderable', () => {
  assert.equal(engine.setResolution(W, H), true, `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), true,
    'setEffect must succeed for a registered effect');
  const before = paramNames(engine.getParameterDefinitions());

  assert.equal(engine.setEffect('NoSuchEffect'), false,
    'setEffect must return false for an unregistered effect name');
  assert.deepEqual(paramNames(engine.getParameterDefinitions()), before,
    'a rejected setEffect must keep the prior effect installed');

  assert.equal(engine.setClip(0, W, 0, H), true,
    'the prior effect must still accept a full-canvas clip');
  engine.drawFrame();
  assert.equal(engine.getPixels().length, W * H * 3,
    'the prior effect must still render into the full buffer');
});

test('an unsupported resolution is rejected and keeps the prior one active', () => {
  const supported = M.HolosphereEngine.getSupportedResolutions()
    .map(([w, h]) => `${w}x${h}`);
  assert.ok(!supported.includes('97x21'),
    '97x21 must stay unsupported for this test to exercise the reject path');

  assert.equal(engine.setResolution(W, H), true, `${W}x${H} must stay buildable`);
  assert.equal(engine.setResolution(97, 21), false,
    'setResolution must return false for an unsupported size');
  assert.equal(engine.getBufferLength(), W * H * 3,
    'a rejected resolution must leave the prior one active');
});

test('malformed clip bounds are rejected', () => {
  assert.equal(engine.setResolution(W, H), true, `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), true,
    'setEffect must succeed after a resolution change');
  for (const bounds of [
    [-1, W, 0, H], [0, W + 1, 0, H], [0, W, -1, H], [0, W, 0, H + 1],
    [W, 0, 0, H], [0, W, H, 0],
  ]) {
    assert.equal(engine.setClip(...bounds), false,
      `setClip(${bounds.join(', ')}) must be rejected`);
  }
  assert.equal(engine.setClip(0, W, 0, H), true,
    'a full-canvas clip must still be accepted after the rejects');
});

test('a rejected parameter write names its reason', () => {
  assert.equal(engine.setResolution(W, H), true, `${W}x${H} must stay buildable`);
  let found = null;
  for (const name of Object.keys(engine.getEffectSizes())) {
    assert.equal(engine.setEffect(name), true, `setEffect must succeed for ${name}`);
    const defs = engine.getParameterDefinitions();
    for (let i = 0; i < defs.length; i++) {
      assert.equal(typeof defs[i].readonly, 'boolean',
        `${name}.${defs[i].name} must carry a boolean readonly flag`);
      if (defs[i].readonly && !found) found = { effect: name, def: defs[i] };
    }
    if (found) break;
  }
  assert.ok(found,
    'no effect exposes a readonly parameter, so the reject path is unreachable');
  assert.equal(engine.setParameter(found.def.name, found.def.value),
    M.ParamSetResult.READONLY,
    `setParameter must report READONLY for ${found.effect}.${found.def.name}`);
  assert.equal(engine.setParameter('NoSuchParameter', 0),
    M.ParamSetResult.UNKNOWN_PARAM,
    'setParameter must report UNKNOWN_PARAM for an unknown parameter name');
  const editable = engine.getParameterDefinitions()
    .find((d) => !d.readonly && typeof d.value === 'number');
  assert.ok(editable, `${found.effect} must expose an editable float param`);
  assert.equal(engine.setParameter(editable.name, NaN),
    M.ParamSetResult.NON_FINITE,
    'setParameter must report NON_FINITE for a NaN value');
});

test('strobeColumns and getEffectSizes return the shapes daydream consumes', () => {
  assert.equal(engine.setResolution(W, H), true, `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), true,
    'setEffect must succeed after the readonly scan');
  // driver.js gates the column-fill arc on `=== false`.
  assert.equal(typeof engine.strobeColumns(), 'boolean',
    'strobeColumns must return a boolean');

  // daydream.js reads this map to label sidebar entries.
  const sizes = engine.getEffectSizes();
  const names = Object.keys(sizes);
  assert.ok(names.includes('DisplacementField'),
    'getEffectSizes must name the effects the factory builds');
  for (const name of names) {
    assert.equal(typeof sizes[name], 'number',
      `getEffectSizes().${name} must be a number`);
  }
});

// getBufferLength has no daydream call site; it is pinned here as intended API.
test('getBufferLength reports the active resolution buffer length', () => {
  for (const [w, h] of M.HolosphereEngine.getSupportedResolutions()) {
    assert.equal(engine.setResolution(w, h), true,
      `the engine must build the ${w}x${h} row it reports`);
    assert.equal(engine.getBufferLength(), w * h * 3,
      `getBufferLength must report w*h*3 at ${w}x${h}`);
  }
  assert.equal(engine.setResolution(W, H), true, `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), true,
    'setEffect must succeed after a resolution change');
  assert.equal(engine.getBufferLength(), engine.getPixels().length,
    'getBufferLength must equal the getPixels view length');
});

// engine_host.js calls getParamGeneration through an optional-call guard and
// daydream.js's Pole LOD slider calls setPoleLod on an optional chain, so a
// dropped export is silent on both call sites.
test('getParamGeneration and setPoleLod stay exported', () => {
  assert.equal(engine.setResolution(W, H), true, `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), true,
    'setEffect must succeed for a registered effect');

  const generation = engine.getParamGeneration();
  assert.equal(typeof generation, 'number', 'getParamGeneration must return a number');
  assert.equal(engine.setEffect('DisplacementField'), true,
    'setEffect must succeed on a reload');
  assert.notEqual(engine.getParamGeneration(), generation,
    'getParamGeneration must change across a setEffect, or a stale param snapshot ' +
    'cannot be detected');

  assert.equal(typeof engine.setPoleLod, 'function',
    'setPoleLod must stay callable (daydream.js binds the Pole LOD slider to it)');
  // daydream.js's slider spans [0, 2].
  for (const v of [0, 1, 2]) engine.setPoleLod(v);
  engine.setPoleLod(0);
});

// pixel_view.test.js proves refreshPixelView against a synthetic detached
// buffer; this is the only place the real growth happens with a view
// outstanding. MeshOps' 16 MB tooling block is allocated lazily on first use and
// cannot fit the heap the module starts with, so that first call grows it, which
// detaches every live view. Must run ahead of every other MeshOps test in this
// file, which would allocate the block first and leave nothing to grow.
test('heap growth detaches a held pixel view and the re-fetch is live and identical', () => {
  assert.equal(engine.setResolution(W, H), true, `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), true,
    'setEffect must succeed for a registered effect');
  engine.setClip(0, W, 0, H);
  engine.drawFrame();

  const held = engine.getPixels();
  assert.equal(isViewLive(held), true, 'a freshly fetched view must be live');
  const snapshot = Array.from(held);

  const mesh = M.MeshOps.fromSolidName('cube');
  assert.ok(mesh, 'fromSolidName("cube") must build a mesh');
  mesh.delete();
  M.MeshOps.clearToolingMemory();

  assert.equal(isViewLive(held), false,
    'the 16 MB tooling allocation must grow the heap and detach the held view; ' +
    'if it no longer does, nothing exercises the detachment contract daydream.js ' +
    'guards against every frame');

  const { refreshed, view } = refreshPixelView(held, () => engine.getPixels());
  assert.equal(refreshed, true, 'a detached view must be re-fetched');
  assert.equal(isViewLive(view), true, 'the re-fetched view must alias live memory');
  assert.equal(view.length, snapshot.length,
    're-fetched view length must match the pre-growth view');
  assert.deepEqual(Array.from(view), snapshot,
    'growth must preserve the pixels: the re-fetched view must be byte-identical');
});

// Everything MeshOps binds that is not a Conway/SolidBuilder operator. The
// remainder of MeshOps.prototype is the op set the C++ MESHOP lists generate.
const MESH_OPS_NON_OPS = new Set([
  'constructor', 'getVertices', 'getFaces', 'classifyFaces',
]);

const meshOpNames = () =>
  Object.getOwnPropertyNames(M.MeshOps.prototype)
    .filter(name => !MESH_OPS_NON_OPS.has(name)).sort();

test('MeshOps exposes the method surface the solids tool drives', () => {
  assert.equal(typeof M.MeshOps, 'function', 'the module must export MeshOps');
  for (const name of [
    'clearToolingMemory', 'fromSolidName', 'getRegistry', 'getArenaMetrics',
  ]) {
    assert.equal(typeof M.MeshOps[name], 'function',
      `MeshOps is missing class function ${name} (solids.html calls it)`);
  }
  for (const name of ['getVertices', 'getFaces', 'classifyFaces']) {
    assert.equal(typeof M.MeshOps.prototype[name], 'function',
      `MeshOps is missing method ${name} (solids.html calls it)`);
  }
  assert.ok(meshOpNames().length > 0,
    'MeshOps must bind at least one Conway operator');
});

test('solid_codegen KNOWN_OPS matches the operators MeshOps binds', () => {
  assert.deepEqual([...KNOWN_OPS].sort(), meshOpNames(),
    'the codegen op list and the ops bound by the WASM module must agree; ' +
    'update tools/solid_codegen.js KNOWN_OPS to match the engine');
});

// One case per OP_DEFS slider endpoint: the named param at that edge, every
// other param of the op at its default.
function opBoundCases(def) {
  const names = Object.keys(def.params);
  if (names.length === 0) return [{ label: 'no params', params: {} }];
  return names.flatMap((name) => ['min', 'val', 'max'].map((edge) => {
    const params = Object.fromEntries(names.map((k) => [k, def.params[k].val]));
    params[name] = def.params[name][edge];
    return { label: `${name}=${edge} (${params[name]})`, params };
  }));
}

// A bound outside the engine's domain for its operator is invisible in the
// preview — the bridge clamps the argument and logs — while
// generateFuncAndRecipe emits the authored value, so the exported C++ trips an
// always-on engine assert once compiled into firmware. Replaying each endpoint
// on the live bridge and requiring a silent, accepted call is what makes the
// engine, not a JS mirror of it, the authority on those bounds.
test('every OP_DEFS bound sits inside the engine domain the WASM bridge enforces', () => {
  const seed = 'cube';
  for (const [op, def] of Object.entries(OP_DEFS)) {
    for (const { label, params } of opBoundCases(def)) {
      moduleLogs.length = 0;
      const mesh = M.MeshOps.fromSolidName(seed);
      let out = null;
      try {
        // applyOp throws on a soft reject (bridge returned null).
        out = applyOp(mesh, { op, params });
      } finally {
        if (out) out.delete();
        mesh.delete();
        M.MeshOps.clearToolingMemory();
      }
      assert.deepEqual(moduleLogs, [],
        `${op} ${label} on a ${seed} made the WASM bridge log; the OP_DEFS ` +
        'range reaches outside the engine domain for that operator, so the ' +
        'preview silently clamps while the generated C++ carries the authored ' +
        'value into an engine assert. Narrow the range in tools/solid_codegen.js');
    }
  }
});

test('the Platonic and Catalan seed lists name registered Simple solids', () => {
  const registry = M.MeshOps.getRegistry();
  const simple = new Set();
  for (let i = 0; i < registry.length; i++) {
    if (registry[i].category === 'Simple') simple.add(registry[i].name);
  }
  for (const name of [...PLATONIC_SOLIDS, ...CATALAN_BASES]) {
    assert.ok(simple.has(name),
      `solid_codegen.js lists "${name}" but the engine registers no Simple solid ` +
      'by that name; update tools/solid_codegen.js to match solids.h');
  }
  for (const name of PLATONIC_SOLIDS) {
    assert.ok(!CATALAN_BASES.has(name),
      `"${name}" is in both seed lists; the namespace qualifier would be ambiguous`);
  }
});

// MeshOps.getRecipe has no daydream call site; it is pinned here as intended API.
test('MeshOps.getRecipe returns an authored chain for every Complex solid', () => {
  assert.equal(typeof M.MeshOps.getRecipe, 'function',
    'MeshOps is missing class function getRecipe');
  const registry = M.MeshOps.getRegistry();
  const simple = new Set();
  const complex = [];
  for (let i = 0; i < registry.length; i++) {
    if (registry[i].category === 'Simple') simple.add(registry[i].name);
    else if (registry[i].category === 'Complex') complex.push(registry[i].name);
  }
  assert.ok(complex.length > 0, 'the registry must expose at least one Complex solid');
  for (const name of complex) {
    const recipe = M.MeshOps.getRecipe(name);
    assert.ok(recipe, `Complex solid "${name}" must carry an authored recipe`);
    assert.ok(simple.has(recipe.seed),
      `recipe seed "${recipe.seed}" of "${name}" must name a registered Simple solid`);
    assert.ok(Array.isArray(recipe.ops) && recipe.ops.length > 0,
      `recipe of "${name}" must carry a non-empty ops array`);
    for (const step of recipe.ops) {
      assert.ok(KNOWN_OPS.has(step.op),
        `recipe of "${name}" uses op "${step.op}", which MeshOps does not bind`);
      assert.equal(typeof step.param, 'number',
        `recipe step "${step.op}" of "${name}" must carry a numeric param`);
      assert.equal(typeof step.twist, 'number',
        `recipe step "${step.op}" of "${name}" must carry a numeric twist`);
    }
  }
  assert.equal(M.MeshOps.getRecipe('NoSuchSolid'), null,
    'getRecipe must return null for an unknown name');
});

test('PaletteOps exposes the method surface the palette tool drives', () => {
  assert.equal(typeof M.PaletteOps, 'function',
    'the module must export PaletteOps');
  const ops = new M.PaletteOps();
  try {
    assert.equal(typeof ops.bakeLut, 'function',
      'PaletteOps is missing bakeLut (palettes.html calls it)');
    // STRAIGHT gradient over three in-range HSV keys.
    const lut = ops.bakeLut(0, 0, 255, 255, 85, 255, 255, 170, 255, 255);
    assert.ok(lut instanceof Uint8Array, 'bakeLut must return a Uint8Array');
    assert.equal(lut.length, 256 * 3, 'bakeLut length must be 256*3');
  } finally {
    ops.delete();
  }
});
