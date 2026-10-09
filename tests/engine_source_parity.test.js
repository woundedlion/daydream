//
// Source-text parity between the browser tools' hand-transcribed engine values
// and the C++ headers they are transcribed from, at the engine revision
// recorded alongside the installed WASM.
//
// Without an engine checkout the cases skip, unless HOLOSPHERE_ENGINE_REQUIRED=1,
// under which a missing tree fails.
import { constructorToObject, glslConstants } from './helpers/source_transpile.js';
import { engineRoot, engineMissing, engineSkip } from './helpers/engine_checkout.js';
import * as paletteEnums from './helpers/fake_palette.js';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generativePaletteCpp } from '../src/workbench/palettes/palette_math.js';
import { defaultPaletteRecipe } from '../src/workbench/palettes/palette_controls.js';
import { closingDomain, lissajousCodeString } from '../src/workbench/lissajous/lissajous_math.js';
import * as MB from '../src/workbench/mobius/mobius_transforms.js';
import { DEFINED_SEED_CONSTANTS, SIMPLE_SEEDS, KNOWN_OPS } from '../src/workbench/solids/solid_codegen.js';
import { MAX_BUILD_FACES, MAX_BUILD_STEPS, upperSnake, primitiveCount, LOWERING } from '../src/workbench/solids/solid_registry_codegen.js';
import { MAX_DISPLAY_CAP_PERCENT } from '../src/renderer/display_caps.js';
import { FPS } from '../src/renderer/frame_constants.js';
import { CHAIN_SNAPSHOT_SCHEMA_VERSION } from '../src/workbench/shader/shader_deeplink.js';

const enginePin = readFileSync(new URL('../generated/holosphere_wasm.sha', import.meta.url), 'utf8').trim();

const STEREO_H = 'core/math/stereographic.h';
const MOBIUS_H = 'core/math/mobius.h';
const MATH_H = 'core/math/3dmath.h';
const PALETTE_RECIPE_H = 'core/color/palette_recipe.h';
const SOLIDS_H = 'core/mesh/solids.h';
const ISLAMIC_STARS_H = 'effects/IslamicStars.h';

/**
 * Reads an engine header from the installed module's source revision.
 * @param {string} path - Path below the engine root.
 * @returns {string} The file's text.
 */
const header = (path) => {
  assert.ok(engineRoot, engineMissing);
  return execFileSync('git', ['-C', engineRoot, 'show', `${enginePin}:${path}`],
    { encoding: 'utf8' });
};

/**
 * The body of a single named function, for either language.
 * @param {string} source - File text.
 * @param {string} name - Function name.
 * @returns {string} Everything between the opening brace and the closing brace
 *   at the signature line's indentation.
 */
function functionBody(source, name) {
  const m = source.match(new RegExp(`^([\\t ]*)[^\\n]*?\\b${name}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\1\\}`, 'm'));
  assert.ok(m, `${name} not found - the parity reader is out of date with the source`);
  return m[2];
}

test('functionBody isolates indented members from later methods', () => {
  const source = `class Engine {
  bool setDisplayCaps(double top_percent, double bottom_percent) {
    if (top_percent > 50) {
      return false;
    }
    return bottom_percent <= 50;
  }
  bool later(double top_percent) {
    return top_percent > 75;
  }
};`;
  const body = functionBody(source, 'bool setDisplayCaps');
  assert.match(body, /top_percent > 50/);
  assert.match(body, /return bottom_percent <= 50/);
  assert.doesNotMatch(body, /later|75/);
});

/**
 * Evaluates an `inline constexpr float` definition from an engine header.
 * @param {string} source - Header text.
 * @param {string} name - Constant name.
 * @param {string} path - The header `source` was read from, named in the diagnostic.
 * @param {Object<string, number>} scope - Constants its expression may name.
 * @returns {number} The value, computed in double precision.
 */
