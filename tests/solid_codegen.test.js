import { fakeModule, stubMesh } from './helpers/fake_meshops.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


const {
  OP_DEFS,
  KNOWN_OPS,
  PARAMETERIZED_OPS,
  applyOp,
  savedChainShapeError,
  MAX_RECIPE_STEPS,
  SAVED_SOLIDS_MAX,
  captureSavedSolidThumbnail,
  queueSavedSolidRestore,
  formatFloat,
  formatSolidName,
  pctSuffix,
  generateFuncAndRecipe,
  generateRecipeCpp,
  D2R_F32,
  SIMPLE_SEEDS,
  computeInternalAngle,
  snapToStep,
  seedOpParams,
  opsFromRecipe,
  dropSlotIndex,
  dropTargetIndex,
  reorderPreviewShift,
  movedOps,
  opTopologyKey,
  meshOpFailure,
  requireMeshResult,
  MORPH_SWEEP,
  unsweepableReason,
} =
  await import('../src/workbench/solids/solid_codegen.js');
const { formatFloatCpp } = await import('../src/shared/cpp_format.js');

/**
 * Builds an op whose params object records every key a code path reads, in read
 * order, seeded with the OP_DEFS defaults.
 */
function recordingOp(op) {
  const seen = new Set();
  const values = seedOpParams(op, null);
  const params = new Proxy(values, {
    get(target, key) {
      if (typeof key === 'string') seen.add(key);
      return target[key];
    },
  });
  return { spec: { op, params }, seen };
}



/**
 * Verifies the live-preview dispatch reads exactly the params OP_DEFS declares
 * for every known op, in the same order.
 */
test('applyOp consumes the OP_DEFS params of every known op', () => {
  assert.ok(KNOWN_OPS.size > 0);
  for (const op of KNOWN_OPS) {
    const previewed = recordingOp(op);
    applyOp(stubMesh(), previewed.spec);
    assert.deepEqual([...previewed.seen], Object.keys(OP_DEFS[op].params),
      `applyOp reads different params than OP_DEFS declares for "${op}"`);
  }
});

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

/**
 * Verifies the live preview hands each bound method exactly the argument values
 * the engine takes, in order — the hankin angle converted from the control's
 * degrees to the engine's radians, everything else passed through untouched.
 */
test('applyOp forwards each op its engine arguments', () => {
  const cases = [
    [{ op: 'truncate', params: { t: 0.33 } }, { op: 'truncate', args: [0.33] }],
    [{ op: 'chamfer', params: { t: 0.4 } }, { op: 'chamfer', args: [0.4] }],
    [{ op: 'expand', params: { t: 0.6 } }, { op: 'expand', args: [0.6] }],
    [{ op: 'bevel', params: { t: 0.25 } }, { op: 'bevel', args: [0.25] }],
    [{ op: 'snub', params: { t: 0.5, twist: 0.28 } }, { op: 'snub', args: [0.5, 0.28] }],
    [{ op: 'relax', params: { iter: 100 } }, { op: 'relax', args: [100] }],
    [{ op: 'hankin', params: { angle: 54 } }, { op: 'hankin', args: [Math.fround(54 * D2R_F32)] }],
    [{ op: 'hankin', params: { angle: 0 } }, { op: 'hankin', args: [0] }],
    ['dual', { op: 'dual', args: [] }],
    ['kis', { op: 'kis', args: [] }],
  ];
  for (const [spec, expected] of cases) {
    const calls = [];
    applyOp(stubMesh(calls), spec);
    assert.deepEqual(calls, [expected], `applyOp dispatched ${expected.op} wrongly`);
  }
});

/** Verifies applyOp rejects an op the mesh wrapper binds no method for. */
test('applyOp throws on an op the module does not bind', () => {
  assert.throws(() => applyOp({}, 'dual'),
    /unknown op "dual" — not bound by the WASM MeshOps module/);
});

/**
 * Verifies applyOp gates on KNOWN_OPS before dispatch. The wrapper also binds
 * lifetime and Object methods, so a name off the op table must be rejected by
 * name rather than reaching mesh[name]() and surfacing as a soft reject.
 */
test('applyOp rejects a bound non-op name without calling it', () => {
  for (const name of ['delete', 'clone', 'isAliasOf', 'constructor', 'toString']) {
    const calls = [];
    assert.throws(() => applyOp(stubMesh(calls), { op: name, params: {} }),
      new RegExp(`applyOp: unknown op "${name}"`),
      `applyOp dispatched "${name}" instead of rejecting it by name`);
    assert.deepEqual(calls, [], `applyOp called mesh.${name}()`);
  }
});

