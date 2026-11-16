import { test } from "node:test";
import assert from "node:assert/strict";
import { installConsoleCapture } from ".././helpers/fake_console.js";
import { DEFAULT_BITRATE_MBPS, MEMORY_BUFFER_LIMIT_BYTES, WRITE_BACKLOG_SECONDS, VideoRecorder } from "../../src/recording/recorder.js";
import { SAVE_CLOCK, expectEmptySessionWarnings, captureSessionBuffers, recordableCanvas, installRecorderEnv, drainSink, trackSinkFinish } from "./fixture.js";

/**
 * With the File System Access API present, chunks are queued for ordered writes
 * and released after writing. Stopping closes the file after those writes;
 * no blob download is assembled on a successful streaming save.
 */
test('streams chunks to disk when the File System Access API is present', async (t) => {
  t.after(installRecorderEnv());
  const writes = [];
  let closed = false;
  const writable = { write: async (d) => { writes.push(d); }, close: async () => { closed = true; } };
  globalThis.showSaveFilePicker = async () => ({ createWritable: async () => writable });
  const rec = new VideoRecorder(recordableCanvas());
  const sinkFinished = trackSinkFinish(rec);
  let downloaded = false;
  rec.download = () => { downloaded = true; };

  const sessionBuffers = captureSessionBuffers(rec);
  rec.start('stream');
  const sessionChunks = sessionBuffers.at(-1);
  const recorder = rec.mediaRecorder;
  await drainSink();
  recorder.ondataavailable({ data: { size: 10 } });
  recorder.ondataavailable({ data: { size: 20 } });
  rec.stop();
  recorder.onstop();

  await sinkFinished();

  assert.deepEqual(writes, [{ size: 10 }, { size: 20 }], 'each chunk written to disk in order');
  assert.equal(closed, true, 'writable closed at stop');
  assert.equal(downloaded, false, 'no in-memory blob download while streaming');
  assert.deepEqual(sessionChunks, [], 'streamed chunks are not retained in RAM');
});

test('a late file close failure reports its session without stopping a new recording', async (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
  let rejectClose;
  let filename;
  const failure = new Error('disk commit failed');
  const chosen = 'take3.mp4';
  globalThis.showSaveFilePicker = async (options) => {
    filename ??= options.suggestedName;
    return { name: chosen, createWritable: async () => ({
      write: async () => {},
      close: () => new Promise((_, reject) => { rejectClose = reject; }),
    }) };
  };
  const rec = new VideoRecorder(recordableCanvas());
  const finished = trackSinkFinish(rec);
  const failures = [];
  const captureFailures = [];
  rec.onSaveError = (error, name) => failures.push({ error, name });
  rec.onError = (error) => captureFailures.push(error);
  rec.start('previous');
  const previous = rec.mediaRecorder;
  await drainSink();
  previous.ondataavailable({ data: { size: 10 } });
  rec.stop();
  previous.onstop();
  await drainSink();
  rec.start('current');
  const current = rec.mediaRecorder;
  rejectClose(failure);
  await finished();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, chosen);
  assert.match(filename, /^previous_/);
  assert.equal(failures[0].error.cause, failure);
  assert.match(failures[0].error.message, /truncated or incomplete/);
  assert.deepEqual(captureFailures, []);
  assert.equal(rec.mediaRecorder, current);
  assert.equal(rec.isRecording, true);
});

test('the encoder is opened at the configured bitrate', (t) => {
  expectEmptySessionWarnings(t);
  t.after(installRecorderEnv());
  const auto = new VideoRecorder(recordableCanvas());
  auto.download = () => {};
  auto.start('e');
  assert.equal(auto.mediaRecorder.options.videoBitsPerSecond, DEFAULT_BITRATE_MBPS * 1_000_000,
    'the constructor default did not reach the encoder');
  auto.stop();
  auto.mediaRecorder.onstop();

  const rec = new VideoRecorder(recordableCanvas());
  rec.download = () => {};
  rec.bitrateMbps = 24;
  rec.start('e');
  // Mbps, not bps: an unconverted 24 would encode at 24 bits per second.
  assert.equal(rec.mediaRecorder.options.videoBitsPerSecond, 24_000_000);
});

