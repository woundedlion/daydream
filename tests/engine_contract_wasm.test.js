// Real-engine contract pin for the WASM surface: loads the shipped module and
// exercises the methods and return shapes FakeEngine models, plus MeshOps and
// PaletteOps.
import { EFFECT_IDENTITIES } from '../generated/engine_contract.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import createHolosphereModule from '../generated/holosphere_wasm.js';
import { LOWERING, validateRegistryFaces } from '../src/workbench/solids/solid_registry_codegen.js';
import { MAX_DISPLAY_CAP_PERCENT } from '../src/renderer/display_caps.js';
import { callWorkbenchBinding } from '../src/engine/workbench_bindings.js';

import { createChainValidator } from '../src/workbench/solids/solid_validation.js';
import {
  KNOWN_OPS, OP_DEFS, CATALAN_BASES, SIMPLE_SEEDS,
  DEFINED_SEED_CONSTANTS, applyOp, meshOpFailure,
} from '../src/workbench/solids/solid_codegen.js';

import { isViewLive, refreshPixelView } from '../src/renderer/pixel_view.js';
import { DEFAULT_EFFECT, resolutionPresets } from '../src/effects/effect_roster.js';
import { paletteControlsFromRecipe, paletteRecipeFromControls, PaletteV4 } from '../src/workbench/palettes/palette_controls.js';
import { paletteAdjustmentSummary } from '../src/workbench/palettes/palette_math.js';
import { stageGrouping } from '../src/effects/shader_stages.js';



// Capture the bridge's diagnostics for clamped MeshOps arguments.
const moduleLogs = [];
const sink = (line) => moduleLogs.push(line);
const M = await createHolosphereModule({ print: sink, printErr: sink });

const { w: W, h: H } = resolutionPresets['Holosphere (96x20)'];

// One shared engine: the engine owns a single global arena, so a second
// instantiation traps.
assert.equal(M.HolosphereEngine.isLive(), false);
const engine = new M.HolosphereEngine();
assert.equal(M.HolosphereEngine.isLive(), true);
const initialDisplayAngles = [engine.getDisplayNorthPhi(), engine.getDisplaySouthPhi()];
const initialPoleLod = engine.getPoleLod();

const resolutionOk = (r) => r === M.ResolutionSetResult.RESIZED
  || r === M.ResolutionSetResult.ALREADY_ACTIVE;

const SIMULATOR_EFFECTS = EFFECT_IDENTITIES.map(({ display_name }) => display_name)
  .filter((name) => name !== 'ShaderChain');

/** @param {*} d @returns {boolean} Whether a definition is a writable numeric slider. */
const writableNumeric = (d) => !d.readonly && typeof d.value === 'number' && d.options === undefined;

const ARENAS = ['scratch_arena_a', 'scratch_arena_b', 'persistent_arena'];

// A registered effect that provisions every arena, exposes a writable numeric
// parameter, renders, and narrows to a clip band, leaving the pixels outside it black.
const FIXTURE_EFFECT = (() => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  for (const name of SIMULATOR_EFFECTS) {
    if (engine.setEffect(name) !== M.EffectSetResult.INSTALLED
        || ARENAS.some((arena) => !(engine.getArenaMetrics()[arena].capacity > 0))
        || !engine.getParameterDefinitions().some(writableNumeric)
        || engine.setClip(0, W / 2, 0, H) !== M.ClipSetResult.APPLIED) continue;
    engine.getPixels().fill(0);
    engine.drawFrame();
    const pixels = engine.getPixels();
    let outside = false;
    for (let y = 0; y < H && !outside; y++) {
      outside = pixels.subarray((y * W + W / 2) * 3, (y + 1) * W * 3).some((v) => v !== 0);
    }
    if (!outside && pixels.some((v) => v !== 0)) return name;
  }
  assert.fail('no registered effect renders inside a clip band with a writable numeric parameter');
})();

// Structured payload shapes are authored separately from emitted bindings.
const DTS_PATH = 'generated/engine_types.d.ts';
const DTS = readFileSync(new URL(`../${DTS_PATH}`, import.meta.url), 'utf8');

/**
 * Reads a file the engine's LF export is pinned against. A CRLF working-tree
 * copy holds the same content, so line endings are normalized away and every
 * other byte still has to match.
 * @param {URL} url - File to read.
 * @returns {string} The text, LF-terminated.
 */
const readPinned = (url) => readFileSync(url, 'utf8').replaceAll('\r\n', '\n');

/**
 * Body of a named `export interface` or object-literal `export type`
 * declaration, comments stripped.
 * @param {string} name - Declaration name.
 * @returns {string} The declaration body.
 */
