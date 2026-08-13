//
// Run: node --test --experimental-test-module-mocks "tests/*.test.js"
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '../worker_protocol.js';
import {
  unpinnedEngineMethods, ParamSetResult, ClipSetResult,
  ResolutionSetResult, EffectSetResult,
  FullConfigRestoreResult,
} from './fake_engine.js';

// ---------------------------------------------------------------------------
// Fakes — installed BEFORE importing the worker, which binds self.postMessage
// and assigns self.onmessage at module-evaluation time. `globalThis.self` is
// never restored, which is only safe because `node --test` gives each test file
// its own process.
// ---------------------------------------------------------------------------

const posted = [];
/** @type {{ postMessage: Function, onmessage: ?Function, onmessageerror: ?Function }} */
const fakeSelf = {
  postMessage(msg, transfer) { posted.push({ msg, transfer }); },
  onmessage: null,
  onmessageerror: null,
};
globalThis.self = fakeSelf;

/**
 * Stand-in for the WASM HolosphereEngine. Records the method calls the worker
 * makes and synthesizes a deterministic pixel buffer so extraction is
 * verifiable. setResolution only adopts a new size when `resolutionOk` is true,
 * mirroring the real factory's "can't build that size" failure.
 */
class FakeEngine {
  constructor() {
    this.curW = 0;
    this.curH = 0;
    this.resolutionOk = true;
    this.effectOk = true;
    this.clipOk = true;
    this.fullFrame = false;
    this.clip = null;
    this.effect = null;
    this.params = [];
    this.paused = false;
    this.poleLod = null;
    this.presetCount = 3;
    this.presetIndex = 0;
    this.metricsThrows = false;
    this.calls = [];
    // Reused view, like the real engine's getParamValues() into WASM memory, so
    // the worker's Array.from() copy-out is load-bearing (a passthrough would
    // send this live buffer, not a detached snapshot).
    this.paramView = Uint16Array.of(5, 15, 25);
  }
  setResolution(w, h) {
    this.calls.push(['setResolution', w, h]);
    if (!this.resolutionOk) return ResolutionSetResult.UNSUPPORTED;
    this.curW = w;
    this.curH = h;
    this.effect = null;
    this.clip = null;
    return ResolutionSetResult.RESIZED;
  }
  // Clearing params models the engine rebuilding to defaults, so the
  // "params re-applied AFTER setEffect" ordering is observable. A rejection
  // keeps the current effect and its params, like a failed factory build.
  setEffect(name) {
    this.calls.push(['setEffect', name]);
    if (!this.effectOk) return EffectSetResult.UNKNOWN_EFFECT;
    this.effect = name;
    this.params = [];
    this.presetIndex = 0;
    return EffectSetResult.INSTALLED;
  }
  setParameter(name, value) {
    this.params.push([name, value]);
    return ParamSetResult.APPLIED;
  }
  getFullConfigSnapshot() { return null; }
  restoreFullConfigSnapshot(snapshot) {
    this.calls.push(['restoreFullConfigSnapshot', snapshot]);
    return FullConfigRestoreResult.APPLIED;
  }
  getFullConfigFieldDefinitions() { return []; }
  getConfigImportNotice() { return ''; }
  clearConfigImportNotice() {}
  setAnimationsPaused(p) {
    this.calls.push(['setAnimationsPaused', p]);
    this.paused = p;
  }
  getPresetCount() { return this.presetCount; }
  getPresetIndex() { return this.presetIndex; }
  selectPreset(index) {
    this.calls.push(['selectPreset', index]);
    if (index < 0 || index >= this.presetCount) return false;
    this.presetIndex = index;
    return true;
  }
  synchronizePreset(index) { return this.selectPreset(index); }
  nextPreset() {
    return this.selectPreset((this.presetIndex + 1) % this.presetCount);
  }
  previousPreset() {
    return this.selectPreset(
      (this.presetIndex + this.presetCount - 1) % this.presetCount);
  }
  setPoleLod(v) {
    this.calls.push(['setPoleLod', v]);
    this.poleLod = v;
  }
  // `fullFrame` models a needs_full_frame() effect: the bounds are accepted but
  // the clip stays at the full canvas.
  setClip(x0, x1, y0, y1) {
    if (!this.effect) return ClipSetResult.NO_EFFECT;
    if (!this.clipOk) return ClipSetResult.INVALID_BOUNDS;
    if (this.fullFrame) return ClipSetResult.FULL_FRAME_KEPT;
    this.clip = { y0, y1, x0, x1 };
    return ClipSetResult.APPLIED;
  }
  drawFrame() { this.calls.push(['drawFrame']); }
  getParamValues() { return this.paramView; }
  /** Each channel encodes its flat canvas index so extraction can be checked. */
  getPixels() {
    const buf = new Uint16Array(this.curW * this.curH * 3);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) & 0xffff;
    return buf;
  }
  getArenaMetrics() {
    if (this.metricsThrows) throw new Error('binding gone');
    const arena = (u, hw, c) => ({ usage: u, high_water_mark: hw, capacity: c });
    return {
      scratch_arena_a: arena(1, 2, 3),
      scratch_arena_b: arena(4, 5, 6),
      persistent_arena: arena(7, 8, 9),
    };
  }
}

