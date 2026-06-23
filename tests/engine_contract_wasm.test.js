// @ts-nocheck
//
// Real-engine contract pin for the segmented-render path.
//
// segment_worker.test.js and segment_controller.test.js both run against a
// hand-written FakeEngine standing in for the WASM HolosphereEngine. Those mocks
// are fast and DOM-free, but nothing stops FakeEngine's method surface from
// drifting away from the real engine — a renamed/dropped binding, or a changed
// return shape (e.g. getArenaMetrics losing a field, setResolution returning
// non-boolean) — which the mocked suites would never catch.
//
// This test loads the REAL shipped module and exercises exactly the methods and
// return shapes the worker/controller (and therefore the FakeEngines) rely on,
// so a divergence between the contract and the engine fails here. Top-level await
// means an absent/un-instantiable module fails this file loudly rather than
// skipping the check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import createHolosphereModule from '../holosphere_wasm.js';

const M = await createHolosphereModule({ print() {}, printErr() {} });

// A resolution the WASM factory is built for (mirrors daydream.js's
// "Holosphere (20x96)" preset). Used to pin getPixels()'s length below.
const W = 96, H = 20;

// One shared engine, constructed once: the engine owns a single global arena, so
// a second instantiation traps (the app itself only ever makes one). A missing
// HolosphereEngine class throws here and fails the whole file loudly.
const engine = new M.HolosphereEngine();

test('HolosphereEngine exposes the method surface the FakeEngines mock', () => {
  // Every method the worker's FakeEngine and the controller's snapshot path call.
  for (const name of [
    'setResolution', 'setEffect', 'setParameter', 'setAnimationsPaused',
    'setClip', 'drawFrame', 'getRenderUs', 'getPixels', 'getArenaMetrics',
    'getParameterDefinitions',
  ]) {
    assert.equal(typeof engine[name], 'function',
      `HolosphereEngine is missing method ${name} (FakeEngine implements it)`);
  }
});

test('HolosphereEngine return shapes match what the segmented path consumes', () => {
  // setResolution must return a strict boolean — segment_worker gates on
  // `=== false`, so a non-boolean would silently slip past that guard.
  const ok = engine.setResolution(W, H);
  assert.equal(typeof ok, 'boolean', 'setResolution must return a boolean');
  assert.equal(ok, true, `the ${W}x${H} preset must be a buildable resolution`);

  // setEffect must return a strict boolean — daydream.js gates on `=== false`,
  // so a non-boolean (or a void-returning FakeEngine) would slip past that guard.
  // DistortedRing is the C++ bootstrap default — a guaranteed-registered name, so
  // the call must report success.
  const effectOk = engine.setEffect('DistortedRing');
  assert.equal(typeof effectOk, 'boolean', 'setEffect must return a boolean');
  assert.equal(effectOk, true, 'setEffect must succeed for a registered effect');

  // getParameterDefinitions: array-like of { name:string, value:number|boolean },
  // exactly what SegmentController._snapshotParams iterates.
  const defs = engine.getParameterDefinitions();
  assert.equal(typeof defs.length, 'number',
    'getParameterDefinitions must return an array-like value');
  if (defs.length > 0) {
    const p = defs[0];
    assert.equal(typeof p.name, 'string', 'param def must carry a string name');
    assert.ok(typeof p.value === 'number' || typeof p.value === 'boolean',
      'param def value must be a number or boolean');
    // setParameter takes a numeric value (the controller flattens bools to 1/0
    // before sending), so coerce the same way before the contract call. It
    // likewise returns a strict boolean (the GUI gates on `=== false`); a known
    // param name fed its own current value must report success.
    const paramOk = engine.setParameter(
      p.name, typeof p.value === 'boolean' ? (p.value ? 1 : 0) : p.value);
    assert.equal(typeof paramOk, 'boolean', 'setParameter must return a boolean');
    assert.equal(paramOk, true, 'setParameter must succeed for a known param name');
  }

  // The remaining void setters the worker drives, called the same way it does.
  engine.setAnimationsPaused(false);
  engine.setClip(0, W, 0, H);
  engine.drawFrame();

  // getPixels: a Uint16Array view sized W*H*3 (the worker copies rows out of it).
  const px = engine.getPixels();
  assert.ok(px instanceof Uint16Array, 'getPixels must return a Uint16Array');
  assert.equal(px.length, W * H * 3, 'getPixels length must be W*H*3');

  // getRenderUs: a number (the worker posts it as renderUs).
  assert.equal(typeof engine.getRenderUs(), 'number', 'getRenderUs must return a number');

  // getArenaMetrics: the three named arenas, each with the numeric fields the
  // worker marshals (usage / high_water_mark / capacity).
  const m = engine.getArenaMetrics();
  for (const arena of ['scratch_arena_a', 'scratch_arena_b', 'persistent_arena']) {
    assert.ok(m[arena], `getArenaMetrics must expose ${arena}`);
    for (const field of ['usage', 'high_water_mark', 'capacity']) {
      assert.equal(typeof m[arena][field], 'number',
        `getArenaMetrics().${arena}.${field} must be a number`);
    }
    // A real arena reports a nonzero capacity and usage that fits within it; a
    // FakeEngine modeling capacity as 0 (or usage past capacity) would
    // mis-represent the contract the worker marshals.
    assert.ok(m[arena].capacity > 0, `${arena}.capacity must be > 0`);
    assert.ok(m[arena].usage <= m[arena].capacity,
      `${arena}.usage must not exceed capacity`);
  }
});
