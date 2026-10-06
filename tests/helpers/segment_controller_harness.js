// SegmentController harness: the fake render driver, the controller factory,
// worker message drivers, and the console/global guards each suite installs.
import { mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDocument } from './fake_dom.js';
import { fakeColorAttribute } from './fake_three.js';
import { FakeWorker } from './fake_worker.js';
import { displayAliasesDiverged, repointDisplayAliases } from '../../src/engine/display_aliases.js';
import { SegmentController } from '../../src/segments/segment_controller.js';
import { pageWarmer } from '../fixtures/module_warmer_fixture.js';
import { PROTOCOL_VERSION } from '../../src/segments/worker_protocol.js';

// Stand-in for the injected Daydream renderer: the grid and display buffer the
// compositor reads, plus the dot mesh the second display alias lives on.
export const driver = {
  W: 0, H: 0, pixels: null,
  dotMesh: { instanceColor: fakeColorAttribute(null) },
  invalidations: 0,
  invalidate() { this.invalidations++; },
};

/** @param {number} width - Columns. @param {number} height - Rows. */
export function setDisplayGrid(width, height) {
  driver.W = width; driver.H = height;
  driver.pixels = new Uint16Array(width * height * 3);
}

const EXPECTED_CONSOLE_MESSAGES = {
  log: [
    /^\[Segmented\] Spawning \d+ workers\.\.\.$/,
    /^\[Segmented\] All \d+ workers ready$/,
  ],
  warn: [
    /^\[Segmented\] seg \d+ shared module rejected: .* \(attempt \d+\/\d+\); rebuilding pool$/,
    /^\[Segmented\] module warm failed/,
    /^\[Segmented\] seg \d+ module failed to load \(attempt \d+\/\d+\); rebuilding pool$/,
    /^\[Segmented\] additional worker fault \(seg -?\d+\): /,
    /^\[Segmented\] pool faulted on \d+ consecutive effect-switch rebuilds; /,
    /^\[Segmented\] shared WASM compile failed; each worker will compile its own$/,
    /^\[Segmented\] module warm did not finish within \d+s; /,
  ],
  error: [
    /^\[Segmented\] Worker seg \d+ error:/,
    /^\[Segmented\] Worker seg \d+ message deserialization failed$/,
    /^SegmentCompositor\.composite: display-buffer alias diverged /,
  ],
};
const PASSTHROUGH_CONSOLE_MESSAGES = {
  error: [/^\(node:\d+\) ExperimentalWarning: Module mocking is an experimental feature/],
};

/**
 * Install the per-file console capture, per-test driver reset, global
 * restore and the Worker/document doubles the controller runs against.
 * @returns {void}
 */
export function installSegmentControllerHarness() {
  const originalConsole = Object.fromEntries(
    Object.keys(EXPECTED_CONSOLE_MESSAGES)
      .map((method) => [method, console[method].bind(console)]),
  );
  const capturedConsole = [];
  const consoleMocks = Object.keys(EXPECTED_CONSOLE_MESSAGES)
    .map((method) => mock.method(console, method, (...args) => {
      capturedConsole.push({ method, args });
      const expected = EXPECTED_CONSOLE_MESSAGES[method]
        .some((pattern) => pattern.test(String(args[0])));
      if (!expected) originalConsole[method](...args);
    }));

  beforeEach(() => {
    driver.W = 0;
    driver.H = 0;
    driver.pixels = null;
    driver.invalidations = 0;
    // A fresh attribute per test: the length invariant binds at first upload and
    // the cases below composite at different grid sizes.
    driver.dotMesh.instanceColor = fakeColorAttribute(null);
    // destroy() keeps the compilation, so a default-warmer spawn in a later
    // test would carry the module this one warmed.
    pageWarmer.discard();
    FakeWorker.reset();
  });

  const savedGlobals = { Worker: globalThis.Worker, document: globalThis.document };
  const restoreGlobal = (key, val) => {
    if (val === undefined) delete globalThis[key];
    else globalThis[key] = val;
  };
  after(() => {
    for (const stub of consoleMocks) stub.mock.restore();
    restoreGlobal('Worker', savedGlobals.Worker);
    restoreGlobal('document', savedGlobals.document);

    const unexpected = capturedConsole.filter(({ method, args }) => {
      const message = String(args[0]);
      return !EXPECTED_CONSOLE_MESSAGES[method].some((pattern) => pattern.test(message))
        && !(PASSTHROUGH_CONSOLE_MESSAGES[method] ?? [])
          .some((pattern) => pattern.test(message));
    });
    assert.deepEqual(
      unexpected.map(({ method, args }) => `${method}: ${args.map(String).join(' ')}`),
      [],
      'unexpected console diagnostics',
    );
  });

  globalThis.Worker = FakeWorker;

  // getElementById -> null makes updateStats() early-return, keeping tick() tests DOM-free.
  installDocument({ getElementById: () => null });
}

/**
 * Build a controller wired to fake injected host deps.
 * @param {Object} [config] - Overrides for the controller's host environment.
 * @param {string} [config.resolution] - Initial app-state resolution key.
 * @param {string} [config.effect] - Initial app-state effect name.
 * @param {Object} [config.presets] - Resolution-preset map keyed by resolution name.
 * @param {Object} [config.moduleWarmer] - Warmer whose compilation the spawn hands to its workers; omitted leaves the page's.
 * @param {(message: string) => void} [config.onFault] - Host pool-fault callback.
 * @param {Object} [config.driver] - Alternate render driver.
 * @returns {SegmentController} Controller wired to fake injected deps.
 */