test('FakeEngine mocks only methods the real engine surface pins', () => {
  assert.deepEqual(unpinnedEngineMethods(new FakeEngine()), [],
    'engine_contract_wasm.test.js never checks these against the real module');
});

/** The single engine the mocked factory hands back, so tests can configure it. */
let engineInstance = null;
/** Seeds the next-constructed engine's resolutionOk, so init-time rejection is testable. */
let nextResolutionOk = true;
/** Seeds the next-constructed engine's effectOk, so init-time rejection is testable. */
let nextEffectOk = true;
/** Seeds the next-constructed engine's clipOk, so init-time rejection is testable. */
let nextClipOk = true;
/** Options the worker handed the module factory, where the instantiate hook lands. */
let moduleOptions = null;
mock.module('../holosphere_wasm.js', {
  defaultExport: async (options) => {
    moduleOptions = options;
    return {
      ParamSetResult,
      ClipSetResult,
      ResolutionSetResult,
      EffectSetResult,
      FullConfigRestoreResult,
      HolosphereEngine: class {
        constructor() {
          engineInstance = new FakeEngine();
          engineInstance.resolutionOk = nextResolutionOk;
          engineInstance.effectOk = nextEffectOk;
          engineInstance.clipOk = nextClipOk;
          return engineInstance;
        }
      },
    };
  },
});

await import('../segment_worker.js');

// 'booted' is posted once at module-eval time, before any beforeEach clears `posted`.
const bootedAtLoad = posted.filter((p) => p.msg.type === 'booted');

/**
 * Deliver one protocol message through the worker's serialized queue and wait
 * for it to settle. onmessage returns the queue tail, so awaiting it tracks the
 * real settle point rather than a fixed number of microtask turns. The error
 * path resolves the tail (the rethrow is deferred to a fresh task), so this
 * never stalls on a thrown handler.
 * @param {Object} msg - Protocol message to deliver.
 * @returns {Promise<void>}
 */
async function dispatch(msg) {
  // Stamp the current protocol version on init so per-test messages needn't
  // repeat it; a test probing the mismatch path passes an explicit version.
  if (msg.type === 'init') {
    msg = { version: PROTOCOL_VERSION, paramRevision: 0, ...msg };
  } else if (msg.type === 'setEffect' || msg.type === 'setParameter') {
    msg = { paramRevision: 0, ...msg };
  }
  await fakeSelf.onmessage({ data: msg });
}

beforeEach(() => {
  posted.length = 0;
  engineInstance = null;
  moduleOptions = null;
  nextResolutionOk = true;
  nextEffectOk = true;
  nextClipOk = true;
});

/** The worker posts 'booted' at module load; the controller's boot watchdog depends on this ping. */
test('worker posts booted at module load', () => {
  assert.equal(bootedAtLoad.length, 1, 'exactly one booted ping emitted at load');
  assert.equal(bootedAtLoad[0].msg.version, PROTOCOL_VERSION, 'booted carries the protocol version');
});

/** A version mismatch faults before any WASM work so the controller stops fast. */
test('init faults on a protocol version mismatch', async () => {
  await dispatch({ type: 'init', version: PROTOCOL_VERSION + 1,
                   segId: 2, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });

  assert.equal(engineInstance, null, 'no engine constructed on version mismatch');
  const failed = posted.find((p) => p.msg.type === 'engineRejected');
  assert.ok(failed, 'engineRejected posted');
  assert.match(failed.msg.reason, /protocol version/);
  assert.equal(posted.find((p) => p.msg.type === 'ready'), undefined, 'no ready posted');
});

/** A render before init faults rather than replying with nothing and stalling the fence. */
test('render before a completed init faults instead of dropping the reply', async () => {
  const captured = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { captured.push(fn); return 0; };
  try {
    await dispatch({ type: 'render' });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(engineInstance, null, 'no engine was ever built for this dispatch');
  assert.equal(posted.length, 0, 'nothing was posted back');
  assert.equal(captured.length, 1, 'one rethrow task scheduled');
  assert.throws(() => captured[0](), /render before a completed init/);
});

/** Header-only module: valid, imports nothing, so it instantiates against `{}`. */
const EMPTY_WASM = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);

