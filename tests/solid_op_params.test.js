import { LOWERING } from '../src/workbench/solids/solid_registry_codegen.js';
import { stubMesh } from './helpers/fake_meshops.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OP_DEFS, KNOWN_OPS, D2R_F32, computeInternalAngle, snapToStep, seedOpParams, opsFromRecipe, opTopologyKey,
} from '../src/workbench/solids/solid_op_params.js';
import { applyOp, savedChainShapeError } from '../src/workbench/solids/solid_validation.js';
import { generateFuncAndRecipe } from '../src/workbench/solids/solid_codegen.js';
import { CLASS_METHODS } from '../generated/engine_contract.mjs';

test('every solid operation is bound by the engine MeshOps class', () => {
  for (const op of KNOWN_OPS) assert.ok(CLASS_METHODS.MeshOps.includes(op), op);
});

/** Verifies computeInternalAngle yields ~90deg (radians) for a unit-square face. */
test('computeInternalAngle returns ~90deg for a square face', () => {
  const mesh = {
    vertices: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0, y: 1, z: 0 },
    ],
    faces: [[0, 1, 2, 3]],
  };
  const deg = computeInternalAngle(mesh) * (180 / Math.PI);
  assert.ok(Math.abs(deg - 90) < 1e-6, `expected ~90, got ${deg}`);
});

/** Verifies computeInternalAngle yields ~60deg (radians) for an equilateral-triangle face. */
test('computeInternalAngle returns ~60deg for an equilateral triangle', () => {
  const mesh = {
    vertices: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0.5, y: Math.sqrt(3) / 2, z: 0 },
    ],
    faces: [[0, 1, 2]],
  };
  const deg = computeInternalAngle(mesh) * (180 / Math.PI);
  assert.ok(Math.abs(deg - 60) < 1e-6, `expected ~60, got ${deg}`);
});

/** Verifies computeInternalAngle returns 0 for null, empty-face, or insufficient-vertex meshes. */
test('computeInternalAngle guards degenerate input', () => {
  assert.equal(computeInternalAngle(null), 0);
  assert.equal(computeInternalAngle({ faces: [] }), 0);
  assert.equal(computeInternalAngle({ vertices: [], faces: [[0, 1]] }), 0);
  const corner = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }];
  assert.equal(computeInternalAngle({ vertices: corner, faces: [[0, 1, 2]] }), 0,
    'a zero-length second edge');
  assert.equal(computeInternalAngle({ vertices: corner, faces: [[1, 2, 0]] }), 0,
    'a zero-length first edge');
});

/** Verifies snapToStep lands on the step grid measured from min, and clamps to the range. */
test('snapToStep snaps to the nearest step from min and clamps', () => {
  const def = { min: 0, max: 90, step: 1 };
  assert.equal(snapToStep(54.7356, def), 55);
  assert.equal(snapToStep(54.4, def), 54);
  assert.equal(snapToStep(-10, def), 0);
  assert.equal(snapToStep(1000, def), 90);
  // The grid starts at min, not at 0.
  assert.equal(snapToStep(7.4, { min: 1, max: 20, step: 5 }), 6);
});

/** Verifies a value already on the grid is returned unchanged. */
test('snapToStep leaves an on-grid value alone', () => {
  const def = OP_DEFS.hankin.params.angle;
  for (const angle of [1, 17, 54, 90]) assert.equal(snapToStep(angle, def), angle);
  for (const t of [0.07, 0.29, 0.57, 0.99])
    assert.equal(snapToStep(t, { min: 0.01, max: 1, step: 0.01 }), t);
});

test('hankin controls start at a positive angle', () => {
  const def = OP_DEFS.hankin.params.angle;
  assert.ok(def.min > 0);
  assert.equal(snapToStep(0, def), def.min);
});

/**
 * Verifies the seeded hankin angle lies on the control's step grid and reaches
 * the generated funcName suffix, emitted recipe literal and live preview
 * unchanged.
 */