test('the save picker is offered the timestamped name and the container filter', async (t) => {
  expectEmptySessionWarnings(t, 2);
  t.after(installRecorderEnv());
  const picked = [];
  const writable = { write: async () => {}, close: async () => {} };
  globalThis.showSaveFilePicker = async (options) => {
    picked.push(options);
    return { createWritable: async () => writable };
  };
  t.mock.timers.enable({ apis: ['Date'], now: SAVE_CLOCK });
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
    const recorder = rec.mediaRecorder;
    await drainSink();
    assert.equal(recorder.state, 'recording');
    rec.stop();
    recorder.onstop();
    await sinkFinished();

    assert.equal(picked.length, 1);
    assert.equal(picked[0].suggestedName, name,
      'the dialog opened on something other than the timestamped file');
    assert.deepEqual(picked[0].types,
      [{ description: 'Video', accept: { [mime]: [`.${format}`] } }]);
  }
});

for (const closeFails of [true, false]) test(`a rejected streaming write reports ${closeFails ? 'an uncommitted save' : 'a truncated saved file'}`, async (t) => {
  t.after(installRecorderEnv());
  const writes = [];
  let closed = false;
  let writeCount = 0;
  const writable = {
    write: async (d) => {
      writeCount++;
      if (writeCount === 2) throw new Error('disk full');
      writes.push(d);
    },
    close: async () => { closed = true; if (closeFails) throw new Error('stream errored'); },
  };
  globalThis.showSaveFilePicker = async () => ({ createWritable: async () => writable });
  const captured = installConsoleCapture('error', 'warn');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  const sinkFinished = trackSinkFinish(rec);
  let downloaded = false;
  const notified = [];
  const saveErrors = [];
  rec.download = () => { downloaded = true; };
  rec.onError = (err) => notified.push(err);
  rec.onSaveError = (err) => saveErrors.push(err);

  rec.start('stream');
  const recorder = rec.mediaRecorder;
  const stream = rec.stream;
  await drainSink();
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
  assert.equal(closed, true, 'closing the errored writable is attempted');
  assert.equal(downloaded, false, 'no blob download of the post-failure tail');
  const message = closeFails ? /chosen file was not updated/ : /saved file is truncated/;
  assert.ok(captured.messages.some((entry) => message.test(entry)));
  assert.equal(saveErrors.length, 1);
  assert.match(saveErrors[0].message, message);
  assert.equal(stream.track.stopped, true);
  assert.equal(rec.stream, null);
});

/**
 * The write chain is serialized, so a link that rejects rejects every link
 * queued behind it and finish()'s close along with them.
 */
test('a host hook that throws does not poison the streaming write chain', async (t) => {
  t.after(installRecorderEnv());
  const writes = [];
  let closed = false;
  let writeCount = 0;
  const writable = {
    write: async (d) => {
      writeCount++;
      if (writeCount === 2) throw new Error('disk full');
      writes.push(d);
    },
    close: async () => { closed = true; throw new Error('stream errored'); },
  };
  globalThis.showSaveFilePicker = async () => ({ createWritable: async () => writable });
  const captured = installConsoleCapture('error', 'warn');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  const sinkFinished = trackSinkFinish(rec);
  let downloaded = false;
  rec.download = () => { downloaded = true; };
  rec.onError = () => { throw new Error('host hook exploded'); };

  rec.start('stream');
  const recorder = rec.mediaRecorder;
  await drainSink();
  recorder.ondataavailable({ data: { size: 10 } });
  recorder.ondataavailable({ data: { size: 20 } }); // this write throws
  await drainSink();
  recorder.onstop();

  await sinkFinished();

  assert.deepEqual(writes, [{ size: 10 }], 'the pre-failure chunk reached disk');
  assert.equal(closed, true,
    'closing is attempted despite the failed host hook');
  assert.equal(downloaded, false, 'no blob download of the post-failure tail');
  assert.ok(captured.messages.some((e) => /host hook exploded/.test(e)),
    'the swallowed host failure is reported');
  assert.ok(captured.messages.some((e) => /chosen file was not updated/.test(e)),
    'the uncommitted save is reported to the user');
});

/**
 * A file that is slow to open holds every chunk in the write chain, bounded at
 * WRITE_BACKLOG_SECONDS of video at the configured or default bitrate.
 */