test('init instantiates a controller-supplied module through the glue hook', async () => {
  const compiled = await WebAssembly.compile(EMPTY_WASM);
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4,
                   effectName: 'Plasma', wasmModule: compiled });

  const instantiate = moduleOptions.instantiateWasm;
  assert.ok(instantiate, 'the glue is handed an instantiate hook');
  const handed = await new Promise((resolve) => {
    instantiate({}, (instance, module) => resolve({ instance, module }));
  });
  assert.ok(handed.instance instanceof WebAssembly.Instance,
    'the hook answers with an instance of its own, so this heap stays private');
  assert.equal(handed.module, compiled, 'built from the shared compilation');
});

test('init without a supplied module leaves the glue its own load path', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  assert.equal(moduleOptions.instantiateWasm, undefined,
    'no hook installed, so the glue fetches and compiles the binary itself');
});

/**
 * The glue's instantiate promise has no rejection path, so a failure inside the
 * hook must be reported here or the worker never answers and the controller
 * waits out its whole init watchdog.
 */
test('a failed instantiate of a supplied module reports instead of hanging', async () => {
  // One unsatisfied function import ("a"."b"), so instantiating against {} fails.
  const needsImport = await WebAssembly.compile(Uint8Array.of(
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    1, 4, 1, 0x60, 0, 0,
    2, 7, 1, 1, 0x61, 1, 0x62, 0, 0));
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4,
                   effectName: 'Plasma', wasmModule: needsImport });

  posted.length = 0;
  moduleOptions.instantiateWasm({}, () => assert.fail('instantiation cannot succeed'));
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const failed = posted.find((p) => p.msg.type === 'engineRejected');
  assert.ok(failed, 'engineRejected posted');
  assert.match(failed.msg.reason, /shared module instantiate failed/);
});

/**
 * The version gate is the first statement of the init handler, so a mismatched
 * init latches nothing: the worker keeps the segment identity it was built with,
 * for both the frame tag and every later segRange recompute.
 */
test('a version-mismatched init latches no segment identity', async () => {
  await dispatch({ type: 'init', segId: 3, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });
  const built = engineInstance;

  posted.length = 0;
  await dispatch({ type: 'init', version: PROTOCOL_VERSION + 1,
                   segId: 0, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });
  assert.equal(engineInstance, built, 'no second engine constructed');
  assert.match(posted.find((p) => p.msg.type === 'engineRejected').msg.reason, /protocol version/);

  posted.length = 0;
  await dispatch({ type: 'render' });
  const frame = posted.find((p) => p.msg.type === 'frame').msg;
  assert.equal(frame.segId, 3, 'frame still tagged with the original segment');
  assert.deepEqual([frame.x0, frame.x1, frame.y0, frame.y1], [4, 8, 2, 4]);

  // The recompute reads segId/totalSegs afresh: segId 3 of 4 over 16x8 → [8,16)x[4,8).
  posted.length = 0;
  await dispatch({ type: 'setResolution', w: 16, h: 8 });
  await dispatch({ type: 'render' });
  const resized = posted.find((p) => p.msg.type === 'frame').msg;
  assert.deepEqual([resized.x0, resized.x1, resized.y0, resized.y1], [8, 16, 4, 8]);
});

/** init builds the segRange, drives the engine setup in order, and posts ready. */
test('init applies the segment clip and posts ready', async () => {
  await dispatch({ type: 'init', segId: 3, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });

  assert.ok(engineInstance, 'engine constructed');
  assert.deepEqual(engineInstance.calls[0], ['setResolution', 8, 4]);
  assert.equal(engineInstance.effect, 'Plasma');
  // segId 3 of 4 over 8x4 → arm B (x0=4), bottom band (y0=2): clip {2,4,4,8}.
  assert.deepEqual(engineInstance.clip, { y0: 2, y1: 4, x0: 4, x1: 8 });

  assert.ok(posted.some((p) => p.msg.type === 'ready'), 'ready posted');
});

/** Regression: an init whose setResolution is rejected posts no ready and an explicit engineRejected so the controller faults at once. */
test('init with a rejected resolution posts engineRejected, not ready', async () => {
  nextResolutionOk = false;
  await dispatch({ type: 'init', segId: 0, totalSegs: 1, w: 8, h: 4, effectName: 'Plasma' });

  assert.ok(engineInstance, 'engine constructed');
  assert.deepEqual(engineInstance.calls[0], ['setResolution', 8, 4], 'setResolution attempted');
  assert.ok(!posted.some((p) => p.msg.type === 'ready'), 'no ready for a rejected resolution');
  const failed = posted.find((p) => p.msg.type === 'engineRejected');
  assert.ok(failed, 'engineRejected posted');
  assert.match(failed.msg.reason, /setResolution\(8, 4\) rejected/);
});

