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
import {
  DEFINED_SEED_CONSTANTS, MORPH_SWEEP, OP_DEFS, SIMPLE_SEEDS,
} from '../tools/solid_codegen.js';
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

// Gated with the rest so a local run without an engine tree stays wholly
// skipped; the workflow it reads is the one that checks the engine out, so the
// case always runs where the flag has to be set.
test('the unit-suite workflow runs this suite against a required engine',
  { skip: SKIP }, () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('.github/workflows/js-unit-suite.yml', REPO)), 'utf8');
    assert.match(workflow, new RegExp(`${REQUIRED_ENV}:`),
      `the workflow must set ${REQUIRED_ENV}, or a job that lost its engine ` +
        'checkout retires every parity case as a skip and still reports green');
  });

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

// The core/math/3dmath.h spellings an engine Complex body uses, paired with the
// JS the mobius_transforms port writes them as. Comments are stripped first so a
// `//` cannot swallow a later substitution.
const ENGINE_CPP_TO_JS = [
  [/\/\/[^\n]*/g, ''],
  [/\bconst float\b/g, 'const'],
  [/\bfloat\b/g, 'const'],
  [/\bstd::(max|min|abs)\(/g, 'Math.$1('],
  [/\bsqrtf\(/g, 'Math.sqrt('],
  [/(\d)f\b/g, '$1'],
];

/**
 * Rewrites every `Complex(re, im)` construction in a C++ fragment as the
 * {re, im} object literal the JS port returns. The arguments can nest parens, so
 * the split is on the top-level comma rather than by regex.
 * @param {string} text - The fragment.
 * @returns {string} The fragment with each construction rewritten.
 */
function complexToObject(text) {
  let source = text;
  let at = 0;
  while ((at = source.indexOf('Complex(', at)) !== -1) {
    const open = at + 'Complex'.length;
    let depth = 0, comma = -1, close = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')' && (depth -= 1) === 0) { close = i; break; }
      else if (source[i] === ',' && depth === 1) comma = i;
    }
    assert.ok(comma > open && close > comma,
      `unreadable Complex(...) at "${source.slice(at, at + 60)}"`);
    source = `${source.slice(0, at)}({ re: (${source.slice(open + 1, comma)}), `
      + `im: (${source.slice(comma + 1, close)}) })${source.slice(close + 1)}`;
    at = 0;
  }
  return source;
}

/**
 * Transpiles one `inline Complex NAME(...)` engine body into a JS function, so
 * the comparison runs the header's own arithmetic rather than a second
 * transcription of it. Both sides then evaluate in doubles, which makes the
 * agreement exact rather than approximate.
 * @param {string} src - core/math/3dmath.h text.
 * @param {string} name - The function's C++ name.
 * @param {string[]} params - JS parameter names, in signature order.
 * @param {Object<string, number>} constants - Engine constants the body names.
 * @returns {(...args: any[]) => {re: number, im: number}} The transpiled function.
 */
function transpileEngineComplex(src, name, params, constants) {
  let body = functionBody(src, name);
  for (const [pattern, replacement] of ENGINE_CPP_TO_JS) {
    body = body.replace(pattern, /** @type {string} */ (replacement));
  }
  body = complexToObject(body);
  assert.doesNotMatch(body, /std::|sqrtf|\bfloat\b|\bComplex\b/,
    `${name} still holds C++ this reader cannot translate: ${body}`);
  const preamble = Object.entries(constants).map(([k, v]) => `const ${k} = ${v};`).join('\n');
  return /** @type {any} */ (Function(...params, `${preamble}\n${body}`));
}

// Sphere points the projection is compared over: the equator, a generic point,
// both poles, and the pole cap sampled off-axis so the azimuth branch runs.
const STEREO_POINTS = (() => {
  const points = [
    { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 },
    { x: 0.48, y: 0.6, z: 0.64 }, { x: -0.36, y: 0.48, z: -0.8 },
    { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  ];
  for (const y of [1 - MB.STEREO_POLE_EPS / 2, 1 - MB.STEREO_POLE_EPS * 1.5, 1 - 1e-4]) {
    const r = Math.sqrt(1 - y * y);
    for (const [ux, uz] of [[1, 0], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2]]) {
      points.push({ x: r * ux, y, z: r * uz });
    }
  }
  return points;
})();

