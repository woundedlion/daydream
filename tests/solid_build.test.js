// The solids tool's MeshOps call sequences, run end to end against a stand-in
// module. MeshOps reports a recoverable failure as a null plus a reason in
// getLastResult(), and the flush that follows overwrites that reason — so the
// stand-in clears its recorded reason on clearToolingMemory(), which turns any
// sequence that reads the reason too late into an 'UNKNOWN' message rather than
// a passing test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseMesh, buildChainMesh, readbackMesh } from '../tools/solid_build.js';
import { KNOWN_OPS, MESH_OP_RESULT_NAMES } from '../tools/solid_codegen.js';
import { installConsoleCapture } from './fake_console.js';

// One triangle: the smallest readback that exercises both arrays.
const VERTICES = () => Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const FACES = () => ({ indices: Uint16Array.from([0, 1, 2]), counts: Uint8Array.from([3]) });

/**
 * Builds a stand-in WASM module whose meshes track their own deletion.
 * @param {object} [opts] - Fake behaviour.
 * @param {Set<string>} [opts.rejects] - Call tokens ('base:<name>', an op name, 'classifyFaces', 'getVertices', 'getFaces') the bridge answers with null.
 * @param {string} [opts.reason] - MeshOpResult key recorded for a rejected call.
 * @param {?function(string): void} [opts.onOp] - Called with each token, to throw from a chosen call.
 * @param {Float32Array} [opts.vertices] - What getVertices reads back.
 * @returns {{Mod: Object, state: {live: number, cleared: number, calls: string[]}}} The module and what it recorded.
 */
function fakeModule({ rejects = new Set(), reason = 'ARENA_EXHAUSTED',
  onOp = () => { }, vertices = VERTICES() } = {}) {
  const state = { live: 0, cleared: 0, calls: [] };
  const MeshOpResult = Object.fromEntries(MESH_OP_RESULT_NAMES.map((n) => [n, Symbol(n)]));
  let lastResult = MeshOpResult.OK;
  const call = (token) => {
    state.calls.push(token);
    onOp(token);
    if (!rejects.has(token)) {
      lastResult = MeshOpResult.OK;
      return false;
    }
    lastResult = MeshOpResult[reason];
    return true;
  };
  const makeMesh = () => {
    state.live++;
    const mesh = {
      deleted: false,
      delete() { this.deleted = true; state.live--; },
      classifyFaces() { return call('classifyFaces') ? null : Int32Array.from([0]); },
      getVertices() { return call('getVertices') ? null : vertices; },
      getFaces() { return call('getFaces') ? null : FACES(); },
    };
    for (const op of KNOWN_OPS) {
      mesh[op] = () => (call(op) ? null : makeMesh());
    }
    return mesh;
  };
  const Mod = {
    MeshOpResult,
    MeshOps: {
      fromSolidName(name) { return call(`base:${name}`) ? null : makeMesh(); },
      // The reason a failure recorded survives only until the next call, so a
      // read after the flush reports nothing.
      clearToolingMemory() { state.cleared++; lastResult = MeshOpResult.OK; },
      getLastResult() { return lastResult; },
    },
  };
  return { Mod, state };
}

/**
 * The live wiring a build runs against, recording what it was told.
 * @param {Object} Mod - The stand-in module.
 * @param {object} [opts] - Context behaviour.
 * @param {boolean} [opts.trapped] - What onTrap reports for a thrown value.
 * @returns {{ctx: Object, errors: string[], traps: unknown[]}} The context and its recordings.
 */
function context(Mod, { trapped = false } = {}) {
  const errors = [];
  const traps = [];
  const ctx = {
    Mod,
    meshOps: Mod.MeshOps,
    vector: (x, y, z) => ({ x, y, z }),
    onError: (message) => errors.push(message),
    onTrap: (e) => { traps.push(e); return trapped; },
  };
  return { ctx, errors, traps };
}

/**
 * Runs a build with console.error captured, so a diagnostic the page logs does
 * not print into the suite output.
 * @param {function(): any} body - The build to run.
 * @returns {any} What the build returned.
 */
function quietly(body) {
  const captured = installConsoleCapture('error');
  try {
    return body();
  } finally {
    captured.restore();
  }
}

test('buildChainMesh reads a clean base solid back and frees what it built', () => {
  const { Mod, state } = fakeModule();
  const { ctx, errors } = context(Mod);

  const built = buildChainMesh('cube', [], ctx);
  assert.ok(built, 'a clean build must yield a mesh to draw');
  assert.deepEqual(built.meshData.vertices,
    [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }]);
  assert.deepEqual(built.meshData.faces, [[0, 1, 2]]);
  assert.deepEqual([...built.faceClasses], [0]);
  assert.equal(built.classifyFailure, null);
  assert.deepEqual(errors, []);
  assert.equal(state.live, 0, 'the final wrapper must be freed');
  assert.equal(state.cleared, 1, 'the tooling arenas must be flushed once the mesh is read out');
});