function engineConstant(source, name, path, scope = {}) {
  const m = source.match(new RegExp(`inline constexpr float ${name}\\s*=\\s*([^;]+);`));
  assert.ok(m, `${name} not found in ${path} — the parity reader is out of date`);
  const expr = m[1].replace(/\s+/g, ' ')
    .replace(/0x([0-9a-f]+)p([+-]?\d+)f?\b/gi,
      (_, significand, exponent) => String(parseInt(significand, 16) * 2 ** Number(exponent)))
    .replace(/(\d)f\b/g, '$1');
  // Guards the eval below: arithmetic over the named constants, nothing else.
  assert.match(expr, /^[\w\s.+\-*/()]+$/, `${name} = ${expr} is not a plain arithmetic expression`);
  const names = Object.keys(scope);
  const identifiers = expr.replace(/\b\d+(?:\.\d*)?(?:e[+-]?\d+)?\b/gi, '')
    .match(/[A-Za-z_]\w*/g) ?? [];
  assert.ok(identifiers.every((identifier) => Object.hasOwn(scope, identifier)),
    `${name} = ${expr} names an unknown constant`);
  return Function(...names, `return ${expr};`)(...names.map((k) => scope[k]));
}

test('engine constant expressions reject unknown identifiers', () => {
  assert.throws(() => engineConstant('inline constexpr float X = process.exit(1);',
    'X', 'fixture'), /unknown constant/);
  assert.equal(engineConstant('inline constexpr float X = A * 1e-3f;',
    'X', 'fixture', { A: 2000 }), 2);
});

/**
 * Pins the stereographic-projection constants mobius_transforms.js mirrors to
 * their definitions in core/math/stereographic.h. STEREO_POLE_EPS is derived from
 * STEREO_INF on both sides, so the engine's expression is evaluated.
 */
test('projection constants match core/math/stereographic.h', { skip: engineSkip }, () => {
  const src = header(STEREO_H);
  const inf = engineConstant(src, 'STEREO_INF', STEREO_H);
  assert.equal(MB.STEREO_INF, inf, 'STEREO_INF drifted from the engine sentinel');
  assert.equal(MB.STEREO_POLE_EPS,
    engineConstant(src, 'STEREO_POLE_EPS', STEREO_H, { STEREO_INF: inf }),
    'STEREO_POLE_EPS drifted from the engine pole cap');
  assert.equal(MB.STEREO_AZIMUTH_EPS, engineConstant(src, 'STEREO_AZIMUTH_EPS', STEREO_H),
    'STEREO_AZIMUTH_EPS drifted from the engine azimuth floor');
});

/**
 * Pins the GLSL prelude the mobius.html shader compiles to the same engine
 * definitions.
 */
test('glslProjectionFunctions constants match core/math/stereographic.h', { skip: engineSkip }, () => {
  const src = header(STEREO_H);
  const inf = engineConstant(src, 'STEREO_INF', STEREO_H);
  const glsl = MB.glslProjectionFunctions;
  const { values } = glslConstants(glsl);
  for (const [name, value] of [
    ['STEREO_INF', inf],
    ['STEREO_POLE_EPS', engineConstant(src, 'STEREO_POLE_EPS', STEREO_H, { STEREO_INF: inf })],
    ['STEREO_AZIMUTH_EPS', engineConstant(src, 'STEREO_AZIMUTH_EPS', STEREO_H)],
  ]) {
    const m = glsl.match(new RegExp(`const float ${name}\\s*=\\s*([^;]+);`));
    assert.ok(m, `glslProjectionFunctions does not declare ${name}`);
    assert.equal(values[name], value,
      `the shader's ${name} drifted from the engine`);
  }
});

