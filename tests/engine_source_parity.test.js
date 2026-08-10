//
// Source-text parity between the browser tools' hand-transcribed engine values
// and the C++ headers they are transcribed from.
//
// tests/color_parity_wasm.test.js runs the tools against the shipped WASM, which
// reaches only what wasm.cpp exports, and only at the engine SHA the committed
// binary was built from (holosphere_wasm.sha). Reading the headers instead
// covers the projection constants — the engine's fused mobius_transform never
// touches them, so no export can — and sees an edit at engine HEAD before a
// rebuild.
//
// The engine is a separate repository. The JS unit suite checks it out and sets
// HOLOSPHERE_ENGINE_REQUIRED, under which a missing tree fails instead of
// skipping; only a local run without a checkout skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as MB from '../tools/mobius_transforms.js';
import * as C from '../tools/color.js';
import * as P from '../tools/palette_math.js';
import * as PC from '../tools/palette_controls.js';
import { DEFINED_SEED_CONSTANTS, SIMPLE_SEEDS } from '../tools/solid_codegen.js';
import { upperSnake } from '../tools/solid_registry_codegen.js';

const REPO = new URL('../', import.meta.url);
const ENGINE_ENV = 'HOLOSPHERE_ENGINE_DIR';
const REQUIRED_ENV = 'HOLOSPHERE_ENGINE_REQUIRED';
// js-unit-suite.yml and deploy.yml's gate both check the engine out to engine/;
// a working checkout sits beside this repo under either its directory name.
const CANDIDATES = ['engine', '../Holosphere', '../pov'];
const MARKER = 'core/math/3dmath.h';

/**
 * Locates a Holosphere checkout to read headers from.
 * @returns {{root: ?string, tried: string[]}} The tree's absolute path, or null
 *   with every path that was probed.
 */
function findEngine() {
  const roots = process.env[ENGINE_ENV]
    ? [resolve(process.env[ENGINE_ENV])]
    : CANDIDATES.map((c) => fileURLToPath(new URL(c, REPO)));
  for (const root of roots) if (existsSync(join(root, MARKER))) return { root, tried: roots };
  return { root: null, tried: roots };
}

const { root: ENGINE, tried: TRIED } = findEngine();
const MISSING =
  `no Holosphere checkout holds ${MARKER} (looked in ${TRIED.join(', ')}) — ` +
  `set ${ENGINE_ENV} to an engine tree to run the source-parity checks`;
// Every case runs where the engine is declared required, so a job that lost its
// engine checkout reports a failure rather than a green run of nothing.
const SKIP = ENGINE || process.env[REQUIRED_ENV] ? false : MISSING;

/**
 * Reads an engine header.
 * @param {string} path - Path below the engine root, e.g. 'core/color/color.h'.
 * @returns {string} The file's text.
 */
const header = (path) => {
  assert.ok(ENGINE, MISSING);
  return readFileSync(join(ENGINE, path), 'utf8');
};

/**
 * Every numeric literal in a fragment of C++ or JS, in source order, with the
 * C++ float suffix dropped.
 * @param {string} text - Source fragment.
 * @returns {number[]} The literals as JS numbers.
 */
const numbersIn = (text) =>
  [...text.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?f?\b/g)]
    .map(([lit]) => Number(lit.replace(/f$/, '')));

/**
 * The body of a single named function, for either language.
 * @param {string} source - File text.
 * @param {string} name - Function name.
 * @returns {string} Everything between the opening brace and the closing brace
 *   in column zero.
 */
function functionBody(source, name) {
  const m = source.match(new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `${name} not found — the parity reader is out of date with the source`);
  return m[1];
}

/**
 * Evaluates an `inline constexpr float` definition from an engine header.
 * @param {string} source - Header text.
 * @param {string} name - Constant name.
 * @param {Object<string, number>} scope - Constants its expression may name.
 * @returns {number} The value, computed in double precision.
 */
function engineConstant(source, name, scope = {}) {
  const m = source.match(new RegExp(`inline constexpr float ${name}\\s*=\\s*([^;]+);`));
  assert.ok(m, `${name} not found in ${MARKER} — the parity reader is out of date`);
  const expr = m[1].replace(/\s+/g, ' ').replace(/(\d)f\b/g, '$1');
  // Guards the eval below: arithmetic over the named constants, nothing else.
  assert.match(expr, /^[\w\s.+\-*/()]+$/, `${name} = ${expr} is not a plain arithmetic expression`);
  const names = Object.keys(scope);
  return Function(...names, `return ${expr};`)(...names.map((k) => scope[k]));
}

/**
 * Pins the stereographic-projection constants mobius_transforms.js mirrors to
 * their definitions in core/math/3dmath.h. STEREO_POLE_EPS is derived from
 * STEREO_INF on both sides, so the engine's expression is evaluated rather than
 * its value read, and a change to either the sentinel or the derivation fails.
 */