/** An init whose setEffect is rejected posts no ready, no clip, and an explicit engineRejected. */
test('init with a rejected effect posts engineRejected, not ready', async () => {
  nextEffectOk = false;
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma',
                   params: [{ name: 'Speed', value: 0.5 }] });

  assert.ok(engineInstance, 'engine constructed');
  assert.deepEqual(engineInstance.calls.at(-1), ['setEffect', 'Plasma'], 'setEffect attempted');
  assert.equal(engineInstance.effect, null, 'no effect adopted');
  assert.deepEqual(engineInstance.params, [], 'carried params are not applied to a dead engine');
  assert.equal(engineInstance.clip, null, 'no clip applied');
  assert.ok(!posted.some((p) => p.msg.type === 'ready'), 'no ready for a rejected effect');
  const failed = posted.find((p) => p.msg.type === 'engineRejected');
  assert.ok(failed, 'engineRejected posted');
  assert.match(failed.msg.reason, /setEffect\(Plasma\) rejected/);
});

/** An init whose clip is rejected has no render geometry, so it posts no ready. */
test('init with a rejected clip posts engineRejected, not ready', async () => {
  nextClipOk = false;
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });

  const failed = posted.find((p) => p.msg.type === 'engineRejected');
  assert.ok(failed, 'engineRejected posted');
  assert.match(failed.msg.reason, /setClip\(0, 4, 0, 4\) rejected/);
  assert.equal(posted.find((p) => p.msg.type === 'ready'), undefined,
    'a worker rendering no geometry must not report itself ready');
});

/** render copies exactly this segment's quadrant rows out of the full buffer. */
test('render extracts only this segment quadrant from the canvas buffer', async () => {
  await dispatch({ type: 'init', segId: 3, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  await dispatch({ type: 'render' });

  const frame = posted.find((p) => p.msg.type === 'frame').msg;
  // Quadrant is the bottom-right 4x2 block: x in [4,8), y in [2,4).
  assert.deepEqual([frame.x0, frame.x1, frame.y0, frame.y1], [4, 8, 2, 4]);

  // Source buffer uses the same encoding as FakeEngine.getPixels.
  const W = 8;
  const src = new Uint16Array(W * 4 * 3);
  for (let i = 0; i < src.length; i++) src[i] = (i * 7) & 0xffff;
  for (let ry = 0; ry < 2; ry++) {
    for (let rx = 0; rx < 4; rx++) {
      for (let c = 0; c < 3; c++) {
        const dst = (ry * 4 + rx) * 3 + c;
        const sx = 4 + rx;
        const sy = 2 + ry;
        const s = (sy * W + sx) * 3 + c;
        assert.equal(frame.pixels[dst], src[s], `pixel (${rx},${ry}) ch${c}`);
      }
    }
  }
});

/** A returned buffer of the right size is refilled in place; anything else allocates. */
test('render refills a recycled buffer and allocates on a size mismatch', async () => {
  await dispatch({ type: 'init', segId: 3, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });

  posted.length = 0;
  const recycle = new Uint16Array(4 * 2 * 3);
  // Stale marker no extracted pixel can carry: FakeEngine encodes (i*7)&0xffff
  // over a 96-element source, so every legitimate value is <= 665. A partial
  // refill leaves a survivor rather than a plausible-looking zero.
  const STALE = 0xbeef;
  recycle.fill(STALE);
  await dispatch({ type: 'render', recycle });
  const reused = posted.find((p) => p.msg.type === 'frame');
  assert.equal(reused.msg.pixels, recycle, 'the returned buffer was refilled, not replaced');
  assert.deepEqual(reused.transfer, [recycle.buffer], 'and transferred straight back');
  assert.equal(recycle.indexOf(STALE), -1, 'every element is overwritten by the extraction');

  posted.length = 0;
  const wrongSize = new Uint16Array(4);
  await dispatch({ type: 'render', recycle: wrongSize });
  const fresh = posted.find((p) => p.msg.type === 'frame').msg;
  assert.notEqual(fresh.pixels, wrongSize, 'a size mismatch falls back to allocation');
  assert.equal(fresh.pixels.length, 4 * 2 * 3);

  posted.length = 0;
  await dispatch({ type: 'render' });
  const none = posted.find((p) => p.msg.type === 'frame').msg;
  assert.equal(none.pixels.length, 4 * 2 * 3, 'a render with no recycle still allocates');
});

/** Arena metrics are marshalled into a plain, transfer-safe object. */
test('render marshals arena metrics into a plain object', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  await dispatch({ type: 'render' });

  const frame = posted.find((p) => p.msg.type === 'frame').msg;
  assert.deepEqual(frame.arenaMetrics, {
    scratch_arena_a: { usage: 1, high_water_mark: 2, capacity: 3 },
    scratch_arena_b: { usage: 4, high_water_mark: 5, capacity: 6 },
    persistent_arena: { usage: 7, high_water_mark: 8, capacity: 9 },
  });
});

/** A failing getArenaMetrics is surfaced as null without dropping the frame. */
test('render still posts a frame when getArenaMetrics throws', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  engineInstance.metricsThrows = true;
  posted.length = 0;
  const warn = mock.method(console, 'warn', () => {});
  await dispatch({ type: 'render' });
  warn.mock.restore();

  const frame = posted.find((p) => p.msg.type === 'frame');
  assert.ok(frame, 'frame still posted');
  assert.equal(frame.msg.arenaMetrics, null);
});

