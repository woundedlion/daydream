import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixture.js';
import { OP_DEFS, KNOWN_OPS, SIMPLE_SEEDS, seedOpParams } from '../src/workbench/solids/solid_op_params.js';
import { savedChainShapeError } from '../src/workbench/solids/solid_validation.js';
import {
  formatSolidName, pctSuffix, generateFuncAndRecipe, generateRecipeCpp,
} from '../src/workbench/solids/solid_codegen.js';

/** An in-band value for a param that differs from its OP_DEFS default. */
const offDefault = (def) => (def.val === def.max ? def.min : def.max);

/** The argument list the recipe hands one op's builder call. */
function emittedArguments(recipe, op) {
  const call = new RegExp(`\\.${op}\\(([^)]*)\\)`).exec(recipe);
  assert.ok(call, `recipe emits no ${op}() call: ${recipe}`);
  const args = call[1].trim();
  return args === '' ? [] : args.split(',');
}

/**
 * Verifies the C++ generator carries every declared param into the recipe it
 * pastes: one argument per declared param.
 */
test('generateFuncAndRecipe emits the OP_DEFS params of every known op', () => {
  assert.ok(KNOWN_OPS.size > 0);
  for (const op of KNOWN_OPS) {
    const defs = Object.entries(OP_DEFS[op].params);
    const defaults = seedOpParams(op, null);
    const base = generateFuncAndRecipe({ base: 'cube', ops: [{ op, params: defaults }] });
    assert.equal(emittedArguments(base.recipe, op).length, defs.length,
      `generateFuncAndRecipe emits the wrong argument count for "${op}"`);
    for (const [key, def] of defs) {
      const moved = generateFuncAndRecipe(
        { base: 'cube', ops: [{ op, params: { ...defaults, [key]: offDefault(def) } }] });
      assert.notDeepEqual(moved.recipe, base.recipe,
        `generateFuncAndRecipe ignores "${key}" of "${op}"`);
    }
  }
});

/** Verifies formatSolidName splits camelCase and underscore segments into capitalized words. */
test('formatSolidName produces readable titles from registry names', () => {
  assert.equal(formatSolidName('cube'), 'Cube');
  assert.equal(formatSolidName('truncatedIcosahedron'), 'Truncated Icosahedron');
  assert.equal(formatSolidName('disdyakisTriacontahedron'), 'Disdyakis Triacontahedron');
  assert.equal(
    formatSolidName('truncatedIcosidodecahedron_truncate50d_ambo_dual'),
    'Truncated Icosidodecahedron Truncate50d Ambo Dual');
  assert.equal(
    formatSolidName('dodecahedron_hk35_ambo_hk62_ambo_relax_hk42'),
    'Dodecahedron Hk35 Ambo Hk62 Ambo Relax Hk42');
});

/** Verifies pctSuffix rounds a fraction to hundredths and emits a zero-padded two-or-three-digit string, snapping float error. */
test('pctSuffix quantizes to hundredths and pads to two digits', () => {
  assert.equal(pctSuffix(0.05), '05');
  assert.equal(pctSuffix(0.5), '50');
  assert.equal(pctSuffix(0.3), '30');
  assert.equal(pctSuffix(0.30000000000000004), '30');
  assert.equal(pctSuffix(0.29), '29', '0.29 * 100 lands just under 29 and must round up');
  assert.equal(pctSuffix(0.256), '26');
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

/** Verifies the hankin funcName suffix names the nearest whole degree. */
test('generateFuncAndRecipe rounds a hankin angle to the nearest degree in the funcName', () => {
  const name = (angle) => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'hankin', params: { angle } }] }).funcName;
  assert.equal(name(54.6), 'cube_hk55');
  assert.equal(name(54.4), 'cube_hk54');
  assert.equal(name(0.29 * 100), 'cube_hk29');
});

/** Verifies a relax with zero iterations is rejected: the engine's apply_step refuses a bake-less RELAX below one iteration. */
test('generateFuncAndRecipe rejects a relax with zero iterations', () => {
  const item = { base: 'cube', ops: [{ op: 'relax', params: { iter: 0 } }] };
  assert.throws(() => generateFuncAndRecipe(item),
    /relax param "iter" must be a positive integer/);
});