test('projection constants match core/math/3dmath.h', { skip: SKIP }, () => {
  const src = header(MARKER);
  const inf = engineConstant(src, 'STEREO_INF');
  assert.equal(MB.STEREO_INF, inf, 'STEREO_INF drifted from the engine sentinel');
  assert.equal(MB.STEREO_POLE_EPS, engineConstant(src, 'STEREO_POLE_EPS', { STEREO_INF: inf }),
    'STEREO_POLE_EPS drifted from the engine pole cap');
  assert.equal(MB.STEREO_AZIMUTH_EPS, engineConstant(src, 'STEREO_AZIMUTH_EPS'),
    'STEREO_AZIMUTH_EPS drifted from the engine azimuth floor');
});

/**
 * Pins the GLSL prelude the mobius.html shader compiles to the same engine
 * definitions. The shader is the preview's only renderer, so a constant that
 * tracked the JS module but not the header would still lie about the pole cap.
 */
test('glslProjectionFunctions constants match core/math/3dmath.h', { skip: SKIP }, () => {
  const src = header(MARKER);
  const inf = engineConstant(src, 'STEREO_INF');
  const glsl = MB.glslProjectionFunctions;
  for (const [name, value] of [
    ['STEREO_INF', inf],
    ['STEREO_POLE_EPS', engineConstant(src, 'STEREO_POLE_EPS', { STEREO_INF: inf })],
    ['STEREO_AZIMUTH_EPS', engineConstant(src, 'STEREO_AZIMUTH_EPS')],
  ]) {
    const m = glsl.match(new RegExp(`const float ${name}\\s*=\\s*([^;]+);`));
    assert.ok(m, `glslProjectionFunctions does not declare ${name}`);
    assert.equal(Function(`const STEREO_INF = ${inf}; return ${m[1]};`)(), value,
      `the shader's ${name} drifted from the engine`);
  }
});

// The two sRGB transfer functions, as color.js names them and as core/color/color.h
// does. Both ports are a single guarded expression whose coefficients appear in
// the same order, so the ordered literals are the comparison — an operator or
// grouping change that keeps them is invisible here, and is caught instead by
// tests/color_parity_wasm.test.js's output sweep.
const SRGB_FUNCTIONS = [
  ['srgbToLinearFloat', 'srgb_to_linear_float'],
  ['linearToSrgbFloat', 'linear_to_srgb_float'],
];

/**
 * Pins color.js's sRGB transfer coefficients to core/color/color.h. The WASM
 * bridge compares the two functions' outputs over a sample sweep; this compares
 * the constants themselves, so a coefficient the sweep happens not to separate
 * still fails.
 */
test('sRGB transfer coefficients match core/color/color.h', { skip: SKIP }, () => {
  const cpp = header('core/color/color.h');
  const js = readFileSync(fileURLToPath(new URL('tools/color.js', REPO)), 'utf8');
  for (const [jsName, cppName] of SRGB_FUNCTIONS) {
    // The scraped file is only the module under test while it still exports it.
    assert.equal(typeof C[jsName], 'function', `color.js must export ${jsName}`);
    const want = numbersIn(functionBody(cpp, cppName));
    assert.ok(want.length > 0, `${cppName} yielded no coefficients — the reader is out of date`);
    assert.deepEqual(numbersIn(functionBody(js, jsName)), want,
      `${jsName} coefficients drifted from ${cppName}`);
  }
});

/**
 * Pins palette_controls.js's OKLab matrix to core/color/color.h. The engine
 * splits the same arithmetic across two functions — the inverse OKLab matrix
 * then the cube-and-RGB matrix — whose coefficients appear in the order
 * oklchLinearRgb restates them. Everything the palettes page draws in OKLCh
 * rides on these: the hue wheel's raster, and the gamut boundary
 * maxSrgbGamutChroma bisects for.
 */
test('the OKLab matrix matches core/color/color.h', { skip: SKIP }, () => {
  const cpp = header('core/color/color.h');
  const js = readFileSync(fileURLToPath(new URL('tools/palette_controls.js', REPO)), 'utf8');
  assert.equal(typeof PC.oklchLinearRgb, 'function', 'palette_controls.js must export oklchLinearRgb');
  const want = [
    ...numbersIn(functionBody(cpp, 'oklab_to_lms_cbrt')),
    ...numbersIn(functionBody(cpp, 'lms_cbrt_to_linear_rgb')),
  ];
  assert.equal(want.length, 15, 'read the wrong coefficient count — the reader is out of date');
  // The turns -> (a, b) polar prelude has no engine counterpart, so the
  // comparison starts where the JS port picks the matrix up.
  const body = functionBody(js, 'oklchLinearRgb');
  const matrix = body.indexOf('const lRoot');
  assert.notEqual(matrix, -1, 'oklchLinearRgb no longer opens its matrix with lRoot');
  assert.deepEqual(numbersIn(body.slice(matrix)), want,
    'the OKLab matrix drifted from the engine');
});

