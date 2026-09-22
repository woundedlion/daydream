import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SegmentCompositor } from '../segment_compositor.js';

function fixture() {
  const pixels = new Uint16Array(4 * 4 * 3);
  const faults = [];
  const compositor = new SegmentCompositor({
    driver: { W: 4, H: 4 }, refreshPixelView: () => false,
    getMemoryView: () => pixels, repointDisplayAliases: () => {},
    displayAliasesDiverged: () => false,
    onFault: (segment, message) => faults.push({ segment, message }),
  });
  const bands = compositor.segmentBands(2, 4, 4, 1);
  const frame = bands.map((band, index) => ({ ...band,
    pixels: new Uint16Array((band.x1 - band.x0) * (band.y1 - band.y0) * 3).fill(index + 1),
  }));
  return { compositor, pixels, faults, frame };
}

test('composition rejects an invalid later segment before writing any band', () => {
  const { compositor, pixels, faults, frame } = fixture();
  pixels.fill(17);
  frame[1].pixels = new Uint16Array(1);
  assert.equal(compositor.composite(frame, 2, 1, false), 0);
  assert.ok(pixels.every((value) => value === 17));
  assert.equal(faults[0].segment, 1);
  assert.match(faults[0].message, /pixel buffer length/);
});

test('overlay changes reuse the published pixels and layout cache', () => {
  const { compositor, pixels, faults, frame } = fixture();
  const bands = compositor.segmentBands(2, 4, 4, 1);
  assert.equal(compositor.composite(frame, 2, 1, false), 2);
  const plain = pixels.slice();
  assert.equal(compositor.composite(frame, 2, 1, true), 2);
  assert.notDeepEqual(pixels, plain);
  assert.equal(compositor.composite(frame, 2, 1, false), 2);
  assert.deepEqual(pixels, plain);
  assert.equal(compositor.segmentBands(2, 4, 4, 1), bands);
  assert.notEqual(compositor.segmentBands(2, 4, 4, 2), bands);
  assert.deepEqual(faults, []);
});

test('an absent display defers composition without a lifecycle fault', () => {
  const { compositor, faults, frame } = fixture();
  compositor.getMemoryView = () => null;
  assert.equal(compositor.composite(frame, 2, 1, false), -1);
  assert.deepEqual(faults, []);
});
