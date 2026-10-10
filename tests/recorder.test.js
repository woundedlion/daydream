import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { installConsoleCapture } from './helpers/fake_console.js';
import { fakeElement, installDocument } from './helpers/fake_dom.js';
import {
  MEMORY_BUFFER_LIMIT_BYTES, PICKER_GRACE_SECONDS, selectMimeType, VideoRecorder,
} from '../src/recording/recorder.js';

/** Fixed local wall-clock time so the timestamped file name is exact. */
const SAVE_CLOCK = new Date(2026, 0, 2, 3, 4, 5);

/**
 * Builds a fake isTypeSupported probe that accepts only the listed MIME types,
 * so each test can pin down exactly which codecs the "browser" advertises.
 * @param {...string} allowed - MIME type strings the probe should report as supported.
 * @returns {function(string): boolean} A probe that returns true only for an allowed MIME type.
 */
const supports = (...allowed) => (mt) => allowed.includes(mt);

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
 * Installs a document whose createElement yields a blank fake canvas, so the
 * offscreen-sizing paths run in Node without a DOM.
 * @returns {() => void} A function that restores the saved document.
 */
const installFakeDocument = () => {
  const savedDocument = globalThis.document;
  installDocument({ createElement: () => fakeCanvas() });
  return () => { globalThis.document = savedDocument; };
};

/** Native capture rounds the start-time source size up to even and keeps it. */
test('native-resolution capture pins the offscreen to the source size at start', () => {
  const restore = installFakeDocument();
  try {
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
  } finally {
    restore();
  }
});

/** Both offscreen dimensions round up to even, at the start-time source aspect. */
test('targetHeight capture scales the offscreen to the target height and pins it', () => {
  const restore = installFakeDocument();
  try {
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
  } finally {
    restore();
  }
});

/** A 0x0 source has a non-finite aspect, which would make NaN canvas dimensions. */
test('targetHeight capture falls back to a square when the source aspect is degenerate', () => {
  const restore = installFakeDocument();
  try {
    const rec = new VideoRecorder(fakeCanvas(0, 0)); // 0/0 → NaN aspect
    rec.targetHeight = 120;
    const off = rec.ensureOffscreen();
    assert.equal(off.height, 120);
    assert.equal(off.width, 120, 'square fallback, not NaN');
  } finally {
    restore();
  }
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

// ---------------------------------------------------------------------------
// MediaRecorder session lifecycle, behind a fake MediaRecorder/captureStream.
// ---------------------------------------------------------------------------

/** A fake video track with the manual-frame API the recorder drives. */
const makeFakeTrack = () => ({ requestFrame() {}, stop() { this.stopped = true; }, stopped: false });

/**
 * A fake capture stream exposing the one video track, tagged with the frame rate
 * it was opened at. This fixture omits requestFrame for nonzero rates to exercise
 * the recorder's capability fallback.
 * @param {number} [fps] - Frame rate captureStream was called with.
 * @returns {Object} The stream.
 */
const makeFakeStream = (fps = 0) => {
  const track = makeFakeTrack();
  if (fps !== 0) delete track.requestFrame;
  return { track, captureRate: fps, getVideoTracks: () => [track], getTracks: () => [track] };
};

/** A fake canvas that can be recorded (has captureStream) and blitted into. */
const recordableCanvas = (w = 64, h = 32) => ({
  width: w, height: h,
  getContext: () => ({ clearRect() {}, drawImage() {} }),
  captureStream: (fps) => makeFakeStream(fps),
});

/**
 * Minimal MediaRecorder stand-in. start()/stop() flip state synchronously like
 * the spec; the test fires onstop manually to model the async stop->start window.
 */
class FakeMediaRecorder {
  static instances = [];
  static constructError = null;
  static startError = null;
  static startData = null;
  static defaultMimeType = 'video/webm';
  static stopData = null;
  // Stream of the most recent construction attempt, including one that threw:
  // the only handle on the tracks a failed construction has to release.
  static lastStream = null;
  static isTypeSupported() { return true; }
  constructor(stream, options) {
    FakeMediaRecorder.lastStream = stream;
    if (FakeMediaRecorder.constructError) throw FakeMediaRecorder.constructError;
    this.stream = stream;
    this.options = options;
    this.mimeType = options.mimeType || '';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    FakeMediaRecorder.instances.push(this);
  }
  start(timesliceMs) {
    // Without a timeslice the encoder buffers the whole recording until stop(),
    // so a start that omits it is a fault rather than a session.
    if (!Number.isFinite(timesliceMs) || timesliceMs <= 0) {
      throw new Error(`start(): expected a positive timeslice, got ${timesliceMs}`);
    }
    this.timesliceMs = timesliceMs;
    if (FakeMediaRecorder.startError) throw FakeMediaRecorder.startError;
    this.state = 'recording';
    queueMicrotask(() => {
      this.mimeType ||= FakeMediaRecorder.defaultMimeType;
      this.onstart?.();
    });
    if (FakeMediaRecorder.startData) {
      this.ondataavailable({ data: FakeMediaRecorder.startData });
    }
  }
  pause() {
    if (this.state !== 'recording') throw new Error(`pause() while ${this.state}`);
    this.state = 'paused';
  }
  resume() {
    if (this.state !== 'paused') throw new Error(`resume() while ${this.state}`);
    this.state = 'recording';
  }
  stop() {
    // Spec order: the state goes inactive at once, then whatever the encoder
    // still holds is flushed as a last dataavailable ahead of the stop event.
    this.state = 'inactive';
    if (FakeMediaRecorder.stopData) {
      this.ondataavailable?.({ data: FakeMediaRecorder.stopData });
    }
  }
}

/**
 * Installs the browser globals the recorder touches and returns a restore fn.
 * showSaveFilePicker is left undefined, so the recorder buffers chunks and saves
 * via the anchor path (download).
 * @returns {() => void} A function that restores the saved globals.
 */
const installRecorderEnv = () => {
  const saved = {
    MediaRecorder: globalThis.MediaRecorder,
    HTMLCanvasElement: globalThis.HTMLCanvasElement,
    document: globalThis.document,
    showSaveFilePicker: globalThis.showSaveFilePicker,
  };
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.constructError = null;
  FakeMediaRecorder.lastStream = null;
  FakeMediaRecorder.startError = null;
  FakeMediaRecorder.startData = null;
  FakeMediaRecorder.defaultMimeType = 'video/webm';
  FakeMediaRecorder.stopData = null;
  FakeMediaRecorder.isTypeSupported = () => true;
  globalThis.MediaRecorder = FakeMediaRecorder;
  globalThis.HTMLCanvasElement = class { captureStream() {} };
  installDocument({ createElement: () => recordableCanvas() });
  delete globalThis.showSaveFilePicker;
  return () => {
    globalThis.MediaRecorder = saved.MediaRecorder;
    globalThis.HTMLCanvasElement = saved.HTMLCanvasElement;
    globalThis.document = saved.document;
    globalThis.showSaveFilePicker = saved.showSaveFilePicker;
  };
};

/**
 * A document that reports `hidden`, dispatches visibilitychange and creates
 * the recorder's offscreen canvas.
 * @param {boolean} hidden - The initial visibility.
 */
const visibilityDocument = (hidden) => Object.assign(new EventTarget(), {
  hidden, createElement: () => recordableCanvas(),
});

test('background visibility pauses recording time and remains stoppable', () => {
  const restore = installRecorderEnv();
  try {
    const doc = visibilityDocument(false);
    const removed = [];
    const removeEventListener = doc.removeEventListener.bind(doc);
    doc.removeEventListener = (type, listener, options) => {
      removed.push([type, listener]);
      removeEventListener(type, listener, options);
    };
    let now = 1000;
    const rec = new VideoRecorder(recordableCanvas(), 1 / 16, () => now, doc);
    rec.download = () => {};
    rec.start('e');
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
  } finally {
    restore();
  }
});

test('a recording started on a hidden page begins paused', () => {
  const restore = installRecorderEnv();
  try {
    const doc = visibilityDocument(true);
    let now = 1000;
    const rec = new VideoRecorder(recordableCanvas(), 1 / 16, () => now, doc);
    rec.download = () => {};
    rec.start('e');
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
  } finally {
    restore();
  }
});

test('isSupported answers false where the DOM globals are absent', () => {
  const saved = {
    HTMLCanvasElement: globalThis.HTMLCanvasElement,
    MediaRecorder: globalThis.MediaRecorder,
  };
  delete globalThis.HTMLCanvasElement;
  delete globalThis.MediaRecorder;
  try {
    assert.equal(VideoRecorder.isSupported(), false,
      'a host with no canvas global must be answered, not thrown at');
    globalThis.HTMLCanvasElement = class { captureStream() {} };
    assert.equal(VideoRecorder.isSupported(), false,
      'a host with no MediaRecorder global must be answered, not thrown at');
  } finally {
    globalThis.HTMLCanvasElement = saved.HTMLCanvasElement;
    globalThis.MediaRecorder = saved.MediaRecorder;
  }
});

test('isSupported answers true where captureStream and MediaRecorder both exist', () => {
  const restore = installRecorderEnv();
  try {
    assert.equal(VideoRecorder.isSupported(), true);
  } finally {
    restore();
  }
});

test('toggle starts then stops, reporting the true state each time', () => {
  const restore = installRecorderEnv();
  try {
    const rec = new VideoRecorder(recordableCanvas());
    rec.download = () => {};
    assert.equal(rec.toggle('e'), true);
    assert.equal(rec.isRecording, true);
    const stream = rec.stream;
    const recorder = rec.mediaRecorder;
    assert.equal(stream.captureRate, 0,
      'the session must capture in manual-frame mode, not off the wall clock');
    assert.equal(typeof rec.track.requestFrame, 'function');
    assert.equal(recorder.timesliceMs, 1000,
      'chunks must be delivered on a timeslice, not buffered until stop');
    assert.equal(rec.toggle('e'), false);
    assert.equal(rec.isRecording, false);
    recorder.onstop();
    assert.equal(rec.mediaRecorder, null, 'onstop clears the recorder');
    assert.equal(stream.track.stopped, true, 'onstop stops the capture track');
  } finally {
    restore();
  }
});

test('elapsed time follows the recording wall-clock lifecycle', () => {
  const restore = installRecorderEnv();
  try {
    let nowMs = 10_000;
    let clockReads = 0;
    const rec = new VideoRecorder(recordableCanvas(), 1 / 16, () => {
      clockReads++;
      return nowMs;
    });
    rec.download = () => {};
    rec.start('e');
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
  } finally {
    restore();
  }
});

/** abort() still finalizes the output; an idle recorder reports nothing. */
test('abort stops a live session and tells the host', () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error');
  try {
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
  } finally {
    captured.restore();
    restore();
  }
});

test('start refuses and stays idle when recording is unsupported', () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error');
  try {
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
  } finally {
    captured.restore();
    restore();
  }
});

