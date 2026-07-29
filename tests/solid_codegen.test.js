// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  OP_DEFS,
  KNOWN_OPS,
  PARAMETERIZED_OPS,
  applyOp,
  formatFloat,
  formatSolidName,
  pctSuffix,
  generateFuncAndRecipe,
  generateRecipeCpp,
  computeInternalAngle,
  isConvexFace,
  uniqueEdges,
  geodesicSegments,
  movedOps,
  createCommitQueue,
  createChainValidator,
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

/** A mesh wrapper whose every method returns another such wrapper, so applyOp runs without WASM. */
function stubMesh() {
  const mesh = new Proxy({}, { get: () => () => mesh });
  return mesh;
}

/**
 * Verifies the live-preview dispatch and the C++ generator read exactly the
 * params OP_DEFS declares for every known op, in the same order — so an op that
 * gains or reorders a parameter cannot diverge silently between what the tool
 * previews and what it pastes.
 */
test('applyOp and generateFuncAndRecipe consume the OP_DEFS params of every known op', () => {
  assert.ok(KNOWN_OPS.size > 0);
  for (const op of KNOWN_OPS) {
    const expected = Object.keys(OP_DEFS[op].params);

    const generated = recordingOp(op);
    generateFuncAndRecipe({ base: 'cube', ops: [generated.spec] });
    assert.deepEqual([...generated.seen], expected,
      `generateFuncAndRecipe reads different params than OP_DEFS declares for "${op}"`);

    const previewed = recordingOp(op);
    applyOp(stubMesh(), previewed.spec);
    assert.deepEqual([...previewed.seen], expected,
      `applyOp reads different params than OP_DEFS declares for "${op}"`);
  }
});

/** Verifies applyOp rejects an op the mesh wrapper binds no method for. */
test('applyOp throws on an op the module does not bind', () => {
  assert.throws(() => applyOp({}, { op: 'frobnicate', params: {} }),
    /unknown op "frobnicate"/);
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

/** Verifies an explicit relax iter:0 is preserved (not coerced to the default 8). */
test('generateFuncAndRecipe preserves an explicit relax iter:0', () => {
  const item = { base: 'cube', ops: [{ op: 'relax', params: { iter: 0 } }] };
  const { funcName, recipe } = generateFuncAndRecipe(item);
  assert.equal(funcName, 'cube_relax0');
  assert.equal(recipe, 'SolidBuilder(cube(a, b), a, b).relax(0).build()');
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

  for (const op of KNOWN_OPS) {
    if (PARAMETERIZED_OPS.has(op)) continue;
    generateFuncAndRecipe({ base: 'cube', ops: [op] });
    applyOp(stubMesh(), op);
  }
});

/** Verifies an op declaring params rejects an empty params object on both paths. */
test('a parameterized op with empty params is rejected, not defaulted', () => {
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'snub', params: {} }] }),
    /snub param "t" must be a finite number/);
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'relax', params: {} }] }),
    /relax param "iter" must be a non-negative integer/);
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
    '// V=8, F=12, I=4\n' +
    'FLASHMEM static PolyMesh tetrahedron_kis(Arena &a, Arena &b) {\n' +
    '  return SolidBuilder(Archimedean::tetrahedron(a, b), a, b).kis().build();\n' +
    '}';
  assert.equal(cpp, expected);
});

/** Verifies generateRecipeCpp falls back to zero vertex/face/internal counts when the item omits them. */
test('generateRecipeCpp defaults missing V/F/I counts to 0', () => {
  const cpp = generateRecipeCpp({ base: 'cube', ops: ['dual'] }, 'Archimedean');
  assert.ok(cpp.startsWith('// V=0, F=0, I=0\n'));
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

/** Verifies generateFuncAndRecipe rejects non-finite fractional params and non-integer/negative relax counts. */
test('generateFuncAndRecipe rejects non-finite or out-of-range op params', () => {
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'truncate', params: { t: NaN } }] }),
    /must be a finite number/);
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'hankin', params: { angle: Infinity } }] }),
    /must be a finite number/);
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'relax', params: { iter: 1.5 } }] }),
    /must be a non-negative integer/);
  assert.throws(() => generateFuncAndRecipe({ base: 'cube', ops: [{ op: 'relax', params: { iter: -1 } }] }),
    /must be a non-negative integer/);
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
 * to make a chosen op throw.
 */
function fakeModule(onOp = () => { }) {
  const state = { live: 0, cleared: 0 };
  const makeMesh = () => {
    state.live++;
    const mesh = {
      deleted: false,
      delete() { this.deleted = true; state.live--; },
      classifyFaces() { onOp('classifyFaces'); },
    };
    for (const op of KNOWN_OPS) {
      mesh[op] = () => { onOp(op); return makeMesh(); };
    }
    return mesh;
  };
  const Mod = {
    MeshOps: {
      fromSolidName(name) { onOp(`base:${name}`); return makeMesh(); },
      clearToolingMemory() { state.cleared++; },
    },
  };
  return { Mod, state };
}

/** Verifies a chain that replays cleanly is accepted and leaves no live meshes. */
test('createChainValidator accepts a chain that replays cleanly', async () => {
  const { Mod, state } = fakeModule();
  const validator = createChainValidator(async () => Mod);
  assert.equal(await validator.chainIsValid('cube', ['dual', { op: 'truncate', params: { t: 0.3 } }]), true);
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

/** Verifies a plain (non-trap) failure rejects the chain and still frees the mesh. */
test('createChainValidator rejects a chain that throws, freeing its mesh', async () => {
  const { Mod, state } = fakeModule((op) => {
    if (op === 'kis') throw new Error('op refused');
  });
  const validator = createChainValidator(async () => Mod);
  assert.equal(await validator.chainIsValid('cube', ['kis']), false);
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

/** Verifies an engine trap wedges the instance, so the next chain runs on a fresh one. */
test('createChainValidator respawns after a WebAssembly trap', async () => {
  let spawns = 0;
  const modules = [
    fakeModule(() => { throw new WebAssembly.RuntimeError('trap'); }).Mod,
    fakeModule().Mod,
  ];
  const validator = createChainValidator(async () => modules[spawns++]);
  assert.equal(await validator.chainIsValid('cube', ['kis']), false);
  assert.equal(spawns, 1);
  assert.equal(await validator.chainIsValid('cube', ['dual']), true);
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
  assert.equal(await validator.chainIsValid('cube', ['kis']), true);
  assert.equal(await validator.withValidator((Mod) => Mod), null);
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