/** Verifies snub emits both t and twist params (matching the live preview) and encodes each in the funcName. */
test('generateFuncAndRecipe emits snub t and twist', () => {
  const item = { base: 'icosahedron', ops: [{ op: 'snub', params: { t: 0.33, twist: 0.28 } }] };
  const { funcName, recipe } = generateFuncAndRecipe(item);
  assert.equal(funcName, 'icosahedron_snub33_tw28');
  assert.equal(recipe, 'SolidBuilder(icosahedron(a, b), a, b).snub(0.33f, 0.28f).build()');
});

/** Verifies an op declaring params rejects an empty params object on both paths. */
test('a parameterized op with empty params is rejected, not defaulted', () => {
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'snub', params: {} }] }),
    /snub param "t" must be a finite number/);
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'relax', params: {} }] }),
    /relax param "iter" must be a positive integer/);
});

/** Pins the tool's full HS_FLASH_INLINE function format, including its V/F/I metadata. */
test('generateRecipeCpp wraps the recipe in an HS_FLASH_INLINE function with V/F/I comment', () => {
  const item = {
    base: 'tetrahedron',
    ops: [{ op: 'kis', params: {} }],
    vCount: 8,
    fCount: 12,
    iCount: 4,
  };
  const cpp = generateRecipeCpp(item, 'Archimedean');
  const expected =
    '/**\n' +
    ' * @brief Builds the tetrahedron_kis star pattern (V=8, F=12, I=4).\n' +
    ' * @param a First arena in the alternating construction pair.\n' +
    ' * @param b Second arena; the result may borrow storage from either arena.\n' +
    ' * @return The resulting star-pattern mesh.\n' +
    ' */\n' +
    'HS_FLASH_INLINE inline PolyMesh tetrahedron_kis(Arena &a, Arena &b) {\n' +
    '  return SolidBuilder(Archimedean::tetrahedron(a, b), a, b).kis().build();\n' +
    '}';
  assert.equal(cpp, expected);
});

/**
 * The tool keeps generated pastes within the target header's 80-column format.
 */
test('generateRecipeCpp wraps a long function at the target header column limit', () => {
  const cpp = generateRecipeCpp({
    base: 'truncatedIcosahedron',
    ops: [{ op: 'hankin', params: { angle: 58 } }, { op: 'chamfer', params: { t: 0.63 } }],
    vCount: 1200,
    fCount: 602,
    iCount: 3600,
  }, 'Archimedean');
  assert.equal(cpp, fixture('recipe-archimedean.cpp'));
});

/**
 * A name too long to leave room for the first parameter moves the return type
 * to its own line instead.
 */
