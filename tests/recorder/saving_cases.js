import { test } from "node:test";
import assert from "node:assert/strict";
import { installConsoleCapture } from ".././helpers/fake_console.js";
import { VideoRecorder } from "../../src/recording/recorder.js";
import { SAVE_CLOCK, recordableCanvas, FakeMediaRecorder, installRecorderEnv, drainSink, trackSinkFinish, installSavePath, installRecorderSaveEnv } from "./fixture.js";

/**
 * Without the File System Access API a stopped session buffers its chunks, packs
 * them into one blob of the container's MIME type, and hands it to the browser
 * through a timestamped, attached-then-detached anchor whose object URL is
 * revoked once the click has consumed it.
 */
test('the buffered save path downloads one blob through an anchor click', (t) => {
  const save = installRecorderSaveEnv();
  t.after(save.restore);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: SAVE_CLOCK });
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
  t.mock.timers.tick(60_000);
  assert.deepEqual(save.revoked, [save.created[0].url], 'then it is revoked');
});

for (const mode of ['buffered', 'picker-fallback']) {
  test(`a throwing ${mode} download reports once and releases its capture session`, async (t) => {
    const save = installRecorderSaveEnv();
    t.after(save.restore);
    const captured = installConsoleCapture('error', 'warn');
    t.after(captured.restore);
    const failure = new Error('object URL unavailable');
    let attempts = 0;
    URL.createObjectURL = () => { attempts++; throw failure; };
    if (mode === 'picker-fallback')
      globalThis.showSaveFilePicker = async () => { throw new Error('picker unavailable'); };
    const rec = new VideoRecorder(recordableCanvas());
    rec.format = 'webm';
    const finished = mode === 'picker-fallback' ? trackSinkFinish(rec) : async () => {};
    const errors = [];
    rec.onSaveError = (error, name) => errors.push({error, name});
    rec.start('failed');
    const encoder = rec.mediaRecorder;
    const stream = rec.stream;
    await drainSink();
    encoder.ondataavailable({data: {size: 10}});
    rec.stop();
    assert.doesNotThrow(() => encoder.onstop());
    await finished();
    assert.equal(attempts, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error.cause, failure);
    assert.match(errors[0].error.message, /buffered video could not be saved/);
    assert.match(errors[0].name, /^failed_.*\.webm$/);
    assert.equal(stream.track.stopped, true);
    assert.equal(rec.stream, null);
    assert.equal(rec.mediaRecorder, null);
    assert.equal(rec.isRecording, false);
    rec.start('next');
    await drainSink();
    assert.equal(rec.isRecording, true);
    assert.notEqual(rec.mediaRecorder, encoder);
    rec.dispose();
  });
}

for (const mode of ['buffered', 'streaming']) {
  test(`dispose saves an active ${mode} recording once with its final chunk`, async (t) => {
    t.after(installRecorderEnv());
    const rec = new VideoRecorder(recordableCanvas());
    const saved = [];
    let finalized = 0;
    let waitForSave = async () => {};
    if (mode === 'streaming') {
      globalThis.showSaveFilePicker = async () => ({
        createWritable: async () => ({
          write: async (data) => { saved.push(data); },
          close: async () => { finalized += 1; },
        }),
      });
      rec.download = () => assert.fail('the streamed session should save directly');
      waitForSave = trackSinkFinish(rec);
    } else {
      rec.download = (_encoder, chunks) => {
        saved.push(...chunks);
        finalized += 1;
      };
    }
    const first = new Blob(['first']);
    const last = new Blob(['last']);
    FakeMediaRecorder.stopData = last;
    rec.start('disposed');
    await drainSink();
    const encoder = rec.mediaRecorder;
    const stream = rec.stream;
    encoder.ondataavailable({data: first});

    rec.dispose();
    assert.equal(encoder.state, 'inactive');
    assert.equal(stream.track.stopped, true);
    assert.equal(rec.mediaRecorder, null);
    encoder.onstop();
    encoder.onstop();
    await waitForSave();

    assert.deepEqual(saved, [first, last]);
    assert.equal(finalized, 1);
  });
}

test('a failing sink finalizer still releases the live capture', (t) => {
  t.after(installRecorderEnv());
  const rec = new VideoRecorder(recordableCanvas());
  rec.openSink = () => ({write() {}, finish() { throw new Error('finalizer failed'); }});
  rec.start('failed');
  const encoder = rec.mediaRecorder;
  const stream = rec.stream;
  rec.stop();
  assert.throws(() => encoder.onstop(), /finalizer failed/);
  assert.equal(stream.track.stopped, true);
  assert.equal(rec.stream, null);
  assert.equal(rec.mediaRecorder, null);
  assert.equal(rec.isRecording, false);
});

/**
 * The blob type and the file extension are both derived from the container the
 * browser actually chose, so they can never disagree; an unknown or empty type
 * falls back to WebM, including a subtype that names an Object.prototype
 * member.
 */
test('the buffered save maps each container to its extension and blob type', (t) => {
  const save = installSavePath();
  t.after(save.restore);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: SAVE_CLOCK });
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
  assert.deepEqual(save.revoked, [], 'no URL is revoked synchronously');
  t.mock.timers.tick(60_000);
  assert.equal(save.revoked.length, cases.length, 'every minted URL is revoked');
});

test('download saves the supplied recorder, chunks, and effect name', (t) => {
  const save = installSavePath();
  t.after(save.restore);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: SAVE_CLOCK });
  const rec = new VideoRecorder(recordableCanvas());

  rec.download(
    /** @type {any} */ ({ mimeType: 'video/webm;codecs=vp9' }),
    /** @type {any} */ ([{ size: 7 }]),
    'live');

  assert.deepEqual(save.blobs[0].parts, [{ size: 7 }]);
  assert.equal(save.blobs[0].type, 'video/webm');
  assert.equal(save.clicks[0].download, 'live_20260102_030405.webm');
});