test('an unsupported explicit format reports the browser-selected container', async () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('warn');
  try {
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

    assert.match(pickerOptions.suggestedName, /\.video$/);
    assert.equal(pickerOptions.types, undefined);
    assert.equal(rec.mediaRecorder.mimeType, '');
    assert.deepEqual(fallbacks, []);
    await Promise.resolve();
    assert.deepEqual(fallbacks, ['mp4']);
    assert.equal(captured.messages.length, 1);
    assert.match(captured.messages[0], /requested format "webm" is unsupported/);
  } finally {
    FakeMediaRecorder.isTypeSupported = () => true;
    captured.restore();
    restore();
  }
});

/** The stream is not on the instance yet, so cleanup() cannot reach those tracks. */
test('a MediaRecorder construction failure stops the acquired capture tracks', () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error');
  try {
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
  } finally {
    captured.restore();
    restore();
  }
});

test('a MediaRecorder start failure releases the entire capture session', () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error');
  try {
    const failure = new Error('codec start rejected');
    failure.name = 'NotSupportedError';
    FakeMediaRecorder.startError = failure;

    const rec = new VideoRecorder(recordableCanvas());
    let sinkOpened = false;
    rec.openSink = () => { sinkOpened = true; };
    const notified = [];
    rec.onError = (err) => notified.push(err);

    assert.doesNotThrow(() => rec.start('e'));

    const recorder = FakeMediaRecorder.instances[0];
    assert.equal(recorder.stream.track.stopped, true);
    assert.equal(recorder.ondataavailable, null);
    assert.equal(recorder.onstop, null);
    assert.equal(rec.mediaRecorder, null);
    assert.equal(rec.stream, null);
    assert.equal(rec.track, null);
    assert.deepEqual(rec.chunks, []);
    assert.equal(rec.offscreen, null);
    assert.equal(rec.offCtx, null);
    assert.equal(rec.isRecording, false);
    assert.equal(sinkOpened, false);
    assert.ok(captured.calls.some((args) => args.includes(failure)));
    assert.deepEqual(notified, [failure], 'the host is told the session never started');

    FakeMediaRecorder.startError = null;
    rec.openSink = () => ({ write() {}, finish() {} });
    notified.length = 0;
    rec.start('retry');
    assert.equal(rec.isRecording, true);
    rec.dispose();
  } finally {
    captured.restore();
    restore();
  }
});