// Numerator/divisor pairs spanning project_div's branches: ordinary quotients, a
// numerator that saturates on the relative test, a divisor small enough that the
// general cdiv would zero it out, the 0/0 indeterminate form, and magnitudes
// whose square leaves the representable range.
const PROJECT_DIV_PAIRS = [
  [{ re: 4, im: 2 }, { re: 2, im: 0 }],
  [{ re: 1, im: -3 }, { re: -0.5, im: 0.25 }],
  [{ re: 1e5, im: 0 }, { re: 1, im: 0 }],
  [{ re: 1e5, im: 1e5 }, { re: 1, im: 0 }],
  [{ re: 1e-6, im: 0 }, { re: 4e-4, im: 0 }],
  [{ re: 0, im: 0 }, { re: 0, im: 0 }],
  [{ re: 1, im: 1 }, { re: 0, im: 0 }],
  [{ re: 3e200, im: -1e200 }, { re: 1, im: 0 }],
  [{ re: 1e-200, im: 1e-200 }, { re: 1e-260, im: 0 }],
];

/**
 * Pins mobius_transforms.js's stereo and projectDiv to the bodies of stereo and
 * project_div in core/math/3dmath.h. The constants above are pinned separately,
 * but these two functions are what mobius.html's shader actually runs, and the
 * WASM bridge reaches only the engine's fused mobius_transform — which never
 * calls either in isolation, so no export can separate them. Comparing the
 * header's own body, transpiled, catches a reordered guard or a changed
 * fallback that matching constants would hide.
 */