/** A pixel buffer whose length disagrees with the canvas faults instead of zero-filling the tail. */
test('render faults on a pixel buffer of the wrong length', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  engineInstance.getPixels = () => new Uint16Array(8 * 4 * 3 - 3); // one pixel short
  const captured = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { captured.push(fn); return 0; };
  try {
    await dispatch({ type: 'render' });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(captured.length, 1, 'one rethrow task scheduled');
  assert.throws(() => captured[0](), /pixel buffer length/);
});

/** A protocol-drift message type fails fast (rethrown to onerror) instead of being silently dropped. */
test('an unknown message type faults instead of being silently dropped', async () => {
  const captured = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { captured.push(fn); return 0; };
  try {
    await dispatch({ type: 'bogusProtocolDrift' });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(captured.length, 1, 'one rethrow task scheduled');
  assert.throws(() => captured[0](), /unknown message type/);
});

/** Segment 0 mirrors its post-frame param values; other segments send null. */
test('render streams param values from segment 0 only', async () => {
  await dispatch({
    type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4,
    effectName: 'Plasma', paramRevision: 11,
  });
  posted.length = 0;
  await dispatch({ type: 'render' });
  const frame0 = posted.find((p) => p.msg.type === 'frame').msg;
  assert.ok(Array.isArray(frame0.paramValues), 'paramValues is a detached plain array');
  assert.deepEqual(frame0.paramValues, [5, 15, 25], 'segment 0 carries params');
  assert.equal(frame0.paramRevision, 11, 'the frame carries its applied write revision');
  // Mutating the engine's reused view after the frame is posted must not disturb
  // the sent values, proving the worker copied them out rather than forwarding.
  engineInstance.paramView[0] = 999;
  assert.deepEqual(frame0.paramValues, [5, 15, 25], 'sent values are a snapshot');

  await dispatch({ type: 'init', segId: 1, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  await dispatch({ type: 'render' });
  const frame1 = posted.find((p) => p.msg.type === 'frame').msg;
  assert.equal(frame1.paramValues, null, 'non-zero segments omit params');
});

/**
 * Regression: an UNSUPPORTED setResolution must leave the worker's geometry and
 * clip untouched, so it keeps extracting the old-size quadrant.
 */
test('a rejected setResolution leaves segRange and clip untouched', async () => {
  await dispatch({ type: 'init', segId: 3, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });
  const clipBefore = { ...engineInstance.clip };

  engineInstance.resolutionOk = false;
  await dispatch({ type: 'setResolution', w: 16, h: 8 });
  assert.deepEqual(engineInstance.calls.find((c) => c[0] === 'setResolution' && c[1] === 16),
    ['setResolution', 16, 8]);
  assert.deepEqual(engineInstance.clip, clipBefore);

  posted.length = 0;
  await dispatch({ type: 'render' });
  const frame = posted.find((p) => p.msg.type === 'frame').msg;
  assert.deepEqual([frame.x0, frame.x1, frame.y0, frame.y1], [4, 8, 2, 4]);
});

/** A successful resize defers clipping until the following effect rebuild. */
test('an accepted setResolution defers the clip until setEffect', async () => {
  await dispatch({ type: 'init', segId: 3, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  await dispatch({ type: 'setResolution', w: 16, h: 8 });
  assert.equal(engineInstance.clip, null, 'the effectless engine is not clipped');
  assert.equal(posted.find((p) => p.msg.type === 'engineRejected'), undefined);

  await dispatch({ type: 'setEffect', name: 'Plasma' });
  // segId 3 of 4 over 16x8 → arm B (x0=8), bottom band (y0=4): clip {4,8,8,16}.
  assert.deepEqual(engineInstance.clip, { y0: 4, y1: 8, x0: 8, x1: 16 });

  posted.length = 0;
  await dispatch({ type: 'render' });
  const frame = posted.find((p) => p.msg.type === 'frame').msg;
  assert.deepEqual([frame.x0, frame.x1, frame.y0, frame.y1], [8, 16, 4, 8]);
});

/** A structured-clone failure is reported immediately to the controller. */
test('worker reports inbound message deserialization failures', () => {
  const error = { type: 'messageerror' };
  const logged = mock.method(console, 'error', () => {});

  fakeSelf.onmessageerror(error);

  logged.mock.restore();
  assert.deepEqual(posted.at(-1).msg, {
    type: 'engineRejected',
    reason: 'message deserialization failed',
  });
});

/**
 * An init carrying no effectName leaves the engine effectless, so its trailing
 * applyClip can only answer NO_EFFECT. That is the ordinary state the following
 * setEffect resolves — faulting on it would latch the whole pool with nothing
 * actually wrong.
 */
test('an init without an effect name does not fault the pool', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4 });

  assert.ok(engineInstance, 'engine constructed');
  assert.equal(engineInstance.effect, null, 'no effect installed');
  assert.equal(engineInstance.clip, null, 'an effectless engine takes no clip');
  assert.equal(posted.find((p) => p.msg.type === 'engineRejected'), undefined,
    'NO_EFFECT must not post engineRejected');
  assert.ok(posted.some((p) => p.msg.type === 'ready'), 'ready posted');
});

/** A clip rejection is surfaced immediately instead of rendering full-canvas. */
test('a rejected clip posts engineRejected', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  engineInstance.clipOk = false;

  await dispatch({ type: 'setEffect', name: 'Waves' });

  const failed = posted.find((p) => p.msg.type === 'engineRejected');
  assert.ok(failed);
  assert.match(failed.msg.reason, /setClip\(0, 4, 0, 4\) rejected/);
});

/**
 * FULL_FRAME_KEPT is a success, not a rejection: a cross-segment stateful effect
 * renders the whole canvas in every worker and the pool must keep running.
 */
test('a full-frame-kept clip does not fault the pool', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  engineInstance.fullFrame = true;

  await dispatch({ type: 'setEffect', name: 'MeshFeedback' });

  assert.equal(posted.find((p) => p.msg.type === 'engineRejected'), undefined,
    'FULL_FRAME_KEPT must not post engineRejected');
});