test('a stopped session downloads its own chunks and clears instance state', () => {
  const restore = installRecorderEnv();
  try {
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
  } finally {
    restore();
  }
});

/** Reported the same way as an empty streaming session. */
test('a buffered session that captured nothing is reported', () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('warn');
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const downloads = [];
    rec.download = (recorder, chunks, name) => downloads.push({ chunks, name });

    rec.start('empty');
    const recorder = rec.mediaRecorder;
    rec.stop();
    recorder.onstop();

    assert.equal(downloads.length, 0, 'an empty buffer must not reach the anchor path');
    assert.equal(captured.messages.length, 1);
    assert.match(captured.messages[0], /session produced no data/);
  } finally {
    captured.restore();
    restore();
  }
});

/** The encoder hands over a final chunk between stop() and the stop event. */
test('the chunk flushed by stop is saved with the rest', () => {
  const restore = installRecorderEnv();
  try {
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
  } finally {
    restore();
  }
});

test('a chunk emitted synchronously by start reaches the installed sink', () => {
  const restore = installRecorderEnv();
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const writes = [];
    rec.openSink = () => ({ write: (chunk) => writes.push(chunk), finish() {} });
    FakeMediaRecorder.startData = { size: 10 };

    rec.start('sync');

    assert.deepEqual(writes, [{ size: 10 }]);
    assert.deepEqual(rec.chunks, []);
    rec.dispose();
  } finally {
    restore();
  }
});

/**
 * An encoder fault ends the session on its own: the recorder must finalize the
 * output once, report the failure, notify the host so the UI can drop its
 * recording state, and clear itself so the next click starts a fresh session
 * instead of a second one.
 */
test('an encoder error finalizes the session, reports it, and clears the recorder', () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error');
  try {
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
  } finally {
    captured.restore();
    restore();
  }
});

test('an encoder error event without an Error cause is normalized', () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error');
  try {
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
  } finally {
    captured.restore();
    restore();
  }
});

/**
 * The stop->start race applied to errors: a stale session's fault must finalize
 * only its own output and must neither tear down nor report against the newer
 * session that replaced it.
 */
test('a stale session error does not clobber the session that replaced it', () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error');
  try {
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
  } finally {
    captured.restore();
    restore();
  }
});

test('a session retains only non-empty chunks', () => {
  const restore = installRecorderEnv();
  try {
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
  } finally {
    restore();
  }
});

/**
 * The core stop->start race: a fast restart installs a new session on this.*
 * before the old recorder's async onstop fires. The stale handler must download
 * ITS OWN chunks and must NOT tear down the newer active session.
 */
test('a stale onstop does not clobber the session that replaced it', () => {
  const restore = installRecorderEnv();
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const downloads = [];
    rec.download = (recorder, chunks, name) => downloads.push({ recorder, chunks, name });

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
    assert.deepEqual(rec.chunks, [{ size: 20 }]);
    assert.equal(rec.stream.track.stopped, false);
  } finally {
    restore();
  }
});

/**
 * Settles the streaming sink's serialized write chain, which defers every chunk
 * behind the picker promise, so a test can assert on what the chain did. A
 * macrotask hop: the chain queues one microtask per link, so awaiting a resolved
 * promise advances it by a link rather than settling it.
 * @returns {Promise<void>} Resolves once the queued chunk writes have run.
 */
const drainSink = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Wraps a recorder's sink factory so a test can await the session's async
 * finish() chain directly, rather than guessing how many task turns it takes.
 * @param {VideoRecorder} rec - Recorder whose next session is instrumented.
 * @returns {() => Promise<void>} Resolves once finish() has run to completion.
 */
const trackSinkFinish = (rec) => {
  const openSink = rec.openSink.bind(rec);
  let finished = null;
  rec.openSink = (...args) => {
    const sink = openSink(...args);
    return { ...sink, finish: () => { finished = sink.finish(); } };
  };
  return async () => {
    assert.ok(typeof finished?.then === 'function',
      'the session sink finished and handed back its completion promise');
    await finished;
  };
};

/**
 * With the File System Access API present, chunks are queued for ordered writes
 * and released after writing. Stopping closes the file after those writes;
 * no blob download is assembled on a successful streaming save.
 */
test('streams chunks to disk when the File System Access API is present', async () => {
  const restore = installRecorderEnv();
  const writes = [];
  let closed = false;
  const writable = { write: async (d) => { writes.push(d); }, close: async () => { closed = true; } };
  globalThis.showSaveFilePicker = async () => ({ createWritable: async () => writable });
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const sinkFinished = trackSinkFinish(rec);
    let downloaded = false;
    rec.download = () => { downloaded = true; };

    rec.start('stream');
    const sessionChunks = rec.chunks;
    const recorder = rec.mediaRecorder;
    recorder.ondataavailable({ data: { size: 10 } });
    recorder.ondataavailable({ data: { size: 20 } });
    rec.stop();
    recorder.onstop();

    await sinkFinished();

    assert.deepEqual(writes, [{ size: 10 }, { size: 20 }], 'each chunk written to disk in order');
    assert.equal(closed, true, 'writable closed at stop');
    assert.equal(downloaded, false, 'no in-memory blob download while streaming');
    assert.deepEqual(sessionChunks, [], 'streamed chunks are not retained in RAM');
  } finally {
    restore();
  }
});

test('a late file close failure reports its session without stopping a new recording', async () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error');
  let rejectClose;
  let filename;
  const failure = new Error('disk commit failed');
  globalThis.showSaveFilePicker = async (options) => {
    filename ??= options.suggestedName;
    return { createWritable: async () => ({
      write: async () => {},
      close: () => new Promise((_, reject) => { rejectClose = reject; }),
    }) };
  };
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const finished = trackSinkFinish(rec);
    const failures = [];
    const captureFailures = [];
    rec.onSaveError = (error, name) => failures.push({ error, name });
    rec.onError = (error) => captureFailures.push(error);
    rec.start('previous');
    const previous = rec.mediaRecorder;
    previous.ondataavailable({ data: { size: 10 } });
    rec.stop();
    previous.onstop();
    await drainSink();
    rec.start('current');
    const current = rec.mediaRecorder;
    rejectClose(failure);
    await finished();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].name, filename);
    assert.match(filename, /^previous_/);
    assert.equal(failures[0].error.cause, failure);
    assert.match(failures[0].error.message, /truncated or incomplete/);
    assert.deepEqual(captureFailures, []);
    assert.equal(rec.mediaRecorder, current);
    assert.equal(rec.isRecording, true);
  } finally {
    captured.restore();
    restore();
  }
});

