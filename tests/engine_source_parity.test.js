//
// Source-text parity between the browser tools' hand-transcribed engine values
// and the C++ headers they are transcribed from.
//
// tests/color_parity_wasm.test.js runs the tools against the shipped WASM, which
// reaches only what wasm.cpp exports, and only at the engine SHA the committed
// binary was built from (holosphere_wasm.sha). Reading the headers covers the
// values no export reaches — the projection constants, the compile-status
// rosters, the recipe field paths, the seed constants and the build-step cap —
// at the engine revision recorded alongside the installed WASM.
//
// The engine is a separate repository. The JS unit suite checks it out and sets
// HOLOSPHERE_ENGINE_REQUIRED, under which a missing tree fails instead of
// skipping; only a local run without a checkout skips. That every case here can
// skip is why the workflow's own declaration of the flag is pinned from
// tests/wasm_provenance.test.js, which never skips.
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as MB from '../tools/mobius_transforms.js';
import * as P from '../tools/palette_math.js';
import { DEFINED_SEED_CONSTANTS, SIMPLE_SEEDS } from '../tools/solid_codegen.js';
import { MAX_BUILD_STEPS, upperSnake } from '../tools/solid_registry_codegen.js';

const engineCandidates = process.env.HOLOSPHERE_ENGINE_DIR
  ? [resolve(process.env.HOLOSPHERE_ENGINE_DIR)]
  : ['engine', '../Holosphere', '../pov'].map((path) => resolve(path));
const engineRoot = engineCandidates.find(
  (path) => existsSync(resolve(path, 'scripts/shader_workbench.mjs')));
const engineMissing = `no Holosphere checkout found in ${engineCandidates.join(', ')}`;
const engineSkip = engineRoot || process.env.HOLOSPHERE_ENGINE_REQUIRED ? false : engineMissing;

const enginePin = readFileSync(new URL('../holosphere_wasm.sha', import.meta.url), 'utf8').trim();

const STEREO_H = 'core/math/stereographic.h';
const MOBIUS_H = 'core/math/mobius.h';
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
 * @param {string} path - The header `source` was read from, named in the diagnostic.
 * @param {Object<string, number>} scope - Constants its expression may name.
 * @returns {number} The value, computed in double precision.
 */
function engineConstant(source, name, path, scope = {}) {
  const m = source.match(new RegExp(`inline constexpr float ${name}\\s*=\\s*([^;]+);`));
  assert.ok(m, `${name} not found in ${path} — the parity reader is out of date`);
  const expr = m[1].replace(/\s+/g, ' ').replace(/(\d)f\b/g, '$1');
  // Guards the eval below: arithmetic over the named constants, nothing else.
  assert.match(expr, /^[\w\s.+\-*/()]+$/, `${name} = ${expr} is not a plain arithmetic expression`);
  const names = Object.keys(scope);
  return Function(...names, `return ${expr};`)(...names.map((k) => scope[k]));
}

/**
 * Pins the stereographic-projection constants mobius_transforms.js mirrors to
 * their definitions in core/math/stereographic.h. STEREO_POLE_EPS is derived from
 * STEREO_INF on both sides, so the engine's expression is evaluated rather than
 * its value read, and a change to either the sentinel or the derivation fails.
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
 * definitions. The shader is the preview's only renderer, so a constant that
 * tracked the JS module but not the header would still lie about the pole cap.
 */
test('glslProjectionFunctions constants match core/math/stereographic.h', { skip: engineSkip }, () => {
  const src = header(STEREO_H);
  const inf = engineConstant(src, 'STEREO_INF', STEREO_H);
  const glsl = MB.glslProjectionFunctions;
  for (const [name, value] of [
    ['STEREO_INF', inf],
    ['STEREO_POLE_EPS', engineConstant(src, 'STEREO_POLE_EPS', STEREO_H, { STEREO_INF: inf })],
    ['STEREO_AZIMUTH_EPS', engineConstant(src, 'STEREO_AZIMUTH_EPS', STEREO_H)],
  ]) {
    const m = glsl.match(new RegExp(`const float ${name}\\s*=\\s*([^;]+);`));
    assert.ok(m, `glslProjectionFunctions does not declare ${name}`);
    assert.equal(Function(`const STEREO_INF = ${inf}; return ${m[1]};`)(), value,
      `the shader's ${name} drifted from the engine`);
  }
});

