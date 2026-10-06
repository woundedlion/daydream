// SegmentController compositor and the tick() render-loop state machine.
import { installFakeTimers } from './helpers/fake_timers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './helpers/fake_dom.js';
import { fakeColorAttribute } from './helpers/fake_three.js';
import { repointDisplayAliases } from '../src/engine/display_aliases.js';
import { SegmentController } from '../src/segments/segment_controller.js';
import {
  installSegmentControllerHarness,
  driver,
  setDisplayGrid,
  makeController,
  deliverReady,
  readyController,
  flush,
  publishGeneration,
  deliverFrame,
} from './helpers/segment_controller_harness.js';

installSegmentControllerHarness();

// ---------------------------------------------------------------------------
// Compositor
// ---------------------------------------------------------------------------

/**
 * Index of (x,y) channel 0 in a W*H*3 RGB16 buffer.
 * @param {number} x - Pixel column.
 * @param {number} y - Pixel row.
 * @param {number} w - Buffer width in pixels.
 * @returns {number} Flat element offset of the red channel at (x, y).
 */
const idx = (x, y, w) => (y * w + x) * 3;

/**
 * Whether the boundary colour was drawn at (x,y) of the driver's display buffer.
 * @param {number} x - Pixel column.
 * @param {number} y - Pixel row.
 * @returns {boolean} True when the pixel is cyan.
 */
const isCyan = (x, y) => {
  const i = idx(x, y, driver.W);
  return driver.pixels[i] === 0 && driver.pixels[i + 1] === 65535 &&
         driver.pixels[i + 2] === 65535;
};

test('composite() blits each quadrant to its display-buffer offset', () => {
  setDisplayGrid(4, 2);

  const c = readyController(2);
  c.showBoundaries = false;
  const quad = new Uint16Array(2 * 2 * 3).fill(111);
  const staged = [null, { pixels: quad, x0: 2, x1: 4, y0: 0, y1: 2 }];

  c.composite(staged);

  assert.equal(driver.pixels[idx(2, 0, 4)], 111);
  assert.equal(driver.pixels[idx(3, 1, 4)], 111);
  assert.equal(driver.pixels[idx(0, 0, 4)], 0);
  assert.equal(driver.pixels[idx(1, 1, 4)], 0);
});

test('composite() faults when the display buffer is not the driver grid', () => {
  // The driver moved to 4x2 while the display buffer is still the 2x2 one the
  // engine's active resolution allocated: every rect below is measured against
  // the driver grid, so the blit would run off the end of the view.
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(2 * 2 * 3);

  const c = makeController();
  c.showBoundaries = false;
  const band = new Uint16Array(4 * 2 * 3).fill(222);
  const staged = [{ pixels: band, x0: 0, x1: 4, y0: 0, y1: 2 }];

  const blitted = c.composite(staged);
  assert.equal(blitted, 0, 'a mis-sized display buffer blits nothing');
  assert.equal(c.faulted, true,
    'a short destination view latches a fault instead of throwing a RangeError');
  assert.match(c.faultInfo.message, /display buffer length 12 != expected 24/);
  assert.ok(driver.pixels.every((v) => v === 0),
    'nothing is written to a display buffer that disagrees with the grid');
});

test('composite() faults on a rectangle that overflows the current display buffer', () => {
  setDisplayGrid(4, 2);

  const c = makeController();
  c.showBoundaries = false;
  const quad = new Uint16Array(2 * 2 * 3).fill(222);
  const staged = [{ pixels: quad, x0: 0, x1: 99, y0: 0, y1: 2 }]; // x1=99 overshoots W=4

  const blitted = c.composite(staged);
  assert.equal(blitted, 0, 'a leading out-of-bounds rect blits nothing');
  assert.equal(c.faulted, true, 'an overflow latches a fault instead of throwing');
  assert.match(c.faultInfo.message, /out of bounds/);
  assert.ok(driver.pixels.every((v) => v === 0),
    'a leading out-of-bounds rect is never partially blitted');
});

test('composite() faults atomically when a non-leading segment overflows', () => {
  // The bounds pre-pass validates every result before any blit, so a good
  // segment ahead of the overflowing one is never composited — no partial frame.
  setDisplayGrid(4, 2);

  const c = readyController(2);
  c.showBoundaries = false;
  const good = new Uint16Array(2 * 2 * 3).fill(111);
  const bad = new Uint16Array(2 * 2 * 3).fill(222);
  const staged = [
    { pixels: good, x0: 0, x1: 2, y0: 0, y1: 2 },
    { pixels: bad, x0: 2, x1: 99, y0: 0, y1: 2 }, // x1=99 overshoots W=4
  ];

  const blitted = c.composite(staged);
  assert.equal(blitted, 0, 'a later out-of-bounds rect blits nothing');
  assert.equal(c.faulted, true);
  assert.match(c.faultInfo.message, /segment 1 .* out of bounds/);
  assert.ok(driver.pixels.every((v) => v === 0),
    'the good leading segment is not blitted when a later segment overflows');
});

