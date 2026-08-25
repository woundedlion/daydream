import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOLIDS_PAGE = readFileSync(new URL('../tools/solids_page.js', import.meta.url), 'utf8');

const {
  OP_DEFS,
  KNOWN_OPS,
  PARAMETERIZED_OPS,
  applyOp,
  savedChainShapeError,
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
  isConvexFace,
  fanTriangulateFace,
  uniqueEdges,
  geodesicSegments,
  geodesicTriangleVertices,
  dropSlotIndex,
  dropTargetIndex,
  reorderPreviewShift,
  movedOps,
  createCommitQueue,
  createChainValidator,
  createOpGate,
  opTopologyKey,
  meshOpFailure,
  requireMeshResult,
  MESH_OP_RESULT_NAMES,
  MORPH_SWEEP,
  unsweepableReason,
} =
  await import('../tools/solid_codegen.js');
const { formatFloatCpp } = await import('../tools/cpp_format.js');

/**
 * Builds an op whose params object records every key a code path reads, in read
 * order, seeded with the OP_DEFS defaults.
 */
function recordingOp(op) {
  const seen = new Set();
  const values = {};
  for (const [key, def] of Object.entries(OP_DEFS[op].params)) values[key] = def.val;
  const params = new Proxy(values, {
    get(target, key) {
      if (typeof key === 'string') seen.add(key);
      return target[key];
    },
  });
  return { spec: { op, params }, seen };
}

/**
 * A mesh wrapper whose every method records its call as {op, args} and returns
 * another such wrapper, so applyOp runs without WASM and the arguments it hands
 * the engine stay observable.
 * @param {Array<{op: string, args: Array<*>}>} [calls] - Sink for the recorded calls.
 */
function stubMesh(calls = []) {
  const mesh = new Proxy({}, {
    get: (target, op) => (...args) => {
      calls.push({ op, args });
      return mesh;
    },
  });
  return mesh;
}

/**
 * Verifies the live-preview dispatch reads exactly the params OP_DEFS declares
 * for every known op, in the same order — so an op that gains or reorders a
 * parameter cannot diverge silently between the table and the preview.
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
 * pastes: one argument per declared param, and a value the emitter drops
 * silently would leave the recipe unchanged. The generator's shared band check
 * reads every declared key after the emit, so a recording proxy cannot tell
 * an emitted param from an ignored one.
 */
test('generateFuncAndRecipe emits the OP_DEFS params of every known op', () => {
  assert.ok(KNOWN_OPS.size > 0);
  for (const op of KNOWN_OPS) {
    const defs = Object.entries(OP_DEFS[op].params);
    const defaults = Object.fromEntries(defs.map(([key, def]) => [key, def.val]));
    const base = generateFuncAndRecipe({ base: 'cube', ops: [{ op, params: defaults }] });
    assert.equal(emittedArguments(base.recipe, op).length, defs.length,
      `generateFuncAndRecipe emits the wrong argument count for "${op}"`);
    for (const [key, def] of defs) {
      const moved = generateFuncAndRecipe(
        { base: 'cube', ops: [{ op, params: { ...defaults, [key]: offDefault(def) } }] });
      assert.notDeepEqual(moved, base,
        `generateFuncAndRecipe ignores "${key}" of "${op}"`);
    }
  }
});

/**
 * Verifies the live preview hands each bound method exactly the argument values
 * the engine takes, in order — the hankin angle converted from the control's
 * degrees to the engine's radians, everything else passed through untouched. The
 * params a path reads say nothing about the values it forwards.
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
    ['dual', { op: 'dual', args: [] }],
    ['kis', { op: 'kis', args: [] }],
  ];
  for (const [spec, expected] of cases) {
    const calls = [];
    applyOp(stubMesh(calls), spec);
    assert.deepEqual(calls, [expected], `applyOp dispatched ${expected.op} wrongly`);
  }
  // The degree->radian conversion is a real change of value, not an identity.
  assert.notEqual(Math.fround(54 * D2R_F32), 54);
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

/** formatFloat re-exports cpp_format's formatter; its behavior is pinned in cpp_format.test.js. */
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
 * paths rather than one silently substituting a default the other cannot.
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

/** Verifies generateRecipeCpp emits the full FLASHMEM function source, prefixed by the V/F/I count comment, byte-for-byte. */
test('generateRecipeCpp wraps the recipe in a FLASHMEM function with V/F/I comment', () => {
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
    ' * @param a Output arena for the result and even pipeline stages.\n' +
    ' * @param b Scratch arena for odd pipeline stages.\n' +
    ' * @return The resulting star-pattern mesh.\n' +
    ' */\n' +
    'FLASHMEM static PolyMesh tetrahedron_kis(Arena &a, Arena &b) {\n' +
    '  return SolidBuilder(Archimedean::tetrahedron(a, b), a, b).kis().build();\n' +
    '}';
  assert.equal(cpp, expected);
});

/**
 * The paste goes into solid_generators.h verbatim, which is clang-formatted at
 * 80 columns, so a line the emitter did not wrap lands as a gate violation.
 */