test('the encoder is opened at the configured bitrate', () => {
  const restore = installRecorderEnv();
  try {
    const auto = new VideoRecorder(recordableCanvas());
    auto.download = () => {};
    auto.start('e');
    assert.equal(auto.mediaRecorder.options.videoBitsPerSecond, 16_000_000,
      'the constructor default did not reach the encoder');
    auto.stop();
    auto.mediaRecorder.onstop();

    const rec = new VideoRecorder(recordableCanvas());
    rec.download = () => {};
    rec.bitrateMbps = 24;
    rec.start('e');
    // Mbps, not bps: an unconverted 24 would encode at 24 bits per second.
    assert.equal(rec.mediaRecorder.options.videoBitsPerSecond, 24_000_000);
  } finally {
    restore();
  }
});

test('the save picker is offered the timestamped name and the container filter', async () => {
  const restore = installRecorderEnv();
  const picked = [];
  const writable = { write: async () => {}, close: async () => {} };
  globalThis.showSaveFilePicker = async (options) => {
    picked.push(options);
    return { createWritable: async () => writable };
  };
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: SAVE_CLOCK });
  try {
    // Both the name and the filter follow the container the encoder settled on,
    // so an advertised-format change has to move them together.
    for (const [format, name, mime] of [
      ['mp4', 'swirl_20260102_030405.mp4', 'video/mp4'],
      ['webm', 'swirl_20260102_030405.webm', 'video/webm'],
    ]) {
      picked.length = 0;
      const rec = new VideoRecorder(recordableCanvas());
      const sinkFinished = trackSinkFinish(rec);
      rec.download = () => {};
      rec.format = format;

      rec.start('swirl');
      rec.stop();
      rec.mediaRecorder.onstop();
      await sinkFinished();

      assert.equal(picked.length, 1);
      assert.equal(picked[0].suggestedName, name,
        'the dialog opened on something other than the timestamped file');
      assert.deepEqual(picked[0].types,
        [{ description: 'Video', accept: { [mime]: [`.${format}`] } }]);
    }
  } finally {
    mock.timers.reset();
    restore();
  }
});

test('a mid-stream streaming write failure stops the session and reports truncation', async () => {
  const restore = installRecorderEnv();
  const writes = [];
  let closed = false;
  let writeCount = 0;
  const writable = {
    write: async (d) => {
      writeCount++;
      if (writeCount === 2) throw new Error('disk full');
      writes.push(d);
    },
    close: async () => { closed = true; },
  };
  globalThis.showSaveFilePicker = async () => ({ createWritable: async () => writable });
  const captured = installConsoleCapture('error', 'warn');
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const sinkFinished = trackSinkFinish(rec);
    let downloaded = false;
    const notified = [];
    rec.download = () => { downloaded = true; };
    rec.onError = (err) => notified.push(err);

    rec.start('stream');
    const recorder = rec.mediaRecorder;
    recorder.ondataavailable({ data: { size: 10 } });
    recorder.ondataavailable({ data: { size: 20 } }); // this write throws
    recorder.ondataavailable({ data: { size: 30 } }); // dropped after the failure
    await drainSink();

    assert.equal(rec.isRecording, false, 'the failed write stops the active recorder');
    assert.equal(notified.length, 1, 'the host is notified once');
    assert.match(notified[0].message, /disk full/);
    recorder.onstop();

    await sinkFinished();

    assert.deepEqual(writes, [{ size: 10 }], 'only the pre-failure chunk reached disk');
    assert.equal(closed, true, 'the writable is closed to flush the on-disk prefix');
    assert.equal(downloaded, false, 'no blob download of the post-failure tail');
    assert.ok(captured.messages.some((e) => /truncated/.test(e)),
      'the truncation is reported to the user');
  } finally {
    captured.restore();
    restore();
  }
});

/**
 * The write chain is serialized, so a link that rejects rejects every link
 * queued behind it and finish()'s close along with them.
 */
test('a host hook that throws does not poison the streaming write chain', async () => {
  const restore = installRecorderEnv();
  const writes = [];
  let closed = false;
  let writeCount = 0;
  const writable = {
    write: async (d) => {
      writeCount++;
      if (writeCount === 2) throw new Error('disk full');
      writes.push(d);
    },
    close: async () => { closed = true; },
  };
  globalThis.showSaveFilePicker = async () => ({ createWritable: async () => writable });
  const captured = installConsoleCapture('error', 'warn');
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const sinkFinished = trackSinkFinish(rec);
    let downloaded = false;
    rec.download = () => { downloaded = true; };
    rec.onError = () => { throw new Error('host hook exploded'); };

    rec.start('stream');
    const recorder = rec.mediaRecorder;
    recorder.ondataavailable({ data: { size: 10 } });
    recorder.ondataavailable({ data: { size: 20 } }); // this write throws
    await drainSink();
    recorder.onstop();

    await sinkFinished();

    assert.deepEqual(writes, [{ size: 10 }], 'the pre-failure chunk reached disk');
    assert.equal(closed, true,
      'the on-disk prefix is still flushed, not stranded behind a rejected chain');
    assert.equal(downloaded, false, 'no blob download of the post-failure tail');
    assert.ok(captured.messages.some((e) => /host hook exploded/.test(e)),
      'the swallowed host failure is reported');
    assert.ok(captured.messages.some((e) => /truncated/.test(e)),
      'the truncation is still reported to the user');
  } finally {
    captured.restore();
    restore();
  }
});

/**
 * A Save dialog nobody answers holds every chunk in the write chain. The sink
 * bounds that hold at 120 s of video: 15 MB at 1 Mbps, or 240 MB using the
 * 16 Mbps default when bitrate is zero. Queued chunks reach the eventual file
 * as a contiguous prefix after the session ends at that limit.
 */