test('composite() faults on an empty/inverted segment rect', () => {
  setDisplayGrid(4, 2);

  const c = makeController();
  c.showBoundaries = false;
  const quad = new Uint16Array(2 * 2 * 3).fill(123);
  const staged = [{ pixels: quad, x0: 2, x1: 2, y0: 0, y1: 2 }]; // x1 == x0

  const blitted = c.composite(staged);
  assert.equal(blitted, 0, 'an empty/inverted rect blits nothing');
  assert.equal(c.faulted, true, 'a zero-area rect latches a fault instead of masking corruption');
  assert.match(c.faultInfo.message, /empty\/inverted/);
  assert.ok(driver.pixels.every((v) => v === 0), 'nothing is blitted on an empty/inverted rect');
});

test('composite() faults on a pixel buffer whose length disagrees with its rect', () => {
  setDisplayGrid(4, 2);

  const c = makeController();
  c.showBoundaries = false;
  // rect [0,0)-[2,2) expects 2 * 2 * 3 = 12 elements; supply 6.
  const short = new Uint16Array(6).fill(123);
  const staged = [{ pixels: short, x0: 0, x1: 2, y0: 0, y1: 2 }];

  const blitted = c.composite(staged);
  assert.equal(blitted, 0, 'a length-mismatched buffer blits nothing');
  assert.equal(c.faulted, true, 'a rect/buffer mismatch latches a fault instead of blitting a truncated row');
  assert.match(c.faultInfo.message, /pixel buffer length/);
  assert.ok(driver.pixels.every((v) => v === 0), 'nothing is blitted on a buffer-length mismatch');
});

test('composite() faults on a rect that is not that segment\'s band of the layout', () => {
  // A worker that missed a resolution change answers under the current generation
  // with a rect that is in bounds and matches its own buffer, so only re-deriving
  // the band catches it before it blits into another segment's rows.
  setDisplayGrid(4, 4);

  const c = readyController(4);
  c.showBoundaries = false;
  // Segment 1's band is [0,2)-[2,4); this is segment 3's, and the same size.
  const quad = new Uint16Array(2 * 2 * 3).fill(123);
  const staged = [null, { pixels: quad, x0: 2, x1: 4, y0: 2, y1: 4 }];

  const blitted = c.composite(staged);
  assert.equal(blitted, 0, 'a misplaced band blits nothing');
  assert.equal(c.faulted, true, 'a wrong-band rect latches a fault instead of blitting');
  assert.match(c.faultInfo.message, /segment 1 .* is not its band/);
  assert.ok(driver.pixels.every((v) => v === 0), 'nothing is blitted on a band mismatch');
});

test('composite() faults when the layout admits no band for a segment', () => {
  // A count create() accepts, over a display buffer that later shrank under it:
  // 2x2 leaves no y-band per arm for an 8-segment split.
  setDisplayGrid(2, 2);

  const c = readyController(8);
  c.showBoundaries = false;
  const cell = new Uint16Array(1 * 1 * 3).fill(123);
  const staged = [{ pixels: cell, x0: 0, x1: 1, y0: 0, y1: 1 }];

  const blitted = c.composite(staged);
  assert.equal(blitted, 0, 'an underivable layout blits nothing');
  assert.equal(c.faulted, true, 'a throwing layout derivation latches a fault instead of escaping');
  assert.match(c.faultInfo.message, /no segment-0 band exists/);
});

// The pre-pass's band table is derived once per layout.
test('the band table is reused until the layout moves', () => {
  const c = makeController();
  const first = c.compositor.segmentBands(2, 4, 4);
  assert.equal(c.compositor.segmentBands(2, 4, 4), first, 'an unchanged layout reuses the table');

  c.destroy();
  const afterGen = c.compositor.segmentBands(2, 4, 4);
  assert.equal(afterGen, first, 'a new generation preserves unchanged geometry');

  const resized = c.compositor.segmentBands(2, 8, 4);
  assert.notEqual(resized, afterGen, 'a resize rebuilds the table');
  assert.equal(resized[1].x0, 4, 'the rebuilt table describes the new width');

  const recounted = c.compositor.segmentBands(4, 8, 4);
  assert.notEqual(recounted, resized, 'a segment-count change rebuilds the table');
});

test('composite() marks both the internal split and the x=0 wrap seam', () => {
  // On the wrapped cylinder a 2-arm split has two boundaries: the internal split
  // at x=2 and the wrap seam at x=0 where arm 1 meets arm 0.
  setDisplayGrid(4, 2);

  const c = readyController(2);
  c.showBoundaries = true;
  const quadL = new Uint16Array(2 * 2 * 3).fill(111);
  const quadR = new Uint16Array(2 * 2 * 3).fill(222);
  const staged = [
    { pixels: quadL, x0: 0, x1: 2, y0: 0, y1: 2 },
    { pixels: quadR, x0: 2, x1: 4, y0: 0, y1: 2 },
  ];

  c.composite(staged);

  assert.ok(isCyan(2, 0) && isCyan(2, 1), 'internal arm split at x=2 marked');
  assert.ok(isCyan(0, 0) && isCyan(0, 1), 'wrap-seam boundary at x=0 marked');
  assert.equal(driver.pixels[idx(1, 0, 4)], 111, 'arm-0 interior untouched');
  assert.equal(driver.pixels[idx(3, 0, 4)], 222, 'arm-1 interior untouched');
});

