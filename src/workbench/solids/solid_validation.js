/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Solid operation validation and dispatch. */

import { CPP_IDENTIFIER } from '../../shared/cpp_format.js';
import { engineHalted } from '../../shared/engine_halt.js';
import { MORPH_SWEEP, NUMERIC_ENUMS } from '../../../generated/engine_contract.mjs';
import {
  D2R_F32, KNOWN_OPS, OP_DEFS, PARAMETERIZED_OPS, chainOpName, offStepGrid,
  opParams, opTopologyKey, seedOpParams,
} from './solid_op_params.js';

/** @typedef {import('./solid_op_params.js').ChainOp} ChainOp */
/** @typedef {import('./solid_op_params.js').SolidMesh} SolidMesh */
/** @typedef {import('./solid_op_params.js').OpParamDef} OpParamDef */

/**
 * A live WASM MeshOps mesh wrapper.
 * @typedef {import('../../../generated/holosphere_wasm.js').MeshHandle} MeshWrapper
 */

/**
 * A spawned WASM module instance, reached by binding name.
 * @typedef {import('../../../generated/holosphere_wasm.js').HolosphereModule} WasmModule
 */

/**
 * Why the engine's morph path would decline a chain step, which makes the entry
 * generate whole instead of op by op, per the engine contract's MORPH_SWEEP.
 * @param {ChainOp} o - The op as the chain holds it.
 * @returns {?string} A sentence naming the reason, or null when the step sweeps.
 */
export function unsweepableReason(o) {
  const opName = chainOpName(o);
  if (MORPH_SWEEP.unswept.includes(opName)) {
    return `${opName} is not swept by the morph path: a shape using it is generated whole `
      + 'rather than built on screen.';
  }
  if (!Object.hasOwn(MORPH_SWEEP.bands, opName)) return null;
  for (const [key, { min, max, excluded }] of Object.entries(MORPH_SWEEP.bands[opName])) {
    const value = typeof o === 'string' ? NaN : Number(o?.params?.[key]);
    if (!Number.isFinite(value)) continue;
    const engineValue = Math.fround(value);
    if (excluded && engineValue > Math.fround(excluded.lower)
        && engineValue <= Math.fround(excluded.upper)) {
      return `${opName} cannot sweep ${key} at ${engineValue}: the shape is `
        + 'generated whole rather than built on screen.';
    }
    if (engineValue >= Math.fround(min) && engineValue <= Math.fround(max)) continue;
    return `${opName} sweeps ${key} only over ${min} to ${max}: at ${value} the `
      + 'shape is generated whole rather than built on screen.';
  }
  return null;
}

/**
 * Longest step table a Recipe can describe: its count field is a uint8_t.
 */
export const MAX_RECIPE_STEPS = 255;

/**
 * Rejects an op whose params object is missing on either dispatch path.
 * @param {string} where - Caller name used in the error message.
 * @param {string} opName - The op being dispatched.
 * @param {ChainOp} o - The op as supplied.
 * @returns {void}
 * @throws {Error} When a parameterized op arrives without a params object.
 */
export function requireParams(where, opName, o) {
  if (PARAMETERIZED_OPS.has(opName) && (typeof o === 'string' || !o.params)) {
    throw new Error(`${where}: op "${opName}" requires a params object`);
  }
}

/**
 * The first declared param of an op that carries a finite value outside its
 * OP_DEFS band. Non-finite values are left to the caller's own finiteness check.
 * @param {string} opName - An op name OP_DEFS declares.
 * @param {Object<string, number>} params - The op's params.
 * @returns {?{key: string, def: OpParamDef, value: number}} The offending param,
 *   or null when every declared param is in band.
 */
export function outOfRangeParam(opName, params) {
  for (const [key, def] of Object.entries(OP_DEFS[opName].params)) {
    const value = params[key];
    if (Number.isFinite(value) && (value < def.min || value > def.max)) {
      return { key, def, value };
    }
  }
  return null;
}

/**
 * Checks whether a saved card has an exportable recipe.
 * @param {string} base - Seed solid.
 * @param {ChainOp[]} ops - Authored operations.
 * @returns {?string} Refusal reason, or null for an exportable shape.
 */
export function savedSolidExportError(base, ops) {
  return savedChainShapeError(base, ops)
    ?? (ops.length === 0 ? 'its op chain is empty; a saved solid needs at least one op' : null);
}

