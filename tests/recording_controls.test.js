import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fakeElement} from './helpers/fake_dom.js';
import {fakeGui} from './helpers/fake_gui.js';
import {createRecordingControls} from '../src/recording/recording_controls.js';

/**
 * A MediaRecorder stand-in as VideoRecorder presents one: a toggle that flips
 * the session, the settings the controls push, and the two hooks they wire.
 * @param {?string} [refusedAs] - Container extension the browser substitutes,
 *   reported through onFormatFallback after the start toggle.
 * @param {boolean} [deferStart] - Waits for a simulated picker after toggling.
 * @returns {Object} The recorder double.
 */
function fakeRecorder(refusedAs = null, deferStart = false) {
  return {
    isRecording: false,
    starting: false,
    elapsedSeconds: 0,
    elapsedFormatted: '0:00',
    toggle(effect) {
      this.effect = effect;
      this.isRecording = !this.isRecording;
      this.starting = this.isRecording && deferStart;
      if (this.isRecording && !this.starting) this.onStarted();
      if (this.isRecording && refusedAs) queueMicrotask(() => this.onFormatFallback(refusedAs));
      return this.isRecording;
    },
  };
}

/**
 * The recording controls over fakes, with the pieces a case drives and reads.
 * @param {{labelAxes?: boolean}} [options] - Driver state the notice reads.
 * @returns {Object} The controls, the attach step, and the surfaces they write.
 */
function recordingRig({ labelAxes = false } = {}) {
  const canvasEl = fakeElement('div');
  const doc = {
    createElement: (tag) => fakeElement(tag),
    getElementById: (id) => (id === 'canvas-container' ? canvasEl : null),
  };
  const gui = fakeGui('view');
  const driver = {
    frameInterval: 1 / 16, labelAxes, recorder: null, invalidations: 0, steps: 0,
    invalidate() { this.invalidations += 1; },
    stepOnce() { this.steps += 1; },
  };
  const notices = [];
  let recorder = null;
  const controls = createRecordingControls({
    doc,
    gui,
    driver,
    getRecorder: () => recorder,
    getEffect: () => 'IslamicStars',
    showNotice: (message) => notices.push(message),
  });
  const folder = gui.folders.find((f) => f.namespace === 'Recording');
  return {
    controls,
    driver,
    notices,
    canvasEl,
    button: folder.controllers.find((c) => c.property === 'record'),
    settings: folder.controllers.find((c) => c.property === 'recQuality').object,
    attach(fake) {
      recorder = fake;
      controls.attach(fake);
      return fake;
    },
  };
}

for (const povFidelity of [false, true]) test(`recording discloses sweep sampling when POV fidelity is ${povFidelity}`, () => {
  const rig = recordingRig();
  rig.driver.povFidelity = povFidelity;
  rig.attach(fakeRecorder());
  rig.button.object.record();
  assert.equal(rig.notices.at(-1).includes('the sweep animation samples only the beginning'), povFidelity);
  rig.button.object.record();
  assert.equal(rig.notices.at(-1).includes('the sweep animation samples only the beginning'), false);
});

test('attaching a recorder enables the toggle and replays its selected format', () => {
  const rig = recordingRig({ labelAxes: true });
  assert.equal(rig.button.enabled, false,
    'there is no recorder to start until the module load builds one');
  rig.settings.recFormat = 'MP4';

  const recorder = rig.attach(fakeRecorder('webm'));

  assert.equal(rig.button.enabled, true);
  assert.equal(recorder.format, 'mp4',
    'a format chosen before the load must replay into the recorder it built');
  assert.equal(rig.driver.recorder, recorder,
    'the driver captures through the recorder, so it must be handed it');

});

async function fallbackRecordingRig() {
  const rig = recordingRig({labelAxes: true});
  rig.settings.recFormat = 'MP4';
  const recorder = rig.attach(fakeRecorder('webm'));
  const invalidationsBeforeStart = rig.driver.invalidations;
  rig.button.object.record();
  const starts = rig.notices.filter(text => text.startsWith('Recording started.')).length;
  await Promise.resolve();
  return {rig, recorder, starts, invalidationsBeforeStart};
}