for (const bitrate of [1, 0]) {
  test(`an unanswered save dialog bounds backlog with configured bitrate ${bitrate}`, async () => {
    const restore = installRecorderEnv();
    const writes = [];
    let closed = false;
    const writable = { write: async (d) => { writes.push(d); }, close: async () => { closed = true; } };
    let answerPicker = () => {};
    globalThis.showSaveFilePicker = () => new Promise((resolve) => {
      answerPicker = () => resolve({ createWritable: async () => writable });
    });
    const captured = installConsoleCapture('error');
    try {
      const rec = new VideoRecorder(recordableCanvas());
      const sinkFinished = trackSinkFinish(rec);
      rec.bitrateMbps = bitrate;
      let downloaded = false;
      rec.download = () => { downloaded = true; };
      const notified = [];
      rec.onError = (err) => notified.push(err);

      rec.start('unanswered');
      const recorder = rec.mediaRecorder;
      const expectedBitrate = (bitrate || 16) * 1_000_000;
      assert.equal(recorder.options.videoBitsPerSecond, expectedBitrate);
      const sessionChunks = rec.chunks;
      const held = (expectedBitrate / 8) * PICKER_GRACE_SECONDS - 1_000_000;
      recorder.ondataavailable({ data: { size: held } });
      assert.equal(rec.isRecording, true, 'a backlog under the bound keeps recording');

      recorder.ondataavailable({ data: { size: 2_000_000 } });
      assert.equal(rec.isRecording, false, 'the session stops when the backlog passes the bound');
      assert.equal(notified.length, 1, 'the host is told the session ended');
      assert.match(captured.messages.join(' '), /Save dialog/,
        'the stop is reported, not silent');
      assert.doesNotMatch(captured.messages.join(' '), /recording stopped/i,
        'the notice prefix already says the session stopped');

      recorder.ondataavailable({ data: { size: 3_000_000 } });
      recorder.onstop();
      assert.equal(notified.length, 1, 'the bound is reported once, not per chunk');

      answerPicker();
      await sinkFinished();

      assert.deepEqual(writes, [{ size: held }],
        'the chunks held under the bound still reach the chosen file, in order');
      assert.equal(closed, true, 'the file is closed once the late pick lands');
      assert.equal(downloaded, false, 'no in-memory blob download of the dropped tail');
      assert.deepEqual(sessionChunks, [], 'the dropped chunks are not retained in RAM');
    } finally {
      captured.restore();
      restore();
    }
  });
}

for (const stalledAt of ['opening', 'writing']) {
  test(`streaming backlog stays bounded during stalled ${stalledAt}`, async () => {
    const restore = installRecorderEnv();
    const captured = installConsoleCapture('error');
    const writes = [];
    const releases = [];
    let open;
    let closed = false;
    const writable = {
      write: (data) => {
        writes.push(data);
        return stalledAt === 'writing'
          ? new Promise((resolve) => releases.push(resolve)) : Promise.resolve();
      },
      close: async () => { closed = true; },
    };
    globalThis.showSaveFilePicker = async () => ({
      createWritable: () => stalledAt === 'opening'
        ? new Promise((resolve) => { open = () => resolve(writable); })
        : Promise.resolve(writable),
    });
    try {
      const rec = new VideoRecorder(recordableCanvas());
      rec.bitrateMbps = 1;
      const notified = [];
      rec.onError = (error) => notified.push(error);
      const finished = trackSinkFinish(rec);
      rec.start('slow-file');
      const recorder = rec.mediaRecorder;
      const size = rec.bitrateMbps * 1_000_000 / 8 * PICKER_GRACE_SECONDS / 2;
      const chunks = Array.from({ length: 5 }, (_, id) => ({ size, id }));
      await drainSink();
      recorder.ondataavailable({ data: chunks[0] });
      await drainSink();
      recorder.ondataavailable({ data: chunks[1] });
      let accepted = 2;
      if (stalledAt === 'writing') {
        releases.shift()();
        await drainSink();
        recorder.ondataavailable({ data: chunks[2] });
        accepted = 3;
      }
      assert.equal(rec.isRecording, true, 'settled writes release their backlog bytes');
      recorder.ondataavailable({ data: chunks[accepted] });
      assert.equal(rec.isRecording, false);
      assert.equal(notified.length, 1);
      assert.match(notified[0].message, /streaming save could not keep up/);
      recorder.ondataavailable({ data: chunks[4] });
      recorder.onstop();
      if (open) open();
      for (let i = 0; i < accepted; i++) {
        await drainSink();
        releases.shift()?.();
      }
      await finished();
      assert.deepEqual(writes, chunks.slice(0, accepted));
      assert.equal(closed, true);
      assert.equal(notified.length, 1);
    } finally {
      captured.restore();
      restore();
    }
  });
}

test('the in-memory fallback sink stops the session at its byte bound', () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error');
  try {
    const rec = new VideoRecorder(recordableCanvas());
    let downloaded = null;
    rec.download = (recorder, chunks) => { downloaded = chunks.length; };
    const notified = [];
    rec.onError = (err) => notified.push(err);

    rec.start('unbounded');
    const recorder = rec.mediaRecorder;
    const CHUNK_BYTES = 1_000_000;
    const underBound = MEMORY_BUFFER_LIMIT_BYTES / CHUNK_BYTES;
    for (let i = 0; i < underBound; i++) recorder.ondataavailable({ data: { size: CHUNK_BYTES } });
    assert.equal(rec.isRecording, true, 'a buffer under the bound keeps recording');

    recorder.ondataavailable({ data: { size: CHUNK_BYTES } });
    assert.equal(rec.isRecording, false, 'the session runs to an OOM instead of stopping');
    assert.equal(notified.length, 1, 'the host is told the session ended');
    assert.match(captured.messages.join(' '), /held in memory/,
      'the stop is reported, not silent');
    assert.doesNotMatch(captured.messages.join(' '), /recording stopped/i,
      'the notice prefix already says the session stopped');

    recorder.ondataavailable({ data: { size: CHUNK_BYTES } });
    recorder.onstop();
    assert.equal(notified.length, 1, 'the bound is reported once, not per chunk');
    assert.equal(downloaded, underBound, 'the prefix captured under the bound is still saved');
  } finally {
    captured.restore();
    restore();
  }
});

/**
 * A picker rejection that is not an AbortError leaves the session running with
 * no file handle, so every chunk lands in the blob buffer for the download at
 * stop. With no queued writes remaining, the fallback uses its own byte bound.
 */
