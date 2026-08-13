//
// Real-engine contract pin for the WASM surface. segment_worker and
// segment_controller run against a hand-written FakeEngine; this test loads the
// REAL shipped module and exercises exactly the methods and return shapes the
// worker/controller rely on, so a divergence between the FakeEngine contract and
// the engine fails here. It also pins MeshOps and PaletteOps, the classes the
// standalone tools (solids.html, palettes.html) run on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import createHolosphereModule from '../holosphere_wasm.js';
import {
  KNOWN_OPS, OP_DEFS, PLATONIC_SOLIDS, CATALAN_BASES, SIMPLE_SEEDS,
  DEFINED_SEED_CONSTANTS, applyOp, meshOpFailure, MESH_OP_RESULT_NAMES,
} from '../tools/solid_codegen.js';
import {
  ENGINE_METHODS, ENGINE_OPTIONAL_METHODS, ParamSetResult, ClipSetResult,
  ResolutionSetResult, EffectSetResult, FullConfigRestoreResult,
} from './fake_engine.js';
import { isViewLive, refreshPixelView } from '../pixel_view.js';
import { selectorControlValue } from '../param_sync.js';

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

// Both non-rejections leave the requested size active; only RESIZED tears the
// effect down. The shared engine makes either possible at most call sites.
const resolutionOk = (r) => r === M.ResolutionSetResult.RESIZED
  || r === M.ResolutionSetResult.ALREADY_ACTIVE;

// The module exports no heap view, so the pixel buffer stands in for one: it
// aliases the heap, so its ArrayBuffer is the heap's.
const heapBytes = () => engine.getPixels().buffer.byteLength;
// Read before any case runs. Resolution changes allocate inside this heap; only
// MeshOps' tooling block grows it.
const INITIAL_HEAP_BYTES = heapBytes();

test('HolosphereEngine exposes the method surface the FakeEngines mock', () => {
  for (const name of ENGINE_METHODS) {
    assert.equal(typeof engine[name], 'function',
      `HolosphereEngine is missing method ${name} (FakeEngine implements it)`);
  }
});

// holosphere_wasm.d.ts is hand-written and stands in for glue the typecheck
// never reads, so nothing but this pin keeps it from drifting off the module.
const DTS = readFileSync(new URL('../holosphere_wasm.d.ts', import.meta.url), 'utf8');

/**
 * Body of a named `export interface` declaration, comments stripped.
 * @param {string} name - Interface name.
 * @returns {string} The declaration body.
 */