// The spellings an engine projection or Mobius Complex body uses, paired
// with the JS the mobius_transforms port writes them as. Comments are stripped
// first so a `//` cannot swallow a later substitution.
const ENGINE_CPP_TO_JS = [
  [/\/\/[^\n]*/g, ''],
  [/std::numeric_limits<float>::min\(\)/g, '(2 ** -1022)'],
  [/\bconst(?:expr)? float\b/g, 'const'],
  [/\bfloat\b/g, 'let'],
  [/\bstd::(max|min|abs)\(/g, 'Math.$1('],
  [/\bf(max|min)f\(/g, 'Math.$1('],
  [/\bsqrtf\(/g, 'Math.sqrt('],
  [/\bmath::Complex\b/g, 'Complex'],
  [/\b(?:projections::)?stereographic_detail::radial_scale\b/g, 'radial_scale'],
  [/\bmobius_detail::saturated_quotient\b/g, 'saturated_quotient'],
  [/\bprojections::(STEREO_[A-Z_]+)\b/g, '$1'],
  [/(\d)f\b/g, '$1'],
];

/**
 * Transpiles one `inline Complex NAME(...)` engine body into a JS function.
 * Both sides evaluate in doubles, so agreement is exact.
 * @param {string} src - The header defining this function.
 * @param {string} name - The function's C++ name.
 * @param {string[]} params - JS parameter names, in signature order.
 * @param {Object<string, number|Function>} bindings - Engine constants and
 *   source-transpiled helpers the body names.
 * @returns {(...args: any[]) => {re: number, im: number}} The transpiled function.
 */
function transpileEngineComplex(src, name, params, bindings) {
  let body = functionBody(src, name);
  for (const [pattern, replacement] of ENGINE_CPP_TO_JS) {
    body = body.replace(pattern, /** @type {string} */ (replacement));
  }
  body = constructorToObject(body, 'Complex');
  assert.doesNotMatch(body, /::|\b(?:sqrtf|fminf|fmaxf|float|Complex)\b/,
    `${name} still holds C++ this reader cannot translate: ${body}`);
  return Function(...Object.keys(bindings),
    `return function(${params.join(', ')}) { ${body} };`)(...Object.values(bindings));
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

// Numerator/divisor pairs spanning project_div's branches: ordinary quotients,
// numerators that saturate on the relative test over real and non-real
// divisors, a divisor small enough that an absolute-guard division would zero it
// out, the 0/0 indeterminate form, magnitudes whose square leaves the
// representable range, and a nonzero divisor whose square underflows to zero,
// which the lift branch divides rather than reads as the pole.
const PROJECT_DIV_PAIRS = [
  [{ re: 4, im: 2 }, { re: 2, im: 0 }],
  [{ re: 1, im: -3 }, { re: -0.5, im: 0.25 }],
  [{ re: 1e5, im: 0 }, { re: 1, im: 0 }],
  [{ re: 1e5, im: 1e5 }, { re: 1, im: 0 }],
  [{ re: 1e4, im: 0 }, { re: 0, im: -1 }],
  [{ re: 1e-6, im: 0 }, { re: 4e-4, im: 0 }],
  [{ re: 0, im: 0 }, { re: 0, im: 0 }],
  [{ re: 1, im: 1 }, { re: 0, im: 0 }],
  [{ re: 3e200, im: -1e200 }, { re: 1, im: 0 }],
  [{ re: 1e-200, im: 1e-200 }, { re: 1e-260, im: 0 }],
  [{ re: 3e-160, im: -1e-160 }, { re: 1e-160, im: 0 }],
  [{ re: 2e-170, im: -1e-170 }, { re: 1e-170, im: 0 }],
  [{ re: 0, im: 3e-170 }, { re: 0, im: -1e-170 }],
  [{ re: 1e-160, im: 0 }, { re: 1e-170, im: 0 }],
];

/**
 * Pins mobius_transforms.js's stereo and projectDiv to the bodies of stereo and
 * project_div in stereographic.h and mobius.h, transpiled from the headers. No
 * WASM export reaches either in isolation.
 */
test('stereo and projectDiv match their engine projection and Mobius headers', { skip: engineSkip }, () => {
  const src = header(STEREO_H);
  const inf = engineConstant(src, 'STEREO_INF', STEREO_H);
  const constants = {
    STEREO_INF: inf,
    STEREO_POLE_EPS: engineConstant(src, 'STEREO_POLE_EPS', STEREO_H, { STEREO_INF: inf }),
    STEREO_AZIMUTH_EPS: engineConstant(src, 'STEREO_AZIMUTH_EPS', STEREO_H),
  };
  const radial_scale = transpileEngineComplex(
    src, 'radial_scale', ['direction', 'length', 'radius'], {});
  const lift = engineConstant(header(MATH_H), 'COMPLEX_UNDERFLOW_LIFT', MATH_H);
  assert.equal(MB.STEREO_UNDERFLOW_LIFT, lift);
  const bindings = { ...constants, radial_scale, COMPLEX_UNDERFLOW_LIFT: lift };
  const engineStereo = transpileEngineComplex(src, 'stereo', ['v'], bindings);
  const mobiusSrc = header(MOBIUS_H);
  const saturated_quotient = transpileEngineComplex(
    mobiusSrc, 'saturated_quotient', ['num', 'den'], bindings);
  const engineProjectDiv = transpileEngineComplex(
    mobiusSrc, 'project_div', ['num', 'den'], { ...bindings, saturated_quotient });

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

/**
 * The enumerators of an `enum class` whose members may carry explicit values,
 * keyed by the value each one is pinned to. A trailing unvalued COUNT is the
 * roster's size rather than a member of it.
 * @param {string} source - core/color/palette_recipe.h text.
 * @param {string} name - The enum's C++ name.
 * @returns {{roster: Map<number, string>, count: ?number}} Value -> enumerator
 *   name, and the COUNT sentinel's value when the enum declares one.
 */
function engineValuedEnumerators(source, name) {
  const m = source.match(new RegExp(`enum class ${name}\\s*:\\s*uint8_t\\s*\\{([^}]*)\\}`));
  assert.ok(m, `enum class ${name} not found in ${PALETTE_RECIPE_H} — the reader is out of date`);
  const roster = new Map();
  let count = null;
  let next = 0;
  const members = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  for (const [at, member] of members.entries()) {
    const parsed = member.match(/^([A-Z][A-Z0-9_]*)(?:\s*=\s*(\d+))?$/);
    assert.ok(parsed, `${name}::${member} is not an enumerator this reader can value`);
    if (parsed[1] === 'COUNT') {
      assert.ok(parsed[2] === undefined && at === members.length - 1,
        `${name}::COUNT is not a trailing unvalued sentinel, so it does not give the size`);
      count = next;
      break;
    }
    next = parsed[2] === undefined ? next : Number(parsed[2]);
    roster.set(next, parsed[1]);
    next += 1;
  }
  return { roster, count };
}

/** Verifies the test palette enums, including COUNT, against the engine source. */
test('the compile-status rosters match core/color/palette_recipe.h', { skip: engineSkip }, () => {
  const cpp = header(PALETTE_RECIPE_H);
  for (const cppName of ['PaletteCompileCode', 'PaletteRecipeField']) {
    const { roster: want, count } = engineValuedEnumerators(cpp, cppName);
    assert.ok(want.size > 0, `${cppName} yielded no enumerators`);
    const got = paletteEnums[cppName];
    const names = [...want.values(), ...(count === null ? [] : ['COUNT'])];
    assert.deepEqual(Object.keys(got).sort(), names.sort(), `${cppName} roster drifted`);
    for (const [value, name] of want)
      assert.equal(got[name].value, value, `${cppName}.${name} ordinal drifted`);
    if (count !== null) assert.equal(got.COUNT.value, count, `${cppName}.COUNT drifted`);
  }
});

/**
 * The non-static data members of a plain struct, in declaration order.
 * @param {string} source - core/color/palette_recipe.h text.
 * @param {string} name - The struct's C++ name.
 * @returns {{type: string, field: string}[]} Each member's declared type and name.
 */
function engineStructFields(source, name) {
  const m = source.match(new RegExp(`struct ${name} \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(m, `struct ${name} not found in ${PALETTE_RECIPE_H} — the reader is out of date`);
  const fields = [];
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const decl of body.split(';')) {
    const text = decl.trim();
    if (!text || text.startsWith('static')) continue;
    if (/^bool\s+operator==\([^)]*\)\s+const\s*=\s*default$/.test(text)) continue;
    const member = text.match(/^(std::array<[^>]+>|[\w:]+)\s+(\w+)\s*(?:=[\s\S]+|\{\s*\})?$/);
    assert.ok(member, `unreadable member "${text}" in struct ${name} — the reader is out of date`);
    fields.push({ type: member[1], field: member[2] });
  }
  return fields;
}

/**
 * Every leaf field below a struct, keyed by the dotted path a C++ assignment
 * reaches it through.
 * @param {string} source - core/color/palette_recipe.h text.
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
 * Checks the C++ generativePaletteCpp emits for a canonical recipe against the
 * declarations of PaletteRecipe and its nested control structs.
 */
test('generativePaletteCpp assigns the fields core/color/palette_recipe.h declares', { skip: engineSkip }, () => {
  const cpp = header(PALETTE_RECIPE_H);
  const want = engineLeafFields(cpp, 'PaletteRecipe');
  assert.ok(want.size >= 20, `read only ${want.size} recipe fields — the reader is out of date`);

  const recipe = defaultPaletteRecipe();
  recipe.domain = 4;
  recipe.hue.harmony = 5;
  recipe.lightness.curve = 1;
  const emitted = new Map([...generativePaletteCpp(recipe)
    .matchAll(/^recipe\.([\w.]+) = (.+);$/gm)].map(([, path, value]) => [path, value]));
  assert.deepEqual([...emitted.keys()].sort(), [...want.keys()].sort(),
    'the emitted paste no longer assigns exactly the PaletteRecipe fields the engine declares');

  for (const [path, type] of want) {
    const value = /** @type {string} */ (emitted.get(path));
    if (new RegExp(`enum class ${type}\\s*:`).test(cpp)) {
      const enumerator = value.match(new RegExp(`^${type}::([A-Z0-9_]+)$`));
      assert.ok(enumerator, `recipe.${path} is a ${type} but the paste assigns "${value}"`);
      const { roster } = engineValuedEnumerators(cpp, type);
      assert.ok([...roster.values()].includes(enumerator[1]),
        `recipe.${path} assigns ${value}, which enum class ${type} does not declare`);
    } else if (type.startsWith('std::array<')) {
      const extent = type.match(/^std::array<float,\s*(\w+)>$/);
      assert.ok(extent, `recipe.${path} has an unreadable array type ${type}`);
      const size = /^\d+$/.test(extent[1]) ? Number(extent[1])
        : Number(cpp.match(new RegExp(`inline constexpr \\w+ ${extent[1]}\\s*=\\s*(\\d+);`))?.[1]);
      assert.ok(size > 0, `the extent ${extent[1]} of recipe.${path} was not found`);
      const braced = value.match(/^\{([^}]*)\}$/);
      assert.ok(braced, `recipe.${path} is a ${type} but the paste assigns "${value}"`);
      const elements = braced[1].split(',').map((element) => element.trim());
      assert.equal(elements.length, size, `recipe.${path} brace-initializes ${elements.length} of ${size} elements`);
      for (const element of elements) {
        assert.match(element, /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?f$/,
          `recipe.${path} element "${element}" is not a float literal`);
      }
    }
  }
});

/**
 * The `SEED_*` constants core/mesh/solids.h declares.
 * @param {string} source - core/mesh/solids.h text.
 * @param {string} bases - core/mesh/base_mesh.h text.
 * @returns {Map<string, number>} Constant name -> the simple_registry index it holds.
 */
function engineSeedConstants(source, bases) {
  const baseNames = [...bases.matchAll(/\bX\((\w+),\s*"[^"]*"\)/g)]
    .map(([, name]) => name);
  assert.ok(baseNames.length > 0, 'BaseMesh roster was not found');
  assert.match(bases, /#define HS_BASE_MESH_ENUM\(name, label\) name,/);
  assert.match(bases, /HS_BASE_MESH_LIST\(HS_BASE_MESH_ENUM\)/);
  return new Map([...source.matchAll(/inline constexpr uint8_t (SEED_\w+)\s*=\s*([^;]+);/g)]
    .map(([, name, expression]) => {
      if (/^\d+$/.test(expression)) return [name, Number(expression)];
      const base = expression.match(/^static_cast<uint8_t>\(BaseMesh::(\w+)\)$/);
      assert.ok(base, `${name} has an unreadable seed expression: ${expression}`);
      const index = baseNames.indexOf(base[1]);
      assert.ok(index >= 0, `${name} names an unknown BaseMesh: ${base[1]}`);
      return [name, index];
    }));
}

/**
 * Pins solid_codegen.js's DEFINED_SEED_CONSTANTS to the constants solids.h
 * declares, and each constant's value to its SIMPLE_SEEDS index.
 */
test('DEFINED_SEED_CONSTANTS matches core/mesh/solids.h', { skip: engineSkip }, () => {
  const declared = engineSeedConstants(header(SOLIDS_H), header('core/mesh/base_mesh.h'));
  assert.ok(declared.size > 0,
    `no SEED_* constant found in ${SOLIDS_H} — the reader is out of date`);
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

test('MAX_BUILD_STEPS matches the pinned shared build budget', { skip: engineSkip }, () => {
  const source = header(ISLAMIC_STARS_H);
  assert.match(source, /static constexpr size_t MAX_BUILD_STEPS\s*=\s*IslamicStarsDetail::MAX_BUILD_OPS;/);
  const match = /namespace IslamicStarsDetail\s*\{[^}]*inline constexpr size_t MAX_BUILD_OPS\s*=\s*(\d+);/.exec(source);
  assert.ok(match, 'IslamicStarsDetail::MAX_BUILD_OPS not found');
  assert.equal(MAX_BUILD_STEPS, Number(match[1]));
});

test('every operator primitive count matches the installed engine lowering', { skip: engineSkip }, () => {
  const body = functionBody(header('core/mesh/recipe.h'), 'lowered_step_count');
  const counts = new Map();
  for (const group of body.matchAll(/((?:\s*case Op::[A-Z_]+:)+)\s*n \+= (\d+);\s*break;/g)) {
    for (const entry of group[1].matchAll(/case Op::([A-Z_]+):/g)) {
      counts.set(entry[1].toLowerCase(), Number(group[2]));
    }
  }
  assert.deepEqual([...counts.keys()].sort(), [...KNOWN_OPS].sort(),
    'the lowering reader must account for every operator');
  for (const [op, count] of counts) assert.equal(primitiveCount(op), count, op);
});

test('Lissajous initializer follows the engine aggregate member order', { skip: engineSkip }, () => {
  const source = header('core/math/spherical.h');
  const body = source.match(/struct LissajousParams\s*\{([\s\S]*?)\};/);
  assert.ok(body, 'LissajousParams aggregate exists');
  const members = [...body[1].matchAll(/\bfloat\s+(\w+)\s*;/g)].map((match) => match[1]);
  assert.deepEqual(members, ['m1', 'm2', 'a', 'domain']);
  const emitted = lissajousCodeString(2, 3, 0.25, 1.5);
  assert.equal(emitted, 'math::LissajousParams{2.0f, 3.0f, 0.25f, 1.5f}');
});

test('engine struct reader ignores semicolons inside member comments', () => {
  const source = `struct Controls {
    /** Three active keys; the fourth is reserved. */
    float value = 1.0f;
    // Second field; still one declaration.
    float other = 2.0f;
};`;
  assert.deepEqual(engineStructFields(source, 'Controls'), [
    { type: 'float', field: 'value' }, { type: 'float', field: 'other' },
  ]);
});

test('MAX_BUILD_FACES matches the pinned shared build budget', { skip: engineSkip }, () => {
  const source = header(ISLAMIC_STARS_H);
  assert.match(source, /static constexpr size_t MAX_BUILD_FACES\s*=\s*IslamicStarsDetail::MAX_BUILD_FACES;/);
  const match = /namespace IslamicStarsDetail\s*\{[^}]*inline constexpr size_t MAX_BUILD_FACES\s*=\s*(\d+);/.exec(source);
  assert.ok(match, 'IslamicStarsDetail::MAX_BUILD_FACES not found');
  assert.equal(MAX_BUILD_FACES, Number(match[1]));
});

test('closingDomain follows the pinned Comets traversal', { skip: engineSkip }, () => {
  const match = /static float closing_domain\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/.exec(header('effects/Comets.h'));
  assert.ok(match);
  const body = match[1].replace(/HS_CHECK\([\s\S]*?\);/, '')
    .replace(/\bfloat\b/g, 'let').replace(/std::round/g, 'Math.round')
    .replace(/math::PI_F/g, 'Math.PI').replace(/(\d)f\b/g, '$1');
  const engineClosingDomain = Function('config', body);
  for (const [m2, domain] of [[1, 4 * Math.PI], [1.06, 5.909], [1, 1],
    [4.01, 3.132], [62.16, 0.404], [8.75, 2.872]]) {
    assert.equal(closingDomain(m2, domain), engineClosingDomain({ m2, domain }));
  }
});

test('gyro lowering uses the engine snub defaults', { skip: engineSkip }, () => {
  const path = 'core/mesh/conway.h';
  const cpp = header(path);
  const [snub] = LOWERING.gyro('gyro');
  assert.equal(snub.params.t, engineConstant(cpp, 'SNUB_DEFAULT_T', path));
  assert.equal(snub.params.twist, engineConstant(cpp, 'SNUB_DEFAULT_TWIST', path));
});

test('MAX_DISPLAY_CAP_PERCENT is the bound setDisplayCaps enforces', { skip: engineSkip }, () => {
  const path = 'targets/wasm/engine_bindings.h';
  const body = functionBody(header(path), 'bool setDisplayCaps');
  const bounds = [...body.matchAll(/\b(top|bottom)_percent > ([\d.]+)/g)];
  assert.deepEqual(bounds.map(([, side]) => side), ['top', 'bottom'],
    `setDisplayCaps bounds not found in ${path} — the parity reader is out of date`);
  for (const [, side, bound] of bounds) assert.equal(MAX_DISPLAY_CAP_PERCENT, Number(bound), side);
});

test('FPS is the firmware show cadence', { skip: engineSkip }, () => {
  const path = 'targets/effects.h';
  const match = /constexpr int HS_SHOW_FRAMES_PER_SECOND\s*=\s*(\d+);/.exec(header(path));
  assert.ok(match, `HS_SHOW_FRAMES_PER_SECOND not found in ${path} — the parity reader is out of date`);
  assert.equal(FPS, Number(match[1]));
});

test('CHAIN_SNAPSHOT_SCHEMA_VERSION is the engine chain snapshot schema', { skip: engineSkip }, () => {
  const path = 'workbench/shader/chain_snapshot.h';
  const match = /static constexpr uint32_t SCHEMA_VERSION\s*=\s*(\d+);/.exec(header(path));
  assert.ok(match, `SCHEMA_VERSION not found in ${path} — the parity reader is out of date`);
  assert.equal(CHAIN_SNAPSHOT_SCHEMA_VERSION, Number(match[1]));
});

test('palettes.html recipe sliders stay inside the limits the engine compiler accepts', { skip: engineSkip }, () => {
  const path = 'core/color/generative_palette.h';
  const cpp = header(path);
  const html = readFileSync(new URL('../tools/palettes.html', import.meta.url), 'utf8');
  /** @param {string} id @returns {{min: number, max: number}} The slider's declared range. */
  const slider = (id) => {
    const m = new RegExp(`<input type="range" id="${id}" min="([^"]+)" max="([^"]+)"`).exec(html);
    assert.ok(m, `palettes.html has no ${id} range slider`);
    return { min: Number(m[1]), max: Number(m[2]) };
  };
  /** @param {string} name @returns {number} A static constexpr float limit, in double precision. */
  const limit = (name) => {
    const m = new RegExp(`static constexpr float ${name}\\s*=\\s*([^;]+);`).exec(cpp);
    assert.ok(m, `${name} not found in ${path} — the parity reader is out of date`);
    const expr = m[1].replace(/math::PI_F/g, 'Math.PI').replace(/(\d)f\b/g, '$1');
    assert.match(expr, /^[\d\s.*/+\-()]*(Math\.PI)?[\d\s.*/+\-()]*$/, `${name} = ${expr} is not plain arithmetic`);
    return Function(`return ${expr};`)();
  };
  for (const [id, name] of [['gen_sweep', 'MAX_SWEEP_TURNS'], ['gen_torsion', 'MAX_ABS_TORSION']]) {
    const { min, max } = slider(id);
    const bound = limit(name);
    assert.ok(-bound <= min && max <= bound, `${id} [${min}, ${max}] exceeds ±${name} = ${bound}`);
  }
  const falloff = /recipe\.falloff_start > ([\d.]+)f \/ ([\d.]+)f && recipe\.falloff_start < ([\d.]+)f/.exec(cpp);
  assert.ok(falloff, `the falloff_start bounds were not found in ${path} — the parity reader is out of date`);
  const { min, max } = slider('gen_falloff');
  assert.ok(Number(falloff[1]) / Number(falloff[2]) < min && max < Number(falloff[3]),
    `gen_falloff [${min}, ${max}] leaves the open falloff_start interval`);
});
