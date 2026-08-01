import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './fake_dom.js';
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
    globalThis.document = prevDoc;
  }
});

/**
 * Verifies the targetHeight (downscale) path sizes the offscreen to the target
 * height and the source's start-time aspect, rounding both dimensions up to even
 * (codecs require it), and then pins that buffer against a mid-recording resize.
 */
test('targetHeight capture scales the offscreen to the target height and pins it', () => {
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => fakeCanvas() };
  try {
    const source = fakeCanvas(800, 600);   // 4:3 source
    const rec = new VideoRecorder(source);
    rec.targetHeight = 121;                 // odd target → rounded up to even
    assert.notEqual(rec.targetHeight, null);

    const off = rec.ensureOffscreen();
    // height 121 → 122; width round(121 * 800/600) = round(161.33) = 161 → 162.
    assert.equal(off.height, 122);
    assert.equal(off.width, 162);

    source.width = 1920;
    source.height = 1080;
    const off2 = rec.ensureOffscreen();
    assert.equal(off2, off);
    assert.equal(off2.width, 162);
    assert.equal(off2.height, 122);
  } finally {
    globalThis.document = prevDoc;
  }
});

/**
 * Verifies the downscale path clamps a degenerate source aspect: a 0x0 source
 * makes width/height non-finite, which would propagate to NaN canvas dimensions;
 * the offscreen falls back to a square at the target height instead.
 */
test('targetHeight capture falls back to a square when the source aspect is degenerate', () => {
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => fakeCanvas() };
  try {
    const rec = new VideoRecorder(fakeCanvas(0, 0)); // 0/0 → NaN aspect
    rec.targetHeight = 120;
    const off = rec.ensureOffscreen();
    assert.equal(off.height, 120);
    assert.equal(off.width, 120, 'square fallback, not NaN');
  } finally {
    globalThis.document = prevDoc;
  }
});

// ---------------------------------------------------------------------------
// MediaRecorder session lifecycle, behind a fake MediaRecorder/captureStream.
// ---------------------------------------------------------------------------

/** A fake video track with the manual-frame API the recorder drives. */
const makeFakeTrack = () => ({ requestFrame() {}, stop() { this.stopped = true; }, stopped: false });

/** A fake capture stream exposing the one video track. */
const makeFakeStream = () => {
  const track = makeFakeTrack();
  return { track, getVideoTracks: () => [track], getTracks: () => [track] };
};

/** A fake canvas that can be recorded (has captureStream) and blitted into. */
const recordableCanvas = (w = 64, h = 32) => ({
  width: w, height: h,
  getContext: () => ({ clearRect() {}, drawImage() {} }),
  captureStream: () => makeFakeStream(),
});

/**
 * Minimal MediaRecorder stand-in. start()/stop() flip state synchronously like
 * the spec; the test fires onstop manually to model the async stop->start window.
 */
class FakeMediaRecorder {
  static instances = [];
  static startError = null;
  static startData = null;
  static isTypeSupported() { return true; }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = options.mimeType || 'video/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    if (FakeMediaRecorder.startError) throw FakeMediaRecorder.startError;
    this.state = 'recording';
    if (FakeMediaRecorder.startData) {
      this.ondataavailable({ data: FakeMediaRecorder.startData });
    }
  }
  stop() { this.state = 'inactive'; }
}

/**
 * Installs the browser globals the recorder touches and returns a restore fn.
 * showSaveFilePicker is left undefined so the recorder buffers chunks and saves
 * via the anchor path (download), which the tests stub out per-instance; the
 * streaming test re-defines showSaveFilePicker to exercise the disk path.
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
  FakeMediaRecorder.startError = null;
  FakeMediaRecorder.startData = null;
  globalThis.MediaRecorder = FakeMediaRecorder;
  globalThis.HTMLCanvasElement = class { captureStream() {} };
  globalThis.document = { createElement: () => recordableCanvas() };
  delete globalThis.showSaveFilePicker;
  return () => {
    globalThis.MediaRecorder = saved.MediaRecorder;
    globalThis.HTMLCanvasElement = saved.HTMLCanvasElement;
    globalThis.document = saved.document;
    globalThis.showSaveFilePicker = saved.showSaveFilePicker;
  };
};

/** Verifies toggle() reports the real recording state for start then stop. */
test('toggle starts then stops, reporting the true state each time', () => {
  const restore = installRecorderEnv();
  try {
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
  } finally {
    restore();
  }
});

/**
 * Verifies abort() ends a live session the way an external fault (a lost canvas
 * context) needs: the stop path still finalizes the output and the host hook
 * fires, while an idle recorder reports nothing.
 */