test('a generation published while paused composites without another tick', async () => {
  setDisplayGrid(4, 2);
  const c = readyController(2);
  c.active = true;
  driver.paused = true;
  try {
    await publishGeneration(c, [
      { pixels: new Uint16Array(12).fill(111), x0: 0, x1: 2, y0: 0, y1: 2 },
      { pixels: new Uint16Array(12).fill(222), x0: 2, x1: 4, y0: 0, y1: 2 },
    ]);
    assert.equal(driver.pixels[idx(1, 0, 4)], 111);
    assert.equal(driver.pixels[idx(3, 0, 4)], 222);
    assert.equal(driver.invalidations, 1);
    assert.equal(c.frameState.pendingFrame, false);
  } finally {
    driver.paused = false;
  }
});

test('the boundary setter re-composites and invalidates a paused held generation', async () => {
  setDisplayGrid(4, 2);

  const c = readyController(2);
  c.active = true; // the app sets this before create(); the setter checks it
  driver.paused = true;
  try {
    const quadL = new Uint16Array(2 * 2 * 3).fill(111);
    const quadR = new Uint16Array(2 * 2 * 3).fill(222);
    await publishGeneration(c, [
      { pixels: quadL, x0: 0, x1: 2, y0: 0, y1: 2 },
      { pixels: quadR, x0: 2, x1: 4, y0: 0, y1: 2 },
    ]);
    c.composite(c.frameState.results);
    const posted = c.workers.map((worker) => worker.posted.length);
    const uploads = driver.dotMesh.instanceColor.version;
    const invalidations = driver.invalidations;

    c.showBoundaries = true;

    assert.ok(isCyan(0, 0) && isCyan(2, 0),
      'the held generation gains its boundaries without a simulation tick');
    assert.equal(driver.invalidations, invalidations + 1, 'the paused render loop was asked to repaint');
    assert.equal(driver.dotMesh.instanceColor.version, uploads + 1,
      'the seams are flagged for upload');
    c.workers.forEach((worker, index) => {
      assert.equal(worker.posted.length, posted[index],
        'refreshing the overlay did not advance or dispatch the simulation');
    });

    c.showBoundaries = false;

    assert.equal(driver.pixels[idx(0, 0, 4)], 111, 'disabling restores the held left band');
    assert.equal(driver.pixels[idx(2, 0, 4)], 222, 'disabling restores the held right band');
    assert.equal(driver.invalidations, invalidations + 2, 'each visible change requests one repaint');
    assert.equal(driver.dotMesh.instanceColor.version, uploads + 2,
      'each visible change flags one upload');
  } finally {
    driver.paused = false;
  }
});

test('the boundary setter composites nothing when the pool owns no display', async () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3).fill(77);

  // Inactive controller: the single main-thread engine owns the display buffer.
  const c = readyController(2);

  await publishGeneration(c, [
    { pixels: new Uint16Array(12).fill(111), x0: 0, x1: 2, y0: 0, y1: 2 },
    { pixels: new Uint16Array(12).fill(222), x0: 2, x1: 4, y0: 0, y1: 2 },
  ]);
  assert.equal(c.hasPublishedFrame(), true);
  assert.equal(c.active, false);
  c.showBoundaries = true;

  assert.equal(driver.pixels[idx(0, 0, 4)], 77,
    'the single-engine frame is left untouched');
  assert.equal(c.faulted, false, 'no fault latched on a controller holding nothing');
  assert.equal(driver.invalidations, 1, 'the repaint is still requested');
});

test('the boundary setter composites nothing over a latched pool', async () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3).fill(77);

  const c = readyController(2);
  c.active = true;
  await publishGeneration(c, [
    { pixels: new Uint16Array(2 * 2 * 3).fill(111), x0: 0, x1: 2, y0: 0, y1: 2 },
    { pixels: new Uint16Array(2 * 2 * 3).fill(222), x0: 2, x1: 4, y0: 0, y1: 2 },
  ]);
  c.onWorkerFault(0, 'boom');
  const invalidations = driver.invalidations;

  c.showBoundaries = true;

  assert.equal(c.frameState.ready, true, 'the latch keeps ready for ownsDisplay');
  assert.equal(driver.pixels[idx(0, 0, 4)], 77,
    'the halted pool does not repaint the frame under its fault banner');
  assert.equal(driver.invalidations, invalidations + 1,
    'the repaint is still requested');
});