/**
 * A rejected clip leaves the engine on its previous one, so the reported
 * disposition must stay on that clip too — otherwise every later frame claims a
 * band render the worker never did.
 */
test('a rejected clip leaves the reported clip disposition alone', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  engineInstance.fullFrame = true;
  await dispatch({ type: 'setEffect', name: 'MeshFeedback' });
  posted.length = 0;
  await dispatch({ type: 'render' });
  assert.equal(posted.find((p) => p.msg.type === 'frame').msg.fullFrame, true,
    'the kept full-canvas clip is in force');

  engineInstance.clipOk = false;
  await dispatch({ type: 'setEffect', name: 'Waves' });
  posted.length = 0;
  await dispatch({ type: 'render' });
  assert.equal(posted.find((p) => p.msg.type === 'frame').msg.fullFrame, true,
    'a rejected clip does not downgrade the report to a band render');
});

/**
 * The two clip successes describe different work: APPLIED shades the band,
 * FULL_FRAME_KEPT shades the whole canvas in every worker. Nothing else in a
 * 'frame' separates them, so the pool would otherwise read N full-canvas
 * renders as an N-way speedup.
 */
test('a frame reports whether the whole canvas was shaded', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  await dispatch({ type: 'render' });
  assert.equal(posted.find((p) => p.msg.type === 'frame').msg.fullFrame, false,
    'an installed band is a clipped render');

  engineInstance.fullFrame = true;
  await dispatch({ type: 'setEffect', name: 'MeshFeedback' });
  posted.length = 0;
  await dispatch({ type: 'render' });
  assert.equal(posted.find((p) => p.msg.type === 'frame').msg.fullFrame, true,
    'a kept full-canvas clip is reported as one');
});

/**
 * The serialized queue must isolate a failure (later messages still run) and
 * rethrow it on a fresh task so it reaches the worker's global error handler
 * rather than vanishing as an unhandled rejection.
 */