test('abort stops a live session and tells the host', () => {
  const restore = installRecorderEnv();
  const errs = [];
  const prevErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
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
    console.error = prevErr;
    restore();
  }
});

/** Verifies start() refuses (no phantom session) when the browser is unsupported. */
test('start refuses and stays idle when recording is unsupported', () => {
  const restore = installRecorderEnv();
  const errs = [];
  const prevErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    delete globalThis.MediaRecorder;
    const rec = new VideoRecorder(recordableCanvas());
    const notified = [];
    rec.onError = (err) => notified.push(err);
    rec.start('e');
    assert.equal(rec.mediaRecorder, null);
    assert.equal(rec.isRecording, false);
    assert.equal(errs.length, 1);
    assert.equal(notified.length, 1, 'the host is told the session never started');
    assert.match(notified[0].message, /not supported/);
  } finally {
    console.error = prevErr;
    restore();
  }
});

test('an unsupported explicit format reports the browser-selected container', () => {
  const restore = installRecorderEnv();
  try {
    FakeMediaRecorder.isTypeSupported = () => false;
    const rec = new VideoRecorder(recordableCanvas());
    const fallbacks = [];
    rec.format = 'mp4';
    rec.onFormatFallback = (extension) => fallbacks.push(extension);
    rec.download = () => {};

    rec.start('e');

    assert.deepEqual(fallbacks, ['webm']);
  } finally {
    FakeMediaRecorder.isTypeSupported = () => true;
    restore();
  }
});

test('a MediaRecorder start failure releases the entire capture session', () => {
  const restore = installRecorderEnv();
  const errors = [];
  const previousError = console.error;
  console.error = (...args) => errors.push(args);
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
    assert.ok(errors.some((args) => args.includes(failure)));
    assert.deepEqual(notified, [failure], 'the host is told the session never started');

    FakeMediaRecorder.startError = null;
    rec.openSink = () => ({ write() {}, finish() {} });
    notified.length = 0;
    rec.start('retry');
    assert.equal(rec.isRecording, true);
    rec.dispose();
  } finally {
    console.error = previousError;
    restore();
  }
});

/** Verifies a normally-stopped session downloads its chunks and then cleans up. */
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
  const errs = [];
  const prevErr = console.error;
  console.error = (...a) => errs.push(a);
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

    assert.equal(downloads.length, 1, 'the partial capture is still finalized');
    assert.deepEqual(downloads[0].chunks, [{ size: 10 }]);
    assert.equal(recorder.state, 'inactive', 'the faulted recorder is stopped');
    assert.equal(stream.track.stopped, true, 'the capture track is released');
    assert.equal(rec.mediaRecorder, null);
    assert.equal(rec.stream, null);
    assert.equal(rec.track, null);
    assert.equal(rec.offscreen, null);
    assert.equal(rec.isRecording, false);
    assert.deepEqual(notified, [failure], 'the host is told the session ended');
    assert.ok(errs.some((args) => args.includes(failure)), 'the failure is reported');

    // The UA may still deliver a stop event after the error; it must not finalize twice.
    recorder.onstop();
    assert.equal(downloads.length, 1);

    rec.start('retry');
    assert.equal(rec.isRecording, true);
    assert.notEqual(rec.mediaRecorder, recorder, 'the next start is a fresh session');
    rec.dispose();
  } finally {
    console.error = prevErr;
    restore();
  }
});

test('an encoder error event without an Error cause is normalized', () => {
  const restore = installRecorderEnv();
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
  } finally {
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
  const prevErr = console.error;
  console.error = () => {};
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

    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].name, 'first');
    assert.equal(notified.length, 0, 'the live session is not reported as failed');
    assert.equal(rec.mediaRecorder, recorderB);
    assert.equal(rec.isRecording, true);
    assert.equal(rec.stream.track.stopped, false);
  } finally {
    console.error = prevErr;
    restore();
  }
});

/** Verifies ondataavailable drops empty (size:0) flushes and keeps real chunks. */
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
 * With the File System Access API present, each chunk streams straight to the
 * writable as it arrives and the file is closed at stop — nothing is buffered in
 * RAM and no blob download is assembled.
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