test('buildChainMesh applies the op chain in order, freeing each intermediate', () => {
  const { Mod, state } = fakeModule();
  const { ctx, errors } = context(Mod);

  const built = buildChainMesh('cube', ['dual', { op: 'truncate', params: { t: 0.3 } }], ctx);
  assert.ok(built);
  assert.deepEqual(state.calls,
    ['base:cube', 'dual', 'truncate', 'classifyFaces', 'getVertices', 'getFaces']);
  assert.deepEqual(errors, []);
  assert.equal(state.live, 0, 'every intermediate wrapper must be freed');
});

test('an exhausted arena on the base solid is reported with its own remedy', () => {
  const { Mod, state } = fakeModule({ rejects: new Set(['base:cube']) });
  const { ctx, errors } = context(Mod);

  assert.equal(buildChainMesh('cube', ['dual'], ctx), null, 'there is nothing to draw');
  assert.equal(errors.length, 1, 'the failure must be surfaced, not swallowed');
  assert.match(errors[0], /^Base solid "cube" failed: /);
  assert.match(errors[0], /tooling arena is full; it has been flushed/,
    'the reason must be read back before the flush overwrites it');
  assert.equal(state.cleared, 1, 'ARENA_EXHAUSTED must flush the arenas');
  assert.deepEqual(state.calls, ['base:cube'], 'no later call may run on the null');
});

test('a different rejection reason on the base solid carries a different remedy', () => {
  const { Mod, state } = fakeModule({
    rejects: new Set(['base:cube']), reason: 'CONNECTIVITY_OVERFLOW',
  });
  const { ctx, errors } = context(Mod);

  assert.equal(buildChainMesh('cube', [], ctx), null);
  assert.match(errors[0], /16-bit element ceiling/,
    'the recorded reason must reach the message, not a generic failure');
  assert.equal(state.cleared, 0, 'flushing an intact arena would strand live wrappers');
});

test('an exhausted arena on the vertex readback draws nothing and still frees the mesh', () => {
  const { Mod, state } = fakeModule({ rejects: new Set(['getVertices']) });
  const { ctx, errors } = context(Mod);

  assert.equal(buildChainMesh('cube', [], ctx), null,
    'a refused readback must not pass an empty mesh on to the stats and export');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Mesh vertex readback failed: /);
  assert.match(errors[0], /tooling arena is full/);
  assert.equal(state.live, 0, 'the wrapper must be freed even when the readback fails');
  assert.ok(state.cleared >= 1, 'the arenas must be flushed on the way out');
  assert.ok(!state.calls.includes('getFaces'), 'the face readback must not run on the null');
});

test('an exhausted arena on the face readback draws nothing and still frees the mesh', () => {
  const { Mod, state } = fakeModule({ rejects: new Set(['getFaces']) });
  const { ctx, errors } = context(Mod);

  assert.equal(buildChainMesh('cube', [], ctx), null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Mesh face readback failed: /);
  assert.match(errors[0], /tooling arena is full/);
  assert.equal(state.live, 0);
});

test('a NaN vertex readback is refused rather than drawn', () => {
  const { Mod, state } = fakeModule({
    vertices: Float32Array.from([0, 0, 0, 1, NaN, 0, 0, 1, 0]),
  });
  const { ctx, errors } = context(Mod);

  assert.equal(buildChainMesh('cube', [], ctx), null,
    'a NaN readback must not yield a mesh that save and export accept');
  assert.deepEqual(errors, ['Mesh vertex readback failed: component 4 is NaN']);
  assert.equal(state.live, 0);
  assert.ok(!state.calls.includes('getFaces'), 'a refused vertex array ends the readback');
});

test('an exhausted arena on the classify pass still draws, with the reason to report', () => {
  const { Mod, state } = fakeModule({ rejects: new Set(['classifyFaces']) });
  const { ctx, errors } = context(Mod);

  const built = quietly(() => buildChainMesh('cube', [], ctx));
  assert.ok(built, 'colorize data is optional — the mesh still draws');
  assert.equal(built.faceClasses, null);
  assert.match(built.classifyFailure, /^Face classification failed: /);
  assert.match(built.classifyFailure, /tooling arena is full/,
    'a colorize toggle that silently stops working must name its reason');
  assert.deepEqual(errors, [],
    'the classify reason is reported after the draw, which rewrites the same line');
  assert.equal(state.live, 0);
});

test('a soft-rejected op ends the chain, freeing the mesh and flushing the arenas', () => {
  const { Mod, state } = fakeModule({ rejects: new Set(['kis']) });
  const { ctx, errors } = context(Mod);

  assert.equal(quietly(() => buildChainMesh('cube', ['dual', 'kis', 'ambo'], ctx)), null,
    'a half-applied solid must not be drawn with wrong stats');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Op error: .*"kis"/, 'the failing op must be named');
  assert.ok(!state.calls.includes('ambo'), 'the chain must stop at the rejection');
  assert.equal(state.live, 0, 'the last valid wrapper must be freed');
  assert.equal(state.cleared, 1, 'the arenas must be reclaimed after a mid-chain failure');
});