function interfaceBody(name) {
  const at = DTS.indexOf(`export interface ${name} {`);
  assert.ok(at >= 0, `holosphere_wasm.d.ts must declare interface ${name}`);
  const end = DTS.indexOf('\n}', at);
  assert.ok(end > at, `interface ${name} must be closed at column 0`);
  return DTS.slice(at, end).replace(/\/\*[\s\S]*?\*\//g, '');
}

test('holosphere_wasm.d.ts declares the pinned engine method roster', () => {
  const body = interfaceBody('HolosphereEngine');
  // The `\??` accepts the optional members the full-config surface is declared
  // as; without it they parse as nothing and are pinned by neither loop below.
  const declared = new Set(
    [...body.matchAll(/^\s*([A-Za-z_]\w*)\??\s*\(/gm)].map((m) => m[1]));
  // getAnimationsPaused is read through an optional call, so it is absent from
  // ENGINE_METHODS while still being part of the surface the app drives.
  for (const name of [
    ...ENGINE_METHODS, ...ENGINE_OPTIONAL_METHODS, 'getAnimationsPaused',
  ]) {
    assert.ok(declared.has(name),
      `holosphere_wasm.d.ts is missing ${name}, which the app calls`);
  }
  for (const name of declared) {
    assert.equal(typeof engine[name], 'function',
      `holosphere_wasm.d.ts declares ${name}, which the module does not export`);
  }
});

test('holosphere_wasm.d.ts declares the engine statics the app calls', () => {
  const body = interfaceBody('HolosphereModule');
  const at = body.indexOf('HolosphereEngine:');
  assert.ok(at >= 0, 'HolosphereModule must carry the engine constructor');
  const decl = body.slice(at, body.indexOf('\n  };', at));
  assert.match(decl, /new\s*\(\s*\)\s*:\s*HolosphereEngine/,
    'the constructor signature must survive the statics being declared beside it');
  assert.match(decl, /getSupportedResolutions\s*\(/,
    'daydream.js narrows its resolution presets through this static; a bare '
    + '`new () => HolosphereEngine` declares it out of existence');
  assert.equal(typeof M.HolosphereEngine.getSupportedResolutions, 'function',
    'the module must expose getSupportedResolutions on the constructor');
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

test('the module ClipSetResult enum matches the fake_engine.js mirror', () => {
  assert.ok(M.ClipSetResult, 'the module must export ClipSetResult');
  const moduleNames = Object.keys(M.ClipSetResult)
    .filter((k) => M.ClipSetResult[k] instanceof M.ClipSetResult);
  assert.deepEqual(moduleNames.sort(), Object.keys(ClipSetResult).sort(),
    'fake_engine.js ClipSetResult must mirror the module enum roster');
  for (const name of Object.keys(ClipSetResult)) {
    assert.equal(M.ClipSetResult[name].value, ClipSetResult[name].value,
      `fake_engine.js ClipSetResult.${name}.value must match the module`);
  }
});

test('the module ResolutionSetResult enum matches the fake_engine.js mirror', () => {
  assert.ok(M.ResolutionSetResult, 'the module must export ResolutionSetResult');
  const moduleNames = Object.keys(M.ResolutionSetResult)
    .filter((k) => M.ResolutionSetResult[k] instanceof M.ResolutionSetResult);
  assert.deepEqual(moduleNames.sort(), Object.keys(ResolutionSetResult).sort(),
    'fake_engine.js ResolutionSetResult must mirror the module enum roster');
  for (const name of Object.keys(ResolutionSetResult)) {
    assert.equal(M.ResolutionSetResult[name].value, ResolutionSetResult[name].value,
      `fake_engine.js ResolutionSetResult.${name}.value must match the module`);
  }
});

test('the module EffectSetResult enum matches the fake_engine.js mirror', () => {
  assert.ok(M.EffectSetResult, 'the module must export EffectSetResult');
  const moduleNames = Object.keys(M.EffectSetResult)
    .filter((k) => M.EffectSetResult[k] instanceof M.EffectSetResult);
  assert.deepEqual(moduleNames.sort(), Object.keys(EffectSetResult).sort(),
    'fake_engine.js EffectSetResult must mirror the module enum roster');
  for (const name of Object.keys(EffectSetResult)) {
    assert.equal(M.EffectSetResult[name].value, EffectSetResult[name].value,
      `fake_engine.js EffectSetResult.${name}.value must match the module`);
  }
});

// daydream.js compares restoreFullConfigSnapshot's return against
// module.FullConfigRestoreResult?.APPLIED and segment_worker.js reads the whole
// roster off the module, both through optional chains: a renumbered or dropped
// value reads as a silent restore failure at those call sites.
test('the module FullConfigRestoreResult enum matches the fake_engine.js mirror', () => {
  assert.ok(M.FullConfigRestoreResult, 'the module must export FullConfigRestoreResult');
  const moduleNames = Object.keys(M.FullConfigRestoreResult)
    .filter((k) => M.FullConfigRestoreResult[k] instanceof M.FullConfigRestoreResult);
  assert.deepEqual(moduleNames.sort(), Object.keys(FullConfigRestoreResult).sort(),
    'fake_engine.js FullConfigRestoreResult must mirror the module enum roster');
  for (const name of Object.keys(FullConfigRestoreResult)) {
    assert.equal(M.FullConfigRestoreResult[name].value,
      FullConfigRestoreResult[name].value,
      `fake_engine.js FullConfigRestoreResult.${name}.value must match the module`);
  }
});

test('getSupportedResolutions reports buildable [w, h] rows', () => {
  const rows = M.HolosphereEngine.getSupportedResolutions();
  assert.ok(Array.isArray(rows), 'getSupportedResolutions must return an array');
  assert.ok(rows.length > 0, 'the engine must report at least one resolution');
  const malformed = [];
  const unbuildable = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2
      || typeof row[0] !== 'number' || typeof row[1] !== 'number') {
      malformed.push(JSON.stringify(row));
      continue;
    }
    const [w, h] = row;
    if (!resolutionOk(engine.setResolution(w, h))) unbuildable.push(`${w}x${h}`);
  }
  assert.deepEqual(malformed.slice(0, 5), [],
    `${malformed.length} reported resolutions are not numeric [w, h] pairs`);
  assert.deepEqual(unbuildable.slice(0, 5), [],
    `${unbuildable.length} reported resolutions the engine cannot build`);
  // daydream.js narrows its preset table to these rows; a preset it offers must
  // stay reachable.
  assert.ok(rows.some(([w, h]) => w === W && h === H),
    `the ${W}x${H} preset must be a reported resolution`);
});

test('HolosphereEngine return shapes match what the segmented path consumes', () => {
  // Enum results: segment_worker compares against Module.ResolutionSetResult /
  // Module.EffectSetResult values, never by truthiness.
  const ok = engine.setResolution(W, H);
  assert.ok(ok instanceof M.ResolutionSetResult,
    'setResolution must return a ResolutionSetResult value');
  assert.ok(resolutionOk(ok), `the ${W}x${H} preset must be a buildable resolution`);

  // DisplacementField is on HS_EFFECT_LIST, so the factory registers it at every
  // supported resolution.
  const effectOk = engine.setEffect('DisplacementField');
  assert.ok(effectOk instanceof M.EffectSetResult,
    'setEffect must return an EffectSetResult value');
  assert.equal(effectOk, M.EffectSetResult.INSTALLED,
    'setEffect must report INSTALLED for a registered effect');

  const defs = engine.getParameterDefinitions();
  assert.equal(typeof defs.length, 'number',
    'getParameterDefinitions must return an array-like value');
  assert.ok(defs.length > 0,
    'DisplacementField must expose at least one parameter');
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
  // APPLIED, not FULL_FRAME_KEPT: DisplacementField's filter pipeline does not
  // cross segment bands, so the clip narrows.
  assert.equal(engine.setClip(0, W, 0, H), M.ClipSetResult.APPLIED,
    'setClip must report APPLIED for a full-canvas band');
  engine.drawFrame();

  const px = engine.getPixels();
  assert.ok(px instanceof Uint16Array, 'getPixels must return a Uint16Array');
  assert.equal(px.length, W * H * 3, 'getPixels length must be W*H*3');

  // Segment 0 streams these post-frame; the worker does Array.from() on the view.
  const paramValues = engine.getParamValues();
  assert.equal(typeof paramValues.length, 'number',
    'getParamValues must return an array-like value');
  assert.deepEqual(
    Array.from(paramValues).filter((v) => typeof v !== 'number'), [],
    'getParamValues elements must be numbers');

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
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), M.EffectSetResult.INSTALLED,
    'setEffect must succeed for a registered effect');
  const before = paramNames(engine.getParameterDefinitions());

  assert.equal(engine.setEffect('NoSuchEffect'), M.EffectSetResult.UNKNOWN_EFFECT,
    'setEffect must report UNKNOWN_EFFECT for an unregistered effect name');
  assert.deepEqual(paramNames(engine.getParameterDefinitions()), before,
    'a rejected setEffect must keep the prior effect installed');

  assert.equal(engine.setClip(0, W, 0, H), M.ClipSetResult.APPLIED,
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

  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setResolution(97, 21), M.ResolutionSetResult.UNSUPPORTED,
    'setResolution must report UNSUPPORTED for an unsupported size');
  assert.equal(engine.getBufferLength(), W * H * 3,
    'a rejected resolution must leave the prior one active');
});

test('malformed clip bounds are rejected', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), M.EffectSetResult.INSTALLED,
    'setEffect must succeed after a resolution change');
  for (const bounds of [
    [-1, W, 0, H], [0, W + 1, 0, H], [0, W, -1, H], [0, W, 0, H + 1],
    [W, 0, 0, H], [0, W, H, 0],
  ]) {
    assert.equal(engine.setClip(...bounds), M.ClipSetResult.INVALID_BOUNDS,
      `setClip(${bounds.join(', ')}) must be rejected`);
  }
  assert.equal(engine.setClip(0, W, 0, H), M.ClipSetResult.APPLIED,
    'a full-canvas clip must still be accepted after the rejects');
});