/**
 * Shape-checks a persisted base+chain against the op table, without the engine.
 * @param {*} base - The persisted seed-solid name.
 * @param {*} ops - The persisted op chain.
 * @returns {?string} A message naming the first defect, or null when the pair is restorable.
 * @details Refuses unknown ops, missing, non-numeric, out-of-range or off-grid
 * params, chains past MAX_RECIPE_STEPS, and bare-string ops. An off-grid value
 * would split the generated funcName from its recipe: the name suffix rounds
 * where the emitted call does not.
 */
export function savedChainShapeError(base, ops) {
  if (typeof base !== 'string' || !base) return 'it names no base solid';
  if (!Array.isArray(ops)) return 'its op chain is not a list';
  if (ops.length > MAX_RECIPE_STEPS) {
    return `its op chain holds ${ops.length} ops; a chain carries at most ${MAX_RECIPE_STEPS}`;
  }
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const at = `op ${i + 1}`;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return `${at} is not an op entry`;
    if (!KNOWN_OPS.has(o.op)) return `${at} names an unknown operator "${o.op}"`;
    const banded = outOfRangeParam(o.op, o.params ?? {});
    if (banded) return `${at} ("${o.op}") carries out-of-range "${banded.key}"`;
    for (const [key, def] of Object.entries(OP_DEFS[o.op].params)) {
      const value = o.params?.[key];
      if (!Number.isFinite(value)) {
        return `${at} ("${o.op}") carries no numeric "${key}"`;
      }
      if (offStepGrid(value, def)) {
        return `${at} ("${o.op}") carries off-grid "${key}"`;
      }
    }
  }
  return null;
}

/**
 * Applies one op of the {op, params} encoding to a WASM mesh wrapper, returning
 * the resulting mesh.
 * @param {MeshWrapper} mesh - A live WASM MeshOps mesh wrapper.
 * @param {ChainOp} o - The op to apply, as a bare op name or an {op, params} object.
 * @returns {MeshWrapper} The new mesh wrapper.
 * @throws {Error} When the op name is not a known operator, when the module binds no method for it, or when the op soft-rejects.
 * @details A soft reject (null from the bridge) throws before the caller swaps
 * its live wrapper. The KNOWN_OPS gate keeps op names off the wrapper's
 * lifetime methods (delete, clone).
 */
export function applyOp(mesh, o) {
  const opName = chainOpName(o);
  if (!KNOWN_OPS.has(opName)) {
    throw new Error(`applyOp: unknown op "${opName}" — not a Conway/SolidBuilder operator`);
  }
  requireParams('applyOp', opName, o);
  const next = dispatchOp(mesh, o, opName);
  if (!next) {
    throw new Error(`applyOp: op "${opName}" was rejected by the WASM MeshOps module`);
  }
  return next;
}

/**
 * Calls the bound method for one op.
 * @param {MeshWrapper} mesh - A live WASM MeshOps mesh wrapper.
 * @param {ChainOp} o - The op to apply.
 * @param {string} opName - The op's name.
 * @returns {?MeshWrapper} The new mesh wrapper, or null when the module soft-rejects the op.
 * @throws {Error} When the module binds no method for the op name.
 */
function dispatchOp(mesh, o, opName) {
  const params = opParams(o);
  if (opName === 'truncate') return mesh.truncate(params.t);
  if (opName === 'chamfer') return mesh.chamfer(params.t);
  if (opName === 'expand') return mesh.expand(params.t);
  if (opName === 'bevel') return mesh.bevel(params.t);
  if (opName === 'snub') return mesh.snub(params.t, params.twist);
  if (opName === 'hankin') return mesh.hankin(Math.fround(params.angle * D2R_F32));
  if (opName === 'relax') return mesh.relax(params.iter);
  const operation = Reflect.get(mesh, opName);
  if (typeof operation === 'function') return operation.call(mesh);
  throw new Error(`unknown op "${opName}" — not bound by the WASM MeshOps module`);
}

/**
 * The set of MeshOpResult keys the WASM bridge binds.
 */
export const MESH_OP_RESULT_NAMES = Object.keys(NUMERIC_ENUMS.MeshOpResult);

