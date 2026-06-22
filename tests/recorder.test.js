// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectMimeType, VideoRecorder } from '../recorder.js';

/**
 * Builds a fake isTypeSupported probe that accepts only the listed MIME types,
 * so each test can pin down exactly which codecs the "browser" advertises.
 * @param {...string} allowed - MIME type strings the probe should report as supported.
 * @returns {function(string): boolean} A probe that returns true only for an allowed MIME type.
 */
const supports = (...allowed) => (mt) => allowed.includes(mt);

/** Verifies the mp4 format selects the H.264 (avc1) candidate when it is supported. */
test('mp4 format picks the H.264 candidate when supported', () => {
  assert.equal(
    selectMimeType('mp4', supports('video/mp4;codecs=avc1')),
    'video/mp4;codecs=avc1');
});

/** Verifies the webm format falls back through VP9, then VP8, then the generic codec. */
test('webm format prefers VP9, then VP8, then generic', () => {
  assert.equal(
    selectMimeType('webm', supports('video/webm;codecs=vp9', 'video/webm;codecs=vp8')),
    'video/webm;codecs=vp9');
  assert.equal(
    selectMimeType('webm', supports('video/webm;codecs=vp8', 'video/webm')),
    'video/webm;codecs=vp8');
  assert.equal(
    selectMimeType('webm', supports('video/webm')),
    'video/webm');
});

/** Verifies auto selection prefers an mp4 candidate when both mp4 and webm are supported. */
test('auto prefers mp4 over webm', () => {
  assert.equal(
    selectMimeType('auto', supports('video/mp4;codecs=avc1', 'video/webm;codecs=vp9')),
    'video/mp4;codecs=avc1');
});

/** Verifies auto selection falls back to webm when no mp4 candidate is supported. */
test('auto falls back to webm when mp4 is unsupported', () => {
  assert.equal(
    selectMimeType('auto', supports('video/webm;codecs=vp9')),
    'video/webm;codecs=vp9');
});

/** Verifies an empty string is returned when no candidate in the list is supported. */
test('returns empty string when nothing in the list is supported', () => {
  assert.equal(selectMimeType('mp4', () => false), '');
  assert.equal(selectMimeType('auto', () => false), '');
});

/**
 * A minimal fake canvas with mutable width/height and a no-op 2D context,
 * standing in for an HTMLCanvasElement so the offscreen-pinning logic runs in
 * Node without a DOM.
 * @param {number} width
 * @param {number} height
 */
const fakeCanvas = (width = 0, height = 0) =>
  ({ width, height, getContext: () => ({ drawImage() {} }) });

/**
 * Verifies native-resolution capture pins the offscreen buffer to the source's
 * start-time size (rounded up to even) and never resizes it when the source
 * canvas changes mid-recording — so the captured track's frame size is fixed.
 */
test('native-resolution capture pins the offscreen to the source size at start', () => {
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => fakeCanvas() };
  try {
    const source = fakeCanvas(201, 101);   // odd dims → rounded up to even
    const rec = new VideoRecorder(source);
    assert.equal(rec.targetHeight, null);  // native path

    const off = rec._ensurePinnedOffscreen();
    assert.equal(off.width, 202);
    assert.equal(off.height, 102);

    // A mid-recording source resize must NOT change the pinned buffer.
    source.width = 640;
    source.height = 480;
    const off2 = rec._ensurePinnedOffscreen();
    assert.equal(off2, off);
    assert.equal(off2.width, 202);
    assert.equal(off2.height, 102);
  } finally {
    globalThis.document = prevDoc;
  }
});
