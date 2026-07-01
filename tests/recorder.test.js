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

    const off = rec.ensurePinnedOffscreen();
    assert.equal(off.width, 202);
    assert.equal(off.height, 102);

    source.width = 640;
    source.height = 480;
    const off2 = rec.ensurePinnedOffscreen();
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
    let downloaded = false;
    rec.download = () => { downloaded = true; };

    rec.start('stream');
    const sessionChunks = rec.chunks;
    const recorder = rec.mediaRecorder;
    recorder.ondataavailable({ data: { size: 10 } });
    recorder.ondataavailable({ data: { size: 20 } });
    rec.stop();
    recorder.onstop();

    await new Promise((r) => setTimeout(r));

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
    let downloaded = false;
    rec.download = () => { downloaded = true; };

    rec.start('stream');
    const recorder = rec.mediaRecorder;
    recorder.ondataavailable({ data: { size: 10 } });
    recorder.ondataavailable({ data: { size: 20 } }); // this write throws
    recorder.ondataavailable({ data: { size: 30 } }); // dropped after the failure
    rec.stop();
    recorder.onstop();

    await new Promise((r) => setTimeout(r));

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
 * On the timed-fallback path (a captured track with no requestFrame, which
 * self-samples from recorder.start()), start() must prime the offscreen with one
 * blit so the leading interval isn't a blank canvas.
 */
test('the timed fallback primes the offscreen with one blit before start', () => {
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

    assert.equal(draws.length, 1, 'exactly one priming blit before recording starts');
  } finally {
    restore();
  }
});
