// The per-frame render adapter between the driver and the engine or worker pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeAliasDriver } from './helpers/fake_three.js';
import { createDriverAliasGuard, repointDisplayAliases } from '../src/engine/display_aliases.js';
import { createRenderAdapter } from '../src/app/render_adapter.js';

/**
 * Build a render adapter over doubles for the host, driver, and worker pool.
 * @param {Object} [options] - Pool state and the view the host publishes.
 * @returns {Object} The adapter plus its doubles and sinks.
 */
function makeAdapter({ ownsDisplay = false, active = false,
                       frameComposited = false, metrics = { stack: 1 } } = {}) {
  const calls = [];
  const errors = [];
  const view = new Uint16Array(4);
  const driver = fakeAliasDriver();
  const host = {
    engine: {
      drawFrame() { calls.push('engine.drawFrame'); },
      getArenaMetrics() { calls.push('engine.getArenaMetrics'); return metrics; },
    },
    view: () => view,
    refresh() {
      calls.push('host.refresh');
      repointDisplayAliases(driver, view);
    },
  };
  const segments = {
    ownsDisplay,
    active,
    faulted: false,
    hasPublishedFrame() { return this.frameComposited; },
    frameComposited,
    consumeCapture() {
      const pending = this.frameComposited;
      this.frameComposited = false;
      return pending;
    },
    tick() { calls.push('segments.tick'); },
    updateStats() { calls.push('segments.updateStats'); },
  };
  const adapter = createRenderAdapter({
    host,
    driver,
    segments,
    syncEffectGui: (advanced) => calls.push(['effectGui.sync', advanced]),
    aliasGuard: createDriverAliasGuard(driver, 'drawFrame', (message) => errors.push(message)),
  });
  return { adapter, calls, errors, driver, host, view, segments };
}

test('a single-engine frame renders and republishes the view', () => {
  const a = makeAdapter();

  a.adapter.drawFrame();

  assert.deepEqual(a.calls, ['engine.drawFrame', 'host.refresh']);
  assert.equal(a.driver.pixels, a.view);
  // The re-point raises the flag once.
  assert.equal(a.driver.dotMesh.instanceColor.version, 1);
});

test('the adapter retains the main frame until the first healthy segmented publication', () => {
  const a = makeAdapter({ownsDisplay: true});
  assert.equal(a.adapter.retainsDisplay(), true);
  a.segments.frameComposited = true;
  assert.equal(a.adapter.retainsDisplay(), false);
  a.segments.frameComposited = false;
  a.segments.faulted = true;
  assert.equal(a.adapter.retainsDisplay(), false);
  a.segments.faulted = false;
  a.segments.ownsDisplay = false;
  assert.equal(a.adapter.retainsDisplay(), false);
});

test('panel reconciliation forwards whether the simulation stepped', () => {
  const a = makeAdapter();

  a.adapter.sync(false);
  a.adapter.sync(true);

  assert.deepEqual(a.calls, [['effectGui.sync', false], ['effectGui.sync', true]]);
});

test('a spawning pool still renders the main engine and reports its progress', () => {
  const a = makeAdapter({ active: true, ownsDisplay: false });

  a.adapter.drawFrame();

  assert.deepEqual(a.calls,
    ['segments.updateStats', 'engine.drawFrame', 'host.refresh']);
});

test('a pool that owns the display composites instead of drawing', () => {
  const a = makeAdapter({ active: true, ownsDisplay: true });

  a.adapter.drawFrame();

  assert.deepEqual(a.calls, ['segments.tick']);
});

test('a diverged alias is healed in place and reported once', () => {
  const a = makeAdapter();
  // A refresh that leaves the view live re-points nothing, so a foreign buffer
  // assigned between frames survives into the next one.
  a.host.refresh = () => a.calls.push('host.refresh');
  a.driver.pixels = new Uint16Array(4);

  a.adapter.drawFrame();
  assert.equal(a.driver.pixels, a.view, 'the frame healed the alias');
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0], /alias diverged/);

  a.driver.dotMesh.instanceColor.array = new Uint16Array(4);
  a.adapter.drawFrame();
  assert.equal(a.driver.dotMesh.instanceColor.array, a.view);
  assert.equal(a.errors.length, 1, 'the report is once per page, not per frame');
});

test('arena metrics come from the main engine only while it renders', () => {
  const single = makeAdapter({ metrics: { stack: 42 } });
  assert.deepEqual(single.adapter.getArenaMetrics(), { stack: 42 });

  const pooled = makeAdapter({ ownsDisplay: true });
  assert.equal(pooled.adapter.getArenaMetrics(), null);
  assert.deepEqual(pooled.calls, [], 'the idle main engine is not polled');
});

test('a segmented frame is capturable only once a composite has landed', () => {
  assert.equal(makeAdapter().adapter.captureReady(), true);
  assert.equal(makeAdapter().adapter.captureReady(false), false);
  assert.equal(
    makeAdapter({ ownsDisplay: true, frameComposited: false }).adapter.captureReady(),
    false);
  const pooled = makeAdapter({ ownsDisplay: true, frameComposited: true }).adapter;
  assert.equal(pooled.captureReady(), true);
  assert.equal(pooled.captureReady(), false);
});

test('refreshPixelView heals both detached display aliases without advancing the engine', () => {
  const a = makeAdapter();
  const stale = new Uint16Array(a.view.length);
  repointDisplayAliases(a.driver, stale);
  structuredClone(stale.buffer, { transfer: [stale.buffer] });
  assert.equal(a.driver.pixels.byteLength, 0);
  a.host.refresh = () => { a.calls.push('host.refresh'); return true; };
  a.adapter.refreshPixelView();
  assert.deepEqual(a.calls, ['host.refresh']);
  assert.strictEqual(a.driver.pixels, a.view);
  assert.strictEqual(a.driver.dotMesh.instanceColor.array, a.view);
});

test('render adapters tolerate a missing pixel view', () => {
  const h = makeAdapter();
  h.driver.pixels = h.view;
  h.driver.dotMesh.instanceColor.array = h.view;
  h.host.view = () => null;
  h.host.refresh = () => {};
  h.adapter.refreshPixelView();
  h.adapter.drawFrame();
  assert.equal(h.driver.pixels, h.view);
  assert.equal(h.driver.dotMesh.instanceColor.array, h.view);
  assert.equal(h.driver.dotMesh.instanceColor.version, 0);
  assert.deepEqual(h.errors, []);
});