// Reason-specific tail of the message a null MeshOps result earns.
/** @type {Object<string, string>} */
const MESH_FAILURE_REMEDY = {
  UNKNOWN_NAME: 'the engine registers no solid by that name',
  CONNECTIVITY_OVERFLOW: 'the result passes the engine 16-bit element ceiling — remove an op',
  FACE_DEGREE_OVERFLOW: 'the result needs a face with more sides than the engine allows — remove an op',
  ARENA_EXHAUSTED: 'the chain needs more tooling memory than the engine reserves — remove an op',
  NON_FINITE_ARG: 'an op argument was not a finite number',
  ANGLE_OUT_OF_DOMAIN: 'an angle argument sat outside its op domain',
  STALE_WRAPPER: 'a tooling-memory flush reclaimed this mesh — rebuild it from the base solid',
  ARENA_UNAVAILABLE: 'the engine could not reserve its tooling memory, so no mesh op can run — reload the page',
};

/**
 * Reads back why a mesh-producing MeshOps call returned null.
 * @param {WasmModule} Mod - The WASM module instance that produced the null.
 * @param {string} what - What the caller was building, used in the message.
 * @returns {{reason: string, message: string, flush: boolean, fatal: boolean}} The MeshOpResult key, a message to show, whether clearToolingMemory() is the remedy that reason calls for, and whether arena-backed mesh operations are unavailable for the instance's lifetime.
 * @details Embind enum values are singletons matched by identity. A module that
 * binds neither the enum nor getLastResult reports reason 'UNKNOWN'.
 */
export function meshOpFailure(Mod, what) {
  const codes = Mod?.MeshOpResult;
  const recorded = Mod?.MeshOps?.getLastResult?.();
  let reason = 'UNKNOWN';
  if (codes && recorded !== undefined) {
    reason = Object.entries(codes).find(([name, value]) => MESH_OP_RESULT_NAMES.includes(name) && value === recorded)?.[0] ?? 'UNKNOWN';
  }
  return {
    reason,
    message: `${what} failed: ${MESH_FAILURE_REMEDY[reason] ?? 'the engine rejected it'}`,
    flush: reason === 'ARENA_EXHAUSTED',
    fatal: reason === 'ARENA_UNAVAILABLE',
  };
}

/**
 * Passes a mesh-producing MeshOps result through, or reports and remedies the
 * failure a null stands for.
 * @template T
 * @param {T|null} result - What the bridge returned.
 * @param {string} what - What the caller was building, used in the message.
 * @param {Object} ctx - The live wiring, read per call because an engine halt nulls it.
 * @param {WasmModule} ctx.Mod - The WASM module instance that produced the result.
 * @param {{clearToolingMemory: () => void}} ctx.meshOps - Its MeshOps binding.
 * @param {(message: string) => void} ctx.onError - Surfaces the failure message to the user.
 * @param {(message: string) => void} [ctx.onFatal] - Stands the tool down for a failure nothing can recover from.
 * @returns {T|null} The result, or null when it was a failure.
 * @details Flushes the tooling arenas only for ARENA_EXHAUSTED. ARENA_UNAVAILABLE
 * is unrecoverable and goes to onFatal.
 */
export function requireMeshResult(result, what, { Mod, meshOps, onError, onFatal }) {
  if (result) return result;
  const failure = meshOpFailure(Mod, what);
  if (failure.flush) meshOps.clearToolingMemory();
  if (failure.fatal && onFatal) onFatal(failure.message);
  else onError(failure.message);
  return null;
}

// Op params become C++ literals, so reject anything that would emit NaN/Inf or a
// malformed token.
/**
 * @param {string} opName - The op the param belongs to.
 * @param {string} param - The param's name.
 * @param {number} val - The value to check.
 * @returns {void}
 * @throws {Error} When the value is not finite.
 */
export function requireFinite(opName, param, val) {
  if (!Number.isFinite(val)) {
    throw new Error(`generateFuncAndRecipe: ${opName} param "${param}" must be a finite number, got ${val}`);
  }
}

/**
 * @param {string} opName - The op the param belongs to.
 * @param {string} param - The param's name.
 * @param {number} val - The value to check.
 * @returns {void}
 * @throws {Error} When the value is not a positive integer.
 */
export function requireCount(opName, param, val) {
  if (!Number.isInteger(val) || val < 1) {
    throw new Error(`generateFuncAndRecipe: ${opName} param "${param}" must be a positive integer, got ${val}`);
  }
}

// The seed call must name its namespace: IslamicStarPatterns has no using-directive.
/**
 * @param {string} where - Caller name used in the error message.
 * @param {string} ns - The namespace to check.
 * @returns {void}
 * @throws {Error} When the namespace is not a valid C++ identifier.
 */