test('a throwing message is isolated and rethrown on a fresh task', async () => {
  const captured = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { captured.push(fn); return 0; };
  try {
    // An odd totalSegs makes computeSegmentRange throw inside handleMessage.
    await dispatch({ type: 'init', segId: 0, totalSegs: 3, w: 8, h: 4 });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(captured.length, 1, 'one rethrow task scheduled');
  assert.throws(() => captured[0](), /positive even number/);

  posted.length = 0;
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  assert.ok(posted.find((p) => p.msg.type === 'ready'), 'queue still processes after a failure');
});

// ---------------------------------------------------------------------------
// Live-tuning handlers — setEffect / setParameter / setAnimationsPaused
// ---------------------------------------------------------------------------

test('init applies the carried params AFTER setEffect rebuilds to defaults', async () => {
  await dispatch({
    type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma',
    params: [{ name: 'Speed', value: 0.5 }, { name: 'Glow', value: 1.0 }],
  });
  assert.equal(engineInstance.effect, 'Plasma');
  assert.deepEqual(engineInstance.params, [['Speed', 0.5], ['Glow', 1.0]]);
});

test('init restores accepted params before replaying rejected requests', async () => {
  await dispatch({
    type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'ShaderBall',
    params: [
      { name: 'Planar Warp 1', acceptedValue: 0, value: 6 },
      { name: 'Planar Warp 1 Scale', acceptedValue: 1, value: 100 },
    ],
  });
  assert.deepEqual(engineInstance.params, [
    ['Planar Warp 1', 0], ['Planar Warp 1 Scale', 1],
    ['Planar Warp 1', 6], ['Planar Warp 1 Scale', 100],
  ]);
});

test('init restores ShaderBall full config atomically instead of replaying params', async () => {
  const snapshot = {
    schemaVersion: 2,
    accepted: [1, 2], requested: [1, 7], pendingFieldIds: [1],
    hasRuntime: false, runtime: [],
  };
  await dispatch({
    type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4,
    effectName: 'ShaderBall', fullConfigSnapshot: snapshot,
  });
  assert.deepEqual(engineInstance.calls.find((call) =>
    call[0] === 'restoreFullConfigSnapshot'),
  ['restoreFullConfigSnapshot', snapshot]);
  assert.deepEqual(engineInstance.params, []);
});

test('init selects the carried preset before applying tuned params', async () => {
  await dispatch({
    type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma',
    presetIndex: 2, params: [{ name: 'Speed', value: 0.5 }],
  });
  assert.equal(engineInstance.presetIndex, 2);
  assert.deepEqual(engineInstance.calls.slice(1, 3),
    [['setEffect', 'Plasma'], ['selectPreset', 2]]);
  assert.deepEqual(engineInstance.params, [['Speed', 0.5]]);
});

test('init with paused:true pauses animations on the rebuilt engine', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma', paused: true });
  assert.equal(engineInstance.paused, true);
});

/**
 * The decimation aggressiveness is per module instance, so a pool spawned after
 * the slider moved must inherit it or the composited preview renders at a
 * different LOD from the value the slider claims.
 */
test('init seeds the worker engine with the carried pole LOD', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4,
                   effectName: 'Plasma', poleLod: 1.25 });
  assert.equal(engineInstance.poleLod, 1.25);
});

test('init without a pole LOD leaves the engine default in place', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  assert.equal(engineInstance.poleLod, null, 'setPoleLod was never called');
});

test('setPoleLod handler forwards the value to the engine', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  await dispatch({ type: 'setPoleLod', value: 0.75 });
  assert.equal(engineInstance.poleLod, 0.75);
  assert.deepEqual(engineInstance.calls.at(-1), ['setPoleLod', 0.75]);
});

test('setEffect handler rebuilds, then re-applies the carried param snapshot', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  await dispatch({
    type: 'setEffect', name: 'Waves',
    params: [{ name: 'Freq', value: 0.25 }],
    paramRevision: 9,
  });
  assert.equal(engineInstance.effect, 'Waves', 'switched to the new effect');
  assert.deepEqual(engineInstance.params, [['Freq', 0.25]]);

  posted.length = 0;
  await dispatch({ type: 'render' });
  assert.equal(posted.find((p) => p.msg.type === 'frame').msg.paramRevision, 9);
});

test('setEffect restores ShaderBall snapshot after rebuilding', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4,
    effectName: 'Plasma' });
  const snapshot = {
    schemaVersion: 2,
    accepted: [3], requested: [4], pendingFieldIds: [0],
    hasRuntime: false, runtime: [],
  };
  await dispatch({
    type: 'setEffect', name: 'ShaderBall', fullConfigSnapshot: snapshot,
    paramRevision: 14,
  });
  assert.deepEqual(engineInstance.calls.slice(-2), [
    ['setEffect', 'ShaderBall'],
    ['restoreFullConfigSnapshot', snapshot],
  ]);
});

test('setEffect re-applies pause after rebuilding the worker engine', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  await dispatch({
    type: 'setEffect', name: 'Waves', paused: true,
    params: [{ name: 'Freq', value: 0.25 }],
  });

  assert.equal(engineInstance.effect, 'Waves');
  assert.deepEqual(engineInstance.params, [['Freq', 0.25]]);
  assert.equal(engineInstance.paused, true);
  assert.deepEqual(engineInstance.calls.slice(-2), [
    ['setEffect', 'Waves'],
    ['setAnimationsPaused', true],
  ]);
});

