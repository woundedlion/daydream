// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatFloat, pctSuffix, generateFuncAndRecipe, generateRecipeCpp, computeInternalAngle } =
  await import('../tools/solid_codegen.js');

test('formatFloat appends a decimal to whole numbers and an f suffix', () => {
  assert.equal(formatFloat(1), '1.0f');
  assert.equal(formatFloat(0.5), '0.5f');
  assert.equal(formatFloat(2), '2.0f');
  // Already-fractional values keep their decimal, gain only the f suffix.
  assert.equal(formatFloat(0.25), '0.25f');
  // Every output ends in the C++ float-literal marker.
  for (const v of [0, 1, 0.5, 3.14]) {
    assert.match(formatFloat(v), /f$/);
    assert.ok(formatFloat(v).includes('.'));
  }
});

test('pctSuffix quantizes to hundredths and pads to two digits', () => {
  assert.equal(pctSuffix(0.05), '05');
  assert.equal(pctSuffix(0.5), '50');
  assert.equal(pctSuffix(0.3), '30');
  // Float-error input still snaps cleanly.
  assert.equal(pctSuffix(0.30000000000000004), '30');
  assert.equal(pctSuffix(1), '100');
});

test('generateFuncAndRecipe builds func name and SolidBuilder chain', () => {
  const item = {
    base: 'icosahedron',
    ops: [
      { op: 'truncate', params: { t: 0.5 } },
      { op: 'dual', params: {} },
    ],
  };
  const { funcName, recipe } = generateFuncAndRecipe(item);

  assert.equal(funcName, 'icosahedron_truncate50_dual');
  assert.equal(recipe, 'SolidBuilder(icosahedron(a, b), a, b).truncate(0.5f).dual().build()');
  // Float literals embedded in the recipe are well-formed.
  assert.match(recipe, /\.truncate\(0\.5f\)/);
});

test('generateFuncAndRecipe handles hankin (angle * D2R) and relax (iter)', () => {
  const item = {
    base: 'cube',
    ops: [
      { op: 'hankin', params: { angle: 30 } },
      { op: 'relax', params: { iter: 200 } },
    ],
  };
  const { funcName, recipe } = generateFuncAndRecipe(item);
  assert.equal(funcName, 'cube_hk30_relax200');
  assert.equal(recipe, 'SolidBuilder(cube(a, b), a, b).hankin(30.0f * D2R).relax(200).build()');
});

test('generateRecipeCpp wraps the recipe in a FLASHMEM function with V/F/I comment', () => {
  const item = {
    base: 'tetrahedron',
    ops: [{ op: 'kis', params: {} }],
    vCount: 8,
    fCount: 12,
    iCount: 4,
  };
  const cpp = generateRecipeCpp(item);
  const expected =
    '// V=8, F=12, I=4\n' +
    'FLASHMEM inline PolyMesh tetrahedron_kis(Arena &a, Arena &b) {\n' +
    '  return SolidBuilder(tetrahedron(a, b), a, b).kis().build();\n' +
    '}';
  // Lock the full structure so any formatting drift is caught (this string is
  // pasted byte-for-byte into the engine).
  assert.equal(cpp, expected);
});

test('generateRecipeCpp defaults missing V/F/I counts to 0', () => {
  const cpp = generateRecipeCpp({ base: 'cube', ops: [] });
  assert.ok(cpp.startsWith('// V=0, F=0, I=0\n'));
});

test('computeInternalAngle returns ~90deg for a square face', () => {
  // Unit square in the XY plane; internal angle at each corner is 90 deg.
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

test('computeInternalAngle guards degenerate input', () => {
  assert.equal(computeInternalAngle(null), 0);
  assert.equal(computeInternalAngle({ faces: [] }), 0);
  assert.equal(computeInternalAngle({ vertices: [], faces: [[0, 1]] }), 0);
});