test('an op that throws is reported rather than escaping the build', () => {
  const { Mod, state } = fakeModule({
    onOp: (token) => { if (token === 'kis') throw new Error('op refused'); },
  });
  const { ctx, errors } = context(Mod);

  assert.equal(quietly(() => buildChainMesh('cube', ['kis'], ctx)), null);
  assert.deepEqual(errors, ['Op error: op refused']);
  assert.equal(state.live, 0);
});

test('an engine trap halts the build at whichever call raised it', () => {
  for (const token of ['base:cube', 'kis', 'classifyFaces']) {
    const boom = new WebAssembly.RuntimeError('unreachable');
    const { Mod, state } = fakeModule({
      onOp: (t) => { if (t === token) throw boom; },
    });
    const { ctx, errors, traps } = context(Mod, { trapped: true });

    assert.equal(quietly(() => buildChainMesh('cube', ['kis'], ctx)), null,
      `a trap at ${token} must draw nothing`);
    assert.deepEqual(traps, [boom], `the trap at ${token} must reach the page's handler`);
    assert.deepEqual(errors, [],
      'a halted module gets the fatal banner, not a stats-line message');
    assert.equal(state.cleared, 0, 'a torn-down module must not be called again');
  }
});

test('a non-trap classify throw leaves the mesh drawable and reports the failure', () => {
  const failure = new TypeError('marshalling');
  const { Mod, state } = fakeModule({
    onOp: (t) => { if (t === 'classifyFaces') throw failure; },
  });
  const { ctx, errors, traps } = context(Mod);

  const built = quietly(() => buildChainMesh('cube', [], ctx));
  assert.ok(built, 'a refused colorize pass must not cost the mesh');
  assert.equal(built.faceClasses, null);
  assert.equal(built.classifyFailure, 'Face classification failed: marshalling');
  assert.deepEqual(traps, [failure]);
  assert.deepEqual(errors, [], 'the page reports the failure after drawing the mesh');
  assert.deepEqual(state.calls,
    ['base:cube', 'classifyFaces', 'getVertices', 'getFaces']);
  assert.equal(state.live, 0);
});

test('buildBaseMesh reads one registered solid back and reclaims the arena', () => {
  const { Mod, state } = fakeModule();
  const { ctx, errors } = context(Mod);

  const meshData = buildBaseMesh('cube', 'Thumbnail for "cube"', ctx);
  assert.deepEqual(meshData.faces, [[0, 1, 2]]);
  assert.equal(meshData.vertices.length, 3);
  assert.deepEqual(state.calls, ['base:cube', 'getVertices', 'getFaces']);
  assert.deepEqual(errors, []);
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

test('buildBaseMesh names its caller when the solid is refused', () => {
  const { Mod, state } = fakeModule({ rejects: new Set(['base:cube']), reason: 'UNKNOWN_NAME' });
  const { ctx, errors } = context(Mod);

  assert.equal(buildBaseMesh('cube', 'Thumbnail for "cube"', ctx), null);
  assert.deepEqual(errors, ['Thumbnail for "cube" failed: the engine registers no solid by that name']);
  assert.equal(state.cleared, 0);
});

test('buildBaseMesh frees the wrapper and the arenas when the readback is refused', () => {
  const { Mod, state } = fakeModule({ rejects: new Set(['getFaces']) });
  const { ctx, errors } = context(Mod);

  assert.equal(buildBaseMesh('cube', 'Thumbnail for "cube"', ctx), null);
  assert.equal(errors.length, 1);
  assert.equal(state.live, 0, 'a refused readback must not strand the wrapper');
  assert.ok(state.cleared >= 1);
});

test('readbackMesh reports UNKNOWN when the module records no reason', () => {
  const { ctx, errors } = context({ MeshOps: {} });
  const wrapper = { getVertices: () => null };

  assert.equal(readbackMesh(wrapper, ctx), null);
  assert.deepEqual(errors, ['Mesh vertex readback failed: the engine rejected it']);
});

test('readbackMesh unpacks a mixed-degree face array', () => {
  const { ctx } = context({ MeshOps: {} });
  const wrapper = {
    getVertices: () => Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
    getFaces: () => ({ indices: Uint16Array.from([0, 1, 2, 3, 0, 3, 2]), counts: Uint8Array.from([4, 3]) }),
  };

  const meshData = readbackMesh(wrapper, ctx);
  assert.deepEqual(meshData.faces, [[0, 1, 2, 3], [0, 3, 2]]);
  assert.equal(meshData.vertices.length, 4);
  assert.deepEqual(meshData.vertices[3], { x: 1, y: 1, z: 0 });
});