/**
 * The engine's named-palette roster, read from its X-macro list.
 * @param {string} source - core/color/palettes.h text.
 * @returns {{name:string, a:number[], b:number[], c:number[], d:number[]}[]} One
 *   entry per X(...) row, in declaration order.
 */
function enginePalettes(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('#define HS_PROCEDURAL_PALETTE_LIST(X)'));
  assert.notEqual(start, -1, 'HS_PROCEDURAL_PALETTE_LIST not found in core/color/palettes.h');
  const body = [];
  // The macro runs to the first line its predecessor did not continue.
  for (let i = start; i < lines.length; i++) {
    body.push(lines[i]);
    if (!lines[i].trimEnd().endsWith('\\')) break;
  }
  const flat = body.map((l) => l.trimEnd().replace(/\\$/, '')).join(' ');
  const rows = [...flat.matchAll(
    /X\(\s*(\w+)\s*,\s*\(([^)]*)\)\s*,\s*\(([^)]*)\)\s*,\s*\(([^)]*)\)\s*,\s*\(([^)]*)\)\s*\)/g)];
  return rows.map(([, name, ...vecs]) => {
    const [a, b, c, d] = vecs.map((v) => numbersIn(v));
    return { name, a, b, c, d };
  });
}

/**
 * Pins palette_math.js's NAMED_PROCEDURAL_PALETTES to the engine's own roster
 * literals: name, order and all twelve coefficients. The WASM bridge pins the
 * same table, but only at the SHA the committed binary was built from, so a
 * palette added or retuned since that build shows up here first.
 */
test('NAMED_PROCEDURAL_PALETTES matches core/color/palettes.h', { skip: SKIP }, () => {
  const want = enginePalettes(header('core/color/palettes.h'));
  assert.ok(want.length >= 20, `read only ${want.length} palettes — the roster reader is out of date`);
  for (const p of want) {
    for (const key of ['a', 'b', 'c', 'd'])
      assert.equal(p[key].length, 3, `${p.name}.${key} is not a vec3`);
  }
  assert.deepEqual(P.NAMED_PROCEDURAL_PALETTES.map(({ name, a, b, c, d }) => ({ name, a, b, c, d })),
    want, 'the palette roster drifted from the engine table');
});

/**
 * The `SEED_*` constants core/mesh/solids.h declares.
 * @param {string} source - core/mesh/solids.h text.
 * @returns {Map<string, number>} Constant name -> the simple_registry index it holds.
 */
function engineSeedConstants(source) {
  return new Map([...source.matchAll(/inline constexpr uint8_t (SEED_\w+)\s*=\s*(\d+);/g)]
    .map(([, name, index]) => [name, Number(index)]));
}

/**
 * Pins solid_codegen.js's DEFINED_SEED_CONSTANTS to the constants solids.h
 * actually declares. The registry generator leads a paste with a seed
 * constant's definition exactly when the set says the engine has none, so drift
 * either way emits C++ that does not compile: a redefinition, or a Recipe
 * naming an undeclared identifier. Each constant's value is checked against
 * SIMPLE_SEEDS too, since the definition a paste carries is generated from that
 * index.
 */
test('DEFINED_SEED_CONSTANTS matches core/mesh/solids.h', { skip: SKIP }, () => {
  const declared = engineSeedConstants(header('core/mesh/solids.h'));
  assert.ok(declared.size > 0,
    'no SEED_* constant found in core/mesh/solids.h — the reader is out of date');
  const seedOf = new Map(SIMPLE_SEEDS.map((name) => [`SEED_${upperSnake(name)}`, name]));
  const want = [];
  for (const [constant, index] of declared) {
    const seed = seedOf.get(constant);
    assert.ok(seed, `${constant} names no SIMPLE_SEEDS entry, so no paste can ever cite it`);
    assert.equal(SIMPLE_SEEDS.indexOf(seed), index,
      `${constant} is ${index} in the engine but ${SIMPLE_SEEDS.indexOf(seed)} in SIMPLE_SEEDS`);
    want.push(seed);
  }
  assert.deepEqual([...DEFINED_SEED_CONSTANTS].sort(), want.sort(),
    'DEFINED_SEED_CONSTANTS drifted from the engine: a seed it names but solids.h '
    + 'does not leaves a Recipe citing an undeclared SEED_*, and one it omits makes '
    + 'the paste redefine a constant the header already has');
});