test('recording start announces the settled container and overlay omissions', async () => {
  const {rig, starts, invalidationsBeforeStart} = await fallbackRecordingRig();
  assert.equal(starts, 1);
  assert.match(rig.notices.at(-1), /^Recording started\./,
    'the tint, the readout and the label are visual; the notice is what a '
    + 'screen-reader user gets');
  assert.match(rig.notices.at(-1), /MP4 is unsupported in this browser/,
    'on Firefox an MP4 request records WebM, which reaches the user as nothing '
    + 'at all without this');
  assert.match(rig.notices.at(-1), /Axis labels are page overlays/,
    'the labels are page overlays, not canvas pixels, so the file will not '
    + 'carry what the user can see');
  assert.equal(rig.canvasEl.classList.contains('recording'), true);
  assert.equal(rig.button.label, '\u25a0 Stop');
  assert.ok(rig.driver.invalidations > invalidationsBeforeStart,
    'a session suppresses the PiP, so the scene must be redrawn without it');

});

test('recording ticks refresh the whole-second duration overlay', async () => {
  const {rig, recorder} = await fallbackRecordingRig();
  recorder.elapsedSeconds = 3.4;
  recorder.elapsedFormatted = '0:03';
  rig.controls.tick();
  const overlay = rig.canvasEl.children.find((el) => el.className === 'rec-duration');
  assert.equal(overlay.textContent, '0:03',
    'the readout is written per whole second, from the frame loop');

});

test('stopping a session clears its recording presentation', async () => {
  const {rig} = await fallbackRecordingRig();
  const invalidationsBeforeStop = rig.driver.invalidations;
  rig.button.object.record();

  assert.equal(rig.notices.at(-1), 'Recording stopped.',
    'a stale fallback detail must not be appended to the stop of a session '
    + 'that encoded fine');
  assert.equal(rig.canvasEl.classList.contains('recording'), false);
  assert.equal(rig.button.label, '\u25cf Record');
  assert.ok(rig.driver.invalidations > invalidationsBeforeStop, 'the stop brings the PiP back');
  assert.equal(rig.driver.steps, 0, 'recording controls redraw without advancing the effect');

});

test('overlay teardown clears a restarted recording presentation', async () => {
  const {rig} = await fallbackRecordingRig();
  rig.button.object.record();
  rig.button.object.record();
  assert.equal(rig.canvasEl.classList.contains('recording'), true);
  rig.controls.removeOverlay();
  assert.equal(rig.canvasEl.classList.contains('recording'), false);
  assert.equal(rig.canvasEl.children.length, 0,
    'the overlay belongs to the controls, so the page teardown drops it');
});

for (const failure of ['error', 'empty']) test(`synchronous stop ${failure} notice survives the toggle`, () => {
  const rig = recordingRig();
  const recorder = rig.attach(fakeRecorder());
  rig.button.object.record();
  recorder.toggle = () => {
    if (failure === 'error') recorder.onError(new Error('encoder died'));
    else recorder.onEmptySession();
    return false;
  };
  rig.button.object.record();
  assert.match(rig.notices.at(-1), failure === 'error' ? /encoder died/ : /no frames were captured/);
  assert.equal(rig.canvasEl.classList.contains('recording'), false);
});

test('Save dialog notices wait for the encoder before announcing recording', () => {
  const rig = recordingRig({labelAxes: true});
  const recorder = rig.attach(fakeRecorder(null, true));
  rig.button.object.record();
  assert.equal(rig.notices.at(-1), 'Choose a file to start recording.');
  recorder.starting = false;
  recorder.onStarted();
  assert.match(rig.notices.at(-1), /^Recording started\./);
  assert.match(rig.notices.at(-1), /Axis labels are page overlays/);
  recorder.onFormatFallback('webm');
  assert.match(rig.notices.at(-1), /^Recording started\./);
});

test('recording start preserves the picker fallback and memory limit', () => {
  const picker = Object.getOwnPropertyDescriptor(globalThis, 'showSaveFilePicker');
  Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: () => {} });
  try {
    const rig = recordingRig();
    const recorder = rig.attach(fakeRecorder(null, true));
    rig.button.object.record();
    recorder.onSaveFallback(new Error('Saving to Downloads instead.'));
    recorder.starting = false;
    recorder.onStarted();
    assert.match(rig.notices.at(-1), /^Recording started.*Saving to Downloads instead/);
    assert.match(rig.notices.at(-1), /up to [\d.]+ MB/);
  } finally {
    if (picker) Object.defineProperty(globalThis, 'showSaveFilePicker', picker);
    else Reflect.deleteProperty(globalThis, 'showSaveFilePicker');
  }
});

