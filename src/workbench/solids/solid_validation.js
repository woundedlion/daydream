/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { engineHalted } from '../../shared/engine_halt.js';
import { applyOp, meshOpFailure, opTopologyKey, seedOpParams } from './solid_codegen.js';

/** @typedef {import('./solid_codegen.js').WasmModule} WasmModule */
/** @typedef {import('./solid_codegen.js').ChainOp} ChainOp */
/** @typedef {import('./solid_codegen.js').MeshWrapper} MeshWrapper */
/** @typedef {import('./solid_codegen.js').SolidMesh} SolidMesh */

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
          what = `Op "${typeof o === 'string' ? o : o.op}"`;
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
 * @param {number} [retries=3] - Incomplete passes tolerated before probing stops.
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