function interfaceBody(name) {
  const at = DTS.search(new RegExp(
    `export (?:interface ${name}(?: extends [A-Za-z_]\\w*)?|type ${name} =) \\{`));
  assert.ok(at >= 0, `${DTS_PATH} must declare interface ${name}`);
  const end = DTS.indexOf('\n}', at);
  assert.ok(end > at, `interface ${name} must be closed at column 0`);
  return DTS.slice(at, end).replace(/\/\*[\s\S]*?\*\//g, '');
}



/**
 * Members of a named `export interface` and of everything it extends. Only
 * members at the interface's own indentation count, so the fields of a nested
 * object type stay out.
 * @param {string} name - Interface name.
 * @returns {Map<string, boolean>} Member name to whether it is optional.
 */
function interfaceMembers(name) {
  const base = DTS.match(
    new RegExp(`export interface ${name} extends ([A-Za-z_]\\w*) \\{`))?.[1];
  return new Map([
    ...(base === undefined ? [] : interfaceMembers(base)),
    ...[...interfaceBody(name).matchAll(/^ {2}(?:readonly )?([A-Za-z_]\w*)(\??):/gm)]
      .map((match) => [match[1], match[2] === '?']),
  ]);
}

/**
 * Pins one declared object shape against a value the module produced: the
 * declarations name every key the module returns, and the module returns every
 * member declared without a `?`.
 * @param {string} name - Interface name.
 * @param {*} value - A live instance of the shape.
 * @returns {void}
 */
function assertDeclaredShape(name, value) {
  const members = interfaceMembers(name);
  assert.ok(members.size > 0, `${name} must declare at least one member`);
  const keys = Object.keys(value);
  for (const key of keys) {
    assert.ok(members.has(key),
      `${DTS_PATH} declares no ${name}.${key}, which the module returns`);
  }
  for (const [member, optional] of members) {
    assert.ok(optional || keys.includes(member),
      `${DTS_PATH} declares ${name}.${member}, which the module `
      + 'does not return');
  }
}

// Return-value shapes for the engine binding methods.
test(`${DTS_PATH} declares the object shapes the engine returns`, () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);

  const metrics = engine.getArenaMetrics();
  assertDeclaredShape('ArenaMetrics', metrics);
  assertDeclaredShape('ArenaUsage', metrics.persistent_arena);
  assertDeclaredShape('StackUsage', metrics.stack);

  let toggle = null;
  for (const name of SIMULATOR_EFFECTS) {
    assert.equal(engine.setEffect(name), M.EffectSetResult.INSTALLED, name);
    toggle = engine.getParameterDefinitions()
      .find((/** @type {*} */ d) => typeof d.value === 'boolean');
    if (toggle) break;
  }
  assert.ok(toggle, 'no effect exposes a toggle, so BooleanParameterDefinition is unchecked');
  assertDeclaredShape('BooleanParameterDefinition', toggle);

  assert.equal(engine.setEffect('ShaderChain'), M.EffectSetResult.INSTALLED);
  const definitions = engine.getParameterDefinitions();
  const selector = definitions.find((/** @type {*} */ d) => d.options !== undefined);
  assert.ok(selector, 'ShaderChain must expose a topology control, or this pin never '
    + 'reaches the optional enum members');
  for (const definition of [definitions[0], selector]) {
    assertDeclaredShape('NumericParameterDefinition', definition);
  }

  const snapshot = callWorkbenchBinding(engine, 'getSnapshot', []);
  assertDeclaredShape('ChainSnapshot', snapshot);
});

// The installed catalog is the engine's own export.
test('getShaderChainCatalog matches the installed generated/shader/engine_catalog.json', () => {
  const pinned = readPinned(
    new URL('../generated/shader/engine_catalog.json', import.meta.url));
  assert.equal(pinned, `${M.ShaderChainBindings.getShaderChainCatalog()}\n`,
    'generated/shader/engine_catalog.json must be the module export plus its trailing '
    + 'newline — re-pin the catalog from the installed module');
});

// The default ShaderChain program, spelled as the payload setShaderChain
// takes.
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
  // The W x H preset must stay reachable.
  assert.ok(rows.some(([w, h]) => w === W && h === H),
    `the ${W}x${H} preset must be a reported resolution`);
});

test('HolosphereEngine return shapes match what the segmented path consumes', () => {
  // Enum results compare by identity, never by truthiness.
  const ok = engine.setResolution(W, H);
  assert.ok(ok instanceof M.ResolutionSetResult,
    'setResolution must return a ResolutionSetResult value');
  assert.ok(resolutionOk(ok), `the ${W}x${H} preset must be a buildable resolution`);

  const effectOk = engine.setEffect(FIXTURE_EFFECT);
  assert.ok(effectOk instanceof M.EffectSetResult,
    'setEffect must return an EffectSetResult value');
  assert.equal(effectOk, M.EffectSetResult.INSTALLED,
    'setEffect must report INSTALLED for a registered effect');

  const defs = engine.getParameterDefinitions();
  assert.equal(typeof defs.length, 'number',
    'getParameterDefinitions must return an array-like value');
  assert.ok(defs.length > 0,
    `${FIXTURE_EFFECT} must expose at least one parameter`);
  const p = defs[0];
  assert.equal(typeof p.name, 'string', 'param def must carry a string name');
  assert.ok(typeof p.value === 'number' || typeof p.value === 'boolean',
    'param def value must be a number or boolean');
  const paramResult = engine.setParameter(
    p.name, typeof p.value === 'boolean' ? (p.value ? 1 : 0) : p.value);
  assert.equal(paramResult, M.ParamSetResult.APPLIED,
    'setParameter must report APPLIED for a known param name');

  engine.setAnimationsPaused(false);
  assert.equal(engine.setClip(0, W, 0, H), M.ClipSetResult.APPLIED,
    'setClip must report APPLIED for a full-canvas band');
  engine.drawFrame();

  const px = engine.getPixels();
  assert.ok(px instanceof Uint16Array, 'getPixels must return a Uint16Array');
  assert.equal(px.length, W * H * 3, 'getPixels length must be W*H*3');

  const paramValues = engine.getParamValues();
  assert.equal(typeof paramValues.length, 'number',
    'getParamValues must return an array-like value');
  assert.deepEqual(
    Array.from(paramValues).filter((v) => typeof v !== 'number'), [],
    'getParamValues elements must be numbers');

  const m = engine.getArenaMetrics();
  for (const arena of ARENAS) {
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
  assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED,
    'setEffect must succeed for a registered effect');
  const before = paramNames(engine.getParameterDefinitions());

  assert.equal(engine.setEffect('NoSuchEffect'), M.EffectSetResult.UNKNOWN_EFFECT,
    'setEffect must report UNKNOWN_EFFECT for an unregistered effect name');
  assert.deepEqual(paramNames(engine.getParameterDefinitions()), before,
    'a rejected setEffect must keep the prior effect installed');

  assert.equal(engine.setClip(0, W, 0, H), M.ClipSetResult.APPLIED,
    'the prior effect must still accept a full-canvas clip');
  engine.getPixels().fill(0);
  engine.drawFrame();
  assert.ok(engine.getPixels().some((value) => value !== 0),
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
  assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED,
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

// NO_EFFECT, the state between a resolution change and the setEffect that
// follows it, is distinct from INVALID_BOUNDS.
test('an effectless engine reports NO_EFFECT, not a bounds rejection', () => {
  const other = M.HolosphereEngine.getSupportedResolutions()
    .find(([w, h]) => w !== W || h !== H);
  assert.ok(other, 'a second supported resolution is needed to tear the effect down');

  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED,
    'setEffect must succeed for a registered effect');
  const [ow, oh] = other;
  assert.equal(engine.setResolution(ow, oh), M.ResolutionSetResult.RESIZED,
    `switching to ${ow}x${oh} must report RESIZED`);
  assert.equal(engine.setClip(0, ow, 0, oh), M.ClipSetResult.NO_EFFECT,
    'a resolution change tears the effect down, so the clip has no receiver');

  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
});

// Only RESIZED obliges the caller to re-apply setEffect/setClip.
test('a request matching the active resolution reports ALREADY_ACTIVE and keeps the effect', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED,
    'setEffect must succeed for a registered effect');
  assert.equal(engine.setResolution(W, H), M.ResolutionSetResult.ALREADY_ACTIVE,
    'a same-size request must report ALREADY_ACTIVE');
  assert.ok(engine.getParameterDefinitions().length > 0,
    'an ALREADY_ACTIVE setResolution must leave the current effect installed');
});

