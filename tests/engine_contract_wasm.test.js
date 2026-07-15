// @ts-nocheck
//
// Real-engine contract pin for the segmented-render path. segment_worker and
// segment_controller run against a hand-written FakeEngine; this test loads the
// REAL shipped module and exercises exactly the methods and return shapes the
// worker/controller rely on, so a divergence between the FakeEngine contract and
// the engine fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import createHolosphereModule from '../holosphere_wasm.js';

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
