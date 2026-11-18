import { test } from "node:test";
import assert from "node:assert/strict";
import { installConsoleCapture } from "../helpers/fake_console.js";
import { stashGlobals } from "../helpers/fake_dom.js";
import { VideoRecorder } from "../../src/recording/recorder.js";
import { expectEmptySessionWarnings, captureSessionBuffers, recordableCanvas, FakeMediaRecorder, installRecorderEnv, visibilityDocument, startRecorder, drainSink } from "./fixture.js";

test('background visibility pauses recording time and remains stoppable', (t) => {
  t.after(installRecorderEnv());
  const doc = visibilityDocument(false);
  const removed = [];
  const removeEventListener = doc.removeEventListener.bind(doc);
  doc.removeEventListener = (type, listener, options) => {
    removed.push([type, listener]);
    removeEventListener(type, listener, options);
  };
  let now = 1000;
  const rec = startRecorder(recordableCanvas(), { now: () => now, doc });
  const media = rec.mediaRecorder;
  assert.equal(media.state, 'recording');
  now = 2000;
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(media.state, 'paused');
  assert.equal(rec.isRecording, true);
  now = 62_000;
  assert.equal(rec.elapsedSeconds, 1);
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(media.state, 'recording');
  now = 63_000;
  assert.equal(rec.elapsedSeconds, 2);
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  rec.stop();
  assert.equal(media.state, 'inactive');
  rec.dispose();
  assert.deepEqual(removed, [['visibilitychange', rec.visibilityChanged]],
    'dispose removes the document listener it installed');
});

test('a recording started on a hidden page begins paused', (t) => {
  t.after(installRecorderEnv());
  const doc = visibilityDocument(true);
  let now = 1000;
  const rec = startRecorder(recordableCanvas(), { now: () => now, doc });
  const media = rec.mediaRecorder;
  assert.equal(media.state, 'paused');
  assert.equal(rec.isRecording, true);
  now = 5000;
  assert.equal(rec.elapsedSeconds, 0);
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(media.state, 'recording');
  now = 7000;
  assert.equal(rec.elapsedSeconds, 2);
  rec.dispose();
  assert.equal(media.state, 'inactive');
});

test('isSupported answers false where the DOM globals are absent', (t) => {
  t.after(stashGlobals('HTMLCanvasElement', 'MediaRecorder'));
  delete globalThis.HTMLCanvasElement;
  delete globalThis.MediaRecorder;
  assert.equal(VideoRecorder.isSupported(), false,
    'a host with no canvas global must be answered, not thrown at');
  globalThis.HTMLCanvasElement = class { captureStream() {} };
  assert.equal(VideoRecorder.isSupported(), false,
    'a host with no MediaRecorder global must be answered, not thrown at');
});

test('isSupported answers true where captureStream and MediaRecorder both exist', (t) => {
  t.after(installRecorderEnv());
  assert.equal(VideoRecorder.isSupported(), true);
});

test('toggle starts then stops, reporting the true state each time', (t) => {
  expectEmptySessionWarnings(t);
  t.after(installRecorderEnv());
  const rec = new VideoRecorder(recordableCanvas());
  rec.download = () => {};
  assert.equal(rec.toggle('e'), true);
  assert.equal(rec.isRecording, true);
  const stream = rec.stream;
  const recorder = rec.mediaRecorder;
  assert.equal(rec.toggle('e'), false);
  assert.equal(rec.isRecording, false);
  recorder.onstop();
  assert.equal(rec.mediaRecorder, null, 'onstop clears the recorder');
  assert.equal(stream.track.stopped, true, 'onstop stops the capture track');
});

test('elapsed time follows the recording wall-clock lifecycle', (t) => {
  expectEmptySessionWarnings(t);
  t.after(installRecorderEnv());
  let nowMs = 10_000;
  let clockReads = 0;
  const rec = startRecorder(recordableCanvas(), {
    now: () => {
      clockReads++;
      return nowMs;
    },
  });
  const recorder = rec.mediaRecorder;
  const clockReadsAtStart = clockReads;

  rec.captureFrame();
  rec.captureFrame();
  assert.equal(clockReads, clockReadsAtStart,
    'captureFrame does not read the clock on the render path');
  assert.equal(rec.elapsedSeconds, 0,
    'captured frames do not manufacture elapsed time');

  nowMs += 5_900;
  assert.equal(rec.elapsedSeconds, 5.9,
    'a simulation pause remains part of the recording duration');
  assert.equal(rec.elapsedFormatted, '0:05');

  nowMs += 55_000;
  assert.equal(rec.elapsedFormatted, '1:00',
    'a render stall advances the readout without a captured frame');

  rec.stop();
  const stoppedElapsed = rec.elapsedSeconds;
  nowMs += 30_000;
  assert.equal(rec.elapsedSeconds, stoppedElapsed,
    'the duration freezes when MediaRecorder stops accepting data');
  recorder.onstop();
});

/** A session waiting on the Save dialog reads 0:00, not the last duration. */
test('a pending save dialog shows zero elapsed after a prior session', (t) => {
  t.after(installRecorderEnv());
  const warnings = installConsoleCapture('warn');
  t.after(warnings.restore);
  let nowMs = 0;
  const rec = startRecorder(recordableCanvas(), { now: () => nowMs });
  nowMs = 42_000;
  const first = rec.mediaRecorder;
  rec.stop();
  first.onstop();
  assert.equal(rec.elapsedFormatted, '0:42');

  globalThis.showSaveFilePicker = () => new Promise(() => {});
  rec.start('second');
  assert.equal(rec.isRecording, true);
  assert.equal(rec.elapsedFormatted, '0:00');
  rec.stop();
});