test('a rejected parameter write names its reason', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  // Scans every effect, accumulating so the assertion count does not track the
  // roster's size.
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

test('Symmetric Strength spans its full range without changing the unit-field fold estimate', () => {
  engine.setEffect('ShaderChain');
  const bindings = engine.getShaderChainBindings();
  try {
    assert.equal(bindings.setShaderChain([
      { instance: 'field', operator: 'sphere.displace.symmetric.v2' },
      { instance: 'project', operator: 'project.stereographic.v2' },
      { instance: 'sample', operator: 'sample.grid.v4' },
      { instance: 'colorize', operator: 'colorize.generated-palette.v4' },
    ]).code, 'APPLIED');
    const advisory = () => engine.getParameterAdvisories()
      .find(({name}) => name === 'field.strength');
    const initial = advisory();
    assert.ok(initial.foldStrength > 0 && initial.foldStrength < Math.PI);
    const strength = (initial.foldStrength + Math.PI) / 2;
    assert.equal(engine.setParameter('field.strength', strength), M.ParamSetResult.APPLIED);
    const current = () => engine.getParameterDefinitions().find((p) => p.name === 'field.strength');
    assert.ok(Math.abs(current().acceptedValue - strength) < 1e-6);
    assert.equal(current().warning, undefined);
    assert.equal(engine.setParameter('field.strength', -Math.fround(4 * Math.PI)), M.ParamSetResult.APPLIED);
    assert.equal(engine.setParameter('field.amplitude', 2), M.ParamSetResult.UNKNOWN_PARAM);
    assert.equal(engine.getParameterDefinitions().some(({name}) => name === 'field.amplitude'), false);
    assert.equal(advisory().foldStrength, initial.foldStrength);
  } finally { bindings.delete(); }
});

test('Symmetric snapshot restore requires current controls and rotation state in WASM', () => {
  engine.setEffect('ShaderChain');
  const bindings = engine.getShaderChainBindings();
  try {
    assert.equal(bindings.setShaderChain([
      {instance: 'field', operator: 'sphere.displace.symmetric.v2'},
      {instance: 'project', operator: 'project.stereographic.v2'},
      {instance: 'sample', operator: 'sample.grid.v4'},
      {instance: 'colorize', operator: 'colorize.generated-palette.v4'},
    ]).code, 'APPLIED');
    const current = bindings.getSnapshot();
    current.parameters.find(({name}) => name === 'field.strength').value = -0.5;
    current.runtime.find(({instance}) => instance === 'field').state.primary = -1.25;
    assert.equal(bindings.restoreSnapshot(current), M.ChainSnapshotRestoreResult.APPLIED);
    assert.deepEqual(bindings.getSnapshot(), current);
    const withoutClock = structuredClone(current);
    withoutClock.parameters = withoutClock.parameters.filter(({name}) => name !== 'field.speed');
    withoutClock.runtime = withoutClock.runtime.filter(({instance}) => instance !== 'field');
    assert.equal(bindings.restoreSnapshot(withoutClock), M.ChainSnapshotRestoreResult.INVALID_VALUE);
    assert.deepEqual(bindings.getSnapshot(), current);
    const retired = structuredClone(current);
    retired.chain[0].operator = 'sphere.displace.symmetric.v1';
    assert.equal(bindings.restoreSnapshot(retired), M.ChainSnapshotRestoreResult.INVALID_CHAIN);
    assert.deepEqual(bindings.getSnapshot(), current);
  } finally { bindings.delete(); }
});

test('live composed groups cover every parameter and both planar-warp slots', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(Object.hasOwn(engine.getEffectSizes(), 'Shader'), false,
    'the slot workbench is absent from the active effect roster');
  const unassigned = [];
  const misplaced = [];
  const dualWarpRosters = [];
  let checked = 0;
  for (const effect of Object.keys(engine.getEffectSizes())) {
    if (engine.setEffect(effect) !== M.EffectSetResult.INSTALLED) continue;
    const presets = Math.max(1, engine.getPresetCount());
    for (let preset = 0; preset < presets; ++preset) {
      if (preset > 0) assert.equal(engine.selectPreset(preset), true, `${effect} preset ${preset}`);
      const definitions = Array.from(engine.getParameterDefinitions());
      if (!definitions.some((entry) => entry.group)) continue;
      ++checked;
      const assignments = stageGrouping(definitions)?.assignments;
      for (const definition of definitions) {
        if (!assignments?.has(definition.name)) {
          unassigned.push(`${effect} preset ${preset}: ${definition.name}`);
        }
      }
      if (definitions.some((entry) => entry.name === 'Singularity Fade')
          && assignments?.get('Singularity Fade') !== 'Projection') {
        misplaced.push(`${effect} preset ${preset}: Singularity Fade`);
      }
      if (assignments?.get('Planar Warp 1 Speed') === 'Planar Warp 1'
          && assignments?.get('Planar Warp 2 Speed') === 'Planar Warp 2') {
        dualWarpRosters.push(`${effect} preset ${preset}`);
      }
    }
  }
  assert.ok(checked > 0, 'the live engine exposes no registered pipeline groups');
  assert.deepEqual(unassigned, [], `unassigned parameters: ${unassigned.join(', ')}`);
  assert.deepEqual(misplaced, [], `misplaced parameters: ${misplaced.join(', ')}`);
  assert.ok(dualWarpRosters.length > 0,
    'the live engine exposes no roster with both planar-warp slots');
});

