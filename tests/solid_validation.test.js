import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCommitQueue, createChainValidator, createOpGate, applyOp, savedChainShapeError,
  MAX_RECIPE_STEPS, meshOpFailure, requireMeshResult, unsweepableReason,
} from '../src/workbench/solids/solid_validation.js';
import { readFileSync } from 'node:fs';
import { fakeModule, stubMesh } from './helpers/fake_meshops.js';
import { LOWERING } from '../src/workbench/solids/solid_registry_codegen.js';
import { queueSavedSolidRestore } from '../src/workbench/solids/solid_saved_store.js';
import {
  OP_DEFS, KNOWN_OPS, PARAMETERIZED_OPS, D2R_F32, seedOpParams,
} from '../src/workbench/solids/solid_op_params.js';
import { generateFuncAndRecipe } from '../src/workbench/solids/solid_codegen.js';
import { MORPH_SWEEP } from '../generated/engine_contract.mjs';

test('a rejected validator task leaves subsequent tasks usable', async () => {
  const { Mod } = fakeModule();
  const validator = createChainValidator(async () => Mod);
  await assert.rejects(validator.withValidator(() => { throw new Error('task failed'); }),
    /task failed/);
  assert.equal(await validator.withValidator((module) => module), Mod);
});

test('validator reports a thrown string and frees its standing mesh', async () => {
  const { Mod, state } = fakeModule({ onOp(token) {
    if (token === 'kis') throw 'op refused';
  } });
  const verdict = await createChainValidator(async () => Mod).chainIsValid('cube', ['kis']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /kis/);
  assert.match(verdict.message, /op refused/);
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

test('gate blocks a classification refusal with no mid-sweep flush', async () => {
  const { Mod, state } = fakeModule({
    rejects: new Set(['classifyFaces']), reason: 'CONNECTIVITY_OVERFLOW',
  });
  const verdict = await createOpGate(createChainValidator(async () => Mod))
    .refresh('cube', [], ['kis']);
  assert.deepEqual(verdict, { blocked: new Set(['kis']), complete: true, abandoned: false });
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

test('gate frees a candidate whose classification throws without halting', async () => {
  const { Mod, state } = fakeModule({ onOp(token) {
    if (token === 'classifyFaces') throw new Error('classification failed');
  } });
  const verdict = await createOpGate(createChainValidator(async () => Mod))
    .refresh('cube', [], ['kis']);
  assert.deepEqual(verdict, { blocked: new Set(['kis']), complete: true, abandoned: false });
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

test('gate returns an incomplete verdict when arena recovery cannot rebuild the base', async () => {
  const rejects = new Set(['classifyFaces']);
  const { Mod, state } = fakeModule({ rejects, onOp(token) {
    if (token === 'classifyFaces') rejects.add('base:cube');
  } });
  const verdict = await createOpGate(createChainValidator(async () => Mod))
    .refresh('cube', [], ['kis']);
  assert.deepEqual(verdict, { blocked: new Set(), complete: false, abandoned: false });
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 2);
});

test('a chain change during a probe frees the stale standing mesh before the next pass', async () => {
  let next;
  let gate;
  const { Mod, state } = fakeModule({ onOp(token) {
    if (token === 'kis' && !next) next = gate.refresh('octahedron', [], ['dual']);
  } });
  gate = createOpGate(createChainValidator(async () => Mod));
  assert.equal(await gate.refresh('cube', [], ['kis', 'ambo']), null);
  assert.deepEqual(await next, { blocked: new Set(), complete: true, abandoned: false });
  assert.equal(state.calls.includes('ambo'), false);
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 2);
});

const SOLIDS_PAGE = readFileSync(new URL('../src/workbench/solids/solids_page.js', import.meta.url), 'utf8');
const CANDIDATES = ['kis', 'ambo', 'dual'];

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


/** Verifies page gates test the verdict's ok field. */
test('the solids page gates on each chainIsValid verdict field', () => {
  const calls = [...SOLIDS_PAGE.matchAll(/\bchainIsValid\(/g)].length;
  assert.ok(calls >= 7, `expected the page's gates to call chainIsValid, found ${calls}`);
  assert.equal([...SOLIDS_PAGE.matchAll(/const \w+ = await chainIsValid\(/g)].length, calls,
    'every call must bind its verdict; an unbound one is truthy and gates nothing');
  assert.doesNotMatch(SOLIDS_PAGE, /!\s*\(?await chainIsValid\(/,
    'a negated call tests the verdict object, not its ok field');
  const bindings = [...SOLIDS_PAGE.matchAll(/const (\w+) = await chainIsValid\(/g)];
  for (const [index, binding] of bindings.entries()) {
    const verdict = binding[1];
    const scope = SOLIDS_PAGE.slice(binding.index, bindings[index + 1]?.index);
    assert.ok(new RegExp(`\\b${verdict}\\.ok\\b`).test(scope)
      || scope.includes(`dropSlotChecks.set(target, ${verdict})`),
    `${verdict} must read ok or hand its verdict to the drop-slot map`);
    assert.doesNotMatch(scope, new RegExp(`if\\s*\\(\\s*!?\\s*${verdict}\\s*(?:\\)|\\|\\||&&)`));
  }
  assert.match(SOLIDS_PAGE, /slotCheck && !slotCheck\.ok/);
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
  const { Mod, state } = fakeModule({ onOp: (op) => {
    if (op === 'kis') throw new Error('op refused');
  } });
  const validator = createChainValidator(async () => Mod);
  const verdict = await validator.chainIsValid('cube', ['kis']);
  assert.equal(verdict.ok, false);
  for (const named of [/kis/, /op refused/]) {
    assert.match(verdict.message, named,
      'a throw the bridge recorded no reason for must still name the op and what it said');
  }
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});


/** Verifies a soft-rejected base solid rejects the chain and reclaims the arena. */
test('createChainValidator rejects a chain whose base solid comes back null', async () => {
  const { Mod, state } = fakeModule({ rejects: new Set(['base:cube']) });
  const validator = createChainValidator(async () => Mod);
  assert.equal((await validator.chainIsValid('cube', ['dual'])).ok, false);
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});


/** Verifies the classify pass the tool always runs is proven, not just called. */
test('createChainValidator rejects a chain whose classify pass comes back null', async () => {
  const { Mod, state } = fakeModule({ rejects: new Set(['classifyFaces']) });
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
    { rejects: new Set(['classifyFaces']), reason: 'ARENA_EXHAUSTED' }).Mod;
  const arena = await createChainValidator(async () => arenaMod).chainIsValid('cube', ['dual']);
  assert.equal(arena.ok, false);
  assert.match(arena.message, /^Face classification failed: /);
  assert.match(arena.message, /remove an op/, 'the arena remedy must survive the gate');

  const overflowMod = fakeModule(
    { rejects: new Set(['base:cube']), reason: 'FACE_DEGREE_OVERFLOW' }).Mod;
  const overflow = await createChainValidator(async () => overflowMod).chainIsValid('cube', ['dual']);
  assert.equal(overflow.ok, false);
  assert.match(overflow.message, /^Base solid "cube" failed: /);
  assert.notEqual(overflow.message, arena.message, 'each reason must arrive with its own remedy');
});


/**
 * Verifies a chain the engine saturated an argument for is refused. The op
 * succeeds, so only getLastAdjusted() says the rendered mesh came from a value
 * the chain does not hold. The next checked mesh call clears that flag, so the
 * read has to precede it.
 */
test('createChainValidator refuses a chain whose argument the engine clamped', async () => {
  const calls = [];
  const { Mod, state } = fakeModule({ onOp: (op) => calls.push(op) });
  Mod.MeshOps.getLastAdjusted = () => { calls.push('adjusted?'); return true; };
  const verdict = await createChainValidator(async () => Mod)
    .chainIsValid('cube', [{ op: 'hankin', params: { angle: 95 } }]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /^Op "hankin" failed: /);
  assert.deepEqual(calls, ['base:cube', 'hankin', 'adjusted?'],
    'the flag must be read straight after the op, before any other bridge call clears it');
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});


/** Verifies an unsaturated argument leaves the chain accepted. */
test('createChainValidator accepts a chain the engine did not clamp', async () => {
  const { Mod } = fakeModule();
  Mod.MeshOps.getLastAdjusted = () => false;
  assert.equal((await createChainValidator(async () => Mod)
    .chainIsValid('cube', [{ op: 'hankin', params: { angle: 54 } }])).ok, true);
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
    fakeModule({ onOp: () => { throw new WebAssembly.RuntimeError('trap'); } }).Mod,
    fakeModule().Mod,
  ];
  const validator = createChainValidator(async () => modules[spawns++]);
  assert.equal((await validator.chainIsValid('cube', ['kis'])).ok, false);
  assert.equal(spawns, 1);
  assert.equal((await validator.chainIsValid('cube', ['dual'])).ok, true);
  assert.equal(spawns, 2);
});


/** Verifies an ordinary op failure leaves the instance in service. */
test('createChainValidator keeps the instance after an op failure that is not a halt', async () => {
  let spawns = 0;
  const { Mod } = fakeModule({ onOp: (op) => {
    if (op === 'kis') throw new Error('op refused');
  } });
  const validator = createChainValidator(async () => { spawns++; return Mod; });
  assert.equal((await validator.chainIsValid('cube', ['kis'])).ok, false);
  assert.equal((await validator.chainIsValid('cube', ['dual'])).ok, true);
  assert.equal(spawns, 1);
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


/** Verifies a transient spawn failure is retried rather than disabling validation for good. */
test('createChainValidator retries after a failed spawn', async () => {
  let spawns = 0;
  const { Mod } = fakeModule({ onOp: (op) => {
    if (op === 'kis') throw new Error('op refused');
  } });
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


/** Concurrent requests for the same signature share one validator sweep. */
test('createOpGate joins concurrent refreshes for the same signature', async () => {
  const { Mod } = fakeModule();
  const validator = createChainValidator(async () => Mod);
  let sweeps = 0;
  const withValidator = validator.withValidator;
  validator.withValidator = (...args) => { sweeps++; return withValidator(...args); };
  const gate = createOpGate(validator);
  const results = await Promise.all(Array.from({ length: 30 }, () => gate.refresh('cube', [], CANDIDATES)));
  assert.equal(sweeps, 1);
  assert.ok(results.every((result) => result === results[0]));
});


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
  const { Mod } = fakeModule({ rejects: new Set(['classifyFaces']) });
  const gate = createOpGate(createChainValidator(async () => Mod));

  const probe = await gate.refresh('cube', [], CANDIDATES);
  assert.deepEqual([...probe.blocked].sort(), [...CANDIDATES].sort());
  assert.equal(probe.complete, true);
});


/** Verifies a trapping candidate is blocked and the sweep resumes on a fresh instance. */
test('createOpGate respawns mid-sweep after a candidate traps', async () => {
  let spawns = 0;
  const modules = [
    fakeModule({ onOp: (op) => { if (op === 'ambo') throw new WebAssembly.RuntimeError('trap'); } }).Mod,
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
  const { Mod, state } = fakeModule({ rejects, onOp: (op) => {
    if (op === 'kis' && seen++ >= 1) rejects.delete('kis');
  } });
  const gate = createOpGate(createChainValidator(async () => Mod));

  const probe = await gate.refresh('cube', [], CANDIDATES);
  assert.deepEqual([...probe.blocked], [], 'an exhausted arena is not an illegal op');
  assert.equal(probe.complete, true);
  assert.ok(state.cleared > 0, 'the sweep must flush the arena it filled');
  assert.equal(state.live, 0, 'the rebuild must free the chain it replaced');
});


/** Verifies a candidate that exhausts a reclaimed arena too is blocked, and only it. */
test('createOpGate blocks a candidate that refills a reclaimed arena', async () => {
  const { Mod } = fakeModule({ rejects: new Set(['kis']) });
  const gate = createOpGate(createChainValidator(async () => Mod));

  const probe = await gate.refresh('cube', [], CANDIDATES);
  assert.deepEqual([...probe.blocked], ['kis']);
  assert.equal(probe.complete, true);
});


/** Verifies a chain whose topology is unchanged is not re-swept. */
test('createOpGate skips a pass whose base and op names repeat', async () => {
  const probes = [];
  const { Mod } = fakeModule({ onOp: (op) => probes.push(op) });
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
 * bevel have. Both slide t up to 0.5, where truncate short-circuits to ambo.
 */
test('createOpGate re-sweeps when a param crosses the ambo lowering', async () => {
  for (const op of ['truncate', 'bevel']) {
    const probes = [];
    const { Mod } = fakeModule({ onOp: (name) => probes.push(name) });
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


test('a gate task yield preserves validator ordering and frees a cancelled standing mesh', async (t) => {
  let posted = 0;
  let closed = 0;
  let release;
  const paused = Promise.withResolvers();
  t.mock.method(globalThis, 'MessageChannel', class {
    constructor() {
      this.port1 = { onmessage: null, close: () => { closed += 1; } };
      this.port2 = {
        close: () => { closed += 1; },
        postMessage: () => {
          const deliver = () => this.port1.onmessage();
          if (++posted === 2) {
            release = deliver;
            paused.resolve();
          } else queueMicrotask(deliver);
        },
      };
    }
  });
  const { Mod, state } = fakeModule();
  const validator = createChainValidator(async () => Mod);
  const gate = createOpGate(validator);
  const stale = gate.refresh('cube', [], ['kis', 'ambo']);
  await paused.promise;
  assert.deepEqual(state.calls, ['base:cube', 'kis', 'classifyFaces']);
  assert.equal(state.live, 1);

  const edit = validator.chainIsValid('tetrahedron', ['dual']);
  const current = gate.refresh('octahedron', [], ['zip']);
  await Promise.resolve();
  assert.deepEqual(state.calls, ['base:cube', 'kis', 'classifyFaces']);
  release();

  assert.equal(await stale, null);
  assert.equal((await edit).ok, true);
  assert.equal((await current).complete, true);
  assert.deepEqual(state.calls, [
    'base:cube', 'kis', 'classifyFaces',
    'base:tetrahedron', 'dual', 'classifyFaces',
    'base:octahedron', 'zip', 'classifyFaces',
  ]);
  assert.equal(state.live, 0);
  assert.equal(closed, posted * 2);
});

/** A pass the chain outran reports nothing. */
test('createOpGate discards a pass the chain changed under', async () => {
  const { Mod } = fakeModule();
  const gate = createOpGate(createChainValidator(async () => Mod));

  const first = gate.refresh('cube', [], CANDIDATES);
  const second = gate.refresh('octahedron', [], CANDIDATES);
  assert.equal(await first, null);
  assert.deepEqual(await second, {
    blocked: new Set(), complete: true, abandoned: false,
  });
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


/**
 * Verifies a chain op the bridge soft-rejects while the standing chain is
 * rebuilt frees the mesh it was applied to and the arenas, as the validator's
 * own rejection path does.
 */
test('createOpGate frees the standing chain when its rebuild is rejected', async () => {
  const { Mod, state } = fakeModule({ rejects: new Set(['kis']) });
  const gate = createOpGate(createChainValidator(async () => Mod));

  const probe = await gate.refresh('cube', [{ op: 'kis', params: {} }], CANDIDATES);
  assert.equal(probe.complete, false);
  assert.equal(state.live, 0, 'the rebuild must free the mesh the rejected op was applied to');
  assert.equal(state.cleared, 1, 'a rejected rebuild flushes the arenas like a rejected validation');
});


/** Verifies a base the registry does not hold leaves the sweep incomplete, not blocking. */
test('createOpGate reports an unbuildable base as an incomplete pass', async () => {
  const { Mod } = fakeModule({ rejects: new Set(['base:nope']), reason: 'UNKNOWN_NAME' });
  const gate = createOpGate(createChainValidator(async () => Mod));

  const probe = await gate.refresh('nope', [], CANDIDATES);
  assert.deepEqual([...probe.blocked], []);
  assert.equal(probe.complete, false);
});



test('queued chain validation snapshots array membership and nested parameters', async () => {
  const calls = [];
  const mesh = stubMesh(calls);
  const validator = createChainValidator(async () => ({
    MeshOps: { fromSolidName: () => mesh, clearToolingMemory() {}, getLastAdjusted: () => false },
  }));
  const ops = [{ op: 'truncate', params: { t: 0.3 } }];
  const pending = validator.chainIsValid('cube', ops);
  ops[0].params.t = 0.5;
  ops.push('dual');
  assert.equal((await pending).ok, true);
  assert.deepEqual(calls.filter(({ op }) => op === 'truncate' || op === 'dual'),
    [{ op: 'truncate', args: [0.3] }]);
});


test('createOpGate cancels a pending pass on returning to its cached chain and re-probes it after', async () => {
  const { Mod } = fakeModule();
  const gate = createOpGate(createChainValidator(async () => Mod));
  assert.notEqual(await gate.refresh('cube', [], CANDIDATES), null);
  const pending = gate.refresh('octahedron', [], CANDIDATES);
  assert.equal(await gate.refresh('cube', [], CANDIDATES), null);
  const renewed = gate.refresh('octahedron', [], CANDIDATES);
  assert.equal(await pending, null);
  assert.equal((await renewed).complete, true);
});


test('createOpGate re-sweeps the last complete chain after an incomplete verdict', async () => {
  const healthy = fakeModule().Mod;
  const trapped = fakeModule({ onOp: (op) => { if (op === 'ambo') throw new WebAssembly.RuntimeError('trap'); } }).Mod;
  let pass = 0;
  const modules = [healthy, trapped, null, healthy];
  const validator = {
    withValidator: (fn) => fn(modules[pass++]),
    acquire: async () => modules[pass++],
    noteDeath() {},
  };
  const gate = createOpGate(validator);
  assert.equal((await gate.refresh('cube', [], CANDIDATES)).complete, true);
  const incomplete = await gate.refresh('tetrahedron', [], CANDIDATES);
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.blocked.size > 0);
  const restored = await gate.refresh('cube', [], CANDIDATES);
  assert.equal(restored.complete, true);
  assert.equal(restored.blocked.size, 0);
});


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
  assert.ok(bare.length > 0);

  for (const op of bare) {
    const { funcName, recipe } = generateFuncAndRecipe({ base: 'cube', ops: [op] });
    assert.equal(funcName, `cube_${op}`);
    assert.equal(recipe, `SolidBuilder(cube(a, b), a, b).${op}().build()`);

    const calls = [];
    applyOp(stubMesh(calls), op);
    assert.deepEqual(calls, [{ op, args: [] }]);
  }
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
    [['cube', [{ op: 'truncate', params: { t: OP_DEFS.truncate.params.t.max + OP_DEFS.truncate.params.t.step } }]],
      /carries out-of-range "t"/],
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
    new RegExp(`at most ${MAX_RECIPE_STEPS}`), 'one op past the cap is refused');
  assert.match(queueSavedSolidRestore({ base: 'cube', ops: [...atCap, kis()] },
    () => assert.fail('a refused chain must not be queued')) ?? '', new RegExp(`at most ${MAX_RECIPE_STEPS}`));
});

test('the engine sweep contract names authored primitive ops', () => {
  for (const op of [...Object.keys(MORPH_SWEEP.bands), ...MORPH_SWEEP.unswept]) {
    assert.ok(op in OP_DEFS, `the engine names ${op}, which OP_DEFS does not author`);
    assert.equal(op in LOWERING, false,
      `${op} lowers to primitives before the engine's morph check reads it`);
  }
});

test('composite sweep exemptions stay inside the engine primitive bands', () => {
  const { min, max } = MORPH_SWEEP.bands.truncate.t;
  assert.ok(OP_DEFS.bevel.params.t.min >= min);
  assert.ok(OP_DEFS.bevel.params.t.max <= max);
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

  const [unswept] = MORPH_SWEEP.unswept;
  if (unswept) {
    assert.match(unsweepableReason({ op: unswept, params: seedOpParams(unswept, null) }),
      new RegExp(`^${unswept} is not swept by the morph path`),
      'an op with a leg kind but no sweep coverage is generated whole');
  }

  const { min, max } = MORPH_SWEEP.bands.chamfer.t;
  assert.equal(unsweepableReason({ op: 'chamfer', params: { t: max } }), null,
    'the band is inclusive at both ends');
  assert.equal(unsweepableReason({ op: 'chamfer', params: { t: min } }), null);
  assert.match(unsweepableReason({ op: 'chamfer', params: { t: max + 0.01 } }),
    /^chamfer sweeps t only over/,
    'the OP_DEFS slider reaches past the band, which is the drift this reports');
  if (OP_DEFS.chamfer.params.t.min < min) {
    assert.match(unsweepableReason({ op: 'chamfer', params: { t: OP_DEFS.chamfer.params.t.min } }),
      /^chamfer sweeps t only over/,
      'the slider also reaches below it');
  }
  assert.match(unsweepableReason({ op: 'chamfer', params: { t: min - 0.01 } }),
    /^chamfer sweeps t only over/, 'a value below the band is reported');
});

test('truncate reports the excluded topology interval at engine float precision', () => {
  for (const t of [0.5, 0.5 - 2 ** -26, 0.5 + 2 ** -26]) {
    assert.match(unsweepableReason({ op: 'truncate', params: { t } }),
      /^truncate cannot sweep t at 0\.5:/, `${t} becomes the engine pinch`);
  }
  const lower = Math.fround(MORPH_SWEEP.bands.truncate.t.excluded.lower);
  for (const t of [lower + 2 ** -25, 0.499, 0.5 - 2 ** -25]) {
    assert.match(unsweepableReason({ op: 'truncate', params: { t } }),
      /^truncate cannot sweep t at /, `${t} lies inside the excluded interval`);
  }
  for (const t of [lower - 2 ** -25, lower, lower + 2 ** -27, 0.5 + 2 ** -24]) {
    assert.equal(unsweepableReason({ op: 'truncate', params: { t } }), null,
      `${t} remains outside the pinch`);
  }
  assert.equal(unsweepableReason({ op: 'bevel', params: { t: 0.5 } }), null,
    'bevel lowers its pinch to AMBO before morphability is checked');
});

test('a slider reaching past its swept band is reported rather than silent', () => {
  const overreaching = [];
  for (const [op, band] of Object.entries(MORPH_SWEEP.bands)) {
    for (const [key, { min, max, excluded }] of Object.entries(band)) {
      const def = OP_DEFS[op].params[key];
      assert.ok(def, `MORPH_SWEEP bounds ${op}.${key}, which OP_DEFS does not declare`);
      if (def.min >= min && def.max <= max) {
        for (const endpoint of [def.min, def.max]) {
          const reason = unsweepableReason({ op, params: { [key]: endpoint } });
          if (excluded && Math.fround(endpoint) > Math.fround(excluded.lower)
              && Math.fround(endpoint) <= Math.fround(excluded.upper)) {
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
  assert.ok(overreaching.length > 0, 'the marker case has a row to exercise');
});