/** abort() still finalizes the output; an idle recorder reports nothing. */
test('abort stops a live session and tells the host', (t) => {
  expectEmptySessionWarnings(t);
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  rec.download = () => {};
  const notified = [];
  rec.onError = (err) => notified.push(err);
  rec.start('e');
  const recorder = rec.mediaRecorder;

  rec.abort('context lost');
  assert.equal(rec.isRecording, false);
  assert.equal(notified.length, 1, 'the host is told the session ended');
  assert.match(notified[0].message, /context lost/);
  recorder.onstop();
  assert.equal(rec.mediaRecorder, null, 'the stop path still finalizes the session');

  rec.abort('context lost');
  assert.equal(notified.length, 1, 'an idle recorder has nothing to abort');
});

test('start refuses and stays idle when recording is unsupported', (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  delete globalThis.MediaRecorder;
  const rec = new VideoRecorder(recordableCanvas());
  const notified = [];
  rec.onError = (err) => notified.push(err);
  rec.start('e');
  assert.equal(rec.mediaRecorder, null);
  assert.equal(rec.isRecording, false);
  assert.equal(captured.messages.length, 1);
  assert.equal(notified.length, 1, 'the host is told the session never started');
  assert.match(notified[0].message, /not supported/);
});

test('an unsupported explicit format reports the browser-selected container', async (t) => {
  t.after(installRecorderEnv());
  t.after(() => { FakeMediaRecorder.isTypeSupported = () => true; });
  const captured = installConsoleCapture('warn');
  t.after(captured.restore);
  FakeMediaRecorder.isTypeSupported = () => false;
  const rec = new VideoRecorder(recordableCanvas());
  const fallbacks = [];
  let pickerOptions;
  globalThis.showSaveFilePicker = (options) => {
    pickerOptions = options;
    return Promise.resolve({});
  };
  rec.format = 'webm';
  FakeMediaRecorder.defaultMimeType = 'video/mp4';
  rec.onFormatFallback = (extension) => fallbacks.push(extension);
  rec.download = () => {};

  rec.start('e');
  const recorder = rec.mediaRecorder;

  assert.match(pickerOptions.suggestedName, /\.video$/);
  assert.equal(pickerOptions.types, undefined);
  assert.equal(recorder.mimeType, '');
  assert.deepEqual(fallbacks, []);
  await drainSink();
  assert.equal(recorder.state, 'recording');
  assert.deepEqual(fallbacks, ['mp4']);
  assert.equal(captured.messages.length, 1);
  assert.match(captured.messages[0], /requested format "webm" is unsupported/);
});

/** The stream is not on the instance yet, so cleanup() cannot reach those tracks. */
test('a MediaRecorder construction failure stops the acquired capture tracks', (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  const failure = new Error('unsupported recorder options');
  failure.name = 'NotSupportedError';
  FakeMediaRecorder.constructError = failure;

  const rec = new VideoRecorder(recordableCanvas());
  let sinkOpened = false;
  rec.openSink = () => { sinkOpened = true; };
  const notified = [];
  rec.onError = (err) => notified.push(err);

  assert.doesNotThrow(() => rec.start('e'));

  assert.equal(FakeMediaRecorder.instances.length, 0);
  assert.equal(FakeMediaRecorder.lastStream.track.stopped, true,
    'the capture track is stopped, so the capture does not stay live');
  assert.equal(rec.mediaRecorder, null);
  assert.equal(rec.stream, null);
  assert.equal(rec.track, null);
  assert.equal(rec.offscreen, null);
  assert.equal(rec.offCtx, null);
  assert.equal(rec.isRecording, false);
  assert.equal(sinkOpened, false);
  assert.ok(captured.calls.some((args) => args.includes(failure)));
  assert.deepEqual(notified, [failure], 'the host is told the session never started');

  FakeMediaRecorder.constructError = null;
  rec.openSink = () => ({ write() {}, finish() {} });
  rec.start('retry');
  assert.equal(rec.isRecording, true);
  rec.dispose();
});

test('a MediaRecorder start failure releases the entire capture session', (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  const failure = new Error('codec start rejected');
  failure.name = 'NotSupportedError';
  FakeMediaRecorder.startError = failure;

  const rec = new VideoRecorder(recordableCanvas());
  let sinkFinished = 0;
  rec.openSink = () => ({ write() {}, finish() { sinkFinished++; } });
  const notified = [];
  rec.onError = (err) => notified.push(err);

  const sessionBuffers = captureSessionBuffers(rec);
  assert.doesNotThrow(() => rec.start('e'));

  const recorder = FakeMediaRecorder.instances[0];
  assert.equal(recorder.stream.track.stopped, true);
  assert.equal(recorder.ondataavailable, null);
  assert.equal(recorder.onstop, null);
  assert.equal(recorder.onerror, null);
  assert.equal(rec.mediaRecorder, null);
  assert.equal(rec.stream, null);
  assert.equal(rec.track, null);
  assert.deepEqual(sessionBuffers.at(-1), []);
  assert.equal(rec.offscreen, null);
  assert.equal(rec.offCtx, null);
  assert.equal(rec.isRecording, false);
  assert.equal(sinkFinished, 1, 'the opened sink is closed');
  assert.ok(captured.calls.some((args) => args.includes(failure)));
  assert.deepEqual(notified, [failure], 'the host is told the session never started');

  FakeMediaRecorder.startError = null;
  rec.openSink = () => ({ write() {}, finish() {} });
  notified.length = 0;
  rec.start('retry');
  assert.equal(rec.isRecording, true);
  rec.dispose();
});