test('composite() marks every internal split plus the wrap seam for an 8-segment layout', () => {
  // Eight segments are two arms of four Y-bands each: internal boundaries at
  // x=4 and y=2,4,6 plus the wrap seam at x=0.
  setDisplayGrid(8, 8);

  const c = readyController(8);
  c.showBoundaries = true;
  // Bands run 0, 1, 3, 2 down an arm: its southern half counts back from the pole.
  const bandYs = [[0, 2], [2, 4], [6, 8], [4, 6]];
  const staged = Array.from({ length: 8 }, (_, s) => {
    const [y0, y1] = bandYs[s % 4];
    const x0 = s < 4 ? 0 : 4;
    return {
      pixels: new Uint16Array(4 * 2 * 3).fill(111 * (s + 1)),
      x0, x1: x0 + 4, y0, y1,
    };
  });

  c.composite(staged);

  for (const x of [0, 4])
    assert.ok(isCyan(x, 0) && isCyan(x, 7), `arm boundary at x=${x} marked`);
  for (const y of [2, 4, 6])
    assert.ok(isCyan(0, y) && isCyan(7, y), `band seam at y=${y} marked`);
  assert.equal(driver.pixels[idx(1, 0, 8)], 111, 'arm-0 north band interior untouched');
  assert.equal(driver.pixels[idx(1, 3, 8)], 222, 'arm-0 second band interior untouched');
  assert.equal(driver.pixels[idx(5, 7, 8)], 777, 'arm-1 south band interior untouched');
  assert.equal(driver.pixels[idx(5, 5, 8)], 888, 'arm-1 third band interior untouched');
});

test('composite() marks the horizontal seam between stacked Y-band segments', () => {
  // Four segments split each arm in Y (top band y[0,2), bottom band y[2,4)), so
  // the horizontal boundary at y=2 runs the full width across both arms.
  setDisplayGrid(4, 4);

  const c = readyController(4);
  c.showBoundaries = true;
  const band = (fill) => new Uint16Array(2 * 2 * 3).fill(fill);
  const staged = [
    { pixels: band(111), x0: 0, x1: 2, y0: 0, y1: 2 },
    { pixels: band(222), x0: 0, x1: 2, y0: 2, y1: 4 },
    { pixels: band(333), x0: 2, x1: 4, y0: 0, y1: 2 },
    { pixels: band(444), x0: 2, x1: 4, y0: 2, y1: 4 },
  ];

  c.composite(staged);

  assert.ok([0, 1, 2, 3].every((x) => isCyan(x, 2)),
    'horizontal band seam at y=2 marked across the row');
  assert.ok(isCyan(2, 0) && isCyan(0, 0), 'arm split at x=2 and wrap seam at x=0 marked');
  assert.equal(driver.pixels[idx(1, 0, 4)], 111, 'top-band interior untouched');
  assert.equal(driver.pixels[idx(1, 3, 4)], 222, 'bottom-band interior untouched');
});

test('composite() marks the layout seams, not only the reported segments', () => {
  // The seams describe the layout, so a frame that only two of the four segments
  // reported carries the same overlay as a complete one.
  setDisplayGrid(4, 4);

  const c = readyController(4);
  c.showBoundaries = true;
  const band = (fill) => new Uint16Array(2 * 2 * 3).fill(fill);
  const staged = [
    { pixels: band(111), x0: 0, x1: 2, y0: 0, y1: 2 },
    { pixels: band(222), x0: 0, x1: 2, y0: 2, y1: 4 },
    null, null,
  ];

  c.composite(staged);

  assert.ok(isCyan(2, 0) && isCyan(0, 0), 'arm split at x=2 and wrap seam at x=0 marked');
  assert.ok([0, 1, 2, 3].every((x) => isCyan(x, 2)), 'the band seam is still marked');
  assert.equal(driver.pixels[idx(1, 0, 4)], 111, 'top-band interior untouched');
  assert.equal(driver.pixels[idx(3, 0, 4)], 0, 'the unreported arm stays black');
});

test('composite() self-heals a broken display-buffer alias instead of throwing', () => {
  setDisplayGrid(4, 2);

  const c = makeController();
  const target = new Uint16Array(4 * 2 * 3);
  c.compositor.getMemoryView = () => target;
  const staged = [];

  assert.doesNotThrow(() => c.composite(staged));
  assert.equal(driver.pixels, target,
    'driver.pixels re-pointed at the composite target');
  assert.equal(driver.dotMesh.instanceColor.array, target,
    'the mesh alias the GPU reads is re-pointed too');
  assert.equal(driver.dotMesh.instanceColor.version, 1,
    'a re-pointed attribute nobody flagged uploads the old buffer forever');
});

