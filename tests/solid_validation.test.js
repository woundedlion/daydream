import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommitQueue, createChainValidator, createOpGate } from '../src/workbench/solids/solid_validation.js';
import { readFileSync } from 'node:fs';
import { fakeModule, stubMesh } from './helpers/fake_meshops.js';

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
  assert.deepEqual(verdict, { ok: false, message: 'Op "kis" failed: op refused' });
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

test('gate blocks a classification refusal without reclaiming an unexhausted arena', async () => {
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


/**
 * Verifies every page gate binds the verdict instead of negating the call. The verdict
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
  const { Mod, state } = fakeModule({ onOp: (op) => {
    if (op === 'kis') throw new Error('op refused');
  } });
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


/** Verifies a pass the chain outran reports nothing rather than gating on stale probes. */
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