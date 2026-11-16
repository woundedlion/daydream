import { test } from "node:test";
import assert from "node:assert/strict";
import { installConsoleCapture } from ".././helpers/fake_console.js";
import { installDocument } from ".././helpers/fake_dom.js";
import { DEFAULT_BITRATE_MBPS, MEMORY_BUFFER_LIMIT_BYTES, WRITE_BACKLOG_SECONDS, VideoRecorder } from "../../src/recording/recorder.js";
import { FPS } from "../../src/renderer/frame_constants.js";
import { expectEmptySessionWarnings, makeFakeStream, recordableCanvas, FakeMediaRecorder, installRecorderEnv, drainSink, trackSinkFinish, startAborted } from "./fixture.js";

test('a throwing format probe notifies and releases its capture stream', (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  const stream = makeFakeStream(0);
  const offscreen = {...recordableCanvas(), captureStream: () => stream};
  installDocument({createElement: () => offscreen});
  const failure = new Error('format probe unavailable');
  FakeMediaRecorder.isTypeSupported = () => { throw failure; };
  const rec = new VideoRecorder(recordableCanvas());
  rec.format = 'webm';
  const notified = [];
  rec.onError = (error) => notified.push(error);
  assert.doesNotThrow(() => rec.start('probe'));
  assert.deepEqual(notified, [failure]);
  assert.ok(captured.messages.some((message) => /format probing failed/.test(message)));
  assert.equal(FakeMediaRecorder.instances.length, 0);
  assert.equal(stream.track.stopped, true);
  assert.equal(rec.isRecording, false);
  assert.equal(rec.stream, null);
  assert.equal(rec.offscreen, null);
});

/**
 * A canvas whose 2D context is unavailable (memory pressure, a context-count
 * cap) cannot be blitted into, so start() gives up before opening any capture at
 * all and does not latch the useless buffer.
 */
test('start aborts without capturing when the offscreen has no 2D context', () => {
  const captures = [];
  const outcome = startAborted({
    width: 0, height: 0,
    getContext: () => null,
    captureStream: (fps) => { captures.push(fps); return makeFakeStream(); },
  });

  assert.deepEqual(captures, [], 'no capture stream is opened without a drawing context');
  assert.equal(outcome.recorders.length, 0, 'no recorder is constructed');
  assert.equal(outcome.rec.isRecording, false);
  assert.equal(outcome.rec.mediaRecorder, null);
  assert.equal(outcome.rec.stream, null);
  assert.equal(outcome.rec.track, null);
  assert.equal(outcome.rec.offscreen, null, 'the context-less buffer is not latched');
  assert.equal(outcome.notified.length, 1, 'the host is told the session never started');
  assert.match(outcome.notified[0].message, /2D drawing context/);
});

test('start aborts and stays idle when captureStream throws', () => {
  const failure = new Error('capture unavailable');
  const outcome = startAborted({
    width: 0, height: 0,
    getContext: () => ({ clearRect() {}, drawImage() {} }),
    captureStream: () => { throw failure; },
  });

  assert.equal(outcome.recorders.length, 0, 'no recorder is constructed');
  assert.equal(outcome.rec.isRecording, false);
  assert.equal(outcome.rec.mediaRecorder, null);
  assert.equal(outcome.rec.stream, null);
  assert.equal(outcome.rec.track, null);
  assert.equal(outcome.rec.offscreen, null, 'the capture buffer is released');
  assert.deepEqual(outcome.notified, [failure], 'the host is told the session never started');
});

/**
 * The manual-frame stream opens, its track turns out to have no requestFrame, and
 * the timed-fallback capture then fails with its stream already in hand: both the
 * manual-mode track and the half-opened fallback stream must be released rather
 * than left capturing for the rest of the page's life.
 */
test('a failed timed-fallback capture releases every stream it opened', () => {
  const failure = new Error('capture unavailable');
  const manualTrack = { stopped: false, stop() { this.stopped = true; } };
  const manualMode = { getVideoTracks: () => [manualTrack], getTracks: () => [manualTrack] };
  const fallbackTrack = { stopped: false, stop() { this.stopped = true; } };
  const fallback = {
    getVideoTracks: () => { throw failure; },
    getTracks: () => [fallbackTrack],
  };
  const fps = [];
  const outcome = startAborted({
    width: 0, height: 0,
    getContext: () => ({ clearRect() {}, drawImage() {} }),
    // The first track has no requestFrame, which forces the timed fallback.
    captureStream: (rate) => { fps.push(rate); return fps.length === 1 ? manualMode : fallback; },
  });

  assert.deepEqual(fps, [0, Math.max(1, Math.round(FPS))], 'the timed fallback is attempted at the frame rate');
  assert.equal(manualTrack.stopped, true, 'the manual-mode track is stopped');
  assert.equal(fallbackTrack.stopped, true, 'the half-opened fallback stream is released');
  assert.equal(outcome.recorders.length, 0, 'no recorder is constructed');
  assert.equal(outcome.rec.isRecording, false);
  assert.equal(outcome.rec.stream, null);
  assert.equal(outcome.rec.offscreen, null, 'the capture buffer is released');
  assert.deepEqual(outcome.notified, [failure], 'the host is told the session never started');
});