test('a streaming session with no file handle bounds its in-memory fallback', async () => {
  const restore = installRecorderEnv();
  globalThis.showSaveFilePicker = async () => { throw new Error('picker unavailable'); };
  const captured = installConsoleCapture('warn', 'error');
  try {
    const rec = new VideoRecorder(recordableCanvas());
    let downloaded = null;
    rec.download = (recorder, chunks) => { downloaded = chunks.length; };
    const notified = [];
    rec.onError = (err) => notified.push(err);
    const sinkFinished = trackSinkFinish(rec);

    rec.start('handleless');
    const recorder = rec.mediaRecorder;
    // Let the picker's rejection settle, so every chunk below is past the
    // streaming backlog cap and reaches the in-memory fallback.
    await drainSink();
    const CHUNK_BYTES = 1_000_000;
    const underBound = MEMORY_BUFFER_LIMIT_BYTES / CHUNK_BYTES;
    for (let i = 0; i < underBound; i++) recorder.ondataavailable({ data: { size: CHUNK_BYTES } });
    await drainSink();
    assert.equal(rec.isRecording, true, 'a buffer under the bound keeps recording');

    recorder.ondataavailable({ data: { size: CHUNK_BYTES } });
    await drainSink();
    assert.equal(rec.isRecording, false, 'the session runs to an OOM instead of stopping');
    assert.equal(notified.length, 1, 'the host is told the session ended');
    assert.match(captured.messages.join(' '), /held in memory/,
      'the stop is reported, not silent');
    assert.doesNotMatch(captured.messages.join(' '), /recording stopped/i,
      'the notice prefix already says the session stopped');

    recorder.ondataavailable({ data: { size: CHUNK_BYTES } });
    recorder.onstop();
    await sinkFinished();
    assert.equal(notified.length, 1, 'the bound is reported once, not per chunk');
    assert.equal(downloaded, underBound, 'the prefix captured under the bound is still saved');
  } finally {
    captured.restore();
    restore();
  }
});

test('a streaming session that produces no data never opens the chosen file', async () => {
  const restore = installRecorderEnv();
  let createWritableCalls = 0;
  let closed = false;
  const writable = { write: async () => {}, close: async () => { closed = true; } };
  globalThis.showSaveFilePicker = async () => ({
    createWritable: async () => { createWritableCalls++; return writable; },
  });
  const captured = installConsoleCapture('warn');
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const sinkFinished = trackSinkFinish(rec);
    let downloaded = false;
    rec.download = () => { downloaded = true; };

    rec.start('empty');
    const recorder = rec.mediaRecorder;
    // No ondataavailable: the session streams nothing.
    rec.stop();
    recorder.onstop();

    await sinkFinished();

    assert.equal(createWritableCalls, 0, 'the file is never opened/truncated when no data streams');
    assert.equal(closed, false, 'no empty writable is closed over the chosen file');
    assert.equal(downloaded, false, 'nothing to download');
    assert.ok(captured.messages.some((w) => /no data/.test(w)),
      'the empty session is reported');
  } finally {
    captured.restore();
    restore();
  }
});

/**
 * Drives captureFrame once with a chosen source/offscreen size and returns the
 * drawImage destination rect the recorder computed. The offscreen and its
 * context are swapped for a spy after start(), so the recorded args reflect the
 * letterbox math against exactly `offW`x`offH`.
 * @param {{srcW:number, srcH:number, offW:number, offH:number}} dims
 * @returns {{img:any, x:number, y:number, w:number, h:number}} The drawImage call.
 */
const captureLetterbox = ({ srcW, srcH, offW, offH }) => {
  const restore = installRecorderEnv();
  try {
    const source = recordableCanvas(srcW, srcH);
    const rec = new VideoRecorder(source);
    rec.download = () => {};
    rec.start('e');

    /** @type {any[]} */
    const draws = [];
    const spyCtx = { clearRect() {}, drawImage(...a) { draws.push(a); } };
    rec.offscreen = { width: offW, height: offH };
    rec.offCtx = spyCtx;

    rec.captureFrame();
    assert.equal(draws.length, 1, 'exactly one drawImage per captureFrame');
    const [img, x, y, w, h] = draws[0];
    return { img, x, y, w, h };
  } finally {
    restore();
  }
};

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
test('captureFrame leaves elapsed time clock-driven without requestFrame', () => {
  const restore = installRecorderEnv();
  try {
    let nowMs = 0;
    const rec = new VideoRecorder(recordableCanvas(), 1 / 16, () => nowMs);
    rec.download = () => {};
    rec.start('e');
    delete rec.track.requestFrame;
    rec.captureFrame();
    rec.captureFrame();
    assert.equal(rec.elapsedSeconds, 0);
    nowMs = 2_000;
    assert.equal(rec.elapsedSeconds, 2);
  } finally {
    restore();
  }
});

/**
 * stop() flips the recorder inactive but the async onstop that releases the
 * track has not run yet, so a render task already in flight can still reach
 * captureFrame. It must do nothing: no blit into the offscreen, no frame
 * requested on the still-live track, and no elapsed-time advance past the point
 * the encoder stopped accepting frames.
 */
test('captureFrame is inert between stop and the async onstop', () => {
  const restore = installRecorderEnv();
  try {
    const rec = new VideoRecorder(recordableCanvas());
    rec.download = () => {};
    rec.start('e');

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
  } finally {
    restore();
  }
});

/**
 * start() never blits: the source is a WebGL canvas whose drawing buffer is
 * cleared once composited, so a blit outside the render task would write
 * transparent black. Only captureFrame(), called from the render task, fills the
 * offscreen — on the timed-fallback path too.
 */
test('start does not blit; the timed fallback fills the offscreen on captureFrame', () => {
  const restore = installRecorderEnv();
  try {
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

    const rec = new VideoRecorder(recordableCanvas(64, 32));
    rec.download = () => {};
    rec.start('e');

    assert.equal(draws.length, 0, 'no blit from the click-handler task');

    rec.captureFrame();
    assert.equal(draws.length, 1, 'the render-task capture fills the offscreen');
  } finally {
    restore();
  }
});

/**
 * Save picker cancelled after chunks are already flowing: cancelling the picker
 * is a deliberate "don't save", so the buffered chunks are discarded and nothing
 * is written to the default Downloads folder — Cancel means cancel.
 */
test('a cancelled save picker discards buffered chunks without downloading', async () => {
  const restore = installRecorderEnv();
  const abort = new Error('user cancelled');
  abort.name = 'AbortError';
  globalThis.showSaveFilePicker = async () => { throw abort; };
  const captured = installConsoleCapture('warn');
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const sinkFinished = trackSinkFinish(rec);
    const downloads = [];
    rec.download = (recorder, chunks, name) => downloads.push({ chunks, name });

    rec.start('cancelled');
    const sessionChunks = rec.chunks;
    const recorder = rec.mediaRecorder;
    // Chunks arrive before the picker's rejection has settled the open promise.
    recorder.ondataavailable({ data: { size: 10 } });
    recorder.ondataavailable({ data: { size: 20 } });
    recorder.ondataavailable({ data: { size: 30 } });
    rec.stop();
    recorder.onstop();

    await sinkFinished();

    assert.equal(downloads.length, 0, 'no download after the picker was cancelled');
    assert.deepEqual(sessionChunks, []);
  } finally {
    captured.restore();
    restore();
  }
});