test('strobeColumns and effect metadata return the shapes daydream consumes', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED,
    'setEffect must succeed for a registered effect');
  assert.equal(typeof engine.strobeColumns(), 'boolean',
    'strobeColumns must return a boolean');

  const sizes = engine.getEffectSizes();
  const names = Object.keys(sizes);
  assert.deepEqual(SIMULATOR_EFFECTS.filter((name) => !names.includes(name)), [],
    'getEffectSizes must name the effects the factory builds');
  const nonNumeric = names.filter((name) => typeof sizes[name] !== 'number');
  assert.deepEqual(nonNumeric.slice(0, 5), [],
    `${nonNumeric.length} getEffectSizes entries are not numbers`);

  const presetCounts = engine.getEffectPresetCounts();
  assert.deepEqual(Object.keys(presetCounts).sort(), names.sort(),
    'getEffectPresetCounts must cover the same factory roster as getEffectSizes');
  const invalidCounts = Object.entries(presetCounts).filter(
    ([, count]) => !Number.isInteger(count) || count < 0);
  assert.deepEqual(invalidCounts.slice(0, 5), [],
    `${invalidCounts.length} getEffectPresetCounts entries are not non-negative integers`);
  assert.ok(Object.values(presetCounts).some((count) => count > 0),
    'no effect reports authored presets');
  assert.ok(Object.values(presetCounts).some((count) => count === 0),
    'an effect with no authored presets must report zero, not be absent');
});

// Effect identities used by per-resolution favorites and the seeded default.
test('the favorites rosters and the seeded default name installable effects', () => {
  const registered = new Set(Object.keys(engine.getEffectSizes()));
  assert.ok(registered.has(DEFAULT_EFFECT),
    `daydream.js seeds ${DEFAULT_EFFECT}, which the engine does not register`);

  const unregistered = [];
  const uninstallable = [];
  for (const [label, preset] of Object.entries(resolutionPresets)) {
    if (!resolutionOk(engine.setResolution(preset.w, preset.h))) {
      uninstallable.push(`${label}: unbuildable resolution`);
      continue;
    }
    for (const name of preset.favorites) {
      if (!registered.has(name)) unregistered.push(`${label}: ${name}`);
      else if (engine.setEffect(name) !== M.EffectSetResult.INSTALLED)
        uninstallable.push(`${label}: ${name}`);
    }
  }
  assert.deepEqual(unregistered.slice(0, 5), [],
    `${unregistered.length} favorites name effects the engine does not register`);
  assert.deepEqual(uninstallable.slice(0, 5), [],
    `${uninstallable.length} favorites do not install at their own resolution`);

  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
});

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
  assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED,
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

test('getParamGeneration changes across setEffect', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED,
    'setEffect must succeed for a registered effect');

  const generation = engine.getParamGeneration();
  assert.equal(typeof generation, 'number', 'getParamGeneration must return a number');
  assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED,
    'setEffect must succeed on a reload');
  assert.notEqual(engine.getParamGeneration(), generation,
    'getParamGeneration must change across a setEffect, or a stale param snapshot ' +
    'cannot be detected');

});

test('setPoleLod reads back in range and clamps outside it', () => {
  assert.equal(typeof engine.setPoleLod, 'function',
    'setPoleLod must stay callable (pole_lod.js binds the Pole LOD slider to it)');
  assert.ok(Number.isInteger(initialPoleLod) && initialPoleLod >= 0 && initialPoleLod <= 8,
    'a fresh engine starts inside the pole LOD range');
  // The slider uses [0, 2] inside the engine range [0, 8].
  for (let v = 0; v <= 8; v++) {
    engine.setPoleLod(v);
    assert.equal(engine.getPoleLod(), v, `setPoleLod(${v}) must read back`);
  }
  for (const v of [-1, Number.NaN, -Infinity]) {
    engine.setPoleLod(1);
    engine.setPoleLod(v);
    assert.equal(engine.getPoleLod(), 0, `setPoleLod(${v}) must clamp to 0`);
  }
  for (const v of [9, 1000, Infinity]) {
    engine.setPoleLod(1);
    engine.setPoleLod(v);
    assert.equal(engine.getPoleLod(), 8, `setPoleLod(${v}) must saturate at 8`);
  }
  engine.setPoleLod(0);
});