/**
 * A capture stream carrying no video track would record nothing at all, so
 * start() surfaces it instead — after stopping the tracks the streams do carry,
 * on both the manual-frame and timed-fallback attempts.
 */
test('start aborts and releases both streams when no video track is produced', () => {
  const opened = [];
  const trackless = () => {
    const stray = { stopped: false, stop() { this.stopped = true; } };
    opened.push(stray);
    return { getVideoTracks: () => [], getTracks: () => [stray] };
  };
  const outcome = startAborted({
    width: 0, height: 0,
    getContext: () => ({ clearRect() {}, drawImage() {} }),
    captureStream: trackless,
  });

  assert.equal(opened.length, 2, 'both the manual-frame and timed-fallback streams opened');
  assert.deepEqual(opened.map((t) => t.stopped), [true, true],
    'neither trackless stream is left capturing');
  assert.equal(outcome.recorders.length, 0, 'no recorder is constructed');
  assert.equal(outcome.rec.isRecording, false);
  assert.equal(outcome.rec.mediaRecorder, null);
  assert.equal(outcome.rec.stream, null);
  assert.equal(outcome.rec.track, null);
  assert.equal(outcome.rec.offscreen, null, 'the capture buffer is released');
  assert.equal(outcome.notified.length, 1, 'the host is told the session never started');
  assert.match(outcome.notified[0].message, /no video track/);
});

test('output setup failure releases the capture without starting the encoder', (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  const errors = [];
  rec.onError = (error) => errors.push(error);
  rec.openSink = () => { throw new Error('sink unavailable'); };
  rec.start('setup');
  const encoder = FakeMediaRecorder.instances.at(-1);
  assert.equal(encoder.timesliceMs, undefined, 'the encoder is never started');
  assert.equal(encoder.state, 'inactive');
  assert.equal(encoder.stream.track.stopped, true);
  assert.equal(encoder.ondataavailable, null);
  assert.equal(encoder.onstop, null);
  assert.equal(encoder.onerror, null);
  assert.equal(rec.mediaRecorder, null);
  assert.equal(rec.isRecording, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /sink unavailable/);
  assert.match(captured.messages.join(), /output setup failed/);
});

test('a throwing fallback hook cannot strand a recording after picker rejection', async (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  globalThis.showSaveFilePicker = async () => { throw new Error('picker unavailable'); };
  const rec = new VideoRecorder(recordableCanvas());
  rec.onSaveFallback = () => { throw new Error('hook failed'); };
  rec.start('fallback');
  await drainSink();
  assert.equal(rec.starting, false);
  assert.equal(rec.mediaRecorder.state, 'recording');
  assert.match(captured.messages.join(), /host notification failed/);
  rec.stop();
});

test('createWritable rejection preserves every chunk despite a throwing fallback hook', async (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('warn', 'error');
  t.after(captured.restore);
  globalThis.showSaveFilePicker = async () => ({
    createWritable: async () => { throw new Error('file locked'); },
  });
  const rec = new VideoRecorder(recordableCanvas());
  const finished = trackSinkFinish(rec);
  const downloads = [];
  const notices = [];
  const errors = [];
  rec.onSaveFallback = (error) => {
    notices.push(error);
    throw new Error('hook failed');
  };
  rec.onSaveError = (error) => errors.push(error);
  rec.download = (encoder, chunks) => downloads.push([...chunks]);
  rec.start('fallback');
  const encoder = rec.mediaRecorder;
  const first = { size: 10 }, second = { size: 20 };
  await drainSink();
  encoder.ondataavailable({ data: first });
  await drainSink();
  encoder.ondataavailable({ data: second });
  rec.stop();
  encoder.onstop();
  await finished();
  assert.deepEqual(downloads, [[first, second]]);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /could not be opened; saving to Downloads instead/);
  assert.match(captured.messages.join(), /host notification failed/);
  assert.deepEqual(errors, []);
});

test('a streaming write failure after Stop reaches the save-error UI', async (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error', 'warn');
  t.after(captured.restore);
  globalThis.showSaveFilePicker = async () => ({ createWritable: async () => ({
    write: async () => { throw new Error('disk full'); }, close: async () => { throw new Error('stream errored'); },
  }) });
  const rec = new VideoRecorder(recordableCanvas());
  const finished = trackSinkFinish(rec);
  const errors = [];
  rec.onSaveError = (error) => errors.push(error);
  rec.start('stream');
  const recorder = rec.mediaRecorder;
  await drainSink();
  recorder.ondataavailable({ data: { size: 10 } });
  rec.stop();
  recorder.onstop();
  await finished();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /chosen file was not updated/);
});

