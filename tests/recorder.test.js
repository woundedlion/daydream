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
    assert.equal(rec.targetHeight, null);

    const off = rec._ensurePinnedOffscreen();
    assert.equal(off.width, 202);
    assert.equal(off.height, 102);

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

    const off = rec._ensureOffscreen();
    // height 121 → 122; width round(121 * 800/600) = round(161.33) = 161 → 162.
    assert.equal(off.height, 122);
    assert.equal(off.width, 162);

    source.width = 1920;
    source.height = 1080;
    const off2 = rec._ensureOffscreen();
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
    const off = rec._ensureOffscreen();
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
  getContext: () => ({ drawImage() {} }),
  captureStream: () => makeFakeStream(),
});

/**
 * Minimal MediaRecorder stand-in. start()/stop() flip state synchronously like
 * the spec; the test fires onstop manually to model the async stop->start window.
 */
class FakeMediaRecorder {
  static instances = [];
  static isTypeSupported() { return true; }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = options.mimeType || 'video/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    FakeMediaRecorder.instances.push(this);
  }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; }
}

/**
 * Installs the browser globals the recorder touches and returns a restore fn.
 * showSaveFilePicker is left undefined so _download takes the anchor path,
 * which the tests stub out per-instance.
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
    rec._download = () => {};
    assert.equal(rec.toggle('e'), true);
    assert.equal(rec.isRecording, true);
    assert.equal(rec.toggle('e'), false);
    rec.mediaRecorder.onstop();
    assert.equal(rec.isRecording, false);
  } finally {
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
    rec.start('e');
    assert.equal(rec.mediaRecorder, null);
    assert.equal(rec.isRecording, false);
    assert.equal(errs.length, 1);
  } finally {
    console.error = prevErr;
    restore();
  }
});

/** Verifies a normally-stopped session downloads its chunks and then cleans up. */
test('a stopped session downloads its own chunks and clears instance state', () => {
  const restore = installRecorderEnv();
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const downloads = [];
    rec._download = (recorder, chunks, name) => downloads.push({ recorder, chunks, name });

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

/** Verifies ondataavailable drops empty (size:0) flushes and keeps real chunks. */
test('a session retains only non-empty chunks', () => {
  const restore = installRecorderEnv();
  try {
    const rec = new VideoRecorder(recordableCanvas());
    const downloads = [];
    rec._download = (recorder, chunks, name) => downloads.push({ recorder, chunks, name });

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
    rec._download = (recorder, chunks, name) => downloads.push({ recorder, chunks, name });

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

/** Verifies captureFrame no-ops and warns exactly once when requestFrame is absent. */
test('captureFrame warns once when the browser lacks requestFrame', () => {
  const restore = installRecorderEnv();
  const warns = [];
  const prevWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const rec = new VideoRecorder(recordableCanvas());
    rec._download = () => {};
    rec.start('e');
    delete rec.track.requestFrame;
    rec.captureFrame();
    rec.captureFrame();
    assert.equal(rec.elapsedSeconds, 0);
    assert.equal(warns.length, 1);
  } finally {
    console.warn = prevWarn;
    restore();
  }
});