export function makeController({ resolution = 'lo', effect = 'TestEffect',
                         presets = { lo: { w: 4, h: 4 } },
                         moduleWarmer, onFault, driver: renderDriver = driver } = {}) {
  const state = { resolution, effect };
  return new SegmentController({
    moduleWarmer,
    onFault,
    resolutionPresets: presets,
    appState: { get: (k) => state[k], set: (k, v) => { state[k] = v; } },
    driver: renderDriver,
    getWasmEngine: () => null,
    refreshPixelView: () => {},
    getMemoryView: () => renderDriver.pixels,
    repointDisplayAliases: (view) => repointDisplayAliases(renderDriver, view),
    displayAliasesDiverged: (view) => displayAliasesDiverged(renderDriver, view),
  });
}

/**
 * Drive a worker's 'ready' message; once all arrive the controller is ready.
 * @param {SegmentController} controller - Controller owning the worker pool.
 * @param {number} segId - Index of the worker to signal ready.
 * @returns {void}
 */
export function deliverReady(controller, segId) {
  controller.workers[segId].onmessage({ data: { type: 'ready' } });
}

/**
 * Drive a worker's 'booted' ping (module body ran, static imports resolved).
 * @param {SegmentController} controller - Controller owning the worker pool.
 * @param {number} segId - Index of the worker to signal booted.
 * @returns {void}
 */
export function deliverBooted(controller, segId) {
  controller.workers[segId].onmessage({ data: { type: 'booted', version: PROTOCOL_VERSION } });
}

/**
 * Build a controller with `n` workers all signalled ready.
 * @param {number} [n] - Number of workers to create and mark ready.
 * @param {Object} [opts] - Options forwarded to makeController().
 * @returns {SegmentController} A ready controller with `n` workers.
 */
export function readyController(n = 2, opts = {}) {
  const c = makeController(opts);
  c.create(n);
  for (let s = 0; s < n; s++) deliverReady(c, s);
  return c;
}

/**
 * Let the renderParallel() promise's .then (pendingFrame/renderInFlight) run.
 * @returns {Promise<void>} Resolves on the next macrotask tick.
 */
export const flush = () => new Promise((r) => setImmediate(r));

/**
 * Publish one whole generation through the render loop, leaving it where a
 * completed frame does: the controller's own results, which only its own
 * scratch swap ever writes.
 * @param {SegmentController} controller - A ready controller.
 * @param {Array<Object>} bands - Per-segment frame overrides, in segment order.
 * @returns {Promise<void>} Resolves once the generation is published.
 */
export async function publishGeneration(controller, bands) {
  controller.tick();
  bands.forEach((band, segId) => deliverFrame(controller, segId, band));
  await flush();
}

/**
 * Deliver a worker->controller 'frame' message to segment `segId`.
 * @param {SegmentController} controller - Controller owning the worker pool.
 * @param {number} segId - Index of the worker delivering the frame.
 * @param {Object} [overrides] - Per-field overrides for the frame payload.
 * @param {Uint16Array} [overrides.pixels] - RGB16 quadrant pixel buffer.
 * @param {number} [overrides.x0] - Inclusive left display-buffer column.
 * @param {number} [overrides.x1] - Exclusive right display-buffer column.
 * @param {number} [overrides.y0] - Inclusive top display-buffer row.
 * @param {number} [overrides.y1] - Exclusive bottom display-buffer row.
 * @param {number} [overrides.elapsed] - Worker drawFrame wall time in ms (the segment's Compute timing).
 * @param {Object} [overrides.arenaMetrics] - Optional arena-metrics payload.
 * @param {number[]} [overrides.paramValues] - Post-frame param values the worker reports.
 * @param {number} [overrides.paramRevision] - Parameter write revision paired with the frame.
 * @param {number} [overrides.presetCount] - Preset count reported by the worker.
 * @param {number} [overrides.presetIndex] - Current preset index reported by the worker.
 * @param {string[]} [overrides.warnings] - Divergence warnings reported by the worker.
 * @param {boolean} [overrides.fullFrame] - Whether the worker shaded the whole canvas.
 * @returns {void}
 */
export function deliverFrame(controller, segId, overrides = {}) {
  const defW = 2;
  const defH = 2;
  const px = overrides.pixels ?? new Uint16Array(defW * defH * 3);
  controller.workers[segId].onmessage({
    data: {
      type: 'frame', segId,
      // Must be the Uint16Array view, not a bare ArrayBuffer: composite() indexes
      // pixels element-wise.
      pixels: px,
      x0: overrides.x0 ?? 0, x1: overrides.x1 ?? defW,
      y0: overrides.y0 ?? 0, y1: overrides.y1 ?? defH,
      elapsed: overrides.elapsed ?? 1,
      arenaMetrics: overrides.arenaMetrics ?? null,
      paramValues: overrides.paramValues ?? null,
      paramRevision: overrides.paramRevision ?? controller.paramRevision,
      presetCount: overrides.presetCount ?? null,
      presetIndex: overrides.presetIndex ?? null,
      fullFrame: overrides.fullFrame ?? false,
      // Left undefined unless a case supplies one: a worker that reports no
      // divergence omits the field entirely.
      warnings: overrides.warnings,
    },
  });
}
/**
 * Stand-in for engine parameter definitions and preset metadata.
 * @param {Array<{name: string, value: number|boolean,
 *   requestedValue?: number|boolean,
 *   acceptedValue?: number|boolean, readonly?: boolean}>} defs - Param defs.
 * @param {number} [presetCount=0] - Reported preset count.
 * @param {number} [presetIndex=0] - Reported current preset index.
 * @returns {{getParameterDefinitions: () => Array, getPresetCount: () => number,
 *   getPresetIndex: () => number}} Fake engine.
 */
export function fakeEngine(defs, presetCount = 0, presetIndex = 0) {
  return {
    getParameterDefinitions: () => defs,
    getPresetCount: () => presetCount,
    getPresetIndex: () => presetIndex,
  };
}