test('superseded recorder guards ignore fallback and memory overflow', async (t) => {
  t.after(installRecorderEnv());
  t.after(() => { FakeMediaRecorder.isTypeSupported = () => true; });
  const captured = installConsoleCapture('warn');
  t.after(captured.restore);
  FakeMediaRecorder.isTypeSupported = () => false;
  FakeMediaRecorder.defaultMimeType = 'video/mp4';
  const rec = new VideoRecorder(recordableCanvas());
  rec.format = 'webm';
  rec.download = () => {};
  rec.start('first');
  const first = rec.mediaRecorder;
  rec.stop();
  rec.start('second');
  const second = rec.mediaRecorder;
  const errors = [];
  const fallbacks = [];
  rec.onError = (error) => errors.push(error);
  rec.onFormatFallback = (format) => fallbacks.push(format);
  first.onstart();
  first.ondataavailable({ data: { size: MEMORY_BUFFER_LIMIT_BYTES + 1 } });
  assert.equal(rec.mediaRecorder, second);
  assert.equal(rec.isRecording, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(fallbacks, []);
  rec.stop();
  await Promise.resolve();
});

test('superseded streaming recorder ignores picker cancellation and backlog overflow', async (t) => {
  t.after(installRecorderEnv());
  let rejectFirst;
  let picks = 0;
  const stalledFile = { createWritable: () => new Promise(() => {}) };
  globalThis.showSaveFilePicker = () => {
    picks++;
    if (picks === 1) return new Promise((resolve, reject) => { rejectFirst = reject; });
    if (picks === 2) return Promise.resolve(stalledFile);
    return new Promise(() => {});
  };
  const rec = new VideoRecorder(recordableCanvas());
  rec.download = () => {};
  const errors = [];
  rec.onError = (error) => errors.push(error);

  rec.start('first');
  const first = rec.mediaRecorder;
  rec.stop();
  rec.start('second');
  const second = rec.mediaRecorder;
  rejectFirst(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  await drainSink();
  assert.equal(first.state, 'inactive');
  assert.equal(rec.mediaRecorder, second);
  assert.equal(second.state, 'recording');
  assert.deepEqual(errors, []);

  rec.stop();
  rec.start('third');
  const third = rec.mediaRecorder;
  second.ondataavailable({ data: { size: (DEFAULT_BITRATE_MBPS * 1_000_000 / 8) * WRITE_BACKLOG_SECONDS + 1 } });
  assert.equal(rec.mediaRecorder, third);
  assert.equal(rec.isRecording, true);
  assert.deepEqual(errors, []);
  rec.stop();
});

test('stopping while the Save dialog is open prevents a later encoder start', async (t) => {
  t.after(installRecorderEnv());
  let accept;
  globalThis.showSaveFilePicker = () => new Promise(resolve => { accept = resolve; });
  const rec = new VideoRecorder(recordableCanvas());
  rec.start('cancelled');
  const encoder = rec.mediaRecorder;
  assert.equal(rec.starting, true);
  rec.stop();
  accept({createWritable: async () => assert.fail('cancelled session opened a file')});
  await drainSink();
  assert.equal(encoder.timesliceMs, undefined);
  assert.equal(encoder.state, 'inactive');
  assert.equal(rec.starting, false);
});

test('a throwing started hook leaves the encoder recording', (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  rec.onStarted = () => { throw new Error('host hook failed'); };
  rec.start('recording');

  assert.equal(rec.mediaRecorder.state, 'recording');
  assert.equal(rec.isRecording, true);
  assert.equal(rec.stream.track.stopped, false);
  assert.match(captured.messages.join(), /host notification failed/);
  rec.stop();
});

test('started hook waits for the Save dialog and the running encoder', async (t) => {
  t.after(installRecorderEnv());
  let accept;
  globalThis.showSaveFilePicker = () => new Promise(resolve => { accept = resolve; });
  const rec = new VideoRecorder(recordableCanvas());
  let started = 0;
  rec.onStarted = () => { assert.equal(rec.mediaRecorder.state, 'recording'); started++; };
  rec.start('pending');
  assert.equal(started, 0);
  accept({createWritable: async () => ({write() {}, close() {}})});
  await drainSink();
  assert.equal(started, 1);
  rec.stop();
});

test('a recording session captures in manual-frame mode', (t) => {
  expectEmptySessionWarnings(t);
  t.after(installRecorderEnv());
  const rec = new VideoRecorder(recordableCanvas());
  rec.download = () => {};
  rec.toggle('e');
  const stream = rec.stream;
  assert.equal(stream.captureRate, 0,
    'the session must capture in manual-frame mode, not off the wall clock');
  assert.equal(typeof rec.track.requestFrame, 'function');
  rec.stop();
  rec.mediaRecorder.onstop();
});

test('recording chunks arrive on a positive timeslice', (t) => {
  expectEmptySessionWarnings(t);
  t.after(installRecorderEnv());
  const rec = new VideoRecorder(recordableCanvas());
  rec.download = () => {};
  rec.toggle('e');
  const recorder = rec.mediaRecorder;
  assert.ok(Number.isFinite(recorder.timesliceMs) && recorder.timesliceMs > 0,
    'chunks must be delivered on a timeslice, not buffered until stop');
  rec.stop();
  rec.mediaRecorder.onstop();
});
