import { test } from "node:test";
import assert from "node:assert/strict";
import { installConsoleCapture } from ".././helpers/fake_console.js";
import { VideoRecorder } from "../../src/recording/recorder.js";
import { captureSessionBuffers, recordableCanvas, FakeMediaRecorder, installRecorderEnv } from "./fixture.js";

test('a stopped session downloads its own chunks and clears instance state', (t) => {
  t.after(installRecorderEnv());
  const rec = new VideoRecorder(recordableCanvas());
  const downloads = [];
  rec.download = (recorder, chunks, name) => downloads.push({ recorder, chunks, name });

  rec.start('solo');
  const recorder = rec.mediaRecorder;
  const stream = rec.stream;
  recorder.ondataavailable({ data: { size: 10 } });
  rec.stop();
  recorder.onstop();

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, 'solo');
  assert.deepEqual(downloads[0].chunks, [{ size: 10 }]);
  assert.equal(rec.mediaRecorder, null);
  assert.equal(stream.track.stopped, true);
});

/** Reported the same way as an empty streaming session. */
test('a buffered session that captured nothing is reported', (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('warn');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  let empty = 0;
  rec.onEmptySession = () => { empty++; };
  const downloads = [];
  rec.download = (recorder, chunks, name) => downloads.push({ chunks, name });

  rec.start('empty');
  const recorder = rec.mediaRecorder;
  rec.stop();
  recorder.onstop();

  assert.equal(downloads.length, 0, 'an empty buffer must not reach the anchor path');
  assert.equal(captured.messages.length, 1);
  assert.match(captured.messages[0], /session produced no data/);
  assert.equal(empty, 1);
});

/** The encoder hands over a final chunk between stop() and the stop event. */
test('the chunk flushed by stop is saved with the rest', (t) => {
  t.after(installRecorderEnv());
  const rec = new VideoRecorder(recordableCanvas());
  const downloads = [];
  rec.download = (recorder, chunks, name) => downloads.push({ chunks, name });
  FakeMediaRecorder.stopData = { size: 7 };

  rec.start('tail');
  const recorder = rec.mediaRecorder;
  recorder.ondataavailable({ data: { size: 10 } });
  rec.stop();
  recorder.onstop();

  assert.equal(downloads.length, 1);
  assert.deepEqual(downloads[0].chunks, [{ size: 10 }, { size: 7 }],
    'the tail follows the chunks the timeslice already delivered');
});

test('a chunk emitted synchronously by start reaches the installed sink', (t) => {
  t.after(installRecorderEnv());
  const rec = new VideoRecorder(recordableCanvas());
  const writes = [];
  rec.openSink = () => ({ write: (chunk) => writes.push(chunk), finish() {} });
  FakeMediaRecorder.startData = { size: 10 };

  const sessionBuffers = captureSessionBuffers(rec);
  rec.start('sync');

  assert.deepEqual(writes, [{ size: 10 }]);
  assert.deepEqual(sessionBuffers.at(-1), []);
  rec.dispose();
});

/**
 * An encoder fault ends the session on its own: the recorder must finalize the
 * output once, report the failure, notify the host so the UI can drop its
 * recording state, and clear itself so the next click starts a fresh session
 * instead of a second one.
 */
test('an encoder error finalizes the session, reports it, and clears the recorder', (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  const downloads = [];
  rec.download = (recorder, chunks, name) => downloads.push({ chunks, name });
  const notified = [];
  rec.onError = (err) => notified.push(err);

  rec.start('faulted');
  const recorder = rec.mediaRecorder;
  const stream = rec.stream;
  recorder.ondataavailable({ data: { size: 10 } });

  const failure = new Error('encoder died');
  recorder.onerror({ error: failure });
  assert.equal(downloads.length, 0, 'wait for the final data event');
  recorder.ondataavailable({ data: { size: 7 } });
  recorder.onstop();

  assert.equal(downloads.length, 1, 'the partial capture is still finalized');
  assert.deepEqual(downloads[0].chunks, [{ size: 10 }, { size: 7 }]);
  assert.equal(recorder.state, 'inactive', 'the faulted recorder is stopped');
  assert.equal(stream.track.stopped, true, 'the capture track is released');
  assert.equal(rec.mediaRecorder, null);
  assert.equal(rec.stream, null);
  assert.equal(rec.track, null);
  assert.equal(rec.offscreen, null);
  assert.equal(rec.isRecording, false);
  assert.deepEqual(notified, [failure], 'the host is told the session ended');
  assert.ok(captured.calls.some((args) => args.includes(failure)),
    'the failure is reported');

  // The UA may still deliver a stop event after the error; it must not finalize twice.
  recorder.onstop();
  assert.equal(downloads.length, 1);

  rec.start('retry');
  assert.equal(rec.isRecording, true);
  assert.notEqual(rec.mediaRecorder, recorder, 'the next start is a fresh session');
  rec.dispose();
});