test('preset selection pauses, restores authored values and preserves paused tuning', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)));
  const sliders = () => new Map(engine.getParameterDefinitions()
    .filter(writableNumeric).map((d) => [d.name, d]));
  let found = null;
  for (const name of SIMULATOR_EFFECTS) {
    if (engine.setEffect(name) !== M.EffectSetResult.INSTALLED) continue;
    const ids = engine.getPresetIds();
    if (ids.length < 2) continue;
    const first = sliders();
    assert.equal(engine.selectPresetById(ids[1]), true, name);
    const param = [...sliders().values()].find((d) => first.get(d.name)
      && first.get(d.name).value !== d.value);
    if (param) {
      found = { effect: name, ids, param, authored: first.get(param.name).value };
      break;
    }
  }
  assert.ok(found, 'no two presets author different values for one writable parameter');
  const { effect, ids, param, authored } = found;
  const value = () => sliders().get(param.name).value;

  engine.setAnimationsPaused(false);
  assert.equal(engine.setEffect(effect), M.EffectSetResult.INSTALLED);
  assert.equal(engine.getPresetIndex(), 0);
  assert.equal(engine.selectPresetById(ids[1]), true);
  assert.equal(engine.getPresetIndex(), 1);
  assert.equal(engine.getAnimationsPaused(), true);
  const tuned = Math.fround((param.min + param.max) / 2) === Math.fround(param.value)
    ? param.min : (param.min + param.max) / 2;
  assert.equal(engine.setParameter(param.name, tuned), M.ParamSetResult.APPLIED);
  for (let frame = 0; frame < 32; ++frame) engine.drawFrame();
  assert.equal(engine.getPresetIndex(), 1);
  assert.ok(Math.abs(value() - tuned) < 1e-6);
  assert.ok(engine.getPixels().some((v) => v > 0));

  assert.equal(engine.previousPreset(), true);
  assert.equal(engine.getPresetIndex(), 0);
  assert.equal(engine.getAnimationsPaused(), true);
  assert.ok(Math.abs(value() - authored) < 1e-6);
  assert.equal(engine.nextPreset(), true);
  assert.equal(engine.getPresetIndex(), 1);
  assert.equal(engine.selectPresetById('missing'), false);
  assert.equal(engine.getPresetIndex(), 1);
  engine.setAnimationsPaused(false);
  assert.equal(engine.synchronizePreset(0), true);
  assert.equal(engine.getPresetIndex(), 0);
  assert.equal(engine.getAnimationsPaused(), false);
});

test('getPresetIds names the presets selectPresetById answers to', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);

  const malformed = [];
  let identified = null;
  for (const name of Object.keys(engine.getEffectSizes())) {
    if (engine.setEffect(name) !== M.EffectSetResult.INSTALLED) continue;
    const ids = engine.getPresetIds();
    if (!Array.isArray(ids)) {
      malformed.push(`${name}: getPresetIds returned ${typeof ids}`);
      continue;
    }
    // An effect without stable preset metadata reports none; one that reports
    // any must name every preset it navigates.
    if (ids.length === 0) continue;
    if (ids.length !== engine.getPresetCount()) {
      malformed.push(`${name}: ${ids.length} ids for ${engine.getPresetCount()} presets`);
    } else if (new Set(ids).size !== ids.length) {
      malformed.push(`${name}: duplicate ids ${ids.join()}`);
    } else if (ids.some((id) => typeof id !== 'string' || id === '')) {
      malformed.push(`${name}: a preset id is not a non-empty string`);
    }
    if (!identified && ids.length > 1) identified = { effect: name, ids };
  }
  assert.deepEqual(malformed.slice(0, 5), [],
    `${malformed.length} effects report a malformed preset-id roster`);
  assert.ok(identified,
    'no effect carries two identified presets, so selection by ID is unreachable');

  assert.equal(engine.setEffect(identified.effect), M.EffectSetResult.INSTALLED,
    `setEffect must succeed for ${identified.effect}`);
  engine.setAnimationsPaused(false);

  // The roster is in navigation order, so the nth ID must select index n.
  assert.equal(engine.selectPresetById(identified.ids[1]), true,
    'a listed preset id must be selectable');
  assert.equal(engine.getPresetIndex(), 1,
    'the id roster is not in the order the index navigates');
  assert.equal(engine.getAnimationsPaused(), true,
    'selectPresetById must engage the pause selectPreset does');

  engine.setAnimationsPaused(false);
  for (const id of ['', 'no-such-preset']) {
    assert.equal(engine.selectPresetById(id), false,
      `selectPresetById("${id}") must be rejected`);
  }
  assert.equal(engine.getPresetIndex(), 1,
    'a rejected selectPresetById must leave the active preset alone');
  assert.equal(engine.getAnimationsPaused(), false,
    'a rejected selectPresetById must not engage the pause');
});

test('getAnimationsPaused reports the pause both of its writers engage', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
  assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED,
    'setEffect must succeed for a registered effect');

  assert.equal(typeof engine.getAnimationsPaused(), 'boolean',
    'getAnimationsPaused must return a boolean');
  engine.setAnimationsPaused(true);
  assert.equal(engine.getAnimationsPaused(), true,
    'getAnimationsPaused must report the state setAnimationsPaused wrote');
  engine.setAnimationsPaused(false);
  assert.equal(engine.getAnimationsPaused(), false,
    'getAnimationsPaused must report a resume');

  engine.setAnimationsPaused(true);
  assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED,
    'setEffect must succeed on a reload');
  assert.equal(engine.getAnimationsPaused(), true,
    'the pause must be retained across a setEffect rebuild');
  engine.setAnimationsPaused(false);

  // An APPLIED write to an animated param engages the same pause.
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

// Return type, rejection and the pause the preset-method fakes stand in for.
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

  assert.equal(engine.selectPreset(1), true,
    'selectPreset must report boolean success for an in-range index');
  assert.equal(engine.getPresetIndex(), 1, 'selectPreset must move the reported index');
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