test('generateRecipeCpp wraps a long function the way solid_generators.h carries it', () => {
  const cpp = generateRecipeCpp({
    base: 'truncatedIcosahedron',
    ops: [{ op: 'hankin', params: { angle: 58 } }, { op: 'chamfer', params: { t: 0.63 } }],
    vCount: 1200,
    fCount: 602,
    iCount: 3600,
  }, 'Archimedean');
  assert.equal(cpp,
    '/**\n'
    + ' * @brief Builds the truncatedIcosahedron_hk58_chamfer63 star pattern (V=1200,\n'
    + ' * F=602, I=3600).\n'
    + ' * @param a Output arena for the result and even pipeline stages.\n'
    + ' * @param b Scratch arena for odd pipeline stages.\n'
    + ' * @return The resulting star-pattern mesh.\n'
    + ' */\n'
    + 'FLASHMEM static PolyMesh truncatedIcosahedron_hk58_chamfer63(Arena &a,\n'
    + '                                                             Arena &b) {\n'
    + '  return SolidBuilder(Archimedean::truncatedIcosahedron(a, b), a, b)\n'
    + '      .hankin(58.0f * D2R)\n'
    + '      .chamfer(0.63f)\n'
    + '      .build();\n'
    + '}');
});

/**
 * A name too long to leave room for the first parameter moves the return type
 * to its own line instead, the shape solid_generators.h already carries.
 */
test('generateRecipeCpp breaks after the return type when the name fills the line', () => {
  const cpp = generateRecipeCpp({
    base: 'truncatedIcosidodecahedron',
    ops: [{ op: 'truncate', params: { t: 0.5 } }, 'ambo', 'dual'],
  }, 'Archimedean');
  assert.match(cpp, /\nFLASHMEM static PolyMesh\ntruncatedIcosidodecahedron_truncate50_ambo_dual\(Arena &a, Arena &b\) \{\n/);
});

/** Verifies no emitted line exceeds the column limit solid_generators.h is formatted at. */
test('generateRecipeCpp never emits a line past the column limit', () => {
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
  // The widest chain overflows on the funcName alone, so the exemption above is
  // measured against real output rather than left vacuous.
  assert.ok(overflowed > 0, 'no funcName reaches the limit, so nothing tested it');
});

/** Verifies generateRecipeCpp falls back to zero vertex/face/internal counts when the item omits them. */
test('generateRecipeCpp defaults missing V/F/I counts to 0', () => {
  const cpp = generateRecipeCpp({ base: 'cube', ops: ['dual'] }, 'Archimedean');
  assert.ok(cpp.includes('star pattern (V=0, F=0, I=0).'));
});

/**
 * The counts ride in from localStorage, which a user can hand-edit, and the
 * output is pasted into solid_generators.h; a count carrying a newline or a
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
  assert.equal(recipe, 'SolidBuilder(Catalan::rhombicTriacontahedron(a, b), a, b).ambo().build()');
  assert.ok(generateRecipeCpp(item, 'Catalan')
    .includes('SolidBuilder(Catalan::rhombicTriacontahedron(a, b), a, b)'));
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
  const chains = [
    ['dual'],
    ['kis', 'ambo'],
    [{ op: 'truncate', params: { t: 0.33 } }],
    [{ op: 'hankin', params: { angle: 54 } }, { op: 'relax', params: { iter: 100 } }],
  ];
  for (const ops of chains) {
    for (const base of ['cube', 'truncatedIcosahedron']) {
      const { funcName } = generateFuncAndRecipe({ base, ops });
      const body = generateRecipeCpp({ base, ops }, 'Archimedean').split('\n')[2];
      assert.ok(!body.includes(`${funcName}(`),
        `body of ${funcName} calls itself: ${body}`);
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
  for (const angle of [0, 17, 54, 90]) assert.equal(snapToStep(angle, def), angle);
});

/**
 * Verifies the hankin angle the tool seeds from the mesh is single-valued: the
 * value in state, the range input, the number box, the generated funcName suffix,
 * the emitted recipe literal and the angle the live preview hands the engine all
 * describe the same angle.
 */
test('a seeded hankin angle agrees across the control, the funcName and the recipe', () => {
  // A face whose interior angle at its second vertex is arccos(-1/3) = 109.4712
  // degrees, so the tool's half-internal-angle seed is 54.7356 — the unsnapped
  // value that showed one angle in state, another on the thumb, and a third in
  // the name.
  const s = Math.sqrt(8) / 3;
  const mesh = {
    vertices: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: -1 / 3, y: s, z: 0 }],
    faces: [[0, 1, 2]],
  };
  const def = OP_DEFS.hankin.params.angle;
  const derived = (computeInternalAngle(mesh) / 2) * (180 / Math.PI);
  assert.ok(Math.abs(derived - 54.7356) < 1e-3);
  assert.notEqual(derived, Math.round(derived)); // the seed is off the control's grid

  const angle = snapToStep(derived, def);
  assert.equal(angle, 55);

  // The range input: exactly on the step grid, so the thumb reads the state value.
  assert.equal((angle - def.min) % def.step, 0);
  assert.ok(angle >= def.min && angle <= def.max);
  // The number box, which the page renders with toFixed(2).
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
 * away at 54 and 73 degrees, both of which solids.h ships.
 */
test('the preview converts a hankin angle in the float precision the paste uses', () => {
  for (const angle of [54, 73]) {
    const calls = [];
    applyOp(stubMesh(calls), { op: 'hankin', params: { angle } });
    assert.equal(calls[0].args[0], Math.fround(angle * D2R_F32));
    assert.notEqual(calls[0].args[0], Math.fround(angle * (Math.PI / 180)));
  }
});

test('isConvexFace accepts a convex face', () => {
  const vertices = [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 2, y: 2, z: 0 },
    { x: 0, y: 2, z: 0 },
  ];
  assert.equal(isConvexFace(vertices, [0, 1, 2, 3]), true);
});