test('an encoder error event without an Error cause is normalized', (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  const notified = [];
  rec.download = () => {};
  rec.onError = (err) => notified.push(err);
  rec.start('e');

  rec.mediaRecorder.onerror({ type: 'error' });

  assert.equal(notified.length, 1);
  assert.ok(notified[0] instanceof Error);
  assert.match(notified[0].message, /recording failed/);
  rec.dispose();
});

/**
 * The stop->start race applied to errors: a stale session's fault must finalize
 * only its own output and must neither tear down nor report against the newer
 * session that replaced it.
 */
test('a stale session error does not clobber the session that replaced it', (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  const downloads = [];
  rec.download = (recorder, chunks, name) => downloads.push({ chunks, name });
  const notified = [];
  rec.onError = (err) => notified.push(err);

  rec.start('first');
  const recorderA = rec.mediaRecorder;
  recorderA.ondataavailable({ data: { size: 10 } });
  rec.stop();

  rec.start('second');
  const recorderB = rec.mediaRecorder;
  recorderB.ondataavailable({ data: { size: 20 } });

  recorderA.onerror({ error: new Error('late encoder fault') });
  recorderA.onstop();

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, 'first');
  assert.equal(notified.length, 0, 'the live session is not reported as failed');
  assert.equal(rec.mediaRecorder, recorderB);
  assert.equal(rec.isRecording, true);
  assert.equal(rec.stream.track.stopped, false);
});

test('a session retains only non-empty chunks', (t) => {
  t.after(installRecorderEnv());
  const rec = new VideoRecorder(recordableCanvas());
  const downloads = [];
  rec.download = (recorder, chunks, name) => downloads.push({ recorder, chunks, name });

  rec.start('e');
  const recorder = rec.mediaRecorder;
  // MediaRecorder can emit zero-byte dataavailable events (a flush with nothing buffered).
  recorder.ondataavailable({ data: { size: 0 } });
  recorder.ondataavailable({ data: { size: 42 } });
  recorder.ondataavailable({ data: { size: 0 } });
  rec.stop();
  recorder.onstop();

  assert.equal(downloads.length, 1);
  assert.deepEqual(downloads[0].chunks, [{ size: 42 }],
    'only the non-empty chunk is retained');
});

test('a stale empty session does not notify the session that replaced it', (t) => {
  t.after(installRecorderEnv());
  t.mock.method(console, 'warn', () => {});
  let empty = 0;
  const rec = new VideoRecorder(recordableCanvas());
  rec.onEmptySession = () => { empty++; };
  rec.start('first');
  const recorderA = rec.mediaRecorder;
  rec.stop();
  rec.start('second');
  const recorderB = rec.mediaRecorder;
  recorderA.onstop();
  assert.equal(empty, 0);
  assert.equal(rec.mediaRecorder, recorderB);
  assert.equal(rec.isRecording, true);
});

/** A stale stop handler downloads its session's chunks and preserves its replacement. */
test('a stale onstop does not clobber the session that replaced it', (t) => {
  t.after(installRecorderEnv());
  const rec = new VideoRecorder(recordableCanvas());
  const downloads = [];
  rec.download = (recorder, chunks, name) => downloads.push({ recorder, chunks, name });

  const sessionBuffers = captureSessionBuffers(rec);
  rec.start('first');
  const recorderA = rec.mediaRecorder;
  const streamA = rec.stream;
  recorderA.ondataavailable({ data: { size: 10 } });
  rec.stop();

  // Session B installed before A's deferred onstop runs.
  rec.start('second');
  const recorderB = rec.mediaRecorder;
  assert.notEqual(recorderB, recorderA);
  recorderB.ondataavailable({ data: { size: 20 } });

  recorderA.onstop();

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, 'first');
  assert.deepEqual(downloads[0].chunks, [{ size: 10 }]);
  assert.equal(streamA.track.stopped, true);

  assert.equal(rec.mediaRecorder, recorderB);
  assert.deepEqual(sessionBuffers.at(-1), [{ size: 20 }]);
  assert.equal(rec.stream.track.stopped, false);
});