/**
 * Wraps a recorder's host error hook so a test can await an async failure path
 * directly, rather than guessing how many task turns it takes.
 * @param {VideoRecorder} rec - Recorder whose installed onError hook is instrumented.
 * @returns {() => Promise<void>} Resolves once the hook has fired.
 */
const trackHostError = (rec) => {
  const onError = rec.onError;
  let fire = null;
  const fired = new Promise((resolve) => { fire = resolve; });
  rec.onError = (err) => { onError?.(err); fire(); };
  return async () => { await fired; };
};

/**
 * Save picker cancelled while the session is still live: the recorder stops, and
 * the host hook must fire or the UI stays latched on a dead session and the next
 * click starts a second recording instead of stopping the first.
 */
test('a cancelled save picker tells the host the session ended', async () => {
  const restore = installRecorderEnv();
  const abort = new Error('user cancelled');
  abort.name = 'AbortError';
  globalThis.showSaveFilePicker = async () => { throw abort; };
  const captured = installConsoleCapture('error');
  try {
    const rec = new VideoRecorder(recordableCanvas());
    rec.download = () => {};
    const notified = [];
    rec.onError = (err) => notified.push(err);
    const hostNotified = trackHostError(rec);

    rec.start('cancelled');
    const recorder = rec.mediaRecorder;
    // The picker's rejection reaches the hook while the session is still installed.
    await hostNotified();

    assert.equal(notified.length, 1, 'the host is told the session ended');
    assert.notEqual(notified[0], abort, 'the raw AbortError never reaches the host');
    assert.match(notified[0].message, /Save dialog was cancelled/,
      'the host is given the cancellation in the words the UI shows');
    assert.equal(rec.isRecording, false, 'the cancelled session is stopped');

    recorder.onstop();
    assert.equal(rec.mediaRecorder, null, 'the stop path still finalizes the session');
  } finally {
    captured.restore();
    restore();
  }
});

// ---------------------------------------------------------------------------
// The anchor-click save path, taken whenever the File System Access API is
// absent (Firefox, Safari).
// ---------------------------------------------------------------------------

/**
 * Installs the globals the buffered save path drives — Blob, the object-URL
 * registry, and a document whose anchors record their click — over whatever
 * document is already installed; canvas creation falls through to it.
 * @returns {any} The recorded blobs, object URLs, anchors and clicks, the body
 *   the anchor is attached to, and a restore() for every installed global.
 */
const installSavePath = () => {
  const savedDocument = globalThis.document;
  const savedBlob = globalThis.Blob;
  const savedCreateObjectURL = URL.createObjectURL;
  const savedRevokeObjectURL = URL.revokeObjectURL;
  /** @type {any} */
  const spy = { blobs: [], created: [], revoked: [], anchors: [], clicks: [] };

  globalThis.Blob = /** @type {any} */ (class {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options?.type;
      spy.blobs.push(this);
    }
  });
  URL.createObjectURL = (blob) => {
    const url = `blob:recorder/${spy.created.length}`;
    spy.created.push({ blob, url });
    return url;
  };
  URL.revokeObjectURL = (url) => { spy.revoked.push(url); };

  const body = fakeElement('body');
  const createOther = savedDocument?.createElement?.bind(savedDocument);
  spy.body = body;
  installDocument({
    body,
    createElement: (tag) => {
      if (tag !== 'a') {
        if (!createOther) {
          throw new Error(
            `installSavePath: no document underneath to create <${tag}>`);
        }
        return createOther(tag);
      }
      const anchor = fakeElement('a');
      // The anchor is detached right after the click, so record the attachment
      // state at click time rather than reading it afterwards.
      anchor.click = () => spy.clicks.push(
        { href: anchor.href, download: anchor.download, parent: anchor.parentNode });
      spy.anchors.push(anchor);
      return anchor;
    },
  });
  spy.restore = () => {
    globalThis.document = savedDocument;
    globalThis.Blob = savedBlob;
    URL.createObjectURL = savedCreateObjectURL;
    URL.revokeObjectURL = savedRevokeObjectURL;
  };
  return spy;
};

/**
 * Without the File System Access API a stopped session buffers its chunks, packs
 * them into one blob of the container's MIME type, and hands it to the browser
 * through a timestamped, attached-then-detached anchor whose object URL is
 * revoked once the click has consumed it.
 */
test('the buffered save path downloads one blob through an anchor click', () => {
  const restore = installRecorderEnv();
  const save = installSavePath();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: SAVE_CLOCK });
  try {
    const rec = new VideoRecorder(recordableCanvas());
    rec.format = 'mp4';

    rec.start('swirl');
    const recorder = rec.mediaRecorder;
    recorder.ondataavailable({ data: { size: 10 } });
    recorder.ondataavailable({ data: { size: 20 } });
    rec.stop();
    recorder.onstop();

    assert.equal(save.blobs.length, 1, 'the session assembles exactly one blob');
    assert.deepEqual(save.blobs[0].parts, [{ size: 10 }, { size: 20 }],
      'every captured chunk, in capture order');
    assert.equal(save.blobs[0].type, 'video/mp4', 'the blob carries the container MIME type');
    assert.deepEqual(save.created.map((c) => c.blob), [save.blobs[0]],
      'one object URL, minted for that blob');

    assert.equal(save.clicks.length, 1, 'the download is triggered by a single anchor click');
    assert.equal(save.clicks[0].href, save.created[0].url);
    assert.equal(save.clicks[0].download, 'swirl_20260102_030405.mp4');
    assert.equal(save.clicks[0].parent, save.body, 'the anchor is in the document when clicked');
    assert.deepEqual(save.body.children, [], 'and detached again afterwards');

    assert.deepEqual(save.revoked, [], 'the object URL outlives the click');
    mock.timers.tick(1000);
    assert.deepEqual(save.revoked, [save.created[0].url], 'then it is revoked');
  } finally {
    mock.timers.reset();
    save.restore();
    restore();
  }
});

/**
 * The blob type and the file extension are both derived from the container the
 * browser actually chose, so they can never disagree; an unknown or empty type
 * falls back to WebM, including a subtype that names an Object.prototype
 * member.
 */