test('generateRecipeCpp breaks after the return type when the name fills the line', () => {
  const cpp = generateRecipeCpp({
    base: 'truncatedIcosidodecahedron',
    ops: [{ op: 'truncate', params: { t: 0.5 } }, 'ambo', 'dual'],
  }, 'Archimedean');
  assert.match(cpp, /\nHS_FLASH_INLINE inline PolyMesh\ntruncated_icosidodecahedron_truncate50_ambo_dual\(Arena &a, Arena &b\) \{\n/);
});

/**
 * Verifies every breakable emitted line fits the column limit procedural_solids.h
 * is formatted at; only an unbreakable identifier may overflow, as clang-format
 * would leave it.
 */
test('generateRecipeCpp keeps every breakable line within the column limit', () => {
  const sweeps = [
    [SIMPLE_SEEDS, ['dual']],
    [SIMPLE_SEEDS, ['kis', 'ambo', 'gyro', 'meta', 'needle', 'zip', 'dual']],
    [SIMPLE_SEEDS,
      [{ op: 'snub', params: { t: 0.5, twist: 0.28 } }, { op: 'relax', params: { iter: 100 } },
        { op: 'bevel', params: { t: 0.25 } }]],
    // Every parameterized op on the longest seed name: the widest funcName the
    // tool can emit, and the only line allowed to overflow.
    [['truncatedIcosidodecahedron'],
      [{ op: 'truncate', params: { t: 0.33 } }, { op: 'chamfer', params: { t: 0.5 } },
        { op: 'expand', params: { t: 0.5 } }, { op: 'hankin', params: { angle: 54 } },
        { op: 'relax', params: { iter: 100 } }, { op: 'bevel', params: { t: 0.25 } },
        { op: 'snub', params: { t: 0.5, twist: 0.28 } }]],
  ];
  // The only break clang-format cannot take: a bare identifier, optionally
  // carrying the open paren the emitter already broke after. A call list, a
  // method chain and prose all offer one, so each has to fit.
  const UNBREAKABLE = /^[A-Za-z_]\w*\(?$/;
  let overflowed = 0;
  for (const [seeds, ops] of sweeps) {
    for (const base of seeds) {
      for (const line of generateRecipeCpp({ base, ops, vCount: 12345 }, 'Archimedean').split('\n')) {
        if (line.length > 80) overflowed++;
        const atom = line.replace(/^\s*(\* )?/, '');
        assert.ok(line.length <= 80 || UNBREAKABLE.test(atom),
          `"${line}" is ${line.length} columns for base "${base}"`);
      }
    }
  }
  // The widest chain overflows on the funcName alone, so the exemption is
  // exercised.
  assert.ok(overflowed > 0, 'no funcName reaches the limit, so nothing tested it');
});

/** Verifies a line that exactly fills the column limit stays whole and one past it wraps. */
test('generateRecipeCpp wraps at the column limit, not one column early or late', () => {
  const signature = generateRecipeCpp({
    base: 'a'.repeat(19), ops: [{ op: 'relax', params: { iter: 9 } }],
  }, 'Archimedean').split('\n').find((line) => line.startsWith('HS_FLASH_INLINE'));
  assert.equal(signature, `HS_FLASH_INLINE inline PolyMesh ${'a'.repeat(19)}_relax9(Arena &a, Arena &b) {`);
  assert.equal(signature.length, 80);

  const seedLines = (base) => {
    const lines = generateRecipeCpp({ base, ops: ['dual'] }, 'IslamicStarPatterns').split('\n');
    const start = lines.findIndex((line) => line.startsWith('  return '));
    return lines.slice(start, lines.indexOf('      .dual()'));
  };
  assert.deepEqual(seedLines('truncatedIcosidodecahedron_hk'), [
    '  return SolidBuilder(IslamicStarPatterns::truncated_icosidodecahedron_hk(a, b),',
    '                      a, b)',
  ]);
  assert.deepEqual(seedLines('truncatedIcosidodecahedron_hk58'), [
    '  return SolidBuilder(',
    '             IslamicStarPatterns::truncated_icosidodecahedron_hk58(a, b), a, b)',
  ]);
});

test('generateRecipeCpp omits mesh counts if any count is missing', () => {
  const cpp = generateRecipeCpp({ base: 'cube', ops: ['dual'], vCount: 8, fCount: 12 }, 'Archimedean');
  assert.ok(cpp.includes('star pattern.'));
  assert.doesNotMatch(cpp, /V=/);
});

test('generateRecipeCpp wraps a long star seed constructor argument', () => {
  const cpp = generateRecipeCpp({
    base: 'truncatedIcosidodecahedron_hankin62_chamfer50', ops: ['dual'],
  }, 'IslamicStarPatterns');
  assert.equal(cpp, fixture('recipe-2.cpp'));
});

/**
 * The counts ride in from localStorage, which a user can hand-edit, and the
 * output is pasted into a namespace of procedural_solids.h; a count carrying a newline or a
 * comment terminator must not be able to splice C++ around the generated
 * function.
 */
test('generateRecipeCpp renders counts as non-negative integer comment text', () => {
  const spliced = generateRecipeCpp({
    base: 'cube',
    ops: ['dual'],
    vCount: '8\nvoid evil() { launch(); }\n// V=8',
    fCount: 12,
    iCount: 4,
  }, 'Archimedean');
  assert.equal(spliced.split('\n').length, 9);
  assert.ok(!spliced.includes('evil'));
  assert.ok(spliced.includes('star pattern.'));

  for (const [count, shown] of [[-3, 0], [1.9, 1], ['24', 24]]) {
    const cpp = generateRecipeCpp({ base: 'cube', ops: ['dual'], vCount: count, fCount: 12, iCount: 0 }, 'Archimedean');
    assert.ok(cpp.includes(`star pattern (V=${shown}, F=12, I=0).`),
      `count ${String(count)} rendered wrong`);
  }
  for (const count of [NaN, Infinity, null, {}, '', false, '*/ evil() /*']) {
    const cpp = generateRecipeCpp({ base: 'cube', ops: ['dual'], vCount: count, fCount: 12, iCount: 0 }, 'Archimedean');
    assert.doesNotMatch(cpp, /V=|evil/);
  }
});

/**
 * The generated function is pasted into `namespace IslamicStarPatterns`, which
 * carries no using-directive, so an unqualified seed call would not compile.
 */
test('the seed call is qualified with the base namespace', () => {
  const item = { base: 'rhombicTriacontahedron', ops: ['ambo'] };
  const { recipe } = generateFuncAndRecipe(item, 'Catalan');
  assert.equal(recipe, 'SolidBuilder(Catalan::rhombic_triacontahedron(a, b), a, b).ambo().build()');
  assert.ok(generateRecipeCpp(item, 'Catalan')
    .includes('SolidBuilder(Catalan::rhombic_triacontahedron(a, b), a, b)'));
});

/** Verifies a pasteable function is never emitted without a valid namespace for its seed. */
test('generateRecipeCpp requires a valid base namespace', () => {
  const item = { base: 'cube', ops: ['dual'] };
  assert.throws(() => generateRecipeCpp(item),
    /base namespace "undefined" is not a valid C\+\+ identifier/);
  assert.throws(() => generateRecipeCpp(item, ''),
    /base namespace "" is not a valid C\+\+ identifier/);
  assert.throws(() => generateFuncAndRecipe(item, 'Archimedean::evil()'),
    /base namespace "Archimedean::evil\(\)" is not a valid C\+\+ identifier/);
});

/** Verifies the emitted function body never calls the function it defines, which would recurse forever. */
test('generateRecipeCpp never emits a body that calls its own function', () => {
  const assertNonRecursive = (source, funcName) => {
    const match = source.match(/\)\s*\{([\s\S]*)\}\s*$/);
    assert.ok(match, `missing function body for ${funcName}`);
    assert.ok(!new RegExp(`\\b${funcName}\\s*\\(`).test(match[1]),
      `body of ${funcName} calls itself: ${match[1]}`);
  };
  const chains = [
    ['dual'],
    ['kis', 'ambo'],
    [{ op: 'truncate', params: { t: 0.33 } }],
    [{ op: 'hankin', params: { angle: 54 } }, { op: 'relax', params: { iter: 100 } }],
  ];
  for (const ops of chains) {
    for (const base of ['cube', 'truncatedIcosahedron']) {
      const { funcName } = generateFuncAndRecipe({ base, ops });
      const source = generateRecipeCpp({ base, ops }, 'Archimedean');
      assertNonRecursive(source, funcName);
      const recursive = source.replace(/^ {2}return [\s\S]*?;\s*\}/m,
        `  return ${funcName}(a, b);\n}`);
      assert.throws(() => assertNonRecursive(recursive, funcName),
        /calls itself/);
    }
  }
});