// MeshOps' tooling block is allocated lazily on first use and cannot fit
// the heap the module starts with, so that first call grows it, which detaches
// every live view.
test('heap growth detaches a held pixel view and the re-fetch is live and identical', async () => {
  const M = await createHolosphereModule({ print: sink, printErr: sink });
  const engine = new M.HolosphereEngine();
  try {
    assert.ok([M.ResolutionSetResult.RESIZED, M.ResolutionSetResult.ALREADY_ACTIVE].includes(engine.setResolution(W, H)), `${W}x${H} must stay buildable`);
    assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED,
      'setEffect must succeed for a registered effect');
    engine.setClip(0, W, 0, H);
    engine.drawFrame();

    const held = engine.getPixels();
    assert.equal(isViewLive(held), true, 'a freshly fetched view must be live');
    const snapshot = Array.from(held);

    const baselineBytes = held.buffer.byteLength;
    const mesh = M.MeshOps.fromSolidName('cube');
    assert.ok(mesh, 'fromSolidName("cube") must build a mesh');
    mesh.delete();
    M.MeshOps.clearToolingMemory();

    assert.ok(engine.getPixels().buffer.byteLength > baselineBytes);
    assert.equal(isViewLive(held), false,
      'the tooling allocation must grow the heap and detach the held view; ' +
      'if it no longer does, nothing exercises the detachment contract src/renderer/driver.js ' +
      'guards against every frame');

    const { refreshed, view } = refreshPixelView(
      held, () => engine.getPixels(), engine.getBufferLength());
    assert.equal(refreshed, true, 'a detached view must be re-fetched');
    assert.equal(isViewLive(view), true, 'the re-fetched view must alias live memory');
    assert.equal(view.length, snapshot.length,
      're-fetched view length must match the pre-growth view');
    assert.deepEqual(Array.from(view), snapshot,
      'growth must preserve the pixels: the re-fetched view must be byte-identical');
  } finally {
    engine.delete();
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
    'getLastResult', 'getLastAdjusted',
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

// A null mesh is the bridge's recoverable failure channel; its recorded reason
// picks the remedy (shrink the chain versus flush the arenas).
test('meshOpFailure routes a real bridge reject by the reason the module records', () => {
  assert.ok(M.MeshOpResult, 'the module must export MeshOpResult');
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
    'update src/workbench/solids/solid_codegen.js KNOWN_OPS to match the engine');
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

// The bridge clamps an out-of-domain argument and logs, while
// generateFuncAndRecipe emits the authored value, which trips an always-on
// engine assert in firmware.
test('every OP_DEFS bound sits inside the engine domain the WASM bridge enforces', () => {
  const seed = 'cube';
  const clamped = [];
  let cases = 0;
  for (const [op, def] of Object.entries(OP_DEFS)) {
    for (const { label, params } of opBoundCases(def)) {
      cases++;
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
  assert.ok(cases > 0, 'OP_DEFS yielded no bound cases');
  assert.deepEqual(clamped.slice(0, 5), [],
    `${clamped.length} OP_DEFS endpoints made the WASM bridge log on a ${seed}; ` +
    'the range reaches outside the engine domain for that operator, so the ' +
    'preview silently clamps while the generated C++ carries the authored value ' +
    'into an engine assert. Narrow the range in src/workbench/solids/solid_codegen.js');
});

test('the seed lists name registered Simple solids and do not overlap', () => {
  assert.ok(SIMPLE_SEEDS.length > 0 && CATALAN_BASES.size > 0, 'both seed lists are populated');
  const registry = M.MeshOps.getRegistry();
  const simple = new Set();
  for (let i = 0; i < registry.length; i++) {
    if (registry[i].category === 'Simple') simple.add(registry[i].name);
  }
  const unregistered = [...SIMPLE_SEEDS, ...CATALAN_BASES]
    .filter((name) => !simple.has(name));
  assert.deepEqual(unregistered.slice(0, 5), [],
    `solid_codegen.js lists ${unregistered.length} names the engine registers no ` +
    'Simple solid for; update src/workbench/solids/solid_codegen.js to match solids.h');
  const inBoth = SIMPLE_SEEDS.filter((name) => CATALAN_BASES.has(name));
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
  // simple_registry ends.
  assert.ok(CATALAN_BASES.has(registry[SIMPLE_SEEDS.length].name),
    `SIMPLE_SEEDS stops short of simple_registry, which also holds ` +
    `"${registry[SIMPLE_SEEDS.length].name}"`);
  const unseeded = [...DEFINED_SEED_CONSTANTS]
    .filter((seed) => !SIMPLE_SEEDS.includes(seed));
  assert.deepEqual(unseeded.slice(0, 5), [],
    `DEFINED_SEED_CONSTANTS names ${unseeded.length} seeds that are no ` +
    'SIMPLE_SEEDS entry, so none of the registry just matched');
});

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

test('PaletteOps compiles a palette recipe', () => {
  assert.equal(typeof M.PaletteOps, 'function',
    'the module must export PaletteOps');
  const ops = new M.PaletteOps();
  try {
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
    assert.equal(compiled.status.code, M.PaletteCompileCode.OK);
    assert.ok(compiled.lut instanceof Uint8Array);
    assert.equal(compiled.lut.length, 256 * 3);
    recipe.chroma.center = 1;
    recipe.chroma.headroom = 0.8;
    const capped = ops.compileAndBakeV4(recipe);
    assert.equal(capped.status.code, M.PaletteCompileCode.OK);
    assert.ok(Math.abs(capped.canonicalRecipe.chroma.headroom - 0.8) < 1e-6);
    const inspected = ops.inspectV4(recipe);
    assert.equal(inspected.diagnostics.length, 256 * 6);
    assert.equal(inspected.fallback.length, 256);
  } finally {
    ops.delete();
  }
});

// Pinned against embind's own prototypes.
test('MeshOps returns the authored structured payloads', () => {
  const registry = M.MeshOps.getRegistry();
  assertDeclaredShape('SolidRegistryEntry', registry[0]);
  const complex = registry.find((/** @type {*} */ e) => e.category === 'Complex');
  assert.ok(complex, 'the registry must expose a Complex solid to read a recipe from');
  const recipe = M.MeshOps.getRecipe(complex.name);
  assertDeclaredShape('SolidRecipe', recipe);
  assertDeclaredShape('SolidRecipeStep', recipe.ops[0]);

  const mesh = M.MeshOps.fromSolidName('cube');
  assert.ok(mesh, 'fromSolidName("cube") must build a mesh');
  assertDeclaredShape('MeshFaces', mesh.getFaces());
  mesh.delete();
  assertDeclaredShape('MeshArenaMetrics', M.MeshOps.getArenaMetrics());
  M.MeshOps.clearToolingMemory();
});

test('PaletteOps returns the authored structured payloads', () => {
  const ops = new M.PaletteOps();
  try {
    const preset = Array.from(ops.effectPresetsV4())[0];
    assertDeclaredShape('PaletteEffectPreset', preset);
    const inspected = ops.inspectV4(preset.recipe);
    assertDeclaredShape('PaletteCompileResult', inspected);
    assertDeclaredShape('PaletteCompileStatus', inspected.status);
  } finally {
    ops.delete();
  }
});

/**
 * Instances of one WebAssembly.Module, each instantiated through the glue's
 * instantiateWasm hook: the glue must honour the hook, and instances must not
 * share state (the binary declares its own memory, so each gets a private heap,
 * global arena and engine singleton).
 */
test('the glue honours instantiateWasm, and shared-module instances stay isolated', async () => {
  const binary = readFileSync(new URL('../generated/holosphere_wasm.wasm', import.meta.url));
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
      assert.equal(e.setEffect(FIXTURE_EFFECT), mod.EffectSetResult.INSTALLED);
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

test('simulator consumes the active WASM display geometry', async () => {
  const { pixelToSpherical } = await import('../src/renderer/geometry.js');
  const { createDisplayCapsBinding } = await import('../src/renderer/display_caps.js');
  const dims = { W: 288, H: 144, DISPLAY_NORTH_PHI: 0, DISPLAY_SOUTH_PHI: Math.PI };
  const caps = createDisplayCapsBinding({ getEngine: () => engine,
    onChange: geometry => Object.assign(dims, geometry) });
  assert.equal(caps.apply(), true);
  assert.equal(pixelToSpherical(0, 0, dims).phi, 0);
  assert.ok(Math.abs(pixelToSpherical(0, dims.H - 1, dims).phi - Math.PI) < 1e-6);
  try {
    Object.assign(caps.state, { topCap: 2, bottomCap: 3 });
    assert.equal(caps.apply(), true);
    assert.ok(Math.abs(pixelToSpherical(0, 0, dims).phi - Math.PI * 0.02) < 1e-6);
    assert.ok(Math.abs(pixelToSpherical(0, dims.H - 1, dims).phi - Math.PI * 0.97) < 1e-6);
  } finally {
    engine.setDisplayCaps(0, 0);
  }
});

test('display caps default to full coverage and validate requests without rebuilding', () => {
  assert.equal(initialDisplayAngles[0], 0);
  assert.ok(Math.abs(initialDisplayAngles[1] - Math.PI) < 1e-6);
  assert.equal(engine.setDisplayCaps(0, 0), true);
  const generation = engine.getParamGeneration();
  const over = MAX_DISPLAY_CAP_PERCENT + 0.1;
  for (const caps of [[0, 0], [-1, 0], [over, 0], [0, over], [NaN, 0], [0, Infinity]]) {
    assert.equal(engine.setDisplayCaps(...caps), caps[0] === 0 && caps[1] === 0);
    assert.equal(engine.getParamGeneration(), generation);
    assert.equal(engine.getDisplayNorthPhi(), 0);
    assert.ok(Math.abs(engine.getDisplaySouthPhi() - Math.PI) < 1e-6);
  }
  try {
    assert.equal(engine.setDisplayCaps(MAX_DISPLAY_CAP_PERCENT, MAX_DISPLAY_CAP_PERCENT), true);
  } finally {
    engine.setDisplayCaps(0, 0);
  }
});

test('display caps preserve tuning, pause, clipping and resolution-independent placement', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)));
  assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED);
  const tunable = engine.getParameterDefinitions().find(writableNumeric);
  assert.equal(engine.setParameter(tunable.name, (tunable.min + tunable.max) / 2),
    M.ParamSetResult.APPLIED);
  engine.setAnimationsPaused(true);
  assert.equal(engine.setClip(0, W / 2, 0, H), M.ClipSetResult.APPLIED);
  const definitions = engine.getParameterDefinitions();
  const generation = engine.getParamGeneration();
  try {
    assert.equal(engine.setDisplayCaps(2, 3), true);
    assert.notEqual(engine.getParamGeneration(), generation);
    assert.deepEqual(engine.getParameterDefinitions(), definitions);
    assert.equal(engine.getAnimationsPaused(), true);
    assert.ok(Math.abs(engine.getDisplayNorthPhi() - Math.PI * 0.02) < 1e-6);
    assert.ok(Math.abs(engine.getDisplaySouthPhi() - Math.PI * 0.97) < 1e-6);
    engine.getPixels().fill(0);
    engine.drawFrame();
    const pixels = engine.getPixels();
    for (let y = 0; y < H; y++) {
      assert.ok(pixels.subarray((y * W + W / 2) * 3, (y + 1) * W * 3).every((v) => v === 0));
    }
    assert.ok(pixels.some((v) => v !== 0));
    assert.ok(resolutionOk(engine.setResolution(288, 144)));
    assert.equal(engine.setEffect(FIXTURE_EFFECT), M.EffectSetResult.INSTALLED);
    assert.ok(Math.abs(engine.getDisplayNorthPhi() - Math.PI * 0.02) < 1e-6);
    assert.ok(Math.abs(engine.getDisplaySouthPhi() - Math.PI * 0.97) < 1e-6);
  } finally {
    engine.setDisplayCaps(0, 0);
    engine.setAnimationsPaused(false);
    engine.setResolution(W, H);
  }
});

test('display caps preserve every effect\'s parameter values and rendering after rebuilds', () => {
  assert.ok(resolutionOk(engine.setResolution(W, H)));
  const values = () => Array.from(engine.getParameterDefinitions(),
    ({ name, value, acceptedValue }) => ({ name, value, acceptedValue }));
  const rendersWithin = (frames) => {
    for (let frame = 0; frame < frames; frame++) {
      engine.getPixels().fill(0);
      engine.drawFrame();
      if (engine.getPixels().some((value) => value !== 0)) return true;
    }
    return false;
  };
  const failures = [];
  try {
    for (const name of SIMULATOR_EFFECTS) {
      engine.setDisplayCaps(0, 0);
      assert.equal(engine.setEffect(name), M.EffectSetResult.INSTALLED, name);
      const before = values();
      assert.equal(engine.setDisplayCaps(2, 3), true);
      if (!isDeepStrictEqual(values(), before)) failures.push(`${name}: parameter values changed`);
      if (!rendersWithin(2)) failures.push(`${name}: blank frames`);
    }
  } finally {
    engine.setDisplayCaps(0, 0);
  }
  assert.deepEqual(failures, []);
});

test('each composite operator builds the mesh its registry lowering builds', () => {
  /** @param {*} mesh @returns {Array<number[]>} Vertices and face arrays, for comparison. */
  const geometry = (mesh) => {
    const faces = mesh.getFaces();
    return [Array.from(mesh.getVertices()), Array.from(faces.indices), Array.from(faces.counts)];
  };
  for (const name of Object.keys(LOWERING)) {
    for (const t of [0.25, 0.5]) {
      const op = { op: name, params: { t } };
      const live = [M.MeshOps.fromSolidName('cube'), M.MeshOps.fromSolidName('cube')];
      try {
        live.push(applyOp(live[0], op));
        const composite = live.at(-1);
        let lowered = live[1];
        for (const step of LOWERING[name](op)) {
          lowered = applyOp(lowered, step);
          live.push(lowered);
        }
        assert.deepEqual(geometry(composite), geometry(lowered), `${name}(${t})`);
      } finally {
        for (const mesh of live) mesh.delete();
      }
    }
  }
});

test('registry export rejects oversized intermediate primitive endpoints', async () => {
  const validator = createChainValidator(() => createHolosphereModule({ print: sink, printErr: sink }));
  await assert.rejects(validateRegistryFaces(validator, {
    name: 'Oversized', base: 'truncatedIcosahedron', ops: ['kis', 'kis', 'kis', 'dual'], fCount: 812,
  }), /endpoint has 1620 faces/);
  await validateRegistryFaces(validator, {
    name: 'Small', base: 'cube', ops: ['kis'], fCount: 24,
  });
});

test('whole-generated registry chains skip bridge budgets but retain endpoint budgets', async () => {
  const validator = createChainValidator(() => createHolosphereModule({print: sink, printErr: sink}));
  await assert.doesNotReject(validateRegistryFaces(validator, {
    name: 'Whole', base: 'truncatedIcosidodecahedron',
    ops: ['kis', {op: 'expand', params: {t: 0.5}}, 'dual'],
  }));
  await assert.rejects(validateRegistryFaces(validator, {
    name: 'Oversized', base: 'truncatedIcosahedron',
    ops: [{op: 'expand', params: {t: 0.5}}, 'kis', 'kis', 'kis'],
  }), /endpoint has .* faces/);
});

test('registry validation expands composite and flattened base recipes', async (t) => {
  const validator = createChainValidator(() => createHolosphereModule({ print: sink, printErr: sink }));
  const module = await validator.acquire();
  assert.ok(module);
  const calls = [];
  for (const name of KNOWN_OPS) {
    const original = module.MeshOps.prototype[name];
    t.mock.method(module.MeshOps.prototype, name, function (...args) {
      calls.push(name);
      return original.apply(this, args);
    });
  }
  for (const [op, primitives] of [
    ['meta', ['ambo', 'dual', 'kis']],
    ['needle', ['dual', 'kis']],
    ['zip', ['kis', 'dual']],
    ['gyro', ['snub', 'dual']],
    [{ op: 'bevel', params: { t: 0.5 } }, ['ambo', 'ambo']],
    [{ op: 'bevel', params: { t: 0.25 } }, ['ambo', 'truncate']],
  ]) {
    calls.length = 0;
    await assert.doesNotReject(validateRegistryFaces(validator, { name: 'Composite', base: 'cube', ops: [op] }));
    assert.deepEqual(calls, primitives);
  }
  calls.length = 0;
  await assert.doesNotReject(validateRegistryFaces(validator, { name: 'Flattened', base: 'authored', ops: ['dual'] }, {
    seed: 'cube', ops: [{ op: 'hankin', param: 45 * Math.PI / 180, twist: 0 }],
  }));
  assert.deepEqual(calls, ['hankin', 'dual']);
});


test('generated effect IDs and display names install the same preset and parameter signature', () => {
  assert.deepEqual(engine.getEffectIdentities(), EFFECT_IDENTITIES);
  const ids = new Set();
  const signature = () => ({
    presets: engine.getPresetIds(),
    params: paramNames(engine.getParameterDefinitions()),
  });
  for (const row of EFFECT_IDENTITIES) {
    assert.match(row.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(ids.has(row.id), false);
    ids.add(row.id);
    assert.equal(engine.setEffect(row.id), M.EffectSetResult.INSTALLED, row.id);
    const canonical = signature();
    assert.equal(engine.setEffect(row.display_name), M.EffectSetResult.INSTALLED, row.display_name);
    assert.deepEqual(signature(), canonical, row.display_name);
  }
});

test('palette CUSTOM transitions send canonical recipes to WASM', () => {
  const ops = new M.PaletteOps();
  try {
    const template = Array.from(ops.effectPresetsV4())[0].recipe;
    const controls = paletteControlsFromRecipe(template);
    controls.hueMode = 'HARMONY';
    controls.lightnessCurve = controls.chromaCurve = 'CONSTANT';
    template.hue.mode = PaletteV4.hueMode.CUSTOM;
    template.hue.customTurns = [0.1, 0.2, 0.3, 0.4];
    for (const name of ['lightness', 'chroma']) {
      template[name].curve = PaletteV4.curve.CUSTOM;
      template[name].custom = [0.2, 0.4, 0.6, 0.8];
    }
    const recipe = paletteRecipeFromControls(template, controls);
    assert.equal(paletteAdjustmentSummary(ops.inspectV4(recipe).status), '');
  } finally {
    ops.delete();
  }
});

test('every effect the engine registers is offered at some resolution', () => {
  const offered = new Set(Object.values(resolutionPresets).flatMap((preset) => preset.favorites));
  const missing = Array.from(engine.getEffectIdentities(), ({ display_name }) => display_name)
    .filter((name) => name !== 'ShaderChain' && !offered.has(name));
  assert.deepEqual(missing, []);
});