test('isConvexFace rejects a concave star face', () => {
  const vertices = Array.from({ length: 10 }, (_, i) => {
    const angle = i * Math.PI / 5;
    const radius = i % 2 === 0 ? 2 : 0.8;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle), z: 0 };
  });
  assert.equal(isConvexFace(vertices, vertices.map((_, i) => i)), false);
});

const SQUARE = [
  { x: 0, y: 0, z: 0 },
  { x: 2, y: 0, z: 0 },
  { x: 2, y: 2, z: 0 },
  { x: 0, y: 2, z: 0 },
];

/** Collects fanTriangulateFace's emitted corners as flat x/y/z triples. */
const fanCorners = (vertices, face, forceCentroid) => {
  const out = [];
  fanTriangulateFace(vertices, face, (a, b, c) => {
    out.push([a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z]);
  }, forceCentroid);
  return out;
};

test('fanTriangulateFace fans a convex face from its first corner', () => {
  assert.deepEqual(fanCorners(SQUARE, [0, 1, 2, 3]), [
    [0, 0, 0], [2, 0, 0], [2, 2, 0],
    [0, 0, 0], [2, 2, 0], [0, 2, 0],
  ]);
});

test('fanTriangulateFace fans a non-convex face from its centroid', () => {
  const star = Array.from({ length: 10 }, (_, i) => {
    const angle = i * Math.PI / 5;
    const radius = i % 2 === 0 ? 2 : 0.8;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle), z: 0 };
  });
  const face = star.map((_, i) => i);
  const corners = fanCorners(star, face);
  // One triangle per edge, apex first, and no apex is a face vertex.
  assert.equal(corners.length, face.length * 3);
  for (let i = 0; i < corners.length; i += 3) {
    assert.deepEqual(corners[i], corners[0]);
    assert.deepEqual(corners[i + 1], [star[i / 3].x, star[i / 3].y, star[i / 3].z]);
    assert.deepEqual(corners[i + 2],
      [star[(i / 3 + 1) % face.length].x, star[(i / 3 + 1) % face.length].y, 0]);
  }
  assert.ok(Math.hypot(corners[0][0], corners[0][1]) < 1e-9);
});

test('fanTriangulateFace forceCentroid takes the centroid fan on a convex face', () => {
  const corners = fanCorners(SQUARE, [0, 1, 2, 3], true);
  assert.equal(corners.length, 12);
  assert.deepEqual(corners[0], [1, 1, 0]);
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
 * A stale or hand-edited stored card is refused by savedChainShapeError, but its
 * "copy C++" button reaches generateFuncAndRecipe directly, and a param past its
 * band pastes a literal the engine's always-on operator asserts halt on.
 */
test('generateFuncAndRecipe rejects every param savedChainShapeError calls out of range', () => {
  const cases = [
    [{ op: 'chamfer', params: { t: 1 } }, 'chamfer param "t"'],
    [{ op: 'truncate', params: { t: 0.75 } }, 'truncate param "t"'],
    [{ op: 'expand', params: { t: 1 } }, 'expand param "t"'],
    [{ op: 'bevel', params: { t: 0.9 } }, 'bevel param "t"'],
    [{ op: 'hankin', params: { angle: 120 } }, 'hankin param "angle"'],
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

/** Verifies uniqueEdges returns each undirected edge once, in first-seen order. */
test('uniqueEdges deduplicates shared edges across faces', () => {
  // Two triangles sharing edge 1-2: 5 distinct undirected edges.
  const edges = uniqueEdges([[0, 1, 2], [2, 1, 3]], 4);
  assert.deepEqual(edges, [[0, 1], [1, 2], [0, 2], [1, 3], [2, 3]]);
});

/** Verifies the lo*vertexCount+hi edge key never aliases two distinct edges. */
test('uniqueEdges keys stay unique at the vertex-count radix', () => {
  // (lo,hi) = (0,5) and (1,0) would collide on a radix below 6.
  const edges = uniqueEdges([[0, 5], [1, 0]], 6);
  assert.deepEqual(edges, [[0, 5], [0, 1]]);
});

/** Verifies a degenerate 2-gon face yields one edge rather than a self-pair. */
test('uniqueEdges collapses the two half-edges of a 2-gon', () => {
  assert.deepEqual(uniqueEdges([[0, 1]], 2), [[0, 1]]);
});

/** Verifies the geodesic level rounds the arc up to whole ~3-degree segments when the budget is slack. */
test('geodesicSegments targets three degrees of arc per segment', () => {
  const seg = Math.PI / 60;
  assert.equal(geodesicSegments(3.2 * seg, 4), 4);
  assert.equal(geodesicSegments(4.5 * seg, 4), 5);
});

/** Verifies the total-triangle budget caps the level on dense meshes. */
test('geodesicSegments caps dense meshes on the triangle budget', () => {
  // sqrt(400000 / 40000) = 3.16 -> 3, below the arc target for a 90-degree face.
  assert.equal(geodesicSegments(Math.PI / 2, 40000), 3);
  // 400000 triangles leave no subdivision headroom at all.
  assert.equal(geodesicSegments(Math.PI / 2, 400000), 1);
});

/** Verifies the level stays within [1, 24] for degenerate and huge arcs. */
test('geodesicSegments clamps to the [1, 24] range', () => {
  assert.equal(geodesicSegments(0, 1), 1);
  assert.equal(geodesicSegments(Math.PI, 1), 24);
});

/** Corners of a spherical octant, the fan triangle the tessellation tests subdivide. */
const OCTANT = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];

/** Reads the flat tessellation output back as {x, y, z} points. */
function points(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 3) out.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2] });
  return out;
}