/** Verifies generateFuncAndRecipe rejects a base or op that would emit non-compiling C++. */
test('generateFuncAndRecipe rejects an unknown op or a malformed base', () => {
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'frobnicate', params: {} }] }),
    /unknown op "frobnicate"/);
  assert.throws(() => generateFuncAndRecipe({ base: 'cube(a,b); evil()', ops: [] }),
    /not a valid C\+\+ identifier/);
  assert.throws(() => generateFuncAndRecipe({ base: '', ops: [] }),
    /not a valid C\+\+ identifier/);
  assert.doesNotThrow(() => generateFuncAndRecipe({ base: 'icosahedron', ops: ['dual', { op: 'truncate', params: { t: 0.3 } }] }));
  // A parameterized op given as a bare string has no params: descriptive throw, not an opaque TypeError.
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: ['truncate'] }),
    /op "truncate" requires a params object/);
});

/** Verifies an empty op chain is rejected: its funcName would equal the base, redefining the seed and recursing. */
test('generateFuncAndRecipe rejects an empty op chain', () => {
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [] }), /op chain is empty/);
  assert.throws(() => generateRecipeCpp({ base: 'cube', ops: [] }, 'Archimedean'), /op chain is empty/);
});

/** Verifies generateFuncAndRecipe rejects non-finite fractional params and non-integer or non-positive relax counts. */
test('generateFuncAndRecipe rejects non-finite or out-of-range op params', () => {
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'truncate', params: { t: NaN } }] }),
    /must be a finite number/);
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'hankin', params: { angle: Infinity } }] }),
    /must be a finite number/);
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'relax', params: { iter: 1.5 } }] }),
    /must be a positive integer/);
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'relax', params: { iter: -1 } }] }),
    /must be a positive integer/);
});