// The spellings an engine projection or Mobius Complex body uses, paired
// with the JS the mobius_transforms port writes them as. Comments are stripped
// first so a `//` cannot swallow a later substitution.
const ENGINE_CPP_TO_JS = [
  [/\/\/[^\n]*/g, ''],
  [/\bconst(?:expr)? float\b/g, 'const'],
  [/\bfloat\b/g, 'let'],
  [/\bstd::(max|min|abs)\(/g, 'Math.$1('],
  [/\bsqrtf\(/g, 'Math.sqrt('],
  [/\bmath::Complex\b/g, 'Complex'],
  [/\b(?:projections::)?stereographic_detail::radial_scale\b/g, 'radial_scale'],
  [/\bprojections::(STEREO_[A-Z_]+)\b/g, '$1'],
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
  body = complexToObject(body);
  assert.doesNotMatch(body, /::|sqrtf|\bfloat\b|\bComplex\b/,
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

// Numerator/divisor pairs spanning project_div's branches: ordinary quotients, a
// numerator that saturates on the relative test, a divisor small enough that an
// absolute-guard division would zero it out, the 0/0 indeterminate form,
// magnitudes whose square leaves the representable range, and a nonzero divisor
// whose square underflows to zero, which the lift branch divides rather than
// reads as the pole.
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
  [{ re: 2e-170, im: -1e-170 }, { re: 1e-170, im: 0 }],
  [{ re: 0, im: 3e-170 }, { re: 0, im: -1e-170 }],
  [{ re: 1e-160, im: 0 }, { re: 1e-170, im: 0 }],
];

/**
 * Pins mobius_transforms.js's stereo and projectDiv to the bodies of stereo and
 * project_div in stereographic.h and mobius.h. The constants above are pinned
 * separately, but these two functions are what mobius.html's shader actually
 * runs, and the WASM bridge reaches only the engine's fused mobius_transform —
 * which never calls either in isolation, so no export can separate them.
 * Comparing the header's own body, transpiled, catches a reordered guard or a
 * changed fallback that matching constants would hide.
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
  const bindings = { ...constants, radial_scale };
  const engineStereo = transpileEngineComplex(src, 'stereo', ['v'], bindings);
  const engineProjectDiv = transpileEngineComplex(
    header(MOBIUS_H), 'project_div', ['num', 'den'], bindings);

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

// The two status enums a failed compile is reported through, as palette_math.js
// names its rosters and as core/color/palette_recipe.h declares them.
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
test('the compile-status rosters match core/color/palette_recipe.h', { skip: engineSkip }, () => {
  const cpp = header(PALETTE_RECIPE_H);
  for (const [roster, cppName] of STATUS_ENUMS) {
    const { roster: want, count } = engineValuedEnumerators(cpp, cppName);
    assert.ok(want.size > 0, `${cppName} yielded no enumerators — the reader is out of date`);
    const got = P[roster];
    assert.equal(got.length, count ?? Math.max(...want.keys()) + 1,
      `${roster} does not span ${cppName}'s ordinals`);
    for (const [value, name] of want) {
      assert.equal(got[value], name, `${roster}[${value}] drifted from ${cppName}::${name}`);
    }
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
 * Pins the C++ field paths generativePaletteCpp writes to the members
 * PaletteRecipe and its nested control structs actually declare. That paste is
 * the palettes page's headline deliverable and nothing else checks it: the WASM
 * bridge takes the JS-side recipe, so an engine field renamed, moved between
 * structs or added would leave every emitted paste non-compiling with the whole
 * suite green. The declared type is checked too, so an enum field emitted under
 * the wrong enum name — which does compile, as the wrong constant — fails here.
 */
test('generativePaletteCpp assigns the fields core/color/palette_recipe.h declares', { skip: engineSkip }, () => {
  const cpp = header(PALETTE_RECIPE_H);
  const js = readFileSync('tools/palette_math.js', 'utf8');
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
test('DEFINED_SEED_CONSTANTS matches core/mesh/solids.h', { skip: engineSkip }, () => {
  const declared = engineSeedConstants(header(SOLIDS_H));
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

/**
 * Pins solid_registry_codegen.js's MAX_BUILD_STEPS to the build-step cap
 * IslamicStars.h declares. The generator refuses a registry entry that lowers
 * to more primitive steps than that, and the effect's own static_assert is the
 * only check after it, so a raised or lowered cap would leave the tool refusing
 * entries the engine builds, or pasting ones it cannot.
 */
test('MAX_BUILD_STEPS matches effects/IslamicStars.h', { skip: engineSkip }, () => {
  const src = header(ISLAMIC_STARS_H);
  const m = src.match(/static constexpr size_t MAX_BUILD_STEPS\s*=\s*(\d+);/);
  assert.ok(m, `MAX_BUILD_STEPS not found in ${ISLAMIC_STARS_H} — the reader is out of date`);
  assert.equal(MAX_BUILD_STEPS, Number(m[1]),
    "MAX_BUILD_STEPS drifted from the effect's build-step cap");
});
