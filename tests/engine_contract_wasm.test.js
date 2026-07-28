// @ts-nocheck
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
import { KNOWN_OPS, PLATONIC_SOLIDS, CATALAN_BASES } from '../tools/solid_codegen.js';

const M = await createHolosphereModule({ print() {}, printErr() {} });

// A resolution the WASM factory is built for (mirrors daydream.js's
// "Holosphere (96x20)" preset). Used to pin getPixels()'s length below.
const W = 96, H = 20;

// One shared engine: the engine owns a single global arena, so a second
// instantiation traps (the app itself only ever makes one).
const engine = new M.HolosphereEngine();

test('HolosphereEngine exposes the method surface the FakeEngines mock', () => {
  for (const name of [
    'setResolution', 'setEffect', 'setParameter', 'setAnimationsPaused',
    'setClip', 'drawFrame', 'getRenderUs', 'getPixels', 'getArenaMetrics',
    'getParameterDefinitions', 'getParamValues',
  ]) {
    assert.equal(typeof engine[name], 'function',
      `HolosphereEngine is missing method ${name} (FakeEngine implements it)`);
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
  const paramOk = engine.setParameter(
    p.name, typeof p.value === 'boolean' ? (p.value ? 1 : 0) : p.value);
  assert.equal(typeof paramOk, 'boolean', 'setParameter must return a boolean');
  assert.equal(paramOk, true, 'setParameter must succeed for a known param name');

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

  assert.equal(typeof engine.getRenderUs(), 'number', 'getRenderUs must return a number');

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
