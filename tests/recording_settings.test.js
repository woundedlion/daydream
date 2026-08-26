//
// The recording settings hold their values until the recorder the module load
// builds exists to take them, and report a write the running session cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingSettings } from '../recording_settings.js';

// The recording settings share the Pole LOD binding's problem: the GUI mounts at
// module scope, the recorder is built only when the module load resolves, and
// the recorder latches every one of these at start().

/**
 * Build the recording settings over a recorder that appears only when made to.
 * @returns {Object} The block, the recorder double, the warnings, and the load.
 */
function makeRecordingSettings() {
  const warnings = [];
  let recorder = null;
  const block = createRecordingSettings({
    getRecorder: () => recorder,
    warn: (message) => warnings.push(message),
  });
  block.define('recQuality', 16, 'bitrate',
    (rec, v) => { rec.bitrateMbps = v; });
  block.define('recFormat', 'Auto', 'format',
    (rec, v) => { rec.format = v; });
  return {
    block,
    warnings,
    getRecorder: () => recorder,
    loadRecorder: () => { recorder = { isRecording: false }; return recorder; },
  };
}

test('a setting written before the recorder exists is held, not lost', () => {
  const h = makeRecordingSettings();

  h.block.settings.recQuality = 8;
  assert.equal(h.block.settings.recQuality, 8, 'the setting is its own durable home');
  assert.deepEqual(h.warnings, [], 'there is no session to warn about yet');

  const recorder = h.loadRecorder();
  h.block.replay();

  assert.equal(recorder.bitrateMbps, 8, 'the load carries the held value in');
  assert.equal(recorder.format, 'Auto', 'an untouched setting replays its default');
});

test('a setting written once the recorder exists reaches it immediately', () => {
  const h = makeRecordingSettings();
  const recorder = h.loadRecorder();

  h.block.settings.recFormat = 'mp4';

  assert.equal(recorder.format, 'mp4');
  assert.equal(h.block.settings.recFormat, 'mp4', 'and the setting still reads back');
  assert.deepEqual(h.warnings, [], 'no session is running, so nothing is deferred');
});

test('a write during a session is reported as deferred to the next one', () => {
  const h = makeRecordingSettings();
  const recorder = h.loadRecorder();
  recorder.isRecording = true;

  h.block.settings.recQuality = 20;

  assert.equal(recorder.bitrateMbps, 20, 'the write still lands on the recorder');
  assert.equal(h.warnings.length, 1, 'and is reported exactly once');
  assert.match(h.warnings[0], /bitrate/, 'the notice names the setting');
  assert.match(h.warnings[0], /next recording/, 'and says when it takes effect');
});

// GUI-bound: lil-gui enumerates the object it is handed, so a non-enumerable
// setting would never get a control.
test('every setting is enumerable on the GUI-bound object', () => {
  const h = makeRecordingSettings();

  assert.deepEqual(Object.keys(h.block.settings), ['recQuality', 'recFormat'],
    'the settings enumerate in definition order');
});