test('composite() heals a diverged mesh alias even while driver.pixels is aligned', () => {
  setDisplayGrid(4, 2);
  // Split the alias pair: the GPU-side attribute reads a stale buffer while
  // driver.pixels still matches the composite target.
  driver.dotMesh.instanceColor = fakeColorAttribute(new Uint16Array(4 * 2 * 3));

  const c = makeController();
  const staged = [];

  c.composite(staged);
  assert.equal(driver.dotMesh.instanceColor.array, driver.pixels,
    'the mesh alias the GPU reads is re-pointed at the composite target');
  assert.equal(driver.dotMesh.instanceColor.version, 1,
    'the heal flags the attribute for re-upload');
});

// The composite blits over driver.render()'s zero-fill; a refresh that
// re-fetched moves the aliases onto a buffer the driver never cleared.
test('composite() clears a buffer the refresh re-fetched', () => {
  setDisplayGrid(4, 2);

  const c = readyController(2);
  // The fresh view carries the engine's last frame, not the driver's clear.
  const fetched = new Uint16Array(4 * 2 * 3).fill(999);
  let refreshed = false;
  c.compositor.refreshPixelView = () => {
    if (!refreshed) return false;
    repointDisplayAliases(driver, fetched);
    return true;
  };
  c.compositor.getMemoryView = () => driver.pixels;
  const band = new Uint16Array(2 * 2 * 3).fill(111);
  const staged = [{ pixels: band, x0: 0, x1: 2, y0: 0, y1: 2 }, null];

  refreshed = true;
  c.composite(staged);

  assert.equal(driver.pixels, fetched, 'the refresh moved both aliases with it');
  assert.equal(fetched[0], 111, 'the reported band still lands');
  // Row 0, columns 2-3: segment 1's band, which reported nothing this frame.
  assert.ok(fetched.subarray(6, 12).every((v) => v === 0),
    'the columns no segment reported are cleared, not the engine\'s last frame');
});

test('a controller cannot be built without a two-alias display repointer', () => {
  assert.throws(
    () => new SegmentController({
      resolutionPresets: { lo: { w: 4, h: 4 } },
      appState: { get: () => 'lo' },
      driver,
      getWasmEngine: () => null,
      refreshPixelView: () => {},
      getMemoryView: () => driver.pixels,
      displayAliasesDiverged: () => false,
    }),
    /repointDisplayAliases is required/,
    'an omitted repointer would heal only half the alias pair',
  );
});

test('a controller cannot be built without an alias-divergence detector', () => {
  assert.throws(
    () => new SegmentController({
      resolutionPresets: { lo: { w: 4, h: 4 } },
      appState: { get: () => 'lo' },
      driver,
      getWasmEngine: () => null,
      refreshPixelView: () => {},
      getMemoryView: () => driver.pixels,
      repointDisplayAliases: (view) => repointDisplayAliases(driver, view),
    }),
    /displayAliasesDiverged is required/,
    'the detector and the heal are one contract; half of it cannot be reached for',
  );
});

// ---------------------------------------------------------------------------
// tick() — the one-frame-deep render-loop state machine
// ---------------------------------------------------------------------------

test('tick() is a no-op until every worker has signalled ready', () => {
  const c = makeController();
  c.create(2);
  assert.equal(c.frameState.ready, false);

  c.tick();

  assert.equal(c.frameState.renderInFlight, false, 'no render dispatched before ready');
  assert.equal(c.frameState.pending, 0);
  for (const w of c.workers)
    assert.ok(!w.posted.some((m) => m.type === 'render'),
      'no worker received a render message');
});

test('the first tick() once ready dispatches a parallel render', () => {
  const c = readyController(2);
  assert.equal(c.frameState.ready, true);

  c.tick();

  assert.equal(c.frameState.renderInFlight, true, 'render now in flight');
  assert.equal(c.frameState.pending, 2, 'one outstanding response per worker');
  assert.equal(c.frameState.pendingFrame, false, 'nothing to composite on the first tick');
  for (const w of c.workers)
    assert.ok(w.posted.some((m) => m.type === 'render'),
      'every worker was told to render');
});

test('a completed render arms pendingFrame and frees the in-flight slot', async () => {
  const c = readyController(2);
  c.tick();

  deliverFrame(c, 0);
  deliverFrame(c, 1);
  await flush();

  assert.equal(c.frameState.pending, 0);
  assert.equal(c.frameState.pendingFrame, true, 'results are waiting to be composited');
  assert.equal(c.frameState.renderInFlight, false, 'slot freed for the next dispatch');
});