// segment_worker faults the whole pool on INVALID_BOUNDS, so NO_EFFECT — the
// ordinary state between a resolution change and the setEffect that follows it —
// must stay a distinct value rather than collapsing into the same rejection.
test('an effectless engine reports NO_EFFECT, not a bounds rejection', () => {
  const other = M.HolosphereEngine.getSupportedResolutions()
    .find(([w, h]) => w !== W || h !== H);
  assert.ok(other, 'a second supported resolution is needed to tear the effect down');

  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), M.EffectSetResult.INSTALLED,
    'setEffect must succeed for a registered effect');
  const [ow, oh] = other;
  assert.equal(engine.setResolution(ow, oh), M.ResolutionSetResult.RESIZED,
    `switching to ${ow}x${oh} must report RESIZED`);
  assert.equal(engine.setClip(0, ow, 0, oh), M.ClipSetResult.NO_EFFECT,
    'a resolution change tears the effect down, so the clip has no receiver');

  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
});

// The two non-rejections must stay distinct: only RESIZED obliges the caller to
// re-apply setEffect/setClip, and treating ALREADY_ACTIVE as a resize would
// needlessly tear the app's GUI and worker pool down on every same-size apply.
test('a request matching the active resolution reports ALREADY_ACTIVE and keeps the effect', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), M.EffectSetResult.INSTALLED,
    'setEffect must succeed for a registered effect');
  assert.equal(engine.setResolution(W, H), M.ResolutionSetResult.ALREADY_ACTIVE,
    'a same-size request must report ALREADY_ACTIVE');
  assert.ok(engine.getParameterDefinitions().length > 0,
    'an ALREADY_ACTIVE setResolution must leave the current effect installed');
});

test('a rejected parameter write names its reason', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  // Every effect, not just up to the first readonly hit: stopping there made the
  // flag coverage depend on where one happens to sit in the name order. The scan
  // accumulates so its assertion count does not track the roster's size.
  let found = null;
  const uninstallable = [];
  const nonBoolean = [];
  for (const name of Object.keys(engine.getEffectSizes())) {
    if (engine.setEffect(name) !== M.EffectSetResult.INSTALLED) {
      uninstallable.push(name);
      continue;
    }
    const defs = engine.getParameterDefinitions();
    for (let i = 0; i < defs.length; i++) {
      if (typeof defs[i].readonly !== 'boolean')
        nonBoolean.push(`${name}.${defs[i].name}`);
      if (defs[i].readonly && !found)
        found = { effect: name, name: defs[i].name, value: defs[i].value };
    }
  }
  assert.deepEqual(uninstallable.slice(0, 5), [],
    `setEffect failed for ${uninstallable.length} registered effects`);
  assert.deepEqual(nonBoolean.slice(0, 5), [],
    `${nonBoolean.length} params carry no boolean readonly flag`);
  assert.ok(found,
    'no effect exposes a readonly parameter, so the reject path is unreachable');
  assert.equal(engine.setEffect(found.effect), M.EffectSetResult.INSTALLED,
    `setEffect must succeed for ${found.effect}`);
  assert.equal(engine.setParameter(found.name, found.value),
    M.ParamSetResult.READONLY,
    `setParameter must report READONLY for ${found.effect}.${found.name}`);
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

test('parameter definitions separate rendered and requested state', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('ShaderBall'), M.EffectSetResult.INSTALLED);
  const before = engine.getParameterDefinitions().find((d) => d.name === 'Lens');
  assert.ok(before, 'ShaderBall must expose the Lens selector');
  assert.equal(typeof before.requestedValue, 'number');
  assert.equal(typeof before.acceptedValue, 'number');

  // Admission needs a compiled program for the resulting topology; Glitch is
  // the lens the default topology has one for, so this write is accepted
  // rather than held pending behind a warning.
  const requested = before.options?.indexOf('Glitch');
  assert.ok(requested > 0 && requested !== before.value,
    'Glitch must be a compiled lens alternative to the default');
  assert.equal(engine.setParameter('Lens', requested), M.ParamSetResult.APPLIED);
  const after = engine.getParameterDefinitions().find((d) => d.name === 'Lens');

  assert.equal(after.value, before.value,
    'the GUI value remains the renderer-owned state until a frame advances');
  assert.equal(after.requestedValue, requested,
    'reload/worker initialization can copy the accepted write immediately');
  assert.equal(after.acceptedValue, requested,
    'a valid request is immediately available as the renderer seed');
  assert.equal(selectorControlValue(after), requested,
    'the GUI selector must retain the accepted request while rendering catches up');
});