export function requireNamespace(where, ns) {
  if (typeof ns !== 'string' || !CPP_IDENTIFIER.test(ns)) {
    throw new Error(`${where}: base namespace "${ns}" is not a valid C++ identifier`);
  }
}

/**
 * A createChainValidator handle.
 * @typedef {object} ChainValidator
 * @property {() => Promise<?WasmModule>} acquire - The current validator instance, spawning one if needed.
 * @property {(e: any) => void} noteDeath - Drops a wedged instance.
 * @property {(task: (mod: ?WasmModule) => any) => Promise<any>} withValidator - Runs a task against the instance, serialized.
 * @property {(base: string, ops: ChainOp[]) => Promise<{ok: boolean, message: string}>} chainIsValid - Replays a chain on the validator.
 */

/**
 * What a gate pass concluded. `abandoned` is true on the pass that gives up,
 * and only that one.
 * @typedef {{blocked: Set<string>, complete: boolean, abandoned: boolean}} OpGateVerdict
 */

/**
 * Builds a serializer for validated state mutations: each commit sees the state
 * its predecessors left.
 * @param {(reason: any) => void} [onError] - Handler for a rejected commit; defaults to console.error.
 * @returns {(commit: () => any) => Promise<void>} Enqueues a commit and resolves once it (or its error handler) has run.
 */
export function createCommitQueue(onError = console.error) {
  let tail = Promise.resolve();
  return function queueCommit(/** @type {() => any} */ fn) {
    tail = tail.then(fn).catch(onError);
    return tail;
  };
}

/**
 * Builds the sacrificial-module chain validator. An engine invariant trap
 * permanently halts the module it ran on, so candidate chains run on a
 * sacrificial instance, respawned after a trap, before reaching the live module.
 * @param {() => Promise<WasmModule>} createModule - Spawns a fresh WASM module instance.
 * @returns {ChainValidator} The validator handle.
 */
export function createChainValidator(createModule) {
  /** @type {?Promise<WasmModule>} */
  let modulePromise = null;
  // The instance behind modulePromise, for reading the halt flag.
  /** @type {?WasmModule} */
  let moduleInstance = null;
  // Serializes validator use: tasks hold live mesh wrappers across awaits that
  // an interleaved clearToolingMemory would invalidate.
  let queue = Promise.resolve();

  /**
   * Resolves the current validator instance, spawning one if needed.
   * @returns {Promise<?WasmModule>} The module, or null when it failed to spawn.
   * @details A failed spawn is not cached: the next acquire retries.
   */
  function acquire() {
    const pending = (modulePromise ||= createModule().then((mod) => {
      moduleInstance = mod;
      return mod;
    }));
    return pending.catch(() => {
      // Only drop our own failed attempt; a later acquire may have replaced it.
      if (modulePromise === pending) {
        modulePromise = null;
        moduleInstance = null;
      }
      return null;
    });
  }

  /**
   * Drops a wedged instance so the next task spawns a fresh one.
   * @param {*} e - The error a validator call threw.
   * @returns {void}
   */
  function noteDeath(e) {
    if (!engineHalted(e, moduleInstance)) return;
    modulePromise = null;
    moduleInstance = null;
  }

  /**
   * Runs a task against the validator instance, serialized behind prior tasks.
   * @param {(mod: ?WasmModule) => any} task - Receives the module, or null when it failed to spawn.
   * @returns {Promise<any>} The task's result.
   */
  function withValidator(task) {
    const run = queue.then(async () => task(await acquire()));
    // Keep the queue alive past a rejected task.
    queue = run.catch(() => { });
    return run;
  }

  /**
   * Replays base+ops (plus the classifyFaces pass the tool always runs) on the
   * validator.
   * @param {string} base - Registry name of the seed solid.
   * @param {ChainOp[]} ops - The candidate op chain.
   * @returns {Promise<{ok: boolean, message: string}>} Whether the whole chain is safe for the live module, and why it is not when it is not.
   * @details A missing validator (module failed to spawn) resolves ok: true.
   * Test `.ok`: the result object is always truthy. A chain is also refused when
   * the engine saturated one of its arguments (getLastAdjusted).
   */
  function chainIsValid(base, ops) {
    const candidate = structuredClone(ops);
    return withValidator((Mod) => {
      if (!Mod) return { ok: true, message: '' };
      const Ops = Mod.MeshOps;
      /** @type {?MeshWrapper} */
      let mesh = null;
      // What the replay was building, named in whatever failure it hits.
      let what = `Base solid "${base}"`;
      // Reads the recorded reason before freeing the mesh and the arenas.
      const rejected = (/** @type {any} */ e = null) => {
        const failure = meshOpFailure(Mod, what);
        // A reason of OK means the bridge recorded no rejection and the throw
        // came from JS (an unbound op name, an Embind marshalling error).
        const message = failure.reason === 'OK' && e
          ? `${what} failed: ${e.message || e}`
          : failure.message;
        try { if (mesh) mesh.delete(); Ops.clearToolingMemory(); } catch { /* best effort */ }
        return { ok: false, message };
      };
      // A saturated argument: the engine drew a clamped value, not the chain's.
      const saturated = () => {
        try { if (mesh) mesh.delete(); Ops.clearToolingMemory(); } catch { /* best effort */ }
        return {
          ok: false,
          message: `${what} failed: an argument sat outside its op domain and the `
            + 'engine clamped it — the exported value would not be the one it drew',
        };
      };
      try {
        mesh = Ops.fromSolidName(base);
        if (!mesh) return rejected();
        for (const o of candidate) {
          what = `Op "${chainOpName(o)}"`;
          const next = applyOp(mesh, o);
          // Read before another checked mesh call clears the flag; getVertices
          // also resets it before reading back the mesh.
          const adjusted = Ops.getLastAdjusted();
          mesh.delete();
          mesh = next;
          if (adjusted) return saturated();
        }
        what = 'Face classification';
        const classes = mesh.classifyFaces();
        if (classes == null) return rejected();
        mesh.delete();
        mesh = null;
        Ops.clearToolingMemory();
        return { ok: true, message: '' };
      } catch (e) {
        const halted = engineHalted(e, Mod);
        noteDeath(e);
        // A halted instance records no reason and cannot be called again.
        if (halted) {
          return { ok: false, message: `${what} exceeded an engine mesh limit` };
        }
        return rejected(e);
      }
    });
  }

  return { acquire, noteDeath, withValidator, chainIsValid };
}