test('a seeded hankin angle agrees across the control, the funcName and the recipe', () => {
  // A face whose interior angle at its second vertex is arccos(-1/3) = 109.4712
  // degrees, giving a half-internal-angle seed of 54.7356 degrees.
  const s = Math.sqrt(8) / 3;
  const mesh = {
    vertices: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: -1 / 3, y: s, z: 0 }],
    faces: [[0, 1, 2]],
  };
  const def = OP_DEFS.hankin.params.angle;
  const derived = (computeInternalAngle(mesh) / 2) * (180 / Math.PI);
  assert.ok(Math.abs(derived - 54.7356) < 1e-3);
  assert.notEqual(derived, Math.round(derived)); // the seed is off the control's grid

  const { angle } = seedOpParams('hankin', mesh);
  assert.equal(angle, 55);

  // The range input: exactly on the step grid, so the thumb reads the state value.
  assert.equal((angle - def.min) % def.step, 0);
  assert.ok(angle >= def.min && angle <= def.max);
  assert.equal(Number(angle.toFixed(2)), angle);

  const { funcName, recipe } = generateFuncAndRecipe(
    { base: 'icosahedron', ops: [{ op: 'hankin', params: { angle } }] }, 'Archimedean');
  // The funcName suffix rounds the angle; on the grid, that IS the angle.
  assert.equal(funcName, `icosahedron_hk${angle}`);
  assert.equal(Math.round(angle), angle);
  // The emitted recipe literal parses back to the same angle.
  const literal = recipe.match(/\.hankin\((-?[\d.]+)f \* D2R\)/);
  assert.ok(literal, `no hankin literal in ${recipe}`);
  assert.equal(Number(literal[1]), angle);

  // The live preview: the same angle reaches the engine, in radians, as the
  // pasted `<literal>f * D2R` computes.
  const calls = [];
  applyOp(stubMesh(calls), { op: 'hankin', params: { angle } });
  assert.deepEqual(calls, [{ op: 'hankin', args: [Math.fround(angle * D2R_F32)] }]);
  assert.equal(calls[0].args[0], Math.fround(Number(literal[1]) * D2R_F32));
});



/** Verifies opTopologyKey names the parameter only where the engine lowers on it. */
test('opTopologyKey separates only the params that pick a lowering', () => {
  const key = (op, edge) => {
    const params = {};
    for (const [name, def] of Object.entries(OP_DEFS[op].params)) params[name] = def[edge];
    return opTopologyKey({ op, params });
  };
  for (const op of ['truncate', 'bevel']) {
    assert.notEqual(opTopologyKey({ op, params: { t: 0.5 } }), opTopologyKey({ op, params: { t: 0.49 } }));
    assert.equal(opTopologyKey({ op, params: { t: 0.49 } }), opTopologyKey({ op, params: { t: 0.25 } }));
    // A bare parameterized op carries no t, so it cannot be the aliased lowering.
    assert.equal(opTopologyKey(op), opTopologyKey({ op, params: { t: 0.25 } }));
  }
  const keys = new Set();
  for (const op of Object.keys(OP_DEFS)) {
    if (op === 'truncate' || op === 'bevel') continue;
    assert.equal(key(op, 'min'), key(op, 'max'), `${op} params leave its topology key alone`);
    assert.equal(key(op, 'min'), opTopologyKey(op));
    keys.add(key(op, 'min'));
  }
  keys.add(opTopologyKey('truncate'));
  keys.add(opTopologyKey('bevel'));
  assert.equal(keys.size, Object.keys(OP_DEFS).length, 'distinct ops never share a key');
});

test('restored float32 ambo aliases use the engine topology and bevel lowering', () => {
  for (const op of ['truncate', 'bevel']) {
    const alias = { op, params: { t: 0.499999995 } };
    assert.equal(savedChainShapeError('cube', [alias]), null);
    assert.equal(opTopologyKey(alias), opTopologyKey({ op, params: { t: 0.5 } }));
    assert.notEqual(opTopologyKey(alias), op);
    assert.equal(opTopologyKey({ op, params: { t: 0.49999 } }), op);
    if (op === 'bevel') assert.deepEqual(LOWERING.bevel(alias), ['ambo', 'ambo']);
  }
});

test('seedOpParams handles parameterless, ordinary and missing-mesh seeds', () => {
  assert.deepEqual(seedOpParams('dual', null), {});
  assert.deepEqual(seedOpParams('truncate', null), { t: OP_DEFS.truncate.params.t.val });
  assert.deepEqual(seedOpParams('hankin', null), { angle: OP_DEFS.hankin.params.angle.val });
});

test('opsFromRecipe maps engine-native steps to editor units', () => {
  const rad = (deg) => Math.fround(deg * D2R_F32);
  const ops = opsFromRecipe([
    { op: 'hankin', param: rad(62), twist: 0 },
    { op: 'ambo', param: 0, twist: 0 },
    { op: 'truncate', param: Math.fround(0.33), twist: 0 },
    { op: 'truncate', param: rad(5), twist: 0 },
    { op: 'snub', param: Math.fround(0.5), twist: Math.fround(0.25) },
    { op: 'relax', param: 0, twist: 0 },
    { op: 'relax', param: 100, twist: 0 },
  ]);
  assert.deepEqual(ops, [
    { op: 'hankin', params: { angle: 62 } },
    { op: 'ambo', params: {} },
    { op: 'truncate', params: { t: 0.33 } },
    { op: 'truncate', params: { t: ops[3].params.t } },
    { op: 'snub', params: { t: 0.5, twist: 0.25 } },
    { op: 'relax', params: { iter: OP_DEFS.relax.params.iter.max } },
    { op: 'relax', params: { iter: 100 } },
  ]);
  // Off-grid params are kept at the authored float, not snapped.
  assert.equal(Math.fround(ops[3].params.t), rad(5));
  assert.throws(() => opsFromRecipe([{ op: 'warp', param: 0, twist: 0 }]), /unknown op "warp"/);
});