for (const bitrate of [1, 0]) {
  test(`a stalled file open bounds backlog with configured bitrate ${bitrate}`, async (t) => {
    t.after(installRecorderEnv());
    const writes = [];
    let closed = false;
    const writable = { write: async (d) => { writes.push(d); }, close: async () => { closed = true; } };
    let open = () => {};
    globalThis.showSaveFilePicker = async () => ({
      createWritable: () => new Promise((resolve) => { open = () => resolve(writable); }),
    });
    const captured = installConsoleCapture('error');
    t.after(captured.restore);
    const rec = new VideoRecorder(recordableCanvas());
    const sinkFinished = trackSinkFinish(rec);
    rec.bitrateMbps = bitrate;
    let downloaded = false;
    rec.download = () => { downloaded = true; };
    const notified = [];
    rec.onError = (err) => notified.push(err);

    const sessionBuffers = captureSessionBuffers(rec);
    rec.start('slow-open');
    const recorder = rec.mediaRecorder;
    const expectedBitrate = (bitrate || DEFAULT_BITRATE_MBPS) * 1_000_000;
    assert.equal(recorder.options.videoBitsPerSecond, expectedBitrate);
    await drainSink();
    assert.equal(recorder.state, 'recording', 'the encoder starts once the picker resolves');
    const sessionChunks = sessionBuffers.at(-1);
    const held = (expectedBitrate / 8) * WRITE_BACKLOG_SECONDS - 1_000_000;
    recorder.ondataavailable({ data: { size: held } });
    assert.equal(rec.isRecording, true, 'a backlog under the bound keeps recording');

    recorder.ondataavailable({ data: { size: 2_000_000 } });
    assert.equal(rec.isRecording, false, 'the session stops when the backlog passes the bound');
    assert.equal(notified.length, 1, 'the host is told the session ended');
    assert.match(notified[0].message, /streaming save could not keep up/);
    assert.doesNotMatch(captured.messages.join(' '), /recording stopped/i,
      'the notice prefix already says the session stopped');

    recorder.ondataavailable({ data: { size: 3_000_000 } });
    recorder.onstop();
    assert.equal(notified.length, 1, 'the bound is reported once, not per chunk');

    await drainSink();
    open();
    await sinkFinished();

    assert.deepEqual(writes, [{ size: held }],
      'the chunks held under the bound still reach the chosen file, in order');
    assert.equal(closed, true, 'the file is closed once it opens');
    assert.equal(downloaded, false, 'no in-memory blob download of the dropped tail');
    assert.deepEqual(sessionChunks, [], 'the dropped chunks are not retained in RAM');
  });
}

for (const stalledAt of ['opening', 'writing']) {
  test(`streaming backlog stays bounded during stalled ${stalledAt}`, async (t) => {
    t.after(installRecorderEnv());
    const captured = installConsoleCapture('error');
    t.after(captured.restore);
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
    const rec = new VideoRecorder(recordableCanvas());
    rec.bitrateMbps = 1;
    const notified = [];
    rec.onError = (error) => notified.push(error);
    const finished = trackSinkFinish(rec);
    rec.start('slow-file');
    const recorder = rec.mediaRecorder;
    const size = rec.bitrateMbps * 1_000_000 / 8 * WRITE_BACKLOG_SECONDS / 2;
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
  });
}

test('the in-memory fallback sink stops the session at its byte bound', (t) => {
  t.after(installRecorderEnv());
  const captured = installConsoleCapture('error');
  t.after(captured.restore);
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
});

/**
 * A picker rejection that is not an AbortError leaves the session running with
 * no file handle, so every chunk lands in the blob buffer for the download at
 * stop. With no queued writes remaining, the fallback uses its own byte bound.
 */
test('a streaming session with no file handle bounds its in-memory fallback', async (t) => {
  t.after(installRecorderEnv());
  globalThis.showSaveFilePicker = async () => { throw new Error('picker unavailable'); };
  const captured = installConsoleCapture('warn', 'error');
  t.after(captured.restore);
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
});

test('a streaming session that produces no data never opens the chosen file', async (t) => {
  t.after(installRecorderEnv());
  let createWritableCalls = 0;
  let closed = false;
  const writable = { write: async () => {}, close: async () => { closed = true; } };
  globalThis.showSaveFilePicker = async () => ({
    createWritable: async () => { createWritableCalls++; return writable; },
  });
  const captured = installConsoleCapture('warn');
  t.after(captured.restore);
  const rec = new VideoRecorder(recordableCanvas());
  let empty = 0;
  rec.onEmptySession = () => { empty++; };
  const sinkFinished = trackSinkFinish(rec);
  let downloaded = false;
  rec.download = () => { downloaded = true; };

  rec.start('empty');
  const recorder = rec.mediaRecorder;
  await drainSink();
  // No ondataavailable: the session streams nothing.
  rec.stop();
  recorder.onstop();

  await sinkFinished();

  assert.equal(createWritableCalls, 0, 'the file is never opened/truncated when no data streams');
  assert.equal(closed, false, 'no empty writable is closed over the chosen file');
  assert.equal(downloaded, false, 'nothing to download');
  assert.ok(captured.messages.some((w) => /no data/.test(w)),
    'the empty session is reported');
  assert.equal(empty, 1);
});
