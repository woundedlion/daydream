import { test } from "node:test";
import assert from "node:assert/strict";
import { installConsoleCapture } from "../helpers/fake_console.js";
import { installDocument } from "../helpers/fake_dom.js";
import { VideoRecorder } from "../../src/recording/recorder.js";
import { recordableCanvas, installRecorderEnv, startRecorder, drainSink, captureLetterbox, trackHostError } from "./fixture.js";

/** Wider-than-target source: fit to the offscreen width, letterbox top/bottom. */
test('captureFrame letterboxes a wider-than-target source to fit width', () => {
  const { img, x, y, w, h } = captureLetterbox({ srcW: 64, srcH: 32, offW: 100, offH: 100 });
  assert.equal(img.width, 64, 'blits the source canvas');
  assert.equal(w, 100, 'destW spans the full offscreen width');
  assert.equal(h, 50, 'destH = offW / srcAspect');
  assert.equal(x, 0, 'no horizontal offset when fitting width');
  assert.equal(y, 25, 'centered vertically: (offH - destH) / 2');
});

/** Taller-than-target source: fit to the offscreen height, pillarbox left/right. */
test('captureFrame pillarboxes a taller-than-target source to fit height', () => {
  const { x, y, w, h } = captureLetterbox({ srcW: 30, srcH: 60, offW: 100, offH: 100 });
  assert.equal(h, 100, 'destH spans the full offscreen height');
  assert.equal(w, 50, 'destW = offH * srcAspect');
  assert.equal(y, 0, 'no vertical offset when fitting height');
  assert.equal(x, 25, 'centered horizontally: (offW - destW) / 2');
});

/**
 * A track without requestFrame is the timed-fallback mode (the capture stream
 * self-samples at the frame rate), not an error: captureFrame skips the manual
 * requestFrame call and elapsed time remains clock-driven.
 */
test('captureFrame leaves elapsed time clock-driven without requestFrame', (t) => {
  t.after(installRecorderEnv());
  let nowMs = 0;
  const rec = startRecorder(recordableCanvas(), { now: () => nowMs });
  delete rec.track.requestFrame;
  rec.captureFrame();
  rec.captureFrame();
  assert.equal(rec.elapsedSeconds, 0);
  nowMs = 2_000;
  assert.equal(rec.elapsedSeconds, 2);
});

/**
 * stop() flips the recorder inactive but the async onstop that releases the
 * track has not run yet, so a render task already in flight can still reach
 * captureFrame. It must do nothing: no blit into the offscreen, no frame
 * requested on the still-live track, and no elapsed-time advance past the point
 * the encoder stopped accepting frames.
 */
test('captureFrame is inert between stop and the async onstop', (t) => {
  t.after(installRecorderEnv());
  const rec = startRecorder(recordableCanvas());

  const draws = [];
  let requested = 0;
  rec.offCtx = { clearRect() {}, drawImage(...a) { draws.push(a); } };
  rec.track.requestFrame = () => { requested++; };

  rec.captureFrame();
  assert.equal(draws.length, 1, 'a frame captured while recording blits');
  assert.equal(requested, 1);

  rec.stop();
  const elapsedAtStop = rec.elapsedSeconds;
  assert.equal(rec.isRecording, false);
  assert.ok(rec.track, 'onstop has not released the track yet');

  rec.captureFrame();
  assert.equal(draws.length, 1, 'no blit after stop');
  assert.equal(requested, 1, 'no frame requested on the stopped session');
  assert.equal(rec.elapsedSeconds, elapsedAtStop, 'elapsed does not advance');
});

/**
 * start() never blits: the source is a WebGL canvas whose drawing buffer is
 * cleared once composited, so a blit outside the render task would write
 * transparent black. Only captureFrame(), called from the render task, fills the
 * offscreen — on the timed-fallback path too.
 */
test('start does not blit; the timed fallback fills the offscreen on captureFrame', (t) => {
  t.after(installRecorderEnv());
  const timedTrack = { stop() {} }; // no requestFrame -> forces the fps fallback
  const draws = [];
  // The offscreen (not the source) is the captured surface; make it report the
  // timed-fallback track and spy on its blits.
  const offscreen = {
    width: 0, height: 0,
    getContext: () => ({ clearRect() {}, drawImage(...a) { draws.push(a); } }),
    captureStream: () => ({
      getVideoTracks: () => [timedTrack],
      getTracks: () => [timedTrack],
    }),
  };
  installDocument({ createElement: () => offscreen });

  const rec = startRecorder(recordableCanvas(64, 32));

  assert.equal(draws.length, 0, 'no blit from the click-handler task');

  rec.captureFrame();
  assert.equal(draws.length, 1, 'the render-task capture fills the offscreen');
});

/** A cancelled save picker never starts the encoder and saves nothing. */
test('a cancelled save picker records and downloads nothing', async (t) => {
  t.after(installRecorderEnv());
  const abort = new Error('user cancelled');
  abort.name = 'AbortError';
  globalThis.showSaveFilePicker = async () => { throw abort; };
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  const downloads = [];
  rec.download = (recorder, chunks, name) => downloads.push({ chunks, name });

  rec.start('cancelled');
  const recorder = rec.mediaRecorder;
  await drainSink();

  assert.equal(recorder.state, 'inactive', 'the encoder never starts');
  assert.equal(rec.isRecording, false);
  assert.equal(downloads.length, 0, 'no download after the picker was cancelled');
});

/**
 * Save picker cancelled while the session is still live: the recorder stops, and
 * the host hook must fire or the UI stays latched on a dead session and the next
 * click starts a second recording instead of stopping the first.
 */
test('a cancelled save picker tells the host the session ended', async (t) => {
  t.after(installRecorderEnv());
  const abort = new Error('user cancelled');
  abort.name = 'AbortError';
  globalThis.showSaveFilePicker = async () => { throw abort; };
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  rec.download = () => {};
  const notified = [];
  rec.onError = (err) => notified.push(err);
  const hostNotified = trackHostError(rec);

  rec.start('cancelled');
  // The picker's rejection reaches the hook while the session is still installed.
  await hostNotified();

  assert.equal(notified.length, 1, 'the host is told the session ended');
  assert.notEqual(notified[0], abort, 'the raw AbortError never reaches the host');
  assert.match(notified[0].message, /Save dialog was cancelled/,
    'the host is given the cancellation in the words the UI shows');
  assert.equal(rec.isRecording, false, 'the cancelled session is stopped');

  assert.equal(rec.mediaRecorder, null, 'the cancelled session is cleaned up');
});
