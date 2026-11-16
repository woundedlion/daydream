import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMimeType, VideoRecorder } from "../../src/recording/recorder.js";
import { supports, fakeCanvas, installFakeDocument } from "./fixture.js";

test('mp4 format picks the H.264 candidate when supported', () => {
  assert.equal(
    selectMimeType('mp4', supports('video/mp4;codecs=avc1')),
    'video/mp4;codecs=avc1');
});

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

test('auto prefers mp4 over webm', () => {
  assert.equal(
    selectMimeType('auto', supports('video/mp4;codecs=avc1', 'video/webm;codecs=vp9')),
    'video/mp4;codecs=avc1');
});

test('auto falls back to webm when mp4 is unsupported', () => {
  assert.equal(
    selectMimeType('auto', supports('video/webm;codecs=vp9')),
    'video/webm;codecs=vp9');
});

test('returns empty string when nothing in the list is supported', () => {
  assert.equal(selectMimeType('mp4', () => false), '');
  assert.equal(selectMimeType('auto', () => false), '');
});

/** Native capture rounds the start-time source size up to even and keeps it. */
test('native-resolution capture pins the offscreen to the source size at start', (t) => {
  t.after(installFakeDocument());
  const source = fakeCanvas(201, 101);   // odd dims → rounded up to even
  const rec = new VideoRecorder(source);
  assert.equal(rec.targetHeight, null);

  const off = rec.ensureOffscreen();
  assert.equal(off.width, 202);
  assert.equal(off.height, 102);

  source.width = 640;
  source.height = 480;
  const off2 = rec.ensureOffscreen();
  assert.equal(off2, off);
  assert.equal(off2.width, 202);
  assert.equal(off2.height, 102);
});

/** Both offscreen dimensions round up to even, at the start-time source aspect. */
test('targetHeight capture scales the offscreen to the target height and pins it', (t) => {
  t.after(installFakeDocument());
  const source = fakeCanvas(800, 600);   // 4:3 source
  const rec = new VideoRecorder(source);
  rec.targetHeight = 121;                 // odd target → rounded up to even

  const off = rec.ensureOffscreen();
  assert.equal(off.height, 122);
  assert.equal(off.width, 162);

  source.width = 1920;
  source.height = 1080;
  const off2 = rec.ensureOffscreen();
  assert.equal(off2, off);
  assert.equal(off2.width, 162);
  assert.equal(off2.height, 122);
});

/** A 0x0 source has a non-finite aspect, which would make NaN canvas dimensions. */
test('targetHeight capture falls back to a square when the source aspect is degenerate', (t) => {
  t.after(installFakeDocument());
  const rec = new VideoRecorder(fakeCanvas(0, 0)); // 0/0 → NaN aspect
  rec.targetHeight = 120;
  const off = rec.ensureOffscreen();
  assert.equal(off.height, 120);
  assert.equal(off.width, 120, 'square fallback, not NaN');
});

test('elapsedFormatted zero-pads seconds and rolls over minutes', () => {
  const rec = new VideoRecorder(fakeCanvas());
  rec.elapsedSeconds = 9.9;
  assert.equal(rec.elapsedFormatted, '0:09');
  rec.elapsedSeconds = 60;
  assert.equal(rec.elapsedFormatted, '1:00');
  rec.elapsedSeconds = 3599.9;
  assert.equal(rec.elapsedFormatted, '59:59');
});

test('blitToOffscreen ignores a zero-sized source canvas', () => {
  const rec = new VideoRecorder(fakeCanvas(0, 32));
  rec.offscreen = fakeCanvas(64, 32);
  rec.offCtx = {
    clearRect() { throw new Error('unexpected clear'); },
    drawImage() { throw new Error('unexpected draw'); },
  };

  assert.doesNotThrow(() => rec.blitToOffscreen());
  rec.canvas.width = 64;
  rec.canvas.height = 0;
  assert.doesNotThrow(() => rec.blitToOffscreen());
});

test('blitToOffscreen clears the whole offscreen before drawing into it', () => {
  const rec = new VideoRecorder(fakeCanvas(64, 32)); // 2:1 into a 1:1 offscreen
  rec.offscreen = fakeCanvas(100, 100);
  const log = [];
  rec.offCtx = {
    clearRect: (...a) => log.push(`clear:${a.join(',')}`),
    drawImage: (image, ...a) => log.push(`draw:${a.join(',')}`),
  };

  rec.blitToOffscreen();

  // The letterbox bars lie outside the drawn rect, so without this clear every
  // recorded frame keeps the previous frame's pixels in them.
  assert.deepEqual(log, ['clear:0,0,100,100', 'draw:0,25,100,50']);
});