test('ShaderBall reports an invalid selector without changing its neighbors', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('ShaderBall'), M.EffectSetResult.INSTALLED);
  let before = engine.getParameterDefinitions();
  const warp = before.find((d) => d.name === 'Planar Warp 1');
  const curlFlow = warp?.options?.indexOf('Projected Curl Flow');
  assert.notEqual(curlFlow, undefined);
  assert.notEqual(curlFlow, -1);
  assert.equal(engine.setParameter('Planar Warp 1', curlFlow), M.ParamSetResult.APPLIED);
  assert.equal(engine.setParameter('Planar Warp 1 Strength', 0), M.ParamSetResult.APPLIED);
  assert.equal(engine.setParameter('Planar Warp 1 Time', 0), M.ParamSetResult.APPLIED);
  assert.equal(engine.setParameter('Planar Warp 1 Scale', 1), M.ParamSetResult.APPLIED);
  before = engine.getParameterDefinitions();
  const rootValue = (name) => before.find((d) => d.name === name)?.requestedValue;

  const projectionBefore = before.find((d) => d.name === 'Projection');
  const bonne = projectionBefore?.options?.indexOf('Bonne');
  assert.notEqual(bonne, undefined);
  assert.notEqual(bonne, -1);
  assert.equal(engine.setParameter('Projection', bonne), M.ParamSetResult.APPLIED);
  const after = engine.getParameterDefinitions();
  const projection = after.find((d) => d.name === 'Projection');
  assert.equal(projection?.requestedValue, bonne);
  assert.equal(projection?.acceptedValue, rootValue('Projection'),
    'the renderer seed remains on the last accepted projection');
  assert.match(projection?.warning ?? '', /requires seam-safe stages/);
  for (const name of [
    'Function', 'Lens', 'Planar Warp 1', 'Planar Warp 2', 'Coverage',
  ]) {
    assert.equal(after.find((d) => d.name === name)?.requestedValue, rootValue(name),
      `${name} must not move as a byproduct of the Projection edit`);
  }

  assert.equal(engine.setParameter('Planar Warp 1', 0), M.ParamSetResult.APPLIED);
  const repaired = engine.getParameterDefinitions().find((d) => d.name === 'Projection');
  assert.match(repaired?.warning ?? '', /no compiled pipeline/,
    'a seam-safe tuple still needs a compiled program to admit the Projection');
});

test('ShaderBall exposes rejected Curl Flow separately from the accepted warp', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('ShaderBall'), M.EffectSetResult.INSTALLED);
  assert.equal(engine.setParameter('Planar Warp 1', 0), M.ParamSetResult.APPLIED);
  const outer = engine.getParameterDefinitions().find((d) => d.name === 'Planar Warp 1');
  const curlFlow = outer?.options?.indexOf('Projected Curl Flow');
  assert.notEqual(curlFlow, undefined);
  assert.notEqual(curlFlow, -1);

  assert.equal(engine.setParameter('Planar Warp 1', curlFlow), M.ParamSetResult.APPLIED);
  const rejected = engine.getParameterDefinitions().find((d) => d.name === 'Planar Warp 1');
  assert.equal(rejected?.requestedValue, curlFlow);
  assert.equal(rejected?.acceptedValue, 0,
    'reload must seed the renderer with None, not the preset Stereo Noise');
  assert.match(rejected?.warning ?? '',
    /Planar Warp 1 Projected Curl Flow rejected/);
});

test('ShaderBall keeps planar warps when dodecahedral Grid becomes Primitive Lattice', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('ShaderBall'), M.EffectSetResult.INSTALLED);
  assert.equal(engine.selectPreset(18), true);

  const before = engine.getParameterDefinitions();
  const functionDef = before.find((d) => d.name === 'Function');
  const outerDef = before.find((d) => d.name === 'Planar Warp 1');
  const innerDef = before.find((d) => d.name === 'Planar Warp 2');
  const primitiveLattice = functionDef?.options?.indexOf('Primitive Lattice');
  const mirrorTile = outerDef?.options?.indexOf('Mirror Tile');
  const noInnerWarp = innerDef?.options?.indexOf('None');
  assert.equal(outerDef?.requestedValue, mirrorTile);
  assert.equal(innerDef?.requestedValue, noInnerWarp);

  assert.equal(engine.setParameter('Function', primitiveLattice), M.ParamSetResult.APPLIED);
  const requested = engine.getParameterDefinitions();
  assert.equal(requested.find((d) => d.name === 'Planar Warp 1')?.requestedValue, mirrorTile,
    'the Function edit must not rewrite requested Planar Warp 1');
  assert.equal(requested.find((d) => d.name === 'Planar Warp 2')?.requestedValue, noInnerWarp,
    'the Function edit must not rewrite requested Planar Warp 2');
  assert.equal(requested.find((d) => d.name === 'Function')?.warning, undefined);

  engine.drawFrame();
  const rendered = engine.getParameterDefinitions();
  assert.equal(rendered.find((d) => d.name === 'Function')?.value, primitiveLattice);
  assert.equal(rendered.find((d) => d.name === 'Planar Warp 1')?.value, mirrorTile,
    'rendered Planar Warp 1 must remain Mirror Tile');
  assert.equal(rendered.find((d) => d.name === 'Planar Warp 2')?.value, noInnerWarp,
    'rendered Planar Warp 2 must remain None');
});