test('a mid-stream streaming write failure closes the writable, skips download, and reports truncation', async () => {
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
  const errs = [];
  const prevErr = console.error;
  const prevWarn = console.warn;
  console.error = (...a) => errs.push(a.join(' '));
  console.warn = () => {};
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const sinkFinished = trackSinkFinish(rec);
    let downloaded = false;
    rec.download = () => { downloaded = true; };

    rec.start('stream');
    const recorder = rec.mediaRecorder;
    recorder.ondataavailable({ data: { size: 10 } });
    recorder.ondataavailable({ data: { size: 20 } }); // this write throws
    recorder.ondataavailable({ data: { size: 30 } }); // dropped after the failure
    rec.stop();
    recorder.onstop();

    await sinkFinished();

    assert.deepEqual(writes, [{ size: 10 }], 'only the pre-failure chunk reached disk');
    assert.equal(closed, true, 'the writable is closed to flush the on-disk prefix');
    assert.equal(downloaded, false, 'no blob download of the post-failure tail');
    assert.ok(errs.some((e) => /truncated/.test(e)), 'the truncation is reported to the user');
  } finally {
    console.error = prevErr;
    console.warn = prevWarn;
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
  const warns = [];
  const prevWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
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
    assert.ok(warns.some((w) => /no data/.test(w)), 'the empty session is reported');
  } finally {
    console.warn = prevWarn;
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

/**
 * Wider-than-target source: fit to the offscreen width, letterbox top/bottom.
 * 64x32 (2:1) into a 100x100 (1:1) offscreen -> destW=100, destH=round(100/2)=50,
 * centered at y=round((100-50)/2)=25, x=0.
 */
test('captureFrame letterboxes a wider-than-target source to fit width', () => {
  const { img, x, y, w, h } = captureLetterbox({ srcW: 64, srcH: 32, offW: 100, offH: 100 });
  assert.equal(img.width, 64, 'blits the source canvas');
  assert.equal(w, 100, 'destW spans the full offscreen width');
  assert.equal(h, 50, 'destH = offW / srcAspect');
  assert.equal(x, 0, 'no horizontal offset when fitting width');
  assert.equal(y, 25, 'centered vertically: (offH - destH) / 2');
});

/**
 * Taller-than-target source: fit to the offscreen height, pillarbox left/right.
 * 30x60 (1:2) into a 100x100 (1:1) offscreen -> destH=100, destW=round(100*0.5)=50,
 * centered at x=round((100-50)/2)=25, y=0.
 */
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
 * requestFrame call but still advances the elapsed-time counter.
 */
test('captureFrame advances elapsed when the track lacks requestFrame', () => {
  const restore = installRecorderEnv();
  try {
    const rec = new VideoRecorder(recordableCanvas());
    rec.download = () => {};
    rec.start('e');
    delete rec.track.requestFrame;
    rec.captureFrame();
    rec.captureFrame();
    assert.equal(rec.elapsedSeconds, 2 * rec.frameInterval);
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
    const elapsedAtStop = rec.elapsedSeconds;

    rec.stop();
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
    globalThis.document = { createElement: () => offscreen };

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
  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const sinkFinished = trackSinkFinish(rec);
    const downloads = [];
    rec.download = (recorder, chunks, name) => downloads.push({ chunks, name });

    rec.start('cancelled');
    const recorder = rec.mediaRecorder;
    // Chunks arrive before the picker's rejection has settled the open promise.
    recorder.ondataavailable({ data: { size: 10 } });
    recorder.ondataavailable({ data: { size: 20 } });
    recorder.ondataavailable({ data: { size: 30 } });
    rec.stop();
    recorder.onstop();

    await sinkFinished();

    assert.equal(downloads.length, 0, 'no download after the picker was cancelled');
  } finally {
    console.warn = prevWarn;
    restore();
  }
});

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
  try {
    const rec = new VideoRecorder(recordableCanvas());
    rec.download = () => {};
    const notified = [];
    rec.onError = (err) => notified.push(err);

    rec.start('cancelled');
    const recorder = rec.mediaRecorder;
    // Let the picker's rejection settle while the session is still installed.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(notified.length, 1, 'the host is told the session ended');
    assert.equal(notified[0], abort, 'the cancellation itself is passed through');
    assert.equal(rec.isRecording, false, 'the cancelled session is stopped');

    recorder.onstop();
    assert.equal(rec.mediaRecorder, null, 'the stop path still finalizes the session');
  } finally {
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
  const createOther = savedDocument?.createElement;
  spy.body = body;
  globalThis.document = /** @type {any} */ ({
    body,
    createElement: (tag) => {
      if (tag !== 'a') return createOther(tag);
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

/** Fixed local wall-clock time so the timestamped file name is exact. */
const SAVE_CLOCK = new Date(2026, 0, 2, 3, 4, 5);

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
 * falls back to WebM.
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

/** Verifies download() saves the chunks it is handed under the given name. */
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
  const previousError = console.error;
  console.error = () => {};
  try {
    globalThis.document = /** @type {any} */ ({ createElement: () => offscreen });
    const rec = new VideoRecorder(/** @type {any} */ (recordableCanvas()));
    /** @type {Error[]} */
    const notified = [];
    rec.onError = (err) => notified.push(err);
    const recorders = FakeMediaRecorder.instances;
    rec.start('aborted');
    return { rec, notified, recorders };
  } finally {
    console.error = previousError;
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
  const rec = startAborted({
    width: 0, height: 0,
    getContext: () => null,
    captureStream: (fps) => { captures.push(fps); return makeFakeStream(); },
  });

  assert.deepEqual(captures, [], 'no capture stream is opened without a drawing context');
  assert.equal(rec.recorders.length, 0, 'no recorder is constructed');
  assert.equal(rec.rec.isRecording, false);
  assert.equal(rec.rec.mediaRecorder, null);
  assert.equal(rec.rec.stream, null);
  assert.equal(rec.rec.track, null);
  assert.equal(rec.rec.offscreen, null, 'the context-less buffer is not latched');
  assert.equal(rec.notified.length, 1, 'the host is told the session never started');
  assert.match(rec.notified[0].message, /2D drawing context/);
});

/** Verifies a captureStream that throws outright leaves no session behind. */
test('start aborts and stays idle when captureStream throws', () => {
  const failure = new Error('capture unavailable');
  const rec = startAborted({
    width: 0, height: 0,
    getContext: () => ({ clearRect() {}, drawImage() {} }),
    captureStream: () => { throw failure; },
  });

  assert.equal(rec.recorders.length, 0, 'no recorder is constructed');
  assert.equal(rec.rec.isRecording, false);
  assert.equal(rec.rec.mediaRecorder, null);
  assert.equal(rec.rec.stream, null);
  assert.equal(rec.rec.track, null);
  assert.equal(rec.rec.offscreen, null, 'the capture buffer is released');
  assert.deepEqual(rec.notified, [failure], 'the host is told the session never started');
});

/**
 * The manual-frame stream opens, its track turns out to have no requestFrame, and
 * the timed-fallback capture then fails with its stream already in hand: both the
 * manual-mode track and the half-opened fallback stream must be released rather
 * than left capturing for the rest of the page's life.
 */
test('a failed timed-fallback capture releases every stream it opened', () => {
  const failure = new Error('capture unavailable');
  const timedTrack = { stopped: false, stop() { this.stopped = true; } };
  const manualMode = { getVideoTracks: () => [timedTrack], getTracks: () => [timedTrack] };
  const fallbackTrack = { stopped: false, stop() { this.stopped = true; } };
  const fallback = {
    getVideoTracks: () => { throw failure; },
    getTracks: () => [fallbackTrack],
  };
  const fps = [];
  const rec = startAborted({
    width: 0, height: 0,
    getContext: () => ({ clearRect() {}, drawImage() {} }),
    // The first track has no requestFrame, which forces the timed fallback.
    captureStream: (rate) => { fps.push(rate); return fps.length === 1 ? manualMode : fallback; },
  });

  assert.deepEqual(fps, [0, 16], 'the timed fallback is attempted at the frame rate');
  assert.equal(timedTrack.stopped, true, 'the manual-mode track is stopped');
  assert.equal(fallbackTrack.stopped, true, 'the half-opened fallback stream is released');
  assert.equal(rec.recorders.length, 0, 'no recorder is constructed');
  assert.equal(rec.rec.isRecording, false);
  assert.equal(rec.rec.stream, null);
  assert.equal(rec.rec.offscreen, null, 'the capture buffer is released');
  assert.deepEqual(rec.notified, [failure], 'the host is told the session never started');
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
  const rec = startAborted({
    width: 0, height: 0,
    getContext: () => ({ clearRect() {}, drawImage() {} }),
    captureStream: trackless,
  });

  assert.equal(opened.length, 2, 'both the manual-frame and timed-fallback streams opened');
  assert.deepEqual(opened.map((t) => t.stopped), [true, true],
    'neither trackless stream is left capturing');
  assert.equal(rec.recorders.length, 0, 'no recorder is constructed');
  assert.equal(rec.rec.isRecording, false);
  assert.equal(rec.rec.mediaRecorder, null);
  assert.equal(rec.rec.stream, null);
  assert.equal(rec.rec.track, null);
  assert.equal(rec.rec.offscreen, null, 'the capture buffer is released');
  assert.equal(rec.notified.length, 1, 'the host is told the session never started');
  assert.match(rec.notified[0].message, /no video track/);
});