test('the next tick() composites the armed frame and dispatches the following one', async () => {
  setDisplayGrid(4, 2);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  const quad = () => new Uint16Array(2 * 2 * 3).fill(111);
  deliverFrame(c, 0, { pixels: quad(), x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: quad(), x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();
  assert.equal(c.frameState.pendingFrame, true);

  c.tick();

  assert.equal(c.frameState.pendingFrame, false, 'pending frame was composited and cleared');
  assert.ok(driver.pixels.some((v) => v === 111),
    'the composited quadrants reached the display buffer');
  assert.equal(c.frameState.renderInFlight, true, 'the following frame was dispatched');
  assert.equal(c.frameState.pending, 2);
});

test('each render dispatch hands the retired generation buffer back for reuse', async () => {
  setDisplayGrid(4, 2);

  const c = readyController(2);
  c.showBoundaries = false;
  const lastRender = (w) => w.posted.filter((m) => m.type === 'render').at(-1);

  c.tick(); // dispatch generation A
  assert.ok(c.workers.every((w) => lastRender(w).recycle === undefined),
    'nothing is retired yet, so the first dispatch leaves the worker to allocate');

  const genA = [new Uint16Array(2 * 2 * 3).fill(111), new Uint16Array(2 * 2 * 3).fill(111)];
  deliverFrame(c, 0, { pixels: genA[0], x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: genA[1], x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();
  c.tick(); // composite A, dispatch B: A is the live generation, not retired
  assert.ok(c.workers.every((w) => lastRender(w).recycle === undefined),
    'the generation the compositor is displaying is never handed back');

  const genB = () => new Uint16Array(2 * 2 * 3).fill(222);
  deliverFrame(c, 0, { pixels: genB(), x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: genB(), x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();
  c.tick(); // composite B, dispatch C carrying generation A's retired buffers

  c.workers.forEach((w, s) => {
    assert.deepEqual(lastRender(w).recycle, new Uint16Array(12).fill(111),
      `seg ${s} receives the retired pixel values`);
    assert.deepEqual(w.transfers.at(-1), [genA[s].buffer],
      'the buffer is transferred, not structured-cloned');
    assert.equal(genA[s].buffer.byteLength, 0,
      `seg ${s}'s retired buffer is detached on the controller side`);
  });
  assert.ok(c.frameState.results.every((r) => r.pixels.byteLength > 0 && r.pixels[0] === 222),
    'the displayed generation is still attached and untouched by the recycle');
  assert.ok(c.frameState.scratch.every((slot) => slot === null),
    'every staging slot is cleared as its buffer is consumed');
});

test('tick() re-blits the last composite when a render overruns the tick (preview holds, not black)', async () => {
  setDisplayGrid(4, 2);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  const quad = () => new Uint16Array(2 * 2 * 3).fill(111);
  deliverFrame(c, 0, { pixels: quad(), x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: quad(), x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();
  c.tick(); // composite the armed frame, dispatch the next (now in flight)
  assert.equal(c.frameState.pendingFrame, false);
  assert.equal(c.frameState.renderInFlight, true, 'the next render is in flight and will overrun');

  // driver.stepSimulation() clears the buffer before each tick.
  driver.pixels.fill(0);
  // Overrun tick: render still in flight, no new pendingFrame.
  c.tick();

  assert.ok(driver.pixels.some((v) => v === 111),
    'the last composite is re-blitted so the preview holds instead of flashing black');
  assert.equal(c.frameComposited, false,
    'a re-blit is not a new frame; the recorder must not capture a duplicate');
});

test('an overrun re-blit shows one whole generation, never a half-updated mix', async () => {
  // While the next generation is only partially in, its quadrants live in
  // `scratch`; an overrun re-blit must composite the last WHOLE generation from
  // `results`, never a mix of the two.
  setDisplayGrid(4, 2);

  const { restore } = installFakeTimers(); // the render watchdog never fires
  try {
    const c = readyController(2);
    c.showBoundaries = false;
    c.tick(); // dispatch generation A

    const genA = () => new Uint16Array(2 * 2 * 3).fill(111);
    deliverFrame(c, 0, { pixels: genA(), x0: 0, x1: 2, y0: 0, y1: 2 });
    deliverFrame(c, 1, { pixels: genA(), x0: 2, x1: 4, y0: 0, y1: 2 });
    await flush();
    c.tick(); // composite generation A, dispatch generation B (now in flight)
    assert.equal(c.frameState.renderInFlight, true, 'generation B is in flight and will overrun');

    // Generation B arrives only partially: seg 0 reports, seg 1 still rendering.
    deliverFrame(c, 0, { pixels: new Uint16Array(2 * 2 * 3).fill(222), x0: 0, x1: 2, y0: 0, y1: 2 });
    assert.equal(c.frameState.pending, 1, 'generation B still has one segment outstanding');
    assert.ok(c.frameState.scratch[0] && c.frameState.scratch[0].pixels[0] === 222,
      'the partial next generation is staged in scratch, not results');
    assert.equal(c.frameState.renderInFlight, true, 'the swap has not run, so results is still generation A');

    driver.pixels.fill(0); // driver.stepSimulation() clears before the overrun tick
    c.tick(); // overrun: no new pendingFrame, so re-blit the last whole generation

    assert.ok(!driver.pixels.some((v) => v === 222),
      'the partially-arrived generation B never leaks into the re-blit');
    assert.equal(driver.pixels[idx(0, 0, 4)], 111, 'quadrant 0 holds generation A');
    assert.equal(driver.pixels[idx(2, 0, 4)], 111, 'quadrant 1 holds generation A');
    assert.equal(c.frameComposited, false, 're-blit is not a new frame');
  } finally {
    restore();
  }
});

test('a composite short one segment is not handed to the recorder as a frame', async () => {
  setDisplayGrid(4, 2);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  const quad = () => new Uint16Array(2 * 2 * 3).fill(111);
  deliverFrame(c, 0, { pixels: quad(), x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: quad(), x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();

  // The whole-array swap publishes only generations that filled every slot, so
  // an empty one stands in for that invariant breaking.
  c.frameState.results[1] = null;
  c.tick();

  assert.ok(driver.pixels.some((v) => v === 111), 'the arrived segment still blits');
  assert.equal(driver.pixels[idx(2, 0, 4)], 0, 'the missing segment leaves its band black');
  assert.equal(c.frameComposited, false,
    'a frame with a black band would be recorded as complete');
});

test('destroy() clears frameComposited so a respawning pool cannot capture black frames', async () => {
  setDisplayGrid(4, 2);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  const quad = () => new Uint16Array(2 * 2 * 3).fill(111);
  deliverFrame(c, 0, { pixels: quad(), x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: quad(), x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();
  c.tick();
  assert.equal(c.frameComposited, true, 'a real composite latched the flag');

  c.destroy();
  assert.equal(c.frameComposited, false, 'destroy() cleared the latch');

  c.tick(); // pool not ready yet: tick() returns before touching the flag
  assert.equal(c.frameComposited, false, 'the flag stays clear while the pool respawns');
});

test('a faulted pool keeps tick() from dispatching another doomed render', () => {
  const c = readyController(2);
  c.tick();

  c.workers[0].onerror({ message: 'boom', filename: 'w.js', lineno: 1, colno: 1 });
  assert.equal(c.faulted, true);
  assert.equal(c.frameState.renderInFlight, false);

  const before = c.workers.map((w) => w.posted.length);
  c.tick();

  assert.equal(c.frameState.renderInFlight, false, 'faulted pool never re-dispatches');
  c.workers.forEach((w, i) =>
    assert.equal(w.posted.length, before[i], 'no new render broadcast'));
  assert.ok(c.workers.every((w) => w.postsAfterTermination.length === 0));
});

test('a fault latched by composite() mid-tick() does not re-dispatch a doomed render', async () => {
  // The fence-escaping out-of-bounds result faults inside composite(), so the pool
  // is clean at tick() entry and only latches partway through — the post-composite
  // faulted re-check is what stops the second render.
  setDisplayGrid(4, 2);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { x0: 2, x1: 99, y0: 0, y1: 2 }); // x1=99 overshoots W=4
  await flush();
  assert.equal(c.frameState.pendingFrame, true);
  assert.equal(c.faulted, false, 'not yet faulted at tick() entry');

  const before = c.workers.map((w) => w.posted.length);
  c.tick();

  assert.equal(c.faulted, true, 'composite() latched the fault during tick()');
  assert.equal(c.frameState.renderInFlight, false, 'no render dispatched to the just-faulted pool');
  c.workers.forEach((w, i) =>
    assert.equal(w.posted.length, before[i], 'no new render broadcast'));
  assert.ok(c.workers.every((w) => w.postsAfterTermination.length === 0));
});

test('tick() holds the assembled generation when the display buffer is missing', async () => {
  setDisplayGrid(4, 2);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2,
                       pixels: new Uint16Array(2 * 2 * 3).fill(111) });
  deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2,
                       pixels: new Uint16Array(2 * 2 * 3).fill(222) });
  await flush();
  assert.equal(c.frameState.pendingFrame, true);

  c.compositor.getMemoryView = () => null;
  c.tick();
  assert.equal(c.faulted, false, 'a missing engine view is not a fault');
  assert.equal(c.frameState.pendingFrame, true, 'the generation is held, not consumed');
  assert.equal(c.frameComposited, false);

  c.compositor.getMemoryView = () => driver.pixels;
  c.tick();
  assert.equal(c.frameState.pendingFrame, false);
  assert.equal(c.frameComposited, true, 'the held generation composited whole');
  assert.equal(driver.pixels[idx(0, 0, 4)], 111);
  assert.equal(driver.pixels[idx(2, 0, 4)], 222);
});

test('a fault latched by the overrun re-blit paints the overlay on the same tick', async () => {
  setDisplayGrid(4, 2);

  const { restore } = installFakeTimers(); // the render watchdog never fires
  try {
    const c = readyController(2);
    c.showBoundaries = false;
    c.tick(); // dispatch generation A

    deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
    deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2 });
    await flush();
    c.tick(); // composite A, dispatch B (in flight, so the next tick overruns)

    // Corrupt the published generation so the overrun re-blit's pre-pass faults.
    c.frameState.results[1] = { ...c.frameState.results[1], x1: 99 };
    const stats = fakeElement();
    c.statsView.doc = {
      getElementById: (id) => id === 'segment-stats' ? stats : null,
      createElement: (tag) => fakeElement(tag),
    };
    c.active = true;
    const workers = [...c.workers];
    const posted = workers.map((w) => w.posted.length);

    c.tick(); // overrun branch: composite() latches the fault mid-tick
    assert.equal(c.faulted, true, 'the re-blit pre-pass latched the fault');
    assert.equal(stats.firstElementChild?.getAttribute('role'), 'alert',
      'the overlay painted on the faulting tick, not the next one');
    assert.deepEqual(workers.map((w) => w.posted.length), posted, 'the faulting tick dispatched no render');
  } finally {
    restore();
  }
});

test('an init-phase fault still reaches the fault overlay (faulted checked before ready guard)', () => {
  // A startup trap latches `faulted` but never sends 'ready'.
  const c = makeController();
  c.create(2);
  assert.equal(c.frameState.ready, false);

  c.workers[0].onerror({ message: 'init boom', filename: 'w.js', lineno: 1, colno: 1 });
  assert.equal(c.faulted, true);

  let statsShown = 0;
  c.updateStats = () => { statsShown++; };
  c.tick();

  assert.equal(statsShown, 1, 'tick() refreshed the fault overlay despite never being ready');
  assert.equal(c.frameState.renderInFlight, false, 'no doomed render dispatched');
});

test('the fault overlay is an alert that never takes focus', () => {
  const stats = fakeElement();
  const c = makeController();
  c.statsView.doc = {
    getElementById: (id) => id === 'segment-stats' ? stats : null,
    createElement: (tag) => fakeElement(tag),
  };
  c.active = true;
  c.faulted = true;
  c.faultInfo = { segId: 0, message: 'boom' };

  c.updateStats();

  const alert = stats.firstElementChild;
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.equal(alert.tabIndex, -1);
  assert.equal(alert.focusCalls, 0);

  c.updateStats();
  assert.equal(stats.firstElementChild, alert);
  assert.equal(alert.focusCalls, 0);
});

test('a fault latched outside tick() paints the overlay without waiting for one', () => {
  // A paused host need not tick, so the fault path paints the banner itself.
  const stats = fakeElement();
  const c = makeController();
  c.statsView.doc = {
    getElementById: (id) => id === 'segment-stats' ? stats : null,
    createElement: (tag) => fakeElement(tag),
  };
  c.active = true;
  c.create(2);

  c.workers[0].onerror({ message: 'hang', filename: 'w.js', lineno: 1, colno: 1 });

  assert.equal(c.faulted, true);
  assert.equal(stats.firstElementChild.getAttribute('role'), 'alert',
    'the fault banner painted without a tick');
});

test('a spawning pool reports the spawn and does not own the display', () => {
  const stats = fakeElement();
  const c = makeController();
  c.statsView.doc = {
    getElementById: (id) => id === 'segment-stats' ? stats : null,
    createElement: (tag) => fakeElement(tag),
  };
  c.active = true;
  c.create(4);

  assert.equal(c.ownsDisplay, false, 'a spawning pool leaves the frame to the main engine');

  c.updateStats();
  const status = stats.firstElementChild;
  assert.equal(status.getAttribute('role'), 'status');
  assert.match(status.childNodes.join(''), /4 workers/);

  c.updateStats();
  assert.equal(stats.firstElementChild, status, 'the status row is not rebuilt every frame');

  for (let s = 0; s < 4; s++) deliverReady(c, s);
  assert.equal(c.ownsDisplay, true, 'a ready pool owns the display');

  const latched = makeController();
  latched.active = true;
  latched.create(4);
  latched.onWorkerFault(0, 'boom');
  assert.equal(latched.frameState.ready, false, 'the pool never reached ready');
  assert.equal(latched.ownsDisplay, true,
    'a faulted pool keeps the display for its overlay');
});

test('turning segmented mode off hands the global stat bars back', () => {
  // The overlay hides page-owned elements while it stands in for them; the
  // hand-back rides on the flag.
  const byId = {
    'segment-stats': fakeElement(),
    'global-stats-desktop': fakeElement(),
    'stats-bar': fakeElement(),
  };
  const c = makeController();
  c.statsView.doc = {
    getElementById: (id) => byId[id] ?? null,
    createElement: (tag) => fakeElement(tag),
  };

  c.active = true;
  // A ready pool: the overlay leaves the bars up until it owns the display.
  c.create(2);
  deliverReady(c, 0);
  deliverReady(c, 1);
  c.updateStats();
  assert.equal(byId['global-stats-desktop'].style.display, 'none');
  assert.equal(byId['stats-bar'].style.display, 'none');

  c.active = false;

  assert.equal(byId['segment-stats'].classList.contains('visible'), false,
    'the overlay stayed up');
  assert.equal(byId['global-stats-desktop'].style.display, '');
  assert.equal(byId['stats-bar'].style.display, '');
});