test('strobeColumns and getEffectSizes return the shapes daydream consumes', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), M.EffectSetResult.INSTALLED,
    'setEffect must succeed after the readonly scan');
  // driver.js gates the column-fill arc on `=== false`.
  assert.equal(typeof engine.strobeColumns(), 'boolean',
    'strobeColumns must return a boolean');

  // daydream.js reads this map to label sidebar entries.
  const sizes = engine.getEffectSizes();
  const names = Object.keys(sizes);
  assert.ok(names.includes('DisplacementField'),
    'getEffectSizes must name the effects the factory builds');
  const nonNumeric = names.filter((name) => typeof sizes[name] !== 'number');
  assert.deepEqual(nonNumeric.slice(0, 5), [],
    `${nonNumeric.length} getEffectSizes entries are not numbers`);
});

// engine_host.js calls getBufferLength through an optional-call guard, so a
// dropped export is silent at the call site.
test('getBufferLength reports the active resolution buffer length', () => {
  const wrong = [];
  for (const [w, h] of M.HolosphereEngine.getSupportedResolutions()) {
    if (!resolutionOk(engine.setResolution(w, h))) wrong.push(`${w}x${h} unbuildable`);
    else if (engine.getBufferLength() !== w * h * 3)
      wrong.push(`${w}x${h}: ${engine.getBufferLength()} != ${w * h * 3}`);
  }
  assert.deepEqual(wrong.slice(0, 5), [],
    `getBufferLength is wrong at ${wrong.length} reported resolutions`);
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), M.EffectSetResult.INSTALLED,
    'setEffect must succeed after a resolution change');
  assert.equal(engine.getBufferLength(), engine.getPixels().length,
    'getBufferLength must equal the getPixels view length');
});

// The engine pre-sizes its pixel buffer, so a resolution change re-spans it
// without detaching anything: length, not detachment, is what goes wrong.
test('a resolution change leaves a held pixel view attached at the wrong length', () => {
  const sizes = [];
  for (const [w, h] of M.HolosphereEngine.getSupportedResolutions()) sizes.push([w, h]);
  const [firstW, firstH] = sizes[0];
  const other = sizes.find(([w, h]) => w * h !== firstW * firstH);
  assert.ok(other, 'the engine must offer two differently sized resolutions');

  assert.ok(resolutionOk(engine.setResolution(firstW, firstH)),
    `${firstW}x${firstH} must stay buildable`);
  const held = engine.getPixels();
  assert.equal(held.length, engine.getBufferLength(),
    'a freshly fetched view must span the whole buffer');

  assert.equal(engine.setResolution(other[0], other[1]), M.ResolutionSetResult.RESIZED,
    `switching to ${other[0]}x${other[1]} must report RESIZED`);
  assert.equal(isViewLive(held), true,
    'a resolution change must not detach the held view; if it starts to, the ' +
    'length trigger below is no longer the only thing catching a stale view');
  assert.notEqual(held.length, engine.getBufferLength(),
    'the held view must still cover the old resolution');

  const { refreshed, view } = refreshPixelView(
    held, () => engine.getPixels(), engine.getBufferLength());
  assert.equal(refreshed, true, 'a wrong-length view must be re-fetched');
  assert.equal(view.length, engine.getBufferLength(),
    'the re-fetched view must span the new buffer');

  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
});

// engine_host.js calls getParamGeneration through an optional-call guard and
// daydream.js's Pole LOD slider calls setPoleLod on an optional chain, so a
// dropped export is silent on both call sites.
test('getParamGeneration and setPoleLod stay exported', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), M.EffectSetResult.INSTALLED,
    'setEffect must succeed for a registered effect');

  const generation = engine.getParamGeneration();
  assert.equal(typeof generation, 'number', 'getParamGeneration must return a number');
  assert.equal(engine.setEffect('DisplacementField'), M.EffectSetResult.INSTALLED,
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

// daydream.js reads the pause indicator through an optional-call guard
// (engineAnimationsPaused: () => host.engine.getAnimationsPaused?.()), so a
// dropped export is silent at the call site and only desyncs the GUI toggle.
test('getAnimationsPaused reports the pause both of its writers engage', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), M.EffectSetResult.INSTALLED,
    'setEffect must succeed for a registered effect');

  assert.equal(typeof engine.getAnimationsPaused(), 'boolean',
    'getAnimationsPaused must return a boolean');
  engine.setAnimationsPaused(true);
  assert.equal(engine.getAnimationsPaused(), true,
    'getAnimationsPaused must report the state setAnimationsPaused wrote');
  engine.setAnimationsPaused(false);
  assert.equal(engine.getAnimationsPaused(), false,
    'getAnimationsPaused must report a resume');

  // effect_gui.js re-reads the pause after an apply rather than tracking it.
  engine.setAnimationsPaused(true);
  assert.equal(engine.setEffect('DisplacementField'), M.EffectSetResult.INSTALLED,
    'setEffect must succeed on a reload');
  assert.equal(engine.getAnimationsPaused(), true,
    'the pause must be retained across a setEffect rebuild');
  engine.setAnimationsPaused(false);

  // An APPLIED write to an animated param engages the same pause, so
  // setAnimationsPaused is not the only writer the indicator has to follow.
  let animated = null;
  for (const name of Object.keys(engine.getEffectSizes())) {
    assert.equal(engine.setEffect(name), M.EffectSetResult.INSTALLED,
      `setEffect must succeed for ${name}`);
    const def = engine.getParameterDefinitions()
      .find((d) => d.animated && !d.readonly && typeof d.value === 'number');
    if (def) {
      animated = { effect: name, name: def.name, value: def.value };
      break;
    }
  }
  assert.ok(animated,
    'no effect exposes a writable animated parameter, so the implicit pause is ' +
    'unreachable');
  assert.equal(engine.getAnimationsPaused(), false,
    'the scan must leave animations running');
  assert.equal(engine.setParameter(animated.name, animated.value),
    M.ParamSetResult.APPLIED,
    `setParameter must apply ${animated.effect}.${animated.name}`);
  assert.equal(engine.getAnimationsPaused(), true,
    'an applied write to an animated param must engage the pause');

  engine.setAnimationsPaused(false);
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
});