/**
 * Builds the add-op availability gate: which offered ops would be refused or
 * trap if appended to the current chain. Each candidate is applied and
 * classified on the sacrificial validator; a pass whose base and chain topology
 * repeat the last complete one is skipped.
 * @param {ChainValidator} validator - A createChainValidator handle.
 * @param {number} [retries=3] - Consecutive incomplete passes after which probing stops.
 * @returns {{refresh: (base: string, ops: ChainOp[], candidates: string[], mesh?: ?SolidMesh) => Promise<?OpGateVerdict>}} The gate.
 */
export function createOpGate(validator, retries = 3) {
  let generation = 0;
  /** @type {{signature: string, promise: Promise<?OpGateVerdict>, started: number}|null} */
  let pending = null;
  /** @type {?string} */
  let lastSignature = null;
  let failures = 0;
  let abandoned = false;

  /**
   * Sweeps the candidates against a live validator instance.
   * @param {string} base - Registry name of the seed solid.
   * @param {ChainOp[]} ops - The current chain.
   * @param {string[]} candidates - Op names to probe.
   * @param {?SolidMesh} seedMesh - The current chain's readback mesh, used to
   *   seed each candidate the way the page would seed it; null falls back to
   *   the OP_DEFS defaults.
   * @param {number} started - Refresh generation.
   * @returns {Promise<{bad: Set<string>, complete: boolean}>} The ops that would
   *   be refused or trap, and whether the sweep got a full pass against a live module.
   *   Where it did not, `bad` is only a lower bound on blocked candidates.
   */
  function probe(base, ops, candidates, seedMesh, started) {
    return validator.withValidator(async (Mod) => {
      /** @type {Set<string>} */
      const bad = new Set();
      if (!Mod || started !== generation) return { bad, complete: false };
      /**
       * Replays the standing chain on a validator instance.
       * @param {WasmModule} M - The live validator instance.
       * @returns {MeshWrapper} The chain's mesh.
       * @throws {Error} When the base or an op is rejected. Unless the instance
       *   halted, the mesh the op was applied to and the arenas are freed first.
       */
      const build = (M) => {
        let mesh = M.MeshOps.fromSolidName(base);
        if (!mesh) {
          const failure = meshOpFailure(M, `Base solid "${base}"`);
          if (failure.flush) M.MeshOps.clearToolingMemory();
          throw new Error(failure.message);
        }
        try {
          for (const o of ops) {
            const next = applyOp(mesh, o);
            mesh.delete();
            mesh = next;
          }
        } catch (e) {
          if (!engineHalted(e, M)) {
            try { mesh.delete(); M.MeshOps.clearToolingMemory(); } catch { /* best effort */ }
          }
          throw e;
        }
        return mesh;
      };
      /** @type {MeshWrapper} */
      let mesh;
      try {
        mesh = build(Mod); // current chain: valid by construction
      } catch (e) {
        validator.noteDeath(e);
        return { bad, complete: false };
      }
      /**
       * Applies one candidate to the standing chain and classifies the result.
       * @param {WasmModule} mod - The live validator instance.
       * @param {{op: string, params: Object<string, number>}} candidate - The op to probe.
       * @returns {string} 'ok', 'bad', 'exhausted' when the tooling arena filled, or 'trapped' when the instance died.
       * @details The mesh is freed after the verdict reads the recorded reason.
       */
      const attempt = (mod, candidate) => {
        let out = null;
        try {
          out = applyOp(mesh, candidate);
          const classes = out.classifyFaces();
          const verdict = classes ? 'ok'
            : (meshOpFailure(mod, 'Face classification').flush ? 'exhausted' : 'bad');
          out.delete();
          return verdict;
        } catch (e) {
          const halted = engineHalted(e, mod);
          validator.noteDeath(e);
          if (halted) return 'trapped';
          out?.delete();
          return meshOpFailure(mod, `Op "${candidate.op}"`).flush ? 'exhausted' : 'bad';
        }
      };

      for (const op of candidates) {
        await new Promise((resolve) => {
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = () => {
            port1.close();
            port2.close();
            resolve(undefined);
          };
          port2.postMessage(null);
        });
        if (started !== generation) {
          try { mesh.delete(); Mod.MeshOps.clearToolingMemory(); }
          catch (e) { validator.noteDeath(e); }
          return { bad, complete: false };
        }
        /** @type {{op: string, params: Object<string, number>}} */
        const candidate = { op, params: seedOpParams(op, seedMesh) };
        let verdict = attempt(Mod, candidate);
        if (verdict === 'exhausted') {
          // Reclaim the full arena and retry on a fresh one.
          try { mesh.delete(); Mod.MeshOps.clearToolingMemory(); mesh = build(Mod); }
          catch (e) { validator.noteDeath(e); return { bad, complete: false }; }
          verdict = attempt(Mod, candidate);
        }
        if (verdict === 'trapped') {
          bad.add(op);
          // Instance is wedged; respawn and rebuild for the remaining probes.
          Mod = await validator.acquire();
          if (!Mod) return { bad, complete: false };
          try { mesh = build(Mod); }
          catch (e) { validator.noteDeath(e); return { bad, complete: false }; }
        } else if (verdict !== 'ok') {
          bad.add(op);
        }
      }
      try { mesh.delete(); Mod.MeshOps.clearToolingMemory(); }
      catch (e) { validator.noteDeath(e); }
      return { bad, complete: true };
    });
  }

  /**
   * Re-derives which candidates are blocked on the current chain.
   * @param {string} base - Registry name of the seed solid.
   * @param {ChainOp[]} ops - The current chain.
   * @param {string[]} candidates - Op names to probe.
   * @param {?SolidMesh} [mesh] - The current chain's readback mesh, used to seed
   *   each candidate; omitted falls back to the OP_DEFS defaults.
   * @returns {Promise<?OpGateVerdict>} The verdict, or null when the pass was
   *   skipped or the chain changed under it.
   */
  async function refresh(base, ops, candidates, mesh = null) {
    const signature = `${base}|${ops.map(opTopologyKey).join(',')}`;
    if (pending?.signature === signature && pending.started === generation) return pending.promise;
    const started = ++generation;
    if (abandoned || signature === lastSignature) return null;
    const promise = settle();
    pending = { signature, promise, started };
    try { return await promise; }
    finally { if (pending?.promise === promise) pending = null; }

    async function settle() {
      const { bad, complete } = await probe(base, structuredClone(ops), candidates, mesh, started);
      if (started !== generation) return null;

      if (complete) {
        lastSignature = signature;
        failures = 0;
      } else {
        lastSignature = null;
        if (++failures >= retries) abandoned = true;
      }
      return { blocked: bad, complete, abandoned };
    }
  }

  return { refresh };
}