test('setEffect with no params just rebuilds, leaving defaults', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  await dispatch({ type: 'setEffect', name: 'Waves' });
  assert.equal(engineInstance.effect, 'Waves');
  assert.deepEqual(engineInstance.params, [], 'no snapshot to re-apply');
});

/**
 * A live setEffect rejection faults immediately rather than letting the
 * controller wait out its watchdog, and leaves the running effect and its params
 * in place instead of tuning a rebuild that never happened.
 */
test('a rejected setEffect posts engineRejected and re-applies nothing', async () => {
  await dispatch({
    type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma',
    params: [{ name: 'Speed', value: 0.5 }],
  });
  const clipBefore = { ...engineInstance.clip };
  posted.length = 0;
  engineInstance.effectOk = false;

  await dispatch({ type: 'setEffect', name: 'Waves', params: [{ name: 'Freq', value: 0.25 }] });

  assert.equal(engineInstance.effect, 'Plasma', 'the running effect is kept');
  assert.deepEqual(engineInstance.params, [['Speed', 0.5]], 'no params re-applied');
  assert.deepEqual(engineInstance.clip, clipBefore, 'the clip is untouched');
  const failed = posted.find((p) => p.msg.type === 'engineRejected');
  assert.ok(failed, 'engineRejected posted');
  assert.match(failed.msg.reason, /setEffect\(Waves\) rejected/);
});

test('setParameter handler forwards name/value and advances the frame revision', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  await dispatch({
    type: 'setParameter', name: 'Speed', value: 0.9, paramRevision: 12,
  });
  assert.deepEqual(engineInstance.params.at(-1), ['Speed', 0.9]);

  posted.length = 0;
  await dispatch({ type: 'render' });
  assert.equal(posted.find((p) => p.msg.type === 'frame').msg.paramRevision, 12);
});

test('setAnimationsPaused handler forwards the flag (both directions) to the engine', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  await dispatch({ type: 'setAnimationsPaused', paused: true });
  assert.equal(engineInstance.paused, true);
  await dispatch({ type: 'setAnimationsPaused', paused: false });
  assert.equal(engineInstance.paused, false);
});

test('selectPreset forwards the index and publishes preset state', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4,
    effectName: 'Plasma' });
  await dispatch({ type: 'selectPreset', index: 2, paramRevision: 13 });
  assert.equal(engineInstance.presetIndex, 2);

  posted.length = 0;
  await dispatch({ type: 'render' });
  const frame = posted.find((p) => p.msg.type === 'frame').msg;
  assert.equal(frame.presetCount, 3);
  assert.equal(frame.presetIndex, 2);
  assert.equal(frame.paramRevision, 13);
});

// ---------------------------------------------------------------------------
// Module graph
// ---------------------------------------------------------------------------

const REPO = fileURLToPath(new URL('..', import.meta.url));

/**
 * Static import/export-from specifiers of one module source. Dynamic `import()`
 * is out of scope: it resolves when it runs, and the generated WASM glue guards
 * a node-only one behind an environment check the worker never takes.
 * @param {string} source - Module source text.
 * @returns {string[]} Specifiers, in source order.
 */
function staticSpecifiers(source) {
  const specs = [];
  // Statement-anchored so a specifier-shaped string inside minified code is not
  // read as an import; the bounded gap spans a multi-line import clause.
  for (const m of source.matchAll(
    /^[ \t]*(?:import|export)[ \t][\s\S]{0,400}?from[ \t]*['"]([^'"]+)['"]/gm)) {
    specs.push(m[1]);
  }
  for (const m of source.matchAll(/^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm)) {
    specs.push(m[1]);
  }
  return specs;
}

// A worker resolves its own import graph, and the page's import map does not
// reach it, so a bare specifier anywhere in that graph fails the module load —
// as a message-less error Event, which the controller can only read as the
// transient fetch race it usually is, burning every boot retry on a failure
// that will never resolve.
test('the worker module graph carries no specifier an import map would resolve', () => {
  const reached = new Set();
  /** @param {string} file - Repo-relative, forward-slashed module path. */
  const walk = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    const source = readFileSync(join(REPO, file), 'utf8');
    for (const spec of staticSpecifiers(source)) {
      assert.ok(spec.startsWith('./') || spec.startsWith('../'),
        `${file} statically imports "${spec}"; import maps do not apply to `
        + 'workers, so only a relative specifier resolves inside the pool');
      walk(posix.normalize(posix.join(posix.dirname(file), spec)));
    }
  };
  walk('segment_worker.js');

  // Pinned, not just counted: a module joining the graph is a module the worker
  // now fetches on every spawn, and one leaving it takes its own gate with it.
  assert.deepEqual([...reached].sort(), [
    'holosphere_wasm.js',
    'segment_layout.js',
    'segment_worker.js',
    'worker_protocol.js',
  ]);
});