// The method-surface pin above sees only that the six preset methods exist,
// while segment_worker's FakeEngine models their semantics and
// segment_controller.selectPreset mirrors a pause the engine engages on its own.
// Return type, rejection and the pause are what the fakes stand in for.
test('the preset methods answer the way the segmented path assumes', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);

  // Accumulated over the whole roster so the assertion count does not track it.
  const malformed = [];
  let paged = null;
  let presetless = null;
  for (const name of Object.keys(engine.getEffectSizes())) {
    if (engine.setEffect(name) !== M.EffectSetResult.INSTALLED) {
      malformed.push(`${name}: setEffect failed`);
      continue;
    }
    const count = engine.getPresetCount();
    const index = engine.getPresetIndex();
    if (!Number.isInteger(count) || count < 0) malformed.push(`${name}: count ${count}`);
    else if (index !== 0) malformed.push(`${name}: a fresh effect reports index ${index}`);
    if (count > 1 && !paged) paged = { effect: name, count };
    if (count === 0 && !presetless) presetless = name;
  }
  assert.deepEqual(malformed.slice(0, 5), [],
    `${malformed.length} effects report a malformed preset roster`);
  assert.ok(paged, 'no effect carries two presets, so the paging contract is unreachable');
  assert.ok(presetless,
    'every effect carries presets, so the empty-roster rejection is unreachable');

  assert.equal(engine.setEffect(paged.effect), M.EffectSetResult.INSTALLED,
    `setEffect must succeed for ${paged.effect}`);
  engine.setAnimationsPaused(false);

  // daydream.js gates on the return by truthiness, so a void method would read
  // as a rejection at every call site.
  assert.equal(engine.selectPreset(1), true,
    'selectPreset must report boolean success for an in-range index');
  assert.equal(engine.getPresetIndex(), 1, 'selectPreset must move the reported index');
  // segment_controller.selectPreset writes its own animationsPaused to true on
  // the strength of this, so a preset that stopped pausing would desync the GUI.
  assert.equal(engine.getAnimationsPaused(), true,
    'selectPreset must engage the animation pause');

  engine.setAnimationsPaused(false);
  for (const index of [-1, paged.count, paged.count + 1]) {
    assert.equal(engine.selectPreset(index), false,
      `selectPreset(${index}) must be rejected on a ${paged.count}-preset effect`);
  }
  assert.equal(engine.getPresetIndex(), 1,
    'a rejected selectPreset must leave the active preset alone');
  assert.equal(engine.getAnimationsPaused(), false,
    'a rejected selectPreset must not engage the pause');

  assert.equal(engine.selectPreset(paged.count - 1), true,
    'the last preset must be selectable');
  assert.equal(engine.nextPreset(), true, 'nextPreset must report boolean success');
  assert.equal(engine.getPresetIndex(), 0, 'nextPreset must wrap past the last preset');
  assert.equal(engine.previousPreset(), true, 'previousPreset must report boolean success');
  assert.equal(engine.getPresetIndex(), paged.count - 1,
    'previousPreset must wrap below the first preset');

  // effect_gui's per-frame sync calls this, so a pause here would freeze every
  // animated param the moment the GUI caught up with an external advance.
  engine.setAnimationsPaused(false);
  assert.equal(engine.synchronizePreset(0), true,
    'synchronizePreset must report boolean success for an in-range index');
  assert.equal(engine.getPresetIndex(), 0, 'synchronizePreset must move the reported index');
  assert.equal(engine.getAnimationsPaused(), false,
    'synchronizePreset must not engage the pause selectPreset does');
  assert.equal(engine.synchronizePreset(paged.count), false,
    'synchronizePreset must reject an out-of-range index');

  assert.equal(engine.selectPreset(1), true, 'the second preset must be selectable');
  assert.equal(engine.setEffect(paged.effect), M.EffectSetResult.INSTALLED,
    'setEffect must succeed on a reload');
  assert.equal(engine.getPresetIndex(), 0,
    'a setEffect rebuild must reset the preset index');

  // segment_worker calls selectPreset unguarded on the index it is broadcast.
  assert.equal(engine.setEffect(presetless), M.EffectSetResult.INSTALLED,
    `setEffect must succeed for ${presetless}`);
  assert.equal(engine.getPresetCount(), 0, `${presetless} must carry no presets`);
  assert.equal(engine.selectPreset(0), false,
    'selectPreset must be rejected on an effect with no presets');
  assert.equal(engine.nextPreset(), false,
    'nextPreset must be rejected on an effect with no presets');
  assert.equal(engine.previousPreset(), false,
    'previousPreset must be rejected on an effect with no presets');

  engine.setAnimationsPaused(false);
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
});