test('a recorder fault reports its reason and stops offering to stop', () => {
  const rig = recordingRig();
  const recorder = rig.attach(fakeRecorder());

  recorder.onError(new Error('the encoder died'));
  assert.equal(rig.notices.at(-1), 'Recording failed to start: the encoder died',
    'the hook also fires for a start that never produced a session, where '
    + '"Recording stopped" names something that never happened');

  rig.button.object.record();
  recorder.onError(new Error('the encoder died'));

  assert.equal(rig.notices.at(-1), 'Recording stopped: the encoder died');
  assert.equal(rig.canvasEl.classList.contains('recording'), false,
    'the session is already gone: the button must stop offering to stop it');
  assert.equal(rig.button.label, '\u25cf Record');
});

test('an encoder fault after Stop is reported as a stopped recording', () => {
  const rig = recordingRig();
  const recorder = rig.attach(fakeRecorder());
  rig.button.object.record();
  rig.button.object.record();
  recorder.onError(new Error('the final chunk exceeded the limit'));
  assert.equal(rig.notices.at(-1), 'Recording stopped: the final chunk exceeded the limit');
});

test('a Save dialog start failure is reported before recording begins', () => {
  const rig = recordingRig();
  const recorder = rig.attach(fakeRecorder(null, true));
  rig.button.object.record();
  recorder.starting = false;
  recorder.onError(new Error('encoder could not start'));
  assert.equal(rig.notices.at(-1), 'Recording failed to start: encoder could not start');
  assert.equal(rig.canvasEl.classList.contains('recording'), false);
  assert.equal(rig.button.label, '\u25cf Record');
});

test('empty recording notices explain the missing file and preserve prior errors', () => {
  const rig = recordingRig();
  const recorder = rig.attach(fakeRecorder());
  rig.button.object.record();
  rig.button.object.record();
  recorder.onEmptySession();
  assert.equal(rig.notices.at(-1), 'Recording stopped: no frames were captured, so nothing was saved.');
  rig.button.object.record();
  recorder.onError(new Error('encoder died'));
  const error = rig.notices.at(-1);
  recorder.onEmptySession();
  assert.equal(rig.notices.at(-1), error);
});

test('recorder notices name only typed causes', () => {
  const rig = recordingRig();
  const recorder = rig.attach(fakeRecorder());

  recorder.onSaveFallback(new Error('saving to Downloads instead.'));
  assert.equal(rig.notices.at(-1), 'saving to Downloads instead.');

  rig.button.object.record();
  recorder.onError(new DOMException('disk full', 'QuotaExceededError'));
  assert.equal(rig.notices.at(-1), 'Recording stopped: QuotaExceededError: disk full');
});

test('recording memory notices follow the selected bitrate', () => {
  const rig = recordingRig();
  rig.attach(fakeRecorder());
  rig.settings.recQuality = 10;
  rig.button.object.record();
  const first = rig.notices.at(-1).match(/up to ([\d.]+) MB.*about (\d+) seconds/);
  assert.ok(first, rig.notices.at(-1));
  assert.ok(Number(first[1]) > 0);
  rig.button.object.record();
  rig.settings.recQuality = 20;
  rig.button.object.record();
  const second = rig.notices.at(-1).match(/up to ([\d.]+) MB.*about (\d+) seconds/);
  assert.ok(second, rig.notices.at(-1));
  assert.equal(second[1], first[1]);
  assert.equal(Number(second[2]), Math.floor(Number(first[2]) / 2));
});

test('a completed recording save failure preserves the current recording controls', () => {
  const rig = recordingRig();
  const recorder = rig.attach(fakeRecorder());
  rig.button.object.record();
  recorder.onSaveError(new Error('file commit failed'), 'previous.webm');
  assert.equal(rig.notices.at(-1), 'Recording save failed for previous.webm: file commit failed');
  assert.equal(recorder.isRecording, true);
  assert.equal(rig.canvasEl.classList.contains('recording'), true);
  assert.equal(rig.button.label, '\u25a0 Stop');
});

test('the record toggle drops held captures', () => {
  const rig = recordingRig();
  rig.attach(fakeRecorder());
  rig.button.object.record();
  rig.driver.heldCaptures = 3;
  rig.button.object.record();
  assert.equal(rig.driver.heldCaptures, 0);
  rig.driver.heldCaptures = 3;
  rig.button.object.record();
  assert.equal(rig.driver.heldCaptures, 0);
});