/** Verifies n = 1 emits the untouched triangle, so an unsubdivided mesh is unchanged. */
test('geodesicTriangleVertices at n=1 emits the single input triangle', () => {
  const flat = geodesicTriangleVertices(...OCTANT, 1);
  assert.equal(flat.length, 9);
  assert.deepEqual(points(flat), OCTANT);
});

/** Verifies the emitted triangle count is n squared, the watertight subdivision of one fan triangle. */
test('geodesicTriangleVertices emits n^2 triangles', () => {
  for (const n of [1, 2, 3, 7]) {
    assert.equal(geodesicTriangleVertices(...OCTANT, n).length, 9 * n * n);
  }
});

/** Verifies every emitted vertex is projected onto the unit sphere, which is what curves the face. */
test('geodesicTriangleVertices projects every vertex onto the unit sphere', () => {
  for (const p of points(geodesicTriangleVertices(...OCTANT, 4))) {
    assert.ok(Math.abs(Math.hypot(p.x, p.y, p.z) - 1) < 1e-12);
  }
});

/**
 * Verifies the subdivision is watertight: the points along a triangle side are
 * shared by the sub-triangles either side of them, so no crack opens. Each
 * interior grid point must therefore appear in more than one emitted triangle,
 * and the three corners must each appear exactly once.
 */