// pixel_view.test.js proves refreshPixelView against a synthetic detached
// buffer; this is the only place the real growth happens with a view
// outstanding. MeshOps' 16 MB tooling block is allocated lazily on first use and
// cannot fit the heap the module starts with, so that first call grows it, which
// detaches every live view.
test('heap growth detaches a held pixel view and the re-fetch is live and identical', () => {
  // The growth is a one-time event, so a MeshOps case that ran first would leave
  // this one nothing to observe. Asserted rather than left to declaration order.
  assert.equal(heapBytes(), INITIAL_HEAP_BYTES,
    'the heap has already grown, so the tooling allocation below will not: this ' +
    'case must run ahead of every other MeshOps case in this file');
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect('DisplacementField'), M.EffectSetResult.INSTALLED,
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
    'getLastResult',
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

// A null mesh is the bridge's only recoverable failure channel, and the reason
// behind it decides the caller's remedy — shrink the chain versus flush the
// arenas. Pinning the roster and one live reason keeps solid_codegen.js's
// routing table on the engine's enum rather than a stale copy of it.
test('meshOpFailure routes a real bridge reject by the reason the module records', () => {
  assert.ok(M.MeshOpResult, 'the module must export MeshOpResult');
  const moduleNames = Object.keys(M.MeshOpResult)
    .filter((k) => M.MeshOpResult[k] instanceof M.MeshOpResult);
  assert.deepEqual(moduleNames.sort(), [...MESH_OP_RESULT_NAMES].sort(),
    'solid_codegen.js MESH_OP_RESULT_NAMES must mirror the module enum roster');

  assert.equal(M.MeshOps.fromSolidName('NoSuchSolid'), null,
    'fromSolidName must return null for an unknown name');
  const failure = meshOpFailure(M, 'Base solid "NoSuchSolid"');
  assert.equal(failure.reason, 'UNKNOWN_NAME');
  assert.equal(failure.flush, false,
    'an unknown name leaves nothing in the arena to reclaim');

  const mesh = M.MeshOps.fromSolidName('cube');
  assert.ok(mesh, 'fromSolidName("cube") must build a mesh');
  assert.ok(mesh.classifyFaces(), 'classifyFaces must return codes for a cube');
  assert.equal(meshOpFailure(M, 'Face classification').reason, 'OK');
  mesh.delete();
  M.MeshOps.clearToolingMemory();
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
  const clamped = [];
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
      if (moduleLogs.length > 0) clamped.push(`${op} ${label}: ${moduleLogs.join(' ')}`);
    }
  }
  assert.deepEqual(clamped.slice(0, 5), [],
    `${clamped.length} OP_DEFS endpoints made the WASM bridge log on a ${seed}; ` +
    'the range reaches outside the engine domain for that operator, so the ' +
    'preview silently clamps while the generated C++ carries the authored value ' +
    'into an engine assert. Narrow the range in tools/solid_codegen.js');
});

test('the Platonic and Catalan seed lists name registered Simple solids', () => {
  const registry = M.MeshOps.getRegistry();
  const simple = new Set();
  for (let i = 0; i < registry.length; i++) {
    if (registry[i].category === 'Simple') simple.add(registry[i].name);
  }
  const unregistered = [...PLATONIC_SOLIDS, ...CATALAN_BASES]
    .filter((name) => !simple.has(name));
  assert.deepEqual(unregistered.slice(0, 5), [],
    `solid_codegen.js lists ${unregistered.length} names the engine registers no ` +
    'Simple solid for; update tools/solid_codegen.js to match solids.h');
  const inBoth = [...PLATONIC_SOLIDS].filter((name) => CATALAN_BASES.has(name));
  assert.deepEqual(inBoth.slice(0, 5), [],
    `${inBoth.length} names are in both seed lists; the namespace qualifier ` +
    'would be ambiguous');
});

