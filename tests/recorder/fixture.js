import assert from "node:assert/strict";
import { installConsoleCapture } from ".././helpers/fake_console.js";
import { fakeElement, installDocument, stashGlobals } from ".././helpers/fake_dom.js";
import { VideoRecorder } from "../../src/recording/recorder.js";

/** Fixed local wall-clock time so the timestamped file name is exact. */
export const SAVE_CLOCK = new Date(2026, 0, 2, 3, 4, 5);

/** @param {import('node:test').TestContext} t @param {number} [count] @returns {void} */
export function expectEmptySessionWarnings(t, count = 1) {
  const warnings = installConsoleCapture('warn');
  t.after(() => {
    warnings.restore();
    assert.equal(warnings.messages.length, count);
    for (const message of warnings.messages) assert.match(message, /session produced no data/);
  });
}

/**
 * Builds a fake isTypeSupported probe that accepts only the listed MIME types,
 * so each test can pin down exactly which codecs the "browser" advertises.
 * @param {...string} allowed - MIME type strings the probe should report as supported.
 * @returns {function(string): boolean} A probe that returns true only for an allowed MIME type.
 */
export const supports = (...allowed) => (mt) => allowed.includes(mt);

/**
 * A minimal fake canvas with mutable width/height and a no-op 2D context,
 * standing in for an HTMLCanvasElement so the offscreen-pinning logic runs in
 * Node without a DOM.
 * @param {number} width
 * @param {number} height
 */
export const fakeCanvas = (width = 0, height = 0) =>
  ({ width, height, getContext: () => ({ drawImage() {} }) });

/**
 * Installs a document whose createElement yields a blank fake canvas, so the
 * offscreen-sizing paths run in Node without a DOM.
 * @returns {() => void} A function that restores the saved document.
 */
export const installFakeDocument = () => {
  const restore = stashGlobals('document');
  installDocument({ createElement: () => fakeCanvas() });
  return restore;
};

// ---------------------------------------------------------------------------
// MediaRecorder session lifecycle, behind a fake MediaRecorder/captureStream.
// ---------------------------------------------------------------------------

/** @param {VideoRecorder} recorder @returns {Array<Array<*>>} Buffers passed to each session sink. */
export function captureSessionBuffers(recorder) {
  const buffers = [];
  const open = recorder.openSink.bind(recorder);
  recorder.openSink = (...args) => {
    buffers.push(args[2]);
    return open(...args);
  };
  return buffers;
}

/** A fake video track with the manual-frame API the recorder drives. */
export const makeFakeTrack = () => ({ requestFrame() {}, stop() { this.stopped = true; }, stopped: false });

/**
 * A fake capture stream exposing the one video track, tagged with the frame rate
 * it was opened at.
 * @param {number} [fps] - Frame rate captureStream was called with.
 * @returns {Object} The stream.
 */
export const makeFakeStream = (fps = 0) => {
  const track = makeFakeTrack();
  return { track, captureRate: fps, getVideoTracks: () => [track], getTracks: () => [track] };
};

/** A fake canvas that can be recorded (has captureStream) and blitted into. */
export const recordableCanvas = (w = 64, h = 32) => ({
  width: w, height: h,
  getContext: () => ({ clearRect() {}, drawImage() {} }),
  captureStream: (fps) => makeFakeStream(fps),
});

/**
 * Minimal MediaRecorder stand-in. start()/stop() flip state synchronously like
 * the spec; the test fires onstop manually to model the async stop->start window.
 */
export class FakeMediaRecorder {
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
export const installRecorderEnv = () => {
  const restore = stashGlobals('MediaRecorder', 'HTMLCanvasElement', 'document',
    'showSaveFilePicker');
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
  return restore;
};

/**
 * A document that reports `hidden`, dispatches visibilitychange and creates
 * the recorder's offscreen canvas.
 * @param {boolean} hidden - The initial visibility.
 */
export const visibilityDocument = (hidden) => Object.assign(new EventTarget(), {
  hidden, createElement: () => recordableCanvas(),
});

/**
 * Builds a recorder whose download is a no-op and starts it.
 * @param {HTMLCanvasElement} canvas - Source canvas.
 * @param {ConstructorParameters<typeof VideoRecorder>[1]} [options] - Recorder options.
 * @returns {VideoRecorder} The started recorder.
 */
export const startRecorder = (canvas, options) => {
  const rec = new VideoRecorder(canvas, options);
  rec.download = () => {};
  rec.start('e');
  return rec;
};

/**
 * Settles the streaming sink's serialized write chain, which defers every chunk
 * behind the picker promise, so a test can assert on what the chain did. A
 * macrotask hop: the chain queues one microtask per link, so awaiting a resolved
 * promise advances it by a link rather than settling it.
 * @returns {Promise<void>} Resolves once the queued chunk writes have run.
 */
export const drainSink = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Wraps a recorder's sink factory so a test can await the session's async
 * finish() chain directly, rather than guessing how many task turns it takes.
 * @param {VideoRecorder} rec - Recorder whose next session is instrumented.
 * @returns {() => Promise<void>} Resolves once finish() has run to completion.
 */
export const trackSinkFinish = (rec) => {
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
 * Drives captureFrame once with a chosen source/offscreen size and returns the
 * drawImage destination rect the recorder computed. The offscreen and its
 * context are swapped for a spy after start(), so the recorded args reflect the
 * letterbox math against exactly `offW`x`offH`.
 * @param {{srcW:number, srcH:number, offW:number, offH:number}} dims
 * @returns {{img:any, x:number, y:number, w:number, h:number}} The drawImage call.
 */
export const captureLetterbox = ({ srcW, srcH, offW, offH }) => {
  const restore = installRecorderEnv();
  try {
    const source = recordableCanvas(srcW, srcH);
    const rec = startRecorder(source);

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
 * Wraps a recorder's host error hook so a test can await an async failure path
 * directly, rather than guessing how many task turns it takes.
 * @param {VideoRecorder} rec - Recorder whose installed onError hook is instrumented.
 * @returns {() => Promise<void>} Resolves once the hook has fired.
 */
export const trackHostError = (rec) => {
  const onError = rec.onError;
  let fire = null;
  const fired = new Promise((resolve) => { fire = resolve; });
  rec.onError = (err) => { onError?.(err); fire(); };
  return async () => { await fired; };
};

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
export const installSavePath = () => {
  const savedDocument = globalThis.document;
  const restoreGlobals = stashGlobals('document', 'Blob');
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
    restoreGlobals();
    URL.createObjectURL = savedCreateObjectURL;
    URL.revokeObjectURL = savedRevokeObjectURL;
  };
  return spy;
};

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
export const startAborted = (offscreen) => {
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
