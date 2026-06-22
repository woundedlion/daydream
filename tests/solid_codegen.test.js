// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatFloat, pctSuffix, generateFuncAndRecipe, generateRecipeCpp, computeInternalAngle } =
  await import('../tools/solid_codegen.js');

/** Verifies formatFloat renders whole and fractional numbers as C++ float literals (trailing `.0`/decimal plus `f`). */
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

/** Verifies pctSuffix rounds a fraction to hundredths and emits a zero-padded two-or-three-digit string, snapping float error. */
test('pctSuffix quantizes to hundredths and pads to two digits', () => {
  assert.equal(pctSuffix(0.05), '05');
  assert.equal(pctSuffix(0.5), '50');
  assert.equal(pctSuffix(0.3), '30');
  // Float-error input still snaps cleanly.
  assert.equal(pctSuffix(0.30000000000000004), '30');
  assert.equal(pctSuffix(1), '100');
});

/** Verifies generateFuncAndRecipe derives the function name and SolidBuilder call chain for a truncate+dual recipe. */
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

/** Verifies generateFuncAndRecipe special-cases hankin (degree angle scaled by D2R) and relax (integer iter count). */
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

/** Verifies generateRecipeCpp emits the full FLASHMEM function source, prefixed by the V/F/I count comment, byte-for-byte. */
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

/** Verifies generateRecipeCpp falls back to zero vertex/face/internal counts when the item omits them. */
test('generateRecipeCpp defaults missing V/F/I counts to 0', () => {
  const cpp = generateRecipeCpp({ base: 'cube', ops: [] });
  assert.ok(cpp.startsWith('// V=0, F=0, I=0\n'));
});

/** Verifies computeInternalAngle yields ~90deg (radians) for a unit-square face. */
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
});

/** Verifies generateFuncAndRecipe rejects a base or op that would emit non-compiling C++ (finding 5 guard). */
test('generateFuncAndRecipe rejects an unknown op or a malformed base', () => {
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'frobnicate', params: {} }] }),
    /unknown op "frobnicate"/);
  assert.throws(() => generateFuncAndRecipe({ base: 'cube(a,b); evil()', ops: [] }),
    /not a valid C\+\+ identifier/);
  assert.throws(() => generateFuncAndRecipe({ base: '', ops: [] }),
    /not a valid C\+\+ identifier/);
  // A well-formed base + known ops still pass.
  assert.doesNotThrow(() => generateFuncAndRecipe({ base: 'icosahedron', ops: ['dual', { op: 'truncate', params: { t: 0.3 } }] }));
});