test('SIMPLE_SEEDS mirrors simple_registry, whose index a Recipe seed is', () => {
  const registry = M.MeshOps.getRegistry();
  const misindexed = [];
  for (let i = 0; i < SIMPLE_SEEDS.length; i++)
    if (registry[i].name !== SIMPLE_SEEDS[i])
      misindexed.push(`[${i}] ${SIMPLE_SEEDS[i]} != ${registry[i].name}`);
  assert.deepEqual(misindexed.slice(0, 5), [],
    `${misindexed.length} SIMPLE_SEEDS entries do not name their registry index; ` +
    'a generated SEED_* constant carries that index and would seed another solid');
  // The Catalan registry follows the simple one, so its first entry is where
  // simple_registry ends: a nineteenth simple solid would land here.
  assert.ok(CATALAN_BASES.has(registry[SIMPLE_SEEDS.length].name),
    `SIMPLE_SEEDS stops short of simple_registry, which also holds ` +
    `"${registry[SIMPLE_SEEDS.length].name}"`);
  const unseeded = [...DEFINED_SEED_CONSTANTS]
    .filter((seed) => !SIMPLE_SEEDS.includes(seed));
  assert.deepEqual(unseeded.slice(0, 5), [],
    `solids.h defines SEED_* for ${unseeded.length} names that are no ` +
    'simple_registry entry');
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
  const faults = [];
  for (const name of complex) {
    const recipe = M.MeshOps.getRecipe(name);
    if (!recipe) {
      faults.push(`"${name}" carries no authored recipe`);
      continue;
    }
    if (!simple.has(recipe.seed))
      faults.push(`seed "${recipe.seed}" of "${name}" names no registered Simple solid`);
    if (!Array.isArray(recipe.ops) || recipe.ops.length === 0) {
      faults.push(`recipe of "${name}" carries no ops array`);
      continue;
    }
    for (const step of recipe.ops) {
      if (!KNOWN_OPS.has(step.op))
        faults.push(`recipe of "${name}" uses op "${step.op}", which MeshOps does not bind`);
      if (typeof step.param !== 'number')
        faults.push(`step "${step.op}" of "${name}" carries a non-numeric param`);
      if (typeof step.twist !== 'number')
        faults.push(`step "${step.op}" of "${name}" carries a non-numeric twist`);
    }
  }
  assert.deepEqual(faults.slice(0, 5), [],
    `${faults.length} Complex-solid recipes are malformed`);
  assert.equal(M.MeshOps.getRecipe('NoSuchSolid'), null,
    'getRecipe must return null for an unknown name');
});

test('PaletteOps exposes the method surface the palette tool drives', () => {
  assert.equal(typeof M.PaletteOps, 'function',
    'the module must export PaletteOps');
  const ops = new M.PaletteOps();
  try {
    assert.equal(typeof ops.compileAndBakeV4, 'function');
    assert.equal(typeof ops.inspectV4, 'function');
    assert.equal(ops.bakeLut, undefined);
    const recipe = {
      schemaVersion: 4, input: { offset: 0, span: 1 },
      domain: 0, easing: 1, colorPath: 0,
      hue: {
        mode: 0, harmony: 1, direction: 0, baseTurns: 0,
        spreadTurns: 0.07, sweepTurns: 1, customTurns: [0, 0, 0, 0],
      },
      lightness: { curve: 0, center: 0.62, range: 0, custom: [0, 0, 0, 0] },
      chroma: {
        curve: 0, basis: 0, center: 0.62, range: 0,
        headroom: 0.94, custom: [0, 0, 0, 0],
      },
      hueTorsion: 0, falloffStart: 0.9,
    };
    const compiled = ops.compileAndBakeV4(recipe);
    assert.equal(compiled.status.code, 0);
    assert.ok(compiled.lut instanceof Uint8Array);
    assert.equal(compiled.lut.length, 256 * 3);
    const inspected = ops.inspectV4(recipe);
    assert.equal(inspected.diagnostics.length, 256 * 6);
    assert.equal(inspected.fallback.length, 256);
  } finally {
    ops.delete();
  }
});

/**
 * The segmented pool compiles the binary once and hands every worker the
 * WebAssembly.Module, which each instantiates through the glue's instantiateWasm
 * hook. Two things must hold for that to be safe, and neither is visible from
 * the mocked worker tests: the glue must honour the hook (or the pool silently
 * pays N compilations again), and instances of one compilation must not share
 * state (the binary declares its own memory rather than importing one, so each
 * gets a private heap, global arena and engine singleton).
 */
test('the glue honours instantiateWasm, and shared-module instances stay isolated', async () => {
  const binary = readFileSync(new URL('../holosphere_wasm.wasm', import.meta.url));
  const compiled = await WebAssembly.compile(binary);
  let hookCalls = 0;
  const fromShared = () => createHolosphereModule({
    print: () => {},
    instantiateWasm: (imports, onInstance) => {
      hookCalls++;
      WebAssembly.instantiate(compiled, imports)
        .then((instance) => onInstance(instance, compiled));
      return {};
    },
  });

  const [a, b] = [await fromShared(), await fromShared()];
  assert.equal(hookCalls, 2,
    'the glue must take the supplied compilation, not fetch and compile its own');

  const engines = [new a.HolosphereEngine(), new b.HolosphereEngine()];
  try {
    // Each instance carries its own enum objects, so a result is only ever
    // compared against the module it came from.
    const frames = [a, b].map((mod, i) => {
      const e = engines[i];
      const resized = e.setResolution(W, H);
      assert.ok(resized === mod.ResolutionSetResult.RESIZED
        || resized === mod.ResolutionSetResult.ALREADY_ACTIVE);
      assert.equal(e.setEffect('DisplacementField'), mod.EffectSetResult.INSTALLED);
      e.drawFrame();
      return e.getPixels();
    });
    assert.notEqual(frames[0].buffer, frames[1].buffer,
      'each instance must render into a linear memory of its own');
    assert.ok(frames[0].some((v) => v !== 0), 'the shared module renders a real frame');
    assert.deepEqual(Array.from(frames[0]), Array.from(frames[1]),
      'one compilation, two instances, the same frame');

    // Divergent state in one instance must leave the other's frame alone.
    const before = Uint16Array.from(engines[0].getPixels());
    engines[1].setClip(0, W / 2, 0, H);
    engines[1].drawFrame();
    assert.deepEqual(Array.from(engines[0].getPixels()), Array.from(before),
      "a second instance's clip and redraw must not reach the first's heap");
  } finally {
    for (const e of engines) e.delete();
  }
});