/** Verifies applyOp surfaces the bridge's null soft-reject as an error instead of passing null on as a mesh. */
test('applyOp throws when the module soft-rejects an op', () => {
  assert.throws(() => applyOp({ ambo: () => null }, 'ambo'),
    /applyOp: op "ambo" was rejected/);
  assert.throws(
    () => applyOp({ hankin: () => null }, { op: 'hankin', params: { angle: 54 } }),
    /applyOp: op "hankin" was rejected/);
});

/** formatFloat re-exports cpp_format's formatFloatCpp. */
test('formatFloat is wired to the authoritative formatFloatCpp', () => {
  assert.equal(formatFloat, formatFloatCpp);
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

/**
 * PARAMETERIZED_OPS is derived from OP_DEFS, so every op declaring a param —
 * snub and relax included — is rejected in the bare-string form by both dispatch
 * paths.
 */
test('applyOp and generateFuncAndRecipe share one parameterized-op vocabulary', () => {
  assert.deepEqual([...PARAMETERIZED_OPS].sort(),
    [...KNOWN_OPS].filter(op => Object.keys(OP_DEFS[op].params).length > 0).sort());
  assert.ok(PARAMETERIZED_OPS.has('snub') && PARAMETERIZED_OPS.has('relax'));

  for (const op of PARAMETERIZED_OPS) {
    assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [op] }),
      new RegExp(`generateFuncAndRecipe: op "${op}" requires a params object`));
    assert.throws(() => applyOp(stubMesh(), op),
      new RegExp(`applyOp: op "${op}" requires a params object`));
  }

  // A bare string is the whole spelling of an op with no params: both paths
  // take it, and each emits the nullary call rather than a defaulted one.
  const bare = [...KNOWN_OPS].filter((op) => !PARAMETERIZED_OPS.has(op));
  assert.deepEqual(bare.sort(),
    ['ambo', 'dual', 'gyro', 'kis', 'meta', 'needle', 'zip']);

  for (const op of bare) {
    const { funcName, recipe } = generateFuncAndRecipe({ base: 'cube', ops: [op] });
    assert.equal(funcName, `cube_${op}`);
    assert.equal(recipe, `SolidBuilder(cube(a, b), a, b).${op}().build()`);

    const calls = [];
    applyOp(stubMesh(calls), op);
    assert.deepEqual(calls, [{ op, args: [] }]);
  }
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
  assert.equal(cpp, readFileSync(new URL('./fixtures/recipe-archimedean.cpp', import.meta.url), 'utf8').trimEnd());
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

/** Verifies generateRecipeCpp falls back to zero vertex/face/internal counts when the item omits them. */
test('generateRecipeCpp defaults missing V/F/I counts to 0', () => {
  const cpp = generateRecipeCpp({ base: 'cube', ops: ['dual'] }, 'Archimedean');
  assert.ok(cpp.includes('star pattern (V=0, F=0, I=0).'));
});

test('generateRecipeCpp wraps a long star seed constructor argument', () => {
  const cpp = generateRecipeCpp({
    base: 'truncatedIcosidodecahedron_hankin62_chamfer50', ops: ['dual'],
  }, 'IslamicStarPatterns');
  assert.equal(cpp, readFileSync(new URL('./fixtures/recipe-2.cpp', import.meta.url), 'utf8').trimEnd());
});

/**
 * The counts ride in from localStorage, which a user can hand-edit, and the
 * output is pasted into a namespace of procedural_solids.h; a count carrying a newline or a
 * comment terminator must not be able to splice C++ around the generated
 * function.
 */
test('generateRecipeCpp emits counts no non-negative integer can escape', () => {
  const spliced = generateRecipeCpp({
    base: 'cube',
    ops: ['dual'],
    vCount: '8\nvoid evil() { launch(); }\n// V=8',
    fCount: 12,
    iCount: 4,
  }, 'Archimedean');
  assert.equal(spliced.split('\n').length, 9);
  assert.ok(!spliced.includes('evil'));
  assert.ok(spliced.includes('star pattern (V=0, F=12, I=4).'));

  for (const [count, shown] of [
    [-3, 0], [1.9, 1], ['24', 24], [NaN, 0], [Infinity, 0], [null, 0], [{}, 0],
    ['*/ evil() /*', 0],
  ]) {
    const cpp = generateRecipeCpp({ base: 'cube', ops: ['dual'], vCount: count }, 'Archimedean');
    assert.ok(cpp.includes(`star pattern (V=${shown}, F=0, I=0).`),
      `count ${String(count)} rendered wrong`);
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

test('hankin controls start at one degree', () => {
  const def = OP_DEFS.hankin.params.angle;
  assert.equal(def.min, 1);
  assert.equal(snapToStep(0, def), 1);
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

/**
 * The paste computes `<deg>f * D2R` in float32; a double PI/180 lands one ulp
 * away at 54 and 73 degrees.
 */
test('the preview converts a hankin angle in the float precision the paste uses', () => {
  assert.equal(new Uint32Array(new Float32Array([D2R_F32]).buffer)[0], 0x3c8efa35);
  for (const angle of [54, 73]) {
    const calls = [];
    applyOp(stubMesh(calls), { op: 'hankin', params: { angle } });
    assert.equal(calls[0].args[0], Math.fround(angle * D2R_F32));
    assert.notEqual(calls[0].args[0], Math.fround(angle * (Math.PI / 180)));
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
  const cases = [
    [{ op: 'chamfer', params: { t: 1 } }, 'chamfer param "t"'],
    [{ op: 'truncate', params: { t: 0.75 } }, 'truncate param "t"'],
    [{ op: 'expand', params: { t: 1 } }, 'expand param "t"'],
    [{ op: 'bevel', params: { t: 0.9 } }, 'bevel param "t"'],
    [{ op: 'hankin', params: { angle: 120 } }, 'hankin param "angle"'],
    [{ op: 'hankin', params: { angle: 0 } }, 'hankin param "angle"'],
    [{ op: 'snub', params: { t: 0.5, twist: 2 } }, 'snub param "twist"'],
    [{ op: 'relax', params: { iter: 600 } }, 'relax param "iter"'],
  ];
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

/** A list of uniform 20px rows, the layout the op-chain reorder math reads. */
const rows = (count, height = 20) =>
  Array.from({ length: count }, (_, i) => ({ offsetTop: i * height, offsetHeight: height }));

/** Verifies the drop slot counts the item midpoints the pointer has passed. */
test('dropSlotIndex splits on each item midpoint', () => {
  const items = rows(3);
  assert.equal(dropSlotIndex(0, items), 0);
  assert.equal(dropSlotIndex(9, items), 0);
  assert.equal(dropSlotIndex(10, items), 1); // exactly on the first midpoint
  assert.equal(dropSlotIndex(29, items), 1);
  assert.equal(dropSlotIndex(30, items), 2);
  assert.equal(dropSlotIndex(1000, items), 3); // past the last item
});

/** Verifies an empty list offers only the single slot 0, so the first op can be dropped. */
test('dropSlotIndex reports slot 0 for an empty list', () => {
  assert.equal(dropSlotIndex(0, []), 0);
  assert.equal(dropSlotIndex(500, []), 0);
});

/** Verifies rows of differing heights split on their own midpoints, not a uniform pitch. */
test('dropSlotIndex handles rows of unequal height', () => {
  const items = [
    { offsetTop: 0, offsetHeight: 40 },
    { offsetTop: 40, offsetHeight: 10 },
  ];
  assert.equal(dropSlotIndex(19, items), 0);
  assert.equal(dropSlotIndex(20, items), 1);
  assert.equal(dropSlotIndex(45, items), 2);
});

/** Verifies a slot at or before the dragged op maps straight through, since removal shifts nothing before it. */
test('dropTargetIndex passes slots at or above the drag source through', () => {
  assert.equal(dropTargetIndex(0, 2), 0);
  assert.equal(dropTargetIndex(2, 2), 2);
});

/** Verifies a slot past the dragged op loses the one index the removal frees. */
test('dropTargetIndex decrements slots past the drag source', () => {
  assert.equal(dropTargetIndex(3, 2), 2); // dropping just below itself is a no-op
  assert.equal(dropTargetIndex(4, 2), 3);
});

/**
 * Verifies the slot pair that means "leave it where it is" both resolve to the
 * source index, which is how the page detects a no-op drop.
 */
test('dropTargetIndex resolves both no-op slots to the source index', () => {
  for (const from of [0, 1, 4]) {
    assert.equal(dropTargetIndex(from, from), from);
    assert.equal(dropTargetIndex(from + 1, from), from);
  }
});

/** Verifies dragging down shifts only the ops the dragged one passes, each up one slot. */
test('reorderPreviewShift lifts the ops a downward drag passes', () => {
  // Dragging op 0 to slot 3: ops 1 and 2 move up, op 3 stays.
  assert.deepEqual([0, 1, 2, 3].map(i => reorderPreviewShift(0, 3, i)), [0, -1, -1, 0]);
});

/** Verifies dragging up shifts only the ops the dragged one passes, each down one slot. */
test('reorderPreviewShift pushes down the ops an upward drag passes', () => {
  // Dragging op 3 to slot 1: ops 1 and 2 move down, op 0 stays.
  assert.deepEqual([0, 1, 2, 3].map(i => reorderPreviewShift(3, 1, i)), [0, 1, 1, 0]);
});

/** Verifies the dragged item itself is never shifted, and a no-op drop moves nothing. */
test('reorderPreviewShift leaves the dragged item and no-op drops alone', () => {
  assert.equal(reorderPreviewShift(2, 5, 2), 0);
  assert.equal(reorderPreviewShift(2, 0, 2), 0);
  for (const slot of [2, 3]) {
    assert.deepEqual([0, 1, 2, 3].map(i => reorderPreviewShift(2, slot, i)), [0, 0, 0, 0]);
  }
});

/**
 * Verifies the preview agrees with the commit: an op previewed as shifting by one
 * slot lands exactly one place from where it started in the reordered chain.
 */
test('reorderPreviewShift matches where movedOps actually puts each op', () => {
  const ops = [0, 1, 2, 3].map(i => ({ op: `op${i}`, params: {} }));
  for (let from = 0; from < ops.length; from++) {
    for (let slot = 0; slot <= ops.length; slot++) {
      const moved = movedOps(ops, from, dropTargetIndex(slot, from));
      for (let i = 0; i < ops.length; i++) {
        if (i === from) continue;
        const landed = moved.findIndex(o => o.op === `op${i}`);
        assert.equal(landed - i, reorderPreviewShift(from, slot, i),
          `op${i} preview disagrees with the commit for from=${from} slot=${slot}`);
      }
    }
  }
});

/** Verifies movedOps reorders without aliasing or mutating the input chain. */
test('movedOps returns a reordered deep copy', () => {
  const ops = [
    { op: 'dual', params: {} },
    { op: 'truncate', params: { t: 0.3 } },
    { op: 'ambo', params: {} },
  ];
  const moved = movedOps(ops, 0, 2);
  assert.deepEqual(moved.map(o => o.op), ['truncate', 'ambo', 'dual']);
  assert.deepEqual(ops.map(o => o.op), ['dual', 'truncate', 'ambo']);
  moved[0].params.t = 0.9;
  assert.equal(ops[1].params.t, 0.3);
});


/** Verifies the recorded reason is read back by identity and names its remedy. */
test('meshOpFailure routes each recorded reason', () => {
  const { Mod } = fakeModule({ rejects: new Set(['base:cube']), reason: 'ARENA_EXHAUSTED' });
  assert.equal(Mod.MeshOps.fromSolidName('cube'), null);
  const exhausted = meshOpFailure(Mod, 'Base solid "cube"');
  assert.equal(exhausted.reason, 'ARENA_EXHAUSTED');
  assert.equal(exhausted.flush, true, 'only ARENA_EXHAUSTED is cleared by flushing the arenas');
  assert.match(exhausted.message, /^Base solid "cube" failed: /);

  const unknown = fakeModule({ rejects: new Set(['base:nope']), reason: 'UNKNOWN_NAME' });
  assert.equal(unknown.Mod.MeshOps.fromSolidName('nope'), null);
  const named = meshOpFailure(unknown.Mod, 'Base solid "nope"');
  assert.equal(named.reason, 'UNKNOWN_NAME');
  assert.equal(named.flush, false);
  assert.notEqual(named.message, exhausted.message, 'each reason must carry its own remedy');

  const gone = fakeModule({ rejects: new Set(['base:cube']), reason: 'ARENA_UNAVAILABLE' });
  assert.equal(gone.Mod.MeshOps.fromSolidName('cube'), null);
  const unavailable = meshOpFailure(gone.Mod, 'Base solid "cube"');
  assert.equal(unavailable.fatal, true, 'an unreservable tooling block leaves no call that can succeed');
  assert.equal(unavailable.flush, false, 'there is no arena to flush');
  assert.equal(exhausted.fatal, false, 'a full arena is cleared by the flush, not terminal');
  assert.equal(named.fatal, false);
});

/** Verifies a module that binds neither the enum nor getLastResult still yields a message. */
test('meshOpFailure reports UNKNOWN when the module records no reason', () => {
  const failure = meshOpFailure({ MeshOps: {} }, 'Face classification');
  assert.equal(failure.reason, 'UNKNOWN');
  assert.equal(failure.flush, false);
  assert.match(failure.message, /^Face classification failed: /);
});

/** Verifies a recorded value the enum does not name reads back as UNKNOWN, not as success. */
test('meshOpFailure reports UNKNOWN for a recorded value outside the enum', () => {
  const { Mod } = fakeModule();
  Mod.MeshOps.getLastResult = () => Symbol('UNLISTED');
  const failure = meshOpFailure(Mod, 'Face classification');
  assert.equal(failure.reason, 'UNKNOWN');
  assert.equal(failure.flush, false);
  assert.equal(failure.fatal, false);
});

/** Verifies the null-result handler reports and flushes by reason. */
test('requireMeshResult surfaces the reason and applies its remedy', () => {
  const { Mod, state } = fakeModule({ rejects: new Set(['base:cube']) });
  const shown = [];
  const ctx = { Mod, meshOps: Mod.MeshOps, onError: (m) => shown.push(m) };

  const mesh = Mod.MeshOps.fromSolidName('other');
  assert.equal(requireMeshResult(mesh, 'Base solid', ctx), mesh, 'a real mesh passes through');
  assert.deepEqual(shown, []);
  assert.equal(state.cleared, 0, 'a success must not flush the arenas');

  assert.equal(requireMeshResult(Mod.MeshOps.fromSolidName('cube'), 'Base solid "cube"', ctx), null);
  assert.equal(state.cleared, 1, 'ARENA_EXHAUSTED must flush the tooling arenas');
  assert.equal(shown.length, 1, 'the failure must be surfaced, not only logged');
  assert.match(shown[0], /^Base solid "cube" failed: /);
});

/** Verifies a reason with no flush remedy leaves the arenas alone. */
test('requireMeshResult flushes only for the reason that calls for it', () => {
  const { Mod, state } = fakeModule(
    { rejects: new Set(['base:nope']), reason: 'UNKNOWN_NAME' });
  const shown = [];
  assert.equal(requireMeshResult(Mod.MeshOps.fromSolidName('nope'), 'Base solid "nope"',
    { Mod, meshOps: Mod.MeshOps, onError: (m) => shown.push(m) }), null);
  assert.equal(state.cleared, 0, 'flushing an intact arena would strand live wrappers');
  assert.equal(shown.length, 1);
});

/**
 * Verifies the one reason nothing recovers from stands the tool down instead of
 * scrolling past on the line the next recompute overwrites.
 */
test('requireMeshResult stands the tool down for an unreservable tooling block', () => {
  const { Mod, state } = fakeModule(
    { rejects: new Set(['base:cube']), reason: 'ARENA_UNAVAILABLE' });
  const shown = [];
  const fatal = [];
  const ctx = {
    Mod,
    meshOps: Mod.MeshOps,
    onError: (m) => shown.push(m),
    onFatal: (m) => fatal.push(m),
  };
  assert.equal(requireMeshResult(Mod.MeshOps.fromSolidName('cube'), 'Base solid "cube"', ctx), null);
  assert.deepEqual(shown, [], 'a terminal failure must not go to the transient line');
  assert.equal(fatal.length, 1);
  assert.match(fatal[0], /reload the page$/);
  assert.equal(state.cleared, 0, 'there is no arena to flush');
});

/** Verifies a recoverable failure keeps going to the transient line. */
test('requireMeshResult leaves a recoverable failure on the transient line', () => {
  const { Mod } = fakeModule({ rejects: new Set(['base:cube']) });
  const shown = [];
  const fatal = [];
  assert.equal(requireMeshResult(Mod.MeshOps.fromSolidName('cube'), 'Base solid "cube"',
    { Mod, meshOps: Mod.MeshOps, onError: (m) => shown.push(m), onFatal: (m) => fatal.push(m) }), null);
  assert.equal(shown.length, 1);
  assert.deepEqual(fatal, []);
});

/**
 * Verifies every chain the tool can build passes the shape check, so restoring a
 * legitimately saved solid is never refused. The ops are assembled the way addOp
 * assembles them — one entry per op, params seeded from the OP_DEFS defaults.
 */
test('savedChainShapeError accepts the chains the tool itself saves', () => {
  const ops = [...KNOWN_OPS].map((op) => ({ op, params: seedOpParams(op, null) }));
  assert.equal(savedChainShapeError('cube', ops), null);
  for (const o of ops) {
    assert.equal(savedChainShapeError('truncatedIcosahedron', [o]), null,
      `a saved "${o.op}" must stay restorable`);
  }
  assert.equal(savedChainShapeError('cube', []), null, 'a bare seed can be restored without exporting a card');
});

/**
 * Verifies each way a stored entry can be unrestorable is named rather than
 * passed through.
 */
test('savedChainShapeError rejects every unrestorable stored shape', () => {
  const cases = [
    [['cube', [{ op: 'frobnicate', params: {} }]], /unknown operator "frobnicate"/],
    [['cube', [{ op: 'delete', params: {} }]], /unknown operator "delete"/],
    [['cube', [{ params: {} }]], /unknown operator "undefined"/],
    [['cube', ['dual']], /op 1 is not an op entry/],
    [['cube', [null]], /op 1 is not an op entry/],
    [['cube', [{ op: 'dual', params: {} }, { op: 'hankin' }]],
      /op 2 \("hankin"\) carries no numeric "angle"/],
    [['cube', [{ op: 'snub', params: { t: 0.5 } }]], /carries no numeric "twist"/],
    [['cube', [{ op: 'truncate', params: { t: 'a lot' } }]], /carries no numeric "t"/],
    [['cube', [{ op: 'relax', params: { iter: NaN } }]], /carries no numeric "iter"/],
    [['cube', [{ op: 'truncate', params: { t: 0.75 } }]], /carries out-of-range "t"/],
    [['cube', [{ op: 'hankin', params: { angle: -1 } }]], /carries out-of-range "angle"/],
    // A fractional angle names one solid in the funcName suffix (which rounds)
    // and emits another in the recipe call (which does not).
    [['cube', [{ op: 'hankin', params: { angle: 58.4 } }]], /carries off-grid "angle"/],
    [['cube', [{ op: 'truncate', params: { t: 0.335 } }]], /carries off-grid "t"/],
    [['cube', [{ op: 'truncate', params: { t: 0.3305 } }]], /carries off-grid "t"/],
    [['cube', [{ op: 'relax', params: { iter: 100.5 } }]], /carries off-grid "iter"/],
    [['cube', null], /op chain is not a list/],
    [['cube', { 0: { op: 'dual' } }], /op chain is not a list/],
    [[null, []], /names no base solid/],
    [['', []], /names no base solid/],
  ];
  for (const [[base, ops], expected] of cases) {
    const message = savedChainShapeError(base, ops);
    assert.ok(typeof message === 'string' && expected.test(message),
      `expected ${expected} for ${JSON.stringify(ops)}, got ${message}`);
  }
});

/**
 * Verifies a stored chain longer than the tool's add-op path can build is
 * refused before it is replayed, on both the restore and the import path.
 */
test('savedChainShapeError refuses a chain past the op cap', () => {
  const kis = () => ({ op: 'kis', params: {} });
  const atCap = Array.from({ length: MAX_RECIPE_STEPS }, kis);
  assert.equal(savedChainShapeError('cube', atCap), null, 'the cap is inclusive');
  assert.match(savedChainShapeError('cube', [...atCap, kis()]) ?? '',
    /at most 255/, 'one op past the cap is refused');
  assert.match(queueSavedSolidRestore({ base: 'cube', ops: [...atCap, kis()] },
    () => assert.fail('a refused chain must not be queued')) ?? '', /at most 255/);
});

test('a malformed saved solid is rejected before its restore is queued', () => {
  let queued = false;
  const error = queueSavedSolidRestore(
    { base: 'cube', ops: [{ op: 'unknown' }] },
    () => { queued = true; });

  assert.match(error, /unknown operator/);
  assert.equal(queued, false);

  assert.equal(queueSavedSolidRestore(
    { base: 'cube', ops: [] }, () => { queued = true; }), null);
  assert.equal(queued, true);
});

test('a full saved-solid list refuses before thumbnail capture', () => {
  let captures = 0;
  const capture = () => {
    captures++;
    return 'data:image/png;base64,test';
  };

  assert.deepEqual(captureSavedSolidThumbnail(SAVED_SOLIDS_MAX, capture),
    { full: true, dataURL: null });
  assert.equal(captures, 0);
  assert.deepEqual(captureSavedSolidThumbnail(SAVED_SOLIDS_MAX - 1, capture),
    { full: false, dataURL: 'data:image/png;base64,test' });
  assert.equal(captures, 1);
});


/** Verifies opTopologyKey names the parameter only where the engine lowers on it. */
test('opTopologyKey separates only the params that pick a lowering', () => {
  assert.equal(opTopologyKey({ op: 'truncate', params: { t: 0.5 } }), 'truncate:ambo');
  assert.equal(opTopologyKey({ op: 'bevel', params: { t: 0.5 } }), 'bevel:ambo');
  assert.equal(opTopologyKey({ op: 'truncate', params: { t: 0.49 } }), 'truncate');
  assert.equal(opTopologyKey({ op: 'bevel', params: { t: 0.25 } }), 'bevel');
  // Every other op's params leave the topology alone, so they stay out of the key.
  assert.equal(opTopologyKey({ op: 'chamfer', params: { t: 0.5 } }), 'chamfer');
  assert.equal(opTopologyKey({ op: 'expand', params: { t: 0.5 } }), 'expand');
  assert.equal(opTopologyKey({ op: 'snub', params: { t: 0.5, twist: 0 } }), 'snub');
  assert.equal(opTopologyKey({ op: 'hankin', params: { angle: 54 } }), 'hankin');
  assert.equal(opTopologyKey({ op: 'relax', params: { iter: 100 } }), 'relax');
  assert.equal(opTopologyKey('dual'), 'dual');
  // A bare parameterized op carries no t, so it cannot be the aliased lowering.
  assert.equal(opTopologyKey('truncate'), 'truncate');
});

test('restored float32 ambo aliases use the engine topology and bevel lowering', async () => {
  const { LOWERING } = await import('../src/workbench/solids/solid_registry_codegen.js');
  for (const op of ['truncate', 'bevel']) {
    const alias = { op, params: { t: 0.499999995 } };
    assert.equal(savedChainShapeError('cube', [alias]), null);
    assert.equal(opTopologyKey(alias), `${op}:ambo`);
    assert.equal(opTopologyKey({ op, params: { t: 0.49999 } }), op);
    if (op === 'bevel') assert.deepEqual(LOWERING.bevel(alias), ['ambo', 'ambo']);
  }
});

test('MORPH_SWEEP covers the primitive ops and no composite', () => {
  const COMPOSITES = ['bevel', 'gyro', 'meta', 'needle', 'zip'];
  for (const op of COMPOSITES) {
    assert.equal(op in MORPH_SWEEP, false,
      `${op} lowers to primitives before the engine's morph check reads it`);
  }
  // unsweepableReason answers null for an op the table omits, so a primitive
  // added to OP_DEFS and forgotten here reads as fully swept.
  assert.deepEqual(
    [...Object.keys(MORPH_SWEEP), ...COMPOSITES].sort(),
    Object.keys(OP_DEFS).sort(),
    'every authored op is either swept or a known composite');
});

test('unsweepableReason names the ops the engine morph path declines', () => {
  assert.equal(unsweepableReason({ op: 'kis', params: {} }), null);
  assert.equal(unsweepableReason('ambo'), null);
  assert.equal(unsweepableReason({ op: 'bevel', params: { t: 0.5 } }), null,
    'a composite lowers to primitives the engine sweeps');
  assert.equal(unsweepableReason({ op: 'notanop', params: {} }), null,
    'an op off the table is a different defect, reported by savedChainShapeError');
  assert.equal(unsweepableReason({ op: 'truncate', params: {} }), null,
    'a missing param is a different defect, reported by savedChainShapeError');
  assert.equal(unsweepableReason('truncate'), null);

  assert.match(unsweepableReason({ op: 'expand', params: { t: 0.5 } }), /^expand is not swept by the morph path/,
    'expand has a leg kind but no sweep coverage, so a shape using it is generated whole');

  const { min, max } = MORPH_SWEEP.chamfer.t;
  assert.equal(unsweepableReason({ op: 'chamfer', params: { t: max } }), null,
    'the band is inclusive at both ends');
  assert.equal(unsweepableReason({ op: 'chamfer', params: { t: min } }), null);
  assert.match(unsweepableReason({ op: 'chamfer', params: { t: max + 0.01 } }),
    /^chamfer sweeps t only over/,
    'the OP_DEFS slider reaches past the band, which is the drift this reports');
  assert.match(unsweepableReason({ op: 'chamfer', params: { t: OP_DEFS.chamfer.params.t.min } }),
    /^chamfer sweeps t only over/,
    'the slider also reaches below it');
});

test('truncate reports the topology pinch after conversion to engine float precision', () => {
  for (const t of [0.5, 0.5 - 2 ** -26, 0.5 + 2 ** -26]) {
    assert.match(unsweepableReason({ op: 'truncate', params: { t } }),
      /^truncate cannot sweep t at 0\.5:/, `${t} becomes the engine pinch`);
  }
  for (const t of [0.5 - 2 ** -25, 0.5 + 2 ** -24]) {
    assert.equal(unsweepableReason({ op: 'truncate', params: { t } }), null,
      `${t} remains outside the pinch`);
  }
  assert.equal(unsweepableReason({ op: 'bevel', params: { t: 0.5 } }), null,
    'bevel lowers its pinch to AMBO before morphability is checked');
});

test('a slider reaching past its swept band is reported rather than silent', () => {
  const overreaching = [];
  for (const [op, band] of Object.entries(MORPH_SWEEP)) {
    if (!band) continue;
    for (const [key, { min, max, excluded = [] }] of Object.entries(band)) {
      const def = OP_DEFS[op].params[key];
      assert.ok(def, `MORPH_SWEEP bounds ${op}.${key}, which OP_DEFS does not declare`);
      if (def.min >= min && def.max <= max) {
        for (const endpoint of [def.min, def.max]) {
          const reason = unsweepableReason({ op, params: { [key]: endpoint } });
          if (excluded.includes(Math.fround(endpoint))) {
            assert.match(reason, new RegExp(`^${op} cannot sweep ${key}`));
          } else {
            assert.equal(reason, null, `${op}.${key}=${endpoint} remains inside its band`);
          }
        }
        continue;
      }
      overreaching.push(`${op}.${key}`);
      // A slider reaching outside its band is legal; the row marker is what
      // keeps it from being silent.
      assert.match(unsweepableReason({ op, params: { [key]: def.max } })
        ?? unsweepableReason({ op, params: { [key]: def.min } }) ?? '',
      new RegExp(`^${op} sweeps ${key}`),
      `${op} offers ${key} outside its band with nothing reporting it`);
    }
  }
  // The rows the marker case exists for.
  assert.deepEqual(overreaching, ['chamfer.t']);
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
    { op: 'snub', param: Math.fround(0.5), twist: 0 },
    { op: 'relax', param: 0, twist: 0 },
    { op: 'relax', param: 100, twist: 0 },
  ]);
  assert.deepEqual(ops, [
    { op: 'hankin', params: { angle: 62 } },
    { op: 'ambo', params: {} },
    { op: 'truncate', params: { t: 0.33 } },
    { op: 'truncate', params: { t: ops[3].params.t } },
    { op: 'snub', params: { t: 0.5, twist: 0 } },
    { op: 'relax', params: { iter: OP_DEFS.relax.params.iter.max } },
    { op: 'relax', params: { iter: 100 } },
  ]);
  // Off-grid params are kept at the authored float, not snapped.
  assert.equal(Math.fround(ops[3].params.t), rad(5));
  assert.throws(() => opsFromRecipe([{ op: 'warp', param: 0, twist: 0 }]), /unknown op "warp"/);
});

test('star seed calls match formatter-derived bin-packed fixtures', () => {
  for (const [index, base] of ['dodecahedron_hk62_ambo_hk62',
    'truncatedIcosidodecahedron_hk62_ambo_hk62'].entries()) {
    const expected = readFileSync(new URL(`./fixtures/recipe-${index}.cpp`, import.meta.url), 'utf8').trimEnd();
    assert.equal(generateRecipeCpp({ base, ops: ['kis'] }, 'IslamicStarPatterns'), expected);
  }
});

test('long star seeds match formatter-derived namespace continuations', () => {
  for (const [offset, base] of ['truncatedIcosahedron_hk58_chamfer63',
    'truncatedIcosahedron_ambo_relax_truncate33_hk64',
    'truncatedIcosahedron_ambo_relax_truncate001_hankin59'].entries()) {
    assert.equal(generateRecipeCpp({ base, ops: ['kis'] }, 'IslamicStarPatterns'),
      readFileSync(new URL(`./fixtures/recipe-${offset + 3}.cpp`, import.meta.url), 'utf8').trimEnd());
  }
});