test('stereo and projectDiv match core/math/3dmath.h', { skip: SKIP }, () => {
  const src = header(MARKER);
  const inf = engineConstant(src, 'STEREO_INF');
  const constants = {
    STEREO_INF: inf,
    STEREO_POLE_EPS: engineConstant(src, 'STEREO_POLE_EPS', { STEREO_INF: inf }),
    STEREO_AZIMUTH_EPS: engineConstant(src, 'STEREO_AZIMUTH_EPS'),
  };
  const engineStereo = transpileEngineComplex(src, 'stereo', ['v'], constants);
  const engineProjectDiv = transpileEngineComplex(src, 'project_div', ['num', 'den'], constants);

  for (const v of STEREO_POINTS) {
    const want = engineStereo(v);
    const got = MB.stereo(v);
    assert.equal(got.re, want.re, `stereo(${JSON.stringify(v)}).re drifted from the engine`);
    assert.equal(got.im, want.im, `stereo(${JSON.stringify(v)}).im drifted from the engine`);
  }
  for (const [num, den] of PROJECT_DIV_PAIRS) {
    const pair = `${JSON.stringify(num)} / ${JSON.stringify(den)}`;
    const want = engineProjectDiv(num, den);
    const got = MB.projectDiv(num, den);
    assert.equal(got.re, want.re, `projectDiv ${pair} .re drifted from the engine`);
    assert.equal(got.im, want.im, `projectDiv ${pair} .im drifted from the engine`);
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

// Each V4 recipe enum, as the tool modules group it and as core/color/color.h
// declares it. Both mirrors are keyed by these group names, so a group added on
// one side and not the other fails before any roster is read.
const V4_ENUMS = [
  ['hueMode', 'HueMode'],
  ['harmony', 'PaletteHarmony'],
  ['direction', 'HueDirection'],
  ['curve', 'AxisCurve'],
  ['chromaBasis', 'ChromaBasis'],
  ['colorPath', 'ColorPath'],
  ['domain', 'PaletteDomain'],
  ['easing', 'SegmentEase'],
];

/**
 * The enumerators of a plain `enum class`, in declaration order.
 * @param {string} source - core/color/color.h text.
 * @param {string} name - The enum's C++ name.
 * @returns {string[]} The enumerator names; their positions are their values.
 */
function engineEnumerators(source, name) {
  const m = source.match(new RegExp(`enum class ${name}\\s*:\\s*uint8_t\\s*\\{([^}]*)\\}`));
  assert.ok(m, `enum class ${name} not found in core/color/color.h — the reader is out of date`);
  const members = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  for (const member of members) {
    assert.match(member, /^[A-Z][A-Z0-9_]*$/,
      `${name}::${member} is not a bare enumerator, so position no longer gives its value`);
  }
  return members;
}

/**
 * Pins both V4 enum mirrors to the engine rosters they encode: PaletteV4
 * (name -> value) in palette_controls.js and ENUM_NAMES (value -> name) in
 * palette_math.js. The two are written out independently — one drives the
 * page's harmony and hue-path branches, the other names the enumerators in the
 * exported C++ — so a reordered or inserted engine enumerator can leave the
 * page computing one harmony and the paste naming another.
 */
test('the V4 enum rosters match core/color/color.h', { skip: SKIP }, () => {
  const cpp = header('core/color/color.h');
  const groups = V4_ENUMS.map(([group]) => group).sort();
  assert.deepEqual(Object.keys(PC.PaletteV4).sort(), groups,
    'PaletteV4 no longer covers exactly the engine enums this case reads');
  assert.deepEqual(Object.keys(P.ENUM_NAMES).sort(), groups,
    'ENUM_NAMES no longer covers exactly the engine enums this case reads');
  for (const [group, cppName] of V4_ENUMS) {
    const want = engineEnumerators(cpp, cppName);
    assert.deepEqual(P.ENUM_NAMES[group], want, `ENUM_NAMES.${group} drifted from ${cppName}`);
    assert.deepEqual(PC.PaletteV4[group], Object.fromEntries(want.map((n, i) => [n, i])),
      `PaletteV4.${group} drifted from ${cppName}`);
  }
});

const COLOR_H = 'core/color/color.h';

/**
 * The enumerators of an `enum class` whose members carry explicit values, keyed
 * by the value each one is pinned to.
 * @param {string} source - core/color/color.h text.
 * @param {string} name - The enum's C++ name.
 * @returns {Map<number, string>} Value -> enumerator name.
 */
function engineValuedEnumerators(source, name) {
  const m = source.match(new RegExp(`enum class ${name}\\s*:\\s*uint8_t\\s*\\{([^}]*)\\}`));
  assert.ok(m, `enum class ${name} not found in ${COLOR_H} — the reader is out of date`);
  const roster = new Map();
  let next = 0;
  for (const member of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    const parsed = member.match(/^([A-Z][A-Z0-9_]*)(?:\s*=\s*(\d+))?$/);
    assert.ok(parsed, `${name}::${member} is not an enumerator this reader can value`);
    next = parsed[2] === undefined ? next : Number(parsed[2]);
    roster.set(next, parsed[1]);
    next += 1;
  }
  return roster;
}

// The two status enums a failed compile is reported through, as palette_math.js
// names its rosters and as core/color/color.h declares them.
const STATUS_ENUMS = [
  ['COMPILE_CODE_NAMES', 'PaletteCompileCode'],
  ['RECIPE_FIELD_NAMES', 'PaletteRecipeField'],
];

/**
 * Pins the compiler-status rosters palette_math.js reports a failed palette
 * compile through. The bridge hands back bare ordinals, so these names are the
 * only thing that turns a refusal into a reason a user can act on; an enumerator
 * inserted or renumbered in the engine would otherwise re-label every message
 * silently and point the blame at the wrong recipe field.
 */
test('the compile-status rosters match core/color/color.h', { skip: SKIP }, () => {
  const cpp = header(COLOR_H);
  for (const [roster, cppName] of STATUS_ENUMS) {
    const want = engineValuedEnumerators(cpp, cppName);
    assert.ok(want.size > 0, `${cppName} yielded no enumerators — the reader is out of date`);
    const got = P[roster];
    assert.equal(got.length, Math.max(...want.keys()) + 1,
      `${roster} does not span ${cppName}'s ordinals`);
    for (const [value, name] of want) {
      assert.equal(got[value], name, `${roster}[${value}] drifted from ${cppName}::${name}`);
    }
  }
});

/**
 * The non-static data members of a plain struct, in declaration order.
 * @param {string} source - core/color/color.h text.
 * @param {string} name - The struct's C++ name.
 * @returns {{type: string, field: string}[]} Each member's declared type and name.
 */
function engineStructFields(source, name) {
  const m = source.match(new RegExp(`struct ${name} \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(m, `struct ${name} not found in ${COLOR_H} — the reader is out of date`);
  const fields = [];
  for (const decl of m[1].split(';')) {
    const text = decl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
    if (!text || text.startsWith('static')) continue;
    const member = text.match(/^(std::array<[^>]+>|[\w:]+)\s+(\w+)\s*(?:=[\s\S]+|\{\s*\})?$/);
    assert.ok(member, `unreadable member "${text}" in struct ${name} — the reader is out of date`);
    fields.push({ type: member[1], field: member[2] });
  }
  return fields;
}

/**
 * Every leaf field below a struct, keyed by the dotted path a C++ assignment
 * reaches it through.
 * @param {string} source - core/color/color.h text.
 * @param {string} name - The root struct's C++ name.
 * @returns {Map<string, string>} Path -> the leaf's declared C++ type.
 */
function engineLeafFields(source, name) {
  const leaves = new Map();
  for (const { type, field } of engineStructFields(source, name)) {
    if (new RegExp(`struct ${type} \\{`).test(source)) {
      for (const [path, leafType] of engineLeafFields(source, type)) {
        leaves.set(`${field}.${path}`, leafType);
      }
    } else {
      leaves.set(field, type);
    }
  }
  return leaves;
}

/**
 * Pins the C++ field paths generativePaletteCpp writes to the members
 * PaletteRecipe and its nested control structs actually declare. That paste is
 * the palettes page's headline deliverable and nothing else checks it: the WASM
 * bridge takes the JS-side recipe, so an engine field renamed, moved between
 * structs or added would leave every emitted paste non-compiling with the whole
 * suite green. The declared type is checked too, so an enum field emitted under
 * the wrong enum name — which does compile, as the wrong constant — fails here.
 */
test('generativePaletteCpp assigns the fields core/color/color.h declares', { skip: SKIP }, () => {
  const cpp = header(COLOR_H);
  const js = readFileSync(fileURLToPath(new URL('tools/palette_math.js', REPO)), 'utf8');
  const want = engineLeafFields(cpp, 'PaletteRecipe');
  assert.ok(want.size >= 20, `read only ${want.size} recipe fields — the reader is out of date`);

  const emitted = new Map([...functionBody(js, 'generativePaletteCpp')
    .matchAll(/^recipe\.([\w.]+) = (.+);$/gm)].map(([, path, value]) => [path, value]));
  assert.deepEqual([...emitted.keys()].sort(), [...want.keys()].sort(),
    'the emitted paste no longer assigns exactly the PaletteRecipe fields the engine declares');

  for (const [path, type] of want) {
    const value = /** @type {string} */ (emitted.get(path));
    if (new RegExp(`enum class ${type}\\s*:`).test(cpp)) {
      assert.ok(value.startsWith(`${type}::`),
        `recipe.${path} is a ${type} but the paste assigns "${value}"`);
    } else if (type.startsWith('std::array<')) {
      assert.match(value, /^\$\{cppFloatArray\(/,
        `recipe.${path} is a ${type} but the paste does not brace-initialize it`);
    }
  }
});

/**
 * Pins palette_math.js's fastSin to the engine kernel it mirrors: the fold in
 * sinf_0_2pi then the Bhaskara coefficients in bhaskara_sinf, whose literals
 * appear in that order in the JS port. ProceduralPalette evaluates its cosine
 * through it, so a retuned kernel would leave the browser preview predicting
 * colors the device no longer produces; the WASM bridge sees that only at the
 * SHA the committed binary was built from.
 */
test('fastSin matches core/math/3dmath.h', { skip: SKIP }, () => {
  const cpp = header(MARKER);
  const js = readFileSync(fileURLToPath(new URL('tools/palette_math.js', REPO)), 'utf8');
  assert.equal(typeof P.ProceduralPalette, 'function', 'palette_math.js must export ProceduralPalette');
  const want = [
    ...numbersIn(functionBody(cpp, 'sinf_0_2pi')),
    ...numbersIn(functionBody(cpp, 'bhaskara_sinf')),
  ];
  assert.equal(want.length, 5, 'read the wrong literal count — the reader is out of date');
  assert.deepEqual(numbersIn(functionBody(js, 'fastSin')), want,
    'fastSin drifted from the engine sine kernel');
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

const RECIPE_H = 'core/mesh/recipe.h';
const CONWAY_GRAPH_H = 'core/mesh/conway_graph.h';
const CLAMP_EXPR = /^step\.param >= ([\w:]+) && step\.param <= ([\w:]+)$/;

/**
 * The expression each `case Op::X` label of a switch returns, following
 * fall-through so a shared return covers every label above it.
 * @param {string} body - Function body holding one switch over Op.
 * @returns {Map<string, string>} Op enumerator -> the returned expression.
 */
function switchReturns(body) {
  const verdicts = new Map();
  let labels = [];
  for (const chunk of body.split(/case Op::/).slice(1)) {
    const label = chunk.match(/^(\w+):/);
    assert.ok(label, 'unreadable case label — the parity reader is out of date');
    labels.push(label[1]);
    const ret = chunk.match(/return\s+([\s\S]*?);/);
    if (!ret) continue;
    for (const op of labels) verdicts.set(op, ret[1].replace(/\s+/g, ' ').trim());
    labels = [];
  }
  return verdicts;
}

/**
 * The primitive steps each composite case of expand_to_primitives emits.
 * @param {string} body - The function body.
 * @returns {Map<string, string[]>} Op enumerator -> each emit()'s brace-init text.
 */
function loweredSteps(body) {
  const lowered = new Map();
  let labels = [];
  for (const chunk of body.split(/case Op::/).slice(1)) {
    const label = chunk.match(/^(\w+):/);
    assert.ok(label, 'unreadable case label — the parity reader is out of date');
    labels.push(label[1]);
    const emits = [...chunk.matchAll(/emit\(\{([^}]*)\}\)/g)].map(([, args]) => args.trim());
    if (emits.length === 0) continue;
    for (const op of labels) lowered.set(op, emits);
    labels = [];
  }
  return lowered;
}

/**
 * Pins solid_codegen.js's MORPH_SWEEP to Solids::is_morphable_step and the
 * clamps it reads. The tool authors registry entries the engine's morph path
 * then either sweeps on screen or declines, dropping the whole shape to the
 * whole-generate fallback; nothing in the engine's domain checks reports that
 * bound, so a drift here silently costs an authored shape its build-up.
 * The composite ops carry no entry because they lower to primitives first,
 * which holds only while the primitives they lower to sweep across the ranges
 * OP_DEFS offers — checked here against expand_to_primitives.
 */
test('MORPH_SWEEP matches core/mesh/recipe.h', { skip: SKIP }, () => {
  const graph = header(CONWAY_GRAPH_H);
  const recipe = header(RECIPE_H);
  const clamp = {
    'ConwayGraph::T_EPS': engineConstant(graph, 'T_EPS'),
    'ConwayGraph::T_EPS_TRUNCATE_MIN': engineConstant(graph, 'T_EPS_TRUNCATE_MIN'),
    'ConwayGraph::T_EPS_TRUNCATE_FAR_MAX': engineConstant(graph, 'T_EPS_TRUNCATE_FAR_MAX',
      { T_EPS_AMBO: engineConstant(graph, 'T_EPS_AMBO') }),
    CHAMFER_T_MAX: engineConstant(recipe, 'CHAMFER_T_MAX'),
  };
  const verdicts = switchReturns(functionBody(recipe, 'is_morphable_step'));
  assert.ok(verdicts.size > 0,
    `no Op case found in ${RECIPE_H} — the parity reader is out of date`);

  const want = {};
  for (const [op, expr] of verdicts) {
    const name = op.toLowerCase();
    if (!(name in MORPH_SWEEP)) continue;
    if (expr === 'true' || expr === 'false') {
      want[name] = expr === 'true' ? {} : null;
      continue;
    }
    const band = expr.match(CLAMP_EXPR);
    assert.ok(band, `${op} sweeps on "${expr}", which this reader cannot measure`);
    want[name] = { t: { min: clamp[band[1]], max: clamp[band[2]] } };
  }
  assert.deepEqual(MORPH_SWEEP, want,
    'MORPH_SWEEP drifted from is_morphable_step: the tool would either warn about '
    + 'a chain the engine sweeps or stay silent about one it declines');

  const lowered = loweredSteps(functionBody(recipe, 'expand_to_primitives'));
  for (const op of Object.keys(OP_DEFS)) {
    if (op in MORPH_SWEEP) continue;
    const emits = lowered.get(op.toUpperCase());
    assert.ok(emits, `${op} is neither in MORPH_SWEEP nor lowered by expand_to_primitives`);
    for (const args of emits) {
      const [, prim, param] = args.match(/Op::(\w+)\s*(?:,\s*([^,]+))?/);
      const expr = verdicts.get(prim);
      if (expr === 'true') continue;
      const band = expr?.match(CLAMP_EXPR);
      assert.ok(band, `${op} lowers to ${prim}, whose verdict "${expr}" leaves the `
        + 'tool no ground to stay silent about it');
      const range = param?.includes('step.param')
        ? OP_DEFS[op].params?.t
        : { min: Number(param), max: Number(param) };
      assert.ok(range, `${op} lowers ${prim} from a parameter this reader cannot locate`);
      assert.ok(range.min >= clamp[band[1]] && range.max <= clamp[band[2]],
        `${op} offers ${prim} over ${range.min}-${range.max}, outside the swept `
        + `${clamp[band[1]]}-${clamp[band[2]]}: the tool can no longer stay silent about it`);
    }
  }
});
