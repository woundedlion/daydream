import { KNOWN_OPS, MESH_OP_RESULT_NAMES } from '../../src/workbench/solids/solid_codegen.js';

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
export function fakeModule({ rejects = new Set(), reason = 'ARENA_EXHAUSTED',
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