test('geodesicTriangleVertices reuses grid points across sub-triangles', () => {
  const counts = new Map();
  for (const p of points(geodesicTriangleVertices(...OCTANT, 3))) {
    const key = `${p.x},${p.y},${p.z}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // A grid of n=3 has 10 distinct points; the 3 corners belong to one triangle each.
  assert.equal(counts.size, 10);
  const once = [...counts.values()].filter(c => c === 1);
  assert.equal(once.length, 3);
});

/** Verifies a degenerate (zero-length) mix keeps its coordinates instead of dividing by zero. */
test('geodesicTriangleVertices survives a triangle collapsed on the origin', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const flat = geodesicTriangleVertices(origin, origin, origin, 2);
  assert.ok(flat.every(Number.isFinite));
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

/** Verifies a slot below the dragged op maps straight through, since removal shifts nothing before it. */
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

/** Verifies queued commits run one at a time, in order, each seeing its predecessor's writes. */
test('createCommitQueue serializes commits in enqueue order', async () => {
  const queueCommit = createCommitQueue();
  const log = [];
  let inFlight = 0;
  const commit = (tag) => async () => {
    assert.equal(inFlight, 0, `${tag} overlapped a pending commit`);
    inFlight++;
    await Promise.resolve();
    log.push(tag);
    inFlight--;
  };
  queueCommit(commit('a'));
  queueCommit(commit('b'));
  await queueCommit(commit('c'));
  assert.deepEqual(log, ['a', 'b', 'c']);
});

/** Verifies a rejected commit is reported and leaves the queue usable. */
test('createCommitQueue survives a rejected commit', async () => {
  const errors = [];
  const queueCommit = createCommitQueue((e) => errors.push(e));
  const boom = new Error('boom');
  await queueCommit(async () => { throw boom; });
  const log = [];
  await queueCommit(async () => { log.push('after'); });
  assert.deepEqual(errors, [boom]);
  assert.deepEqual(log, ['after']);
});

/**
 * Builds a fake WASM module whose meshes track their own deletion, with a hook
 * to make a chosen op throw and a set of call tokens ('base:<name>',
 * 'classifyFaces') the bridge answers with a null plus the given reason.
 */
function fakeModule(onOp = () => { }, { rejects = new Set(), reason = 'ARENA_EXHAUSTED' } = {}) {
  const state = { live: 0, cleared: 0 };
  const MeshOpResult = Object.fromEntries(MESH_OP_RESULT_NAMES.map((name) => [name, Symbol(name)]));
  let lastResult = MeshOpResult.OK;
  const rejected = (token) => {
    if (!rejects.has(token)) return false;
    lastResult = MeshOpResult[reason];
    return true;
  };
  const makeMesh = () => {
    state.live++;
    const mesh = {
      deleted: false,
      delete() { this.deleted = true; state.live--; },
      classifyFaces() { onOp('classifyFaces'); return rejected('classifyFaces') ? null : new Int32Array(1); },
    };
    for (const op of KNOWN_OPS) {
      mesh[op] = () => { onOp(op); return rejected(op) ? null : makeMesh(); };
    }
    return mesh;
  };
  const Mod = {
    MeshOpResult,
    MeshOps: {
      fromSolidName(name) { onOp(`base:${name}`); return rejected(`base:${name}`) ? null : makeMesh(); },
      clearToolingMemory() { state.cleared++; },
      getLastResult() { return lastResult; },
    },
  };
  return { Mod, state };
}

/** Verifies the recorded reason is read back by identity and names its remedy. */
test('meshOpFailure routes each recorded reason', () => {
  const { Mod } = fakeModule(() => { }, { rejects: new Set(['base:cube']), reason: 'ARENA_EXHAUSTED' });
  assert.equal(Mod.MeshOps.fromSolidName('cube'), null);
  const exhausted = meshOpFailure(Mod, 'Base solid "cube"');
  assert.equal(exhausted.reason, 'ARENA_EXHAUSTED');
  assert.equal(exhausted.flush, true, 'only ARENA_EXHAUSTED is cleared by flushing the arenas');
  assert.match(exhausted.message, /^Base solid "cube" failed: /);

  const unknown = fakeModule(() => { }, { rejects: new Set(['base:nope']), reason: 'UNKNOWN_NAME' });
  assert.equal(unknown.Mod.MeshOps.fromSolidName('nope'), null);
  const named = meshOpFailure(unknown.Mod, 'Base solid "nope"');
  assert.equal(named.reason, 'UNKNOWN_NAME');
  assert.equal(named.flush, false);
  assert.notEqual(named.message, exhausted.message, 'each reason must carry its own remedy');
});

/** Verifies a module that binds neither the enum nor getLastResult still yields a message. */
test('meshOpFailure reports UNKNOWN when the module records no reason', () => {
  const failure = meshOpFailure({ MeshOps: {} }, 'Face classification');
  assert.equal(failure.reason, 'UNKNOWN');
  assert.equal(failure.flush, false);
  assert.match(failure.message, /^Face classification failed: /);
});

/** Verifies the null-result handler reports and flushes by reason. */
test('requireMeshResult surfaces the reason and applies its remedy', () => {
  const { Mod, state } = fakeModule(() => { }, { rejects: new Set(['base:cube']) });
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
    () => { }, { rejects: new Set(['base:nope']), reason: 'UNKNOWN_NAME' });
  const shown = [];
  assert.equal(requireMeshResult(Mod.MeshOps.fromSolidName('nope'), 'Base solid "nope"',
    { Mod, meshOps: Mod.MeshOps, onError: (m) => shown.push(m) }), null);
  assert.equal(state.cleared, 0, 'flushing an intact arena would strand live wrappers');
  assert.equal(shown.length, 1);
});

test('solids validator resolves the module factory after async initialization', async () => {
  const match = SOLIDS_PAGE.match(/\bcreateChainValidator\((.+)\);/);
  assert.ok(match);
  const instantiate = Function('createChainValidator', 'Mod', `
    let createHolosphereModule = null;
    const validator = createChainValidator(${match[1]});
    createHolosphereModule = async () => Mod;
    return validator.acquire();
  `);
  const { Mod } = fakeModule();
  assert.equal(await instantiate(createChainValidator, Mod), Mod);
});

/**
 * Verifies every page gate binds the verdict and reads its fields. The verdict
 * is an object and therefore always truthy, so a gate left testing the call's
 * result directly would pass every chain.
 */
test('the solids page binds every chainIsValid verdict instead of testing it', () => {
  const calls = [...SOLIDS_PAGE.matchAll(/\bchainIsValid\(/g)].length;
  assert.ok(calls >= 7, `expected the page's gates to call chainIsValid, found ${calls}`);
  assert.equal([...SOLIDS_PAGE.matchAll(/const \w+ = await chainIsValid\(/g)].length, calls,
    'every call must bind its verdict; an unbound one is truthy and gates nothing');
  assert.doesNotMatch(SOLIDS_PAGE, /!\s*\(?await chainIsValid\(/,
    'a negated call tests the verdict object, not its ok field');
});

/** Verifies a chain that replays cleanly is accepted and leaves no live meshes. */
test('createChainValidator accepts a chain that replays cleanly', async () => {
  const { Mod, state } = fakeModule();
  const validator = createChainValidator(async () => Mod);
  assert.equal((await validator.chainIsValid('cube', ['dual', { op: 'truncate', params: { t: 0.3 } }])).ok, true);
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

/** Verifies a plain (non-trap) failure rejects the chain and still frees the mesh. */
test('createChainValidator rejects a chain that throws, freeing its mesh', async () => {
  const { Mod, state } = fakeModule((op) => {
    if (op === 'kis') throw new Error('op refused');
  });
  const validator = createChainValidator(async () => Mod);
  const verdict = await validator.chainIsValid('cube', ['kis']);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.message, 'Op "kis" failed: op refused',
    'a throw the bridge recorded no reason for must still name the op and what it said');
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

/** Verifies a soft-rejected base solid rejects the chain and reclaims the arena. */
test('createChainValidator rejects a chain whose base solid comes back null', async () => {
  const { Mod, state } = fakeModule(() => { }, { rejects: new Set(['base:cube']) });
  const validator = createChainValidator(async () => Mod);
  assert.equal((await validator.chainIsValid('cube', ['dual'])).ok, false);
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

/** Verifies the classify pass the tool always runs is proven, not just called. */
test('createChainValidator rejects a chain whose classify pass comes back null', async () => {
  const { Mod, state } = fakeModule(() => { }, { rejects: new Set(['classifyFaces']) });
  const validator = createChainValidator(async () => Mod);
  assert.equal((await validator.chainIsValid('cube', ['dual'])).ok, false);
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

/**
 * Verifies the reason the module recorded reaches the caller, so an arena
 * exhaustion (cleared by the flush the rejection already ran) does not read as
 * the hard element ceiling.
 */
test('createChainValidator carries each rejection reason out to the caller', async () => {
  const arenaMod = fakeModule(
    () => { }, { rejects: new Set(['classifyFaces']), reason: 'ARENA_EXHAUSTED' }).Mod;
  const arena = await createChainValidator(async () => arenaMod).chainIsValid('cube', ['dual']);
  assert.equal(arena.ok, false);
  assert.match(arena.message, /^Face classification failed: /);
  assert.match(arena.message, /flushed — try again/, 'the arena remedy must survive the gate');

  const overflowMod = fakeModule(
    () => { }, { rejects: new Set(['base:cube']), reason: 'FACE_DEGREE_OVERFLOW' }).Mod;
  const overflow = await createChainValidator(async () => overflowMod).chainIsValid('cube', ['dual']);
  assert.equal(overflow.ok, false);
  assert.match(overflow.message, /^Base solid "cube" failed: /);
  assert.notEqual(overflow.message, arena.message, 'each reason must arrive with its own remedy');
});

/** Verifies an accepted chain carries no message to show. */
test('createChainValidator reports no reason for a chain it accepts', async () => {
  const { Mod } = fakeModule();
  const verdict = await createChainValidator(async () => Mod).chainIsValid('cube', ['dual']);
  assert.deepEqual(verdict, { ok: true, message: '' });
});

/** Verifies an engine trap wedges the instance, so the next chain runs on a fresh one. */
test('createChainValidator respawns after a WebAssembly trap', async () => {
  let spawns = 0;
  const modules = [
    fakeModule(() => { throw new WebAssembly.RuntimeError('trap'); }).Mod,
    fakeModule().Mod,
  ];
  const validator = createChainValidator(async () => modules[spawns++]);
  assert.equal((await validator.chainIsValid('cube', ['kis'])).ok, false);
  assert.equal(spawns, 1);
  assert.equal((await validator.chainIsValid('cube', ['dual'])).ok, true);
  assert.equal(spawns, 2);
});

/** Verifies a healthy instance is reused across chains rather than respawned. */
test('createChainValidator reuses a healthy instance', async () => {
  let spawns = 0;
  const { Mod } = fakeModule();
  const validator = createChainValidator(async () => { spawns++; return Mod; });
  await validator.chainIsValid('cube', ['dual']);
  await validator.chainIsValid('cube', ['ambo']);
  assert.equal(spawns, 1);
});

/** Verifies a module that fails to spawn degrades to permissive rather than blocking the tool. */
test('createChainValidator accepts everything when the module cannot spawn', async () => {
  const validator = createChainValidator(async () => { throw new Error('no wasm'); });
  assert.equal((await validator.chainIsValid('cube', ['kis'])).ok, true);
  assert.equal(await validator.withValidator((Mod) => Mod), null);
});

/**
 * Verifies every chain the tool can build passes the shape check, so restoring a
 * legitimately saved solid is never refused. The ops are assembled the way addOp
 * assembles them — one entry per op, params seeded from the OP_DEFS defaults.
 */
test('savedChainShapeError accepts the chains the tool itself saves', () => {
  const ops = [...KNOWN_OPS].map((op) => {
    const params = {};
    for (const [key, def] of Object.entries(OP_DEFS[op].params)) params[key] = def.val;
    return { op, params };
  });
  assert.equal(savedChainShapeError('cube', ops), null);
  for (const o of ops) {
    assert.equal(savedChainShapeError('truncatedIcosahedron', [o]), null,
      `a saved "${o.op}" must stay restorable`);
  }
  assert.equal(savedChainShapeError('cube', []), null, 'a bare seed is a valid save');
});

/**
 * Verifies each way a stored entry can be unrestorable is named rather than
 * passed through. The validator resolves true when its module cannot spawn, so
 * anything this misses reaches renderOps and throws into the commit queue.
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

/** Verifies a transient spawn failure is retried rather than disabling validation for good. */
test('createChainValidator retries after a failed spawn', async () => {
  let spawns = 0;
  const { Mod } = fakeModule((op) => {
    if (op === 'kis') throw new Error('op refused');
  });
  const validator = createChainValidator(async () => {
    if (spawns++ === 0) throw new Error('no wasm');
    return Mod;
  });
  assert.equal((await validator.chainIsValid('cube', ['kis'])).ok, true);
  assert.equal((await validator.chainIsValid('cube', ['kis'])).ok, false);
  assert.equal(spawns, 2);
});

/** Verifies validator tasks never interleave, so one task's mesh survives another's cleanup. */
test('createChainValidator serializes overlapping tasks', async () => {
  const { Mod } = fakeModule();
  const validator = createChainValidator(async () => Mod);
  const log = [];
  const task = (tag) => async () => {
    log.push(`${tag}:in`);
    await Promise.resolve();
    log.push(`${tag}:out`);
  };
  const a = validator.withValidator(task('a'));
  const b = validator.withValidator(task('b'));
  await Promise.all([a, b]);
  assert.deepEqual(log, ['a:in', 'a:out', 'b:in', 'b:out']);
});

// The add-op buttons the solids page offers, as refreshOpGating reads them.
const CANDIDATES = ['kis', 'ambo', 'dual'];

/** Verifies a clean sweep blocks nothing and reports itself complete. */
test('createOpGate clears every candidate that replays', async () => {
  const { Mod, state } = fakeModule();
  const gate = createOpGate(createChainValidator(async () => Mod));

  const probe = await gate.refresh('cube', [{ op: 'kis', params: {} }], CANDIDATES);
  assert.deepEqual([...probe.blocked], []);
  assert.equal(probe.complete, true);
  assert.equal(probe.abandoned, false);
  assert.equal(state.live, 0, 'the sweep must free every mesh it built');
});

/** Verifies a candidate whose classify pass comes back null is blocked. */
test('createOpGate blocks a candidate the bridge rejects', async () => {
  const { Mod } = fakeModule(() => { }, { rejects: new Set(['classifyFaces']) });
  const gate = createOpGate(createChainValidator(async () => Mod));

  const probe = await gate.refresh('cube', [], CANDIDATES);
  assert.deepEqual([...probe.blocked].sort(), [...CANDIDATES].sort());
  assert.equal(probe.complete, true);
});

/** Verifies a trapping candidate is blocked and the sweep resumes on a fresh instance. */
test('createOpGate respawns mid-sweep after a candidate traps', async () => {
  let spawns = 0;
  const modules = [
    fakeModule((op) => { if (op === 'ambo') throw new WebAssembly.RuntimeError('trap'); }).Mod,
    fakeModule().Mod,
  ];
  const gate = createOpGate(createChainValidator(async () => modules[spawns++]));

  const probe = await gate.refresh('cube', [], CANDIDATES);
  assert.deepEqual([...probe.blocked], ['ambo']);
  assert.equal(probe.complete, true);
  assert.equal(spawns, 2);
});

/**
 * Verifies a candidate that fills the tooling arena does not condemn the
 * candidates behind it: the arena is reclaimed, the chain rebuilt, and the
 * candidate judged on an arena its predecessors did not fill.
 */
test('createOpGate reclaims the arena and re-judges the candidate that filled it', async () => {
  const rejects = new Set(['kis']);
  let seen = 0;
  // The arena is full for the first kis and reclaimed for the retry.
  const { Mod, state } = fakeModule((op) => {
    if (op === 'kis' && seen++ >= 1) rejects.delete('kis');
  }, { rejects });
  const gate = createOpGate(createChainValidator(async () => Mod));

  const probe = await gate.refresh('cube', [], CANDIDATES);
  assert.deepEqual([...probe.blocked], [], 'an exhausted arena is not an illegal op');
  assert.equal(probe.complete, true);
  assert.ok(state.cleared > 0, 'the sweep must flush the arena it filled');
  assert.equal(state.live, 0, 'the rebuild must free the chain it replaced');
});

/** Verifies a candidate that exhausts a reclaimed arena too is blocked, and only it. */
test('createOpGate blocks a candidate that refills a reclaimed arena', async () => {
  const { Mod } = fakeModule(() => { }, { rejects: new Set(['kis']) });
  const gate = createOpGate(createChainValidator(async () => Mod));

  const probe = await gate.refresh('cube', [], CANDIDATES);
  assert.deepEqual([...probe.blocked], ['kis']);
  assert.equal(probe.complete, true);
});

/** Verifies a chain whose topology is unchanged is not re-swept. */
test('createOpGate skips a pass whose base and op names repeat', async () => {
  const probes = [];
  const { Mod } = fakeModule((op) => probes.push(op));
  const gate = createOpGate(createChainValidator(async () => Mod));
  const ops = [{ op: 'truncate', params: { t: 0.33 } }];

  assert.notEqual(await gate.refresh('cube', ops, CANDIDATES), null);
  const swept = probes.length;
  // Only a param moved: the topology, and so the gating, cannot have changed.
  assert.equal(await gate.refresh('cube', [{ op: 'truncate', params: { t: 0.4 } }],
    CANDIDATES), null);
  assert.equal(probes.length, swept);
  assert.notEqual(await gate.refresh('cube', [{ op: 'kis', params: {} }], CANDIDATES), null);
  assert.ok(probes.length > swept);
});

/**
 * Verifies the pass-skipping signature separates the two lowerings truncate and
 * bevel have. Both slide t up to 0.5, where truncate short-circuits to ambo, so
 * the census on either side of that edge differs by roughly a doubling and a
 * verdict carried across it would enable ops the engine then refuses.
 */
test('createOpGate re-sweeps when a param crosses the ambo lowering', async () => {
  for (const op of ['truncate', 'bevel']) {
    const probes = [];
    const { Mod } = fakeModule((name) => probes.push(name));
    const gate = createOpGate(createChainValidator(async () => Mod));

    assert.notEqual(await gate.refresh('cube', [{ op, params: { t: 0.5 } }], CANDIDATES), null,
      `${op} at 0.5 must sweep`);
    const swept = probes.length;
    assert.notEqual(await gate.refresh('cube', [{ op, params: { t: 0.49 } }], CANDIDATES), null,
      `${op} leaving 0.5 must re-sweep`);
    assert.ok(probes.length > swept, `${op} kept a verdict from the other lowering`);

    const again = probes.length;
    assert.equal(await gate.refresh('cube', [{ op, params: { t: 0.48 } }], CANDIDATES), null,
      `${op} moving within one lowering must stay skipped`);
    assert.equal(probes.length, again);
  }
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

/** Verifies a pass the chain outran reports nothing rather than gating on stale probes. */
test('createOpGate discards a pass the chain changed under', async () => {
  const { Mod } = fakeModule();
  const gate = createOpGate(createChainValidator(async () => Mod));

  const first = gate.refresh('cube', [], CANDIDATES);
  const second = gate.refresh('octahedron', [], CANDIDATES);
  assert.equal(await first, null);
  assert.notEqual(await second, null);
});

/**
 * Verifies probing gives up after the retry budget rather than re-spawning a
 * module that will never start on every recompute, and says so exactly once.
 */
test('createOpGate abandons probing after its retry budget', async () => {
  let spawns = 0;
  const gate = createOpGate(
    createChainValidator(async () => { spawns++; throw new Error('no wasm'); }), 3);

  for (let i = 0; i < 2; i++) {
    const probe = await gate.refresh('cube', [], CANDIDATES);
    assert.equal(probe.complete, false);
    assert.equal(probe.abandoned, false, 'the budget must not be spent early');
  }
  assert.equal((await gate.refresh('cube', [], CANDIDATES)).abandoned, true);
  const after = spawns;
  assert.equal(await gate.refresh('cube', [], CANDIDATES), null);
  assert.equal(spawns, after, 'an abandoned gate must stop spawning');
});

/** Verifies an incomplete pass does not bank its signature, so the next one re-sweeps. */
test('createOpGate re-sweeps a chain whose last pass was incomplete', async () => {
  let spawns = 0;
  const { Mod } = fakeModule();
  const gate = createOpGate(createChainValidator(async () => {
    spawns++;
    if (spawns === 1) throw new Error('no wasm');
    return Mod;
  }));

  assert.equal((await gate.refresh('cube', [], CANDIDATES)).complete, false);
  assert.equal((await gate.refresh('cube', [], CANDIDATES)).complete, true);
});

/** Verifies a base the registry does not hold leaves the sweep incomplete, not blocking. */
test('createOpGate reports an unbuildable base as an incomplete pass', async () => {
  const { Mod } = fakeModule(() => { },
    { rejects: new Set(['base:nope']), reason: 'UNKNOWN_NAME' });
  const gate = createOpGate(createChainValidator(async () => Mod));

  const probe = await gate.refresh('nope', [], CANDIDATES);
  assert.deepEqual([...probe.blocked], []);
  assert.equal(probe.complete, false);
});

test('MORPH_SWEEP covers the primitive ops and no composite', () => {
  for (const op of Object.keys(MORPH_SWEEP)) {
    assert.ok(op in OP_DEFS, `MORPH_SWEEP names ${op}, which the tool cannot author`);
  }
  for (const op of ['bevel', 'gyro', 'meta', 'needle', 'zip']) {
    assert.equal(op in MORPH_SWEEP, false,
      `${op} lowers to primitives before the engine's morph check reads it`);
  }
});

test('unsweepableReason names the ops the engine morph path declines', () => {
  assert.equal(unsweepableReason({ op: 'kis', params: {} }), null);
  assert.equal(unsweepableReason('ambo'), null);
  assert.equal(unsweepableReason({ op: 'bevel', params: { t: 0.5 } }), null,
    'a composite lowers to primitives the engine sweeps');
  assert.equal(unsweepableReason({ op: 'notanop', params: {} }), null,
    'an op off the table is a different defect, reported by savedChainShapeError');

  assert.match(unsweepableReason({ op: 'expand', params: { t: 0.5 } }), /^expand has no morph leg/,
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

test('a slider reaching past its swept band is reported rather than silent', () => {
  const overreaching = [];
  for (const [op, band] of Object.entries(MORPH_SWEEP)) {
    if (!band) continue;
    for (const [key, { min, max }] of Object.entries(band)) {
      const def = OP_DEFS[op].params[key];
      assert.ok(def, `MORPH_SWEEP bounds ${op}.${key}, which OP_DEFS does not declare`);
      if (def.min >= min && def.max <= max) {
        assert.equal(unsweepableReason({ op, params: { [key]: def.min } }), null,
          `${op} keeps ${key} inside its band, so no slider position is reported`);
        assert.equal(unsweepableReason({ op, params: { [key]: def.max } }), null,
          `${op} keeps ${key} inside its band, so no slider position is reported`);
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
  // The rows the marker case exists for; pinned so narrowing a slider retires
  // the row rather than leaving this sweep with nothing to assert.
  assert.deepEqual(overreaching, ['chamfer.t']);
});