/**
 * Verifies the emit path applies the same OP_DEFS bands the restore path does.
 */
test('generateFuncAndRecipe rejects every param savedChainShapeError calls out of range', () => {
  const cases = [[{ op: 'hankin', params: { angle: 0 } }, 'hankin param "angle"']];
  for (const [name, { params }] of Object.entries(OP_DEFS)) {
    for (const [key, def] of Object.entries(params)) {
      const op = { op: name, params: seedOpParams(name, null) };
      op.params[key] = def.max + def.step;
      cases.push([op, `${name} param "${key}"`]);
    }
  }
  for (const [op, named] of cases) {
    assert.match(savedChainShapeError('cube', [op]) ?? '', /carries out-of-range/,
      `savedChainShapeError must refuse ${JSON.stringify(op)}`);
    assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [op] }),
      new RegExp(`${named} must be within`),
      `generateFuncAndRecipe must refuse ${JSON.stringify(op)}`);
  }

  // Every op's slider extremes stay emittable, so the band check refuses nothing
  // the tool itself can author.
  for (const [name, { params }] of Object.entries(OP_DEFS)) {
    for (const edge of ['min', 'max']) {
      const op = { op: name, params: {} };
      for (const [key, def] of Object.entries(params)) op.params[key] = def[edge];
      assert.doesNotThrow(() => generateFuncAndRecipe({ base: 'cube', ops: [op] }),
        `${name} at its ${edge} must stay emittable`);
    }
  }
});

/** Verifies a negative fractional param is rejected rather than emitting a `-`-tainted, non-identifier funcName. */
test('pctSuffix and generateFuncAndRecipe reject negative fractional params', () => {
  assert.throws(() => pctSuffix(-0.5), /negative/);
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'truncate', params: { t: -0.5 } }] }),
    /negative/);
});

test('star seed calls match formatter-derived bin-packed fixtures', () => {
  for (const [index, base] of ['dodecahedron_hk62_ambo_hk62',
    'truncatedIcosidodecahedron_hk62_ambo_hk62'].entries()) {
    const expected = fixture(`recipe-${index}.cpp`);
    assert.equal(generateRecipeCpp({ base, ops: ['kis'] }, 'IslamicStarPatterns'), expected);
  }
});

test('long star seeds match formatter-derived namespace continuations', () => {
  for (const [offset, base] of ['truncatedIcosahedron_hk58_chamfer63',
    'truncatedIcosahedron_ambo_relax_truncate33_hk64',
    'truncatedIcosahedron_ambo_relax_truncate001_hankin59'].entries()) {
    assert.equal(generateRecipeCpp({ base, ops: ['kis'] }, 'IslamicStarPatterns'),
      fixture(`recipe-${offset + 3}.cpp`));
  }
});