test('the buffered save maps each container to its extension and blob type', () => {
  const save = installSavePath();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: SAVE_CLOCK });
  try {
    const cases = [
      ['video/mp4;codecs=avc1', 'clip_20260102_030405.mp4', 'video/mp4'],
      ['video/webm;codecs=vp9', 'clip_20260102_030405.webm', 'video/webm'],
      ['video/x-matroska;codecs=avc1', 'clip_20260102_030405.mkv', 'video/x-matroska'],
      ['video/ogg', 'clip_20260102_030405.ogv', 'video/ogg'],
      ['', 'clip_20260102_030405.webm', 'video/webm'],
      ['video/quicktime', 'clip_20260102_030405.webm', 'video/webm'],
      ['video/constructor', 'clip_20260102_030405.webm', 'video/webm'],
    ];
    const rec = new VideoRecorder(recordableCanvas());
    for (const [mimeType, filename, blobType] of cases) {
      save.blobs.length = 0;
      save.clicks.length = 0;
      rec.download(/** @type {any} */ ({ mimeType }), [{ size: 1 }], 'clip');
      assert.equal(save.blobs[0].type, blobType, `blob type for "${mimeType}"`);
      assert.equal(save.clicks[0].download, filename, `file name for "${mimeType}"`);
    }
    mock.timers.tick(1000);
    assert.equal(save.revoked.length, cases.length, 'every minted URL is revoked');
  } finally {
    mock.timers.reset();
    save.restore();
  }
});

test('download saves the supplied recorder, chunks, and effect name', () => {
  const save = installSavePath();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: SAVE_CLOCK });
  try {
    const rec = new VideoRecorder(recordableCanvas());

    rec.download(
      /** @type {any} */ ({ mimeType: 'video/webm;codecs=vp9' }),
      /** @type {any} */ ([{ size: 7 }]),
      'live');

    assert.deepEqual(save.blobs[0].parts, [{ size: 7 }]);
    assert.equal(save.blobs[0].type, 'video/webm');
    assert.equal(save.clicks[0].download, 'live_20260102_030405.webm');
  } finally {
    mock.timers.reset();
    save.restore();
  }
});

// ---------------------------------------------------------------------------
// start() aborts: every path that gives up before a session exists must leave no
// live capture behind.
// ---------------------------------------------------------------------------

/**
 * Drives start() against a chosen offscreen capture canvas — the offscreen is
 * the capture source, so a stand-in here controls getContext and captureStream —
 * and hands back what the aborted start left behind.
 * @param {any} offscreen - Stand-in returned by document.createElement.
 * @returns {{rec: VideoRecorder, notified: Error[], recorders: any[]}} The
 *   recorder, the errors sent to the host hook, and every MediaRecorder built.
 */
const startAborted = (offscreen) => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error');
  try {
    installDocument({ createElement: () => offscreen });
    const rec = new VideoRecorder(/** @type {any} */ (recordableCanvas()));
    /** @type {Error[]} */
    const notified = [];
    rec.onError = (err) => notified.push(err);
    const recorders = FakeMediaRecorder.instances;
    rec.start('aborted');
    return { rec, notified, recorders };
  } finally {
    captured.restore();
    restore();
  }
};

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

  assert.deepEqual(fps, [0, 16], 'the timed fallback is attempted at the frame rate');
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

test('output setup failure closes the picked sink and stops the encoder', () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error');
  try {
    const rec = new VideoRecorder(recordableCanvas());
    let finished = 0;
    const errors = [];
    rec.onError = (error) => errors.push(error);
    rec.openSink = () => ({ write() { throw new Error('sink unavailable'); },
      finish() { finished++; } });
    FakeMediaRecorder.startData = { size: 10 };
    rec.start('setup');
    const encoder = FakeMediaRecorder.instances.at(-1);
    assert.equal(finished, 1);
    assert.equal(encoder.state, 'inactive');
    assert.equal(encoder.ondataavailable, null);
    assert.equal(encoder.onstop, null);
    assert.equal(encoder.onerror, null);
    assert.equal(rec.mediaRecorder, null);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /sink unavailable/);
    assert.match(captured.messages.join(), /output setup failed/);
  } finally {
    captured.restore();
    restore();
  }
});

test('createWritable rejection preserves every chunk for Downloads', async () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('warn');
  globalThis.showSaveFilePicker = async () => ({
    createWritable: async () => { throw new Error('file locked'); },
  });
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const finished = trackSinkFinish(rec);
    const downloads = [];
    const notices = [];
    const errors = [];
    rec.onSaveFallback = (error) => notices.push(error);
    rec.onSaveError = (error) => errors.push(error);
    rec.download = (encoder, chunks) => downloads.push([...chunks]);
    rec.start('fallback');
    const encoder = rec.mediaRecorder;
    const first = { size: 10 }, second = { size: 20 };
    encoder.ondataavailable({ data: first });
    await drainSink();
    encoder.ondataavailable({ data: second });
    rec.stop();
    encoder.onstop();
    await finished();
    assert.deepEqual(downloads, [[first, second]]);
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /could not be opened; saving to Downloads instead/);
    assert.deepEqual(errors, []);
  } finally {
    captured.restore();
    restore();
  }
});

test('a streaming write failure after Stop reaches the save-error UI', async () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('error', 'warn');
  globalThis.showSaveFilePicker = async () => ({ createWritable: async () => ({
    write: async () => { throw new Error('disk full'); }, close: async () => {},
  }) });
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const finished = trackSinkFinish(rec);
    const errors = [];
    rec.onSaveError = (error) => errors.push(error);
    rec.start('stream');
    const recorder = rec.mediaRecorder;
    recorder.ondataavailable({ data: { size: 10 } });
    rec.stop();
    recorder.onstop();
    await finished();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /truncated/);
  } finally {
    captured.restore();
    restore();
  }
});

test('superseded recorder guards ignore fallback and memory overflow', async () => {
  const restore = installRecorderEnv();
  const captured = installConsoleCapture('warn');
  try {
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
  } finally {
    FakeMediaRecorder.isTypeSupported = () => true;
    captured.restore();
    restore();
  }
});

test('superseded streaming recorder ignores picker cancellation and backlog overflow', async () => {
  const restore = installRecorderEnv();
  try {
    let rejectFirst;
    let picks = 0;
    globalThis.showSaveFilePicker = () => {
      picks++;
      if (picks === 1) return new Promise((resolve, reject) => { rejectFirst = reject; });
      return new Promise(() => {});
    };
    const rec = new VideoRecorder(recordableCanvas());
    rec.download = () => {};
    rec.start('first');
    const first = rec.mediaRecorder;
    rec.stop();
    rec.start('second');
    const second = rec.mediaRecorder;
    const errors = [];
    rec.onError = (error) => errors.push(error);
    first.ondataavailable({ data: { size: (16 * 1_000_000 / 8) * PICKER_GRACE_SECONDS + 1 } });
    assert.equal(rec.mediaRecorder, second);
    assert.equal(rec.isRecording, true);
    rejectFirst(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(rec.mediaRecorder, second);
    assert.equal(rec.isRecording, true);
    assert.deepEqual(errors, []);
    rec.stop();
  } finally {
    restore();
  }
});
