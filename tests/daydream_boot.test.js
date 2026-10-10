//
// daydream.js's composition root once its WASM module lands, plus the control
// blocks start() lifts out, driven through their factories.
//
// Cases that read the source anchor on the call site and name the failure they
// stand in for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeElement, restoreDocumentAfterEach } from './helpers/fake_dom.js';
import { URL_FLUSH_DEBOUNCE_MS } from '../src/app/state.js';
import { pageWarmer } from '../src/segments/module_warmer.js';
import { SegmentController } from '../src/segments/segment_controller.js';
import {
  EffectSetResult, ParamSetResult, ResolutionSetResult, ChainSnapshotRestoreResult, unpinnedEngineMethods,
} from './helpers/fake_engine.js';
import { captureConsole, installConsoleCapture } from './helpers/fake_console.js';
import { createRecordingControls } from '../src/recording/recording_controls.js';
import { Daydream } from '../src/renderer/driver.js';
import { createSegmentPoolSpawner, createSegmentedPovControls } from '../src/ui/segmented_pov_controls.js';
import {
  fakeGui,
  fakeWasmModule,
  noticeText,
  trackedStartApp,
  segmentCountControl,
} from './helpers/fake_app.js';

restoreDocumentAfterEach();
const startApp = trackedStartApp();

/**
 * Blanks a source's comments to spaces, leaving every other offset where it
 * was. Prose cannot then satisfy a pattern, so a case that names wiring fails
 * when only a comment describes it.
 * @param {string} src - Source text.
 * @returns {string} The source with its comment bodies spaced out.
 */
function withoutComments(src) {
  const out = [...src];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c !== '/') continue;
    let end;
    if (src[i + 1] === '/') {
      const eol = src.indexOf('\n', i);
      end = eol < 0 ? src.length : eol;
    } else if (src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      end = close < 0 ? src.length : close + 2;
    } else {
      continue;
    }
    for (let j = i; j < end; j++) if (out[j] !== '\n') out[j] = ' ';
    i = end - 1;
  }
  return out.join('');
}

const SOURCE = withoutComments(
  readFileSync(new URL('../src/app/daydream.js', import.meta.url), 'utf8'));

// The two simulator presets, as the driver is told to size itself to them.
const PHANTASM = [288, 144, 0.25];
const HOLOSPHERE = [96, 20, 2];

test('catalog effects are offered at both simulator resolutions', async () => {
  const app = await bootedApp({
    loadModule: () => Promise.resolve(fakeWasmModule()),
  });
  const hiRes = offeredEffects(app);

  captureConsole(() => resolutionControl(app).setValue('Holosphere (96x20)'));
  const loRes = offeredEffects(app);

  for (const effect of ['AshCloud', 'HyperLattice']) {
    assert.ok(hiRes.includes(effect),
      `the sidebar must offer ${effect} at the high-res preset`);
    assert.ok(loRes.includes(effect),
      `the sidebar must offer ${effect} at the low-res preset`);
  }
});

test('a booted render reconciles live panel values', async () => {
  const module = fakeWasmModule({ definitions: [
    { name: 'Speed', value: 0.2, min: 0, max: 1, animated: true },
  ] });
  module.HolosphereEngine.prototype.getParamValues = () => new Float32Array([0.75]);
  const app = await bootedApp({ loadModule: async () => module });
  app.driver.renderer.frame();
  const controls = app.guis.flatMap((gui) => gui.controllers);
  assert.equal(controls.find((control) => control.property === 'Speed').getValue(), 0.75);
});

test('a booted recorder captures at the driver frame rate', async () => {
  const app = await bootedApp({ loadModule: async () => fakeWasmModule() });
  const { recorder } = app.driver;
  assert.ok(recorder, 'the module load did not hand the driver a recorder');
  assert.equal(recorder.frameInterval, 1 / Daydream.FPS);
  assert.equal(Math.round(1 / recorder.frameInterval), Daydream.FPS);
});

test('the boot double mocks only methods the engine has', () => {
  const { HolosphereEngine } = fakeWasmModule();
  assert.deepEqual(unpinnedEngineMethods(new HolosphereEngine()), []);
});

/** @returns {Array<string>} The effects the sidebar is offering. */
function offeredEffects(app) {
  return app.elements.get('effect-sidebar')
    .querySelectorAll('[data-effect]').map((option) => option.dataset.effect);
}

/** @returns {Object} The live resolution dropdown on the global GUI root. */
function resolutionControl(app) {
  return app.guis[0].controllers.find((c) => c.property === 'resolution');
}

test('an effect switch preserves view deep-link parameters', async () => {
  const app = await bootedApp({ search: '?view.poleLod=1.5&fx.stale=2',
    loadModule: async () => fakeWasmModule(),
  });
  const option = app.elements.get('effect-sidebar').querySelectorAll('[data-effect]')
    .find((entry) => entry.dataset.effect === 'Raymarch');
  assert.ok(option);
  assert.ok(app.guis[0].collectUrlKeys().includes('view.poleLod'), app.guis[0].collectUrlKeys().join(', '));
  option.onclick();
  await new Promise((resolve) => setTimeout(resolve, URL_FLUSH_DEBOUNCE_MS + 20));
  const query = new URL(app.urlWrites.at(-1), 'https://example.test').searchParams;
  assert.equal(query.get('view.poleLod'), '1.5', app.urlWrites.join('\n'));
  assert.equal(query.has('fx.stale'), false);
});

/**
 * A controller in the Recording folder of a booted app.
 * @param {Object} app - A startApp() result.
 * @param {string} property - The bound property name.
 * @returns {Object} The controller double.
 */
function recordingControl(app, property) {
  return app.guis[0].folders.find((folder) => folder.namespace === 'Recording')
    .controllers.find((controller) => controller.property === property);
}

/**
 * Starts an app and settles its module load, with the console captured across
 * the whole boot: the refused initial apply reports through it, and the frame
 * guard binds its default error sink while the app is being built.
 * @param {Object} [options] - startApp() seam overrides.
 * @returns {Promise<Object>} The started app fakes.
 */
async function bootedApp(options) {
  const capture = installConsoleCapture('error', 'warn', 'log');
  try {
    const app = startApp(options);
    await app.teardown.ready;
    return app;
  } finally {
    capture.restore();
  }
}


/**
 * A MediaRecorder stand-in as VideoRecorder presents one: a toggle that flips
 * the session, the settings the controls push, and the two hooks they wire.
 * @param {?string} [refusedAs] - Container extension the browser substitutes,
 *   reported through onFormatFallback after the start toggle.
 * @returns {Object} The recorder double.
 */
function fakeRecorder(refusedAs = null) {
  return {
    isRecording: false,
    elapsedSeconds: 0,
    elapsedFormatted: '0:00',
    toggle(effect) {
      this.effect = effect;
      this.isRecording = !this.isRecording;
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

test('the record toggle announces the session and the container it settled on', async () => {
  const rig = recordingRig({ labelAxes: true });
  assert.equal(rig.button.enabled, false,
    'there is no recorder to start until the module load builds one');
  rig.settings.recFormat = 'MP4';

  const recorder = rig.attach(fakeRecorder('webm'));

  assert.equal(rig.button.enabled, true);
  assert.equal(recorder.frameInterval, 1 / 16,
    'the recorder locks its capture rate to the driver frame interval');
  assert.equal(recorder.format, 'mp4',
    'a format chosen before the load must replay into the recorder it built');
  assert.equal(rig.driver.recorder, recorder,
    'the driver captures through the recorder, so it must be handed it');

  rig.button.object.record();
  await Promise.resolve();

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
  assert.equal(rig.driver.invalidations, 1,
    'a session suppresses the PiP, so the scene must be redrawn without it');

  recorder.elapsedSeconds = 3.4;
  recorder.elapsedFormatted = '0:03';
  rig.controls.tick();
  const overlay = rig.canvasEl.children.find((el) => el.className === 'rec-duration');
  assert.equal(overlay.textContent, '0:03',
    'the readout is written per whole second, from the frame loop');

  rig.button.object.record();

  assert.equal(rig.notices.at(-1), 'Recording stopped.',
    'a stale fallback detail must not be appended to the stop of a session '
    + 'that encoded fine');
  assert.equal(rig.canvasEl.classList.contains('recording'), false);
  assert.equal(rig.button.label, '\u25cf Record');
  assert.equal(rig.driver.invalidations, 2, 'the stop brings the PiP back');
  assert.equal(rig.driver.steps, 0, 'recording controls redraw without advancing the effect');

  rig.controls.removeOverlay();
  assert.equal(rig.canvasEl.children.length, 0,
    'the overlay belongs to the controls, so the page teardown drops it');
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
  assert.match(rig.notices.at(-1), /Recording save failed for previous.webm: .*file commit failed/);
  assert.equal(recorder.isRecording, true);
  assert.equal(rig.canvasEl.classList.contains('recording'), true);
  assert.equal(rig.button.label, '\u25a0 Stop');
});

test('a failed engine load disposes the app through the retained teardown', async () => {
  const app = await bootedApp({ loadModule: () => Promise.reject(new Error('no wasm')) });

  assert.equal(app.teardown.disposed(), true,
    'the load handlers must reach the teardown the root built after them, or a '
    + 'page with no engine keeps its listeners, its GUI and its driver');
  assert.deepEqual(app.listeners, [],
    'a listener that outlives the failed load reports into a dead app');
});

test('a module that lands after the page was discarded builds no engine', async () => {
  const module = fakeWasmModule();
  let deliver;
  const capture = installConsoleCapture('error', 'warn', 'log');
  const app = startApp({ loadModule: () => new Promise((resolve) => { deliver = resolve; }) });
  try {
    app.teardown.dispose();
    deliver(module);
    await app.teardown.ready;
  } finally {
    capture.restore();
  }

  assert.equal(module.engines(), 0,
    'the handlers must read the teardown lazily and see the discard, or the '
    + 'startup builds an engine into a torn-down app that will never release it');
});

test('a refused initial apply disposes the app it already moved', async () => {
  const module = fakeWasmModule({ refusedWidth: 288 });
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });

  assert.equal(module.engines(), 1, 'the load must have built the engine');
  assert.equal(app.teardown.disposed(), true,
    'the apply has already moved the engine, pool, driver and sidebar, so the '
    + 'panels would otherwise stay live over a blanked canvas');
  assert.deepEqual(app.listeners, [],
    'a listener that outlives the refused apply reports into a dead app');
});

test('an initial apply that trapped the module is reported as the trap', async () => {
  const module = fakeWasmModule({ trappingSizeQuery: true });
  const capture = installConsoleCapture('error', 'warn', 'log');
  let app;
  try {
    app = startApp({ loadModule: () => Promise.resolve(module) });
    await app.teardown.ready;
  } finally {
    capture.restore();
  }

  assert.match(capture.messages.join('\n'), /Startup stopped: the rendering engine trapped/,
    'a trapped query reported as an unsupported resolution sends the user back '
    + 'to a dropdown that will trap again');
  assert.equal(app.teardown.disposed(), true,
    'a dead module is terminal, so the panels must not stay live');
});

test('the page-failure surface is the shared one, and it is torn down', () => {
  const { teardown, listeners, win } = startApp();
  const failureListeners = () => listeners.filter(
    ({ type }) => type === 'error' || type === 'unhandledrejection');

  assert.deepEqual(failureListeners().map(({ type }) => type),
    ['error', 'unhandledrejection'],
    'a synchronous throw from an animation frame, a lil-gui onChange, or a DOM '
    + 'listener is console-only without the error listener the shared surface '
    + 'installs alongside the rejection one');

  const { handler: onError } = failureListeners()[0];
  const { messages } = captureConsole(
    () => onError({ target: win, error: new Error('boom') }));
  assert.match(messages.join('\n'), /simulator error:.*boom/,
    'the surface must be raised under the page label, or a report from the '
    + 'simulator is indistinguishable from one from a tool page');

  teardown.dispose();
  assert.deepEqual(failureListeners(), [],
    'a listener that outlives the page discard reports into a dead app');
});


test('a parameter write does not clear a rejected switch', async () => {
  const module = fakeWasmModule({
    definitions: [{ name: 'Speed', value: 1, min: 0, max: 2 }],
  });
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });

  // Only the switch the case is about is turned down, so its rollback stands
  // and the coordinator reports a rejection rather than the fatal banner.
  module.HolosphereEngine.prototype.setResolution = (w) => (w === 96
    ? ResolutionSetResult.UNSUPPORTED : ResolutionSetResult.RESIZED);
  captureConsole(() => resolutionControl(app).setValue('Holosphere (96x20)'));
  const rejection = noticeText(app);
  assert.match(rejection, /Resolution change was rejected/,
    'a refused switch whose rollback stood must be reported to the user');

  const speed = app.guis.at(-1).controllers.find((c) => c.property === 'Speed');
  captureConsole(() => speed.setValue(1.5));

  assert.deepEqual(module.params.at(-1), ['Speed', 1.5],
    'the write must have reached the engine');
  assert.equal(noticeText(app), rejection,
    'both announce through the one notice element, so each must tag its writes '
    + 'with an owner of its own; sharing a tag lets a slider nudge clear a '
    + 'switch rejection');
});

test('resolution rollback restores an unpaused animated parameter snapshot', async () => {
  const module = fakeWasmModule({ definitions: [
    { name: 'Speed', value: 0.2, min: 0, max: 1, animated: true },
  ] });
  const app = await bootedApp({ loadModule: async () => module });
  const controls = app.guis.at(-1).controllers;
  controls.find((control) => control.property === 'Speed').setValue(0.8);
  controls.find((control) => control.property === 'pause').setValue(false);
  assert.equal(module.engine.getAnimationsPaused(), false);
  module.HolosphereEngine.prototype.setResolution = (w) => (w === 96
    ? ResolutionSetResult.UNSUPPORTED : ResolutionSetResult.RESIZED);
  captureConsole(() => resolutionControl(app).setValue('Holosphere (96x20)'));
  assert.match(noticeText(app), /Resolution change was rejected/);
  const restored = app.guis.at(-1).controllers;
  assert.equal(restored.find((control) => control.property === 'Speed').getValue(), 0.8);
  assert.equal(restored.find((control) => control.property === 'pause').getValue(), false);
  assert.equal(module.engine.getAnimationsPaused(), false);
});

test('a segmented-POV failure is announced and returns the toggle', async (t) => {
  const gui = fakeGui('view');
  const notices = [];
  const segments = {
    active: false,
    count: 2,
    showBoundaries: false,
    create() { throw new Error('a worker would not start'); },
    destroy() {},
    updateStats() {},
  };
  t.mock.method(pageWarmer, 'warm', async () => {});
  createSegmentedPovControls({
    gui,
    segments,
    nav: { hardwareConcurrency: 8 },
    win: {},
    showNotice: (message) => notices.push(message),
  });
  const enabled = gui.folders.find((f) => f.namespace === 'Segmented POV')
    .controllers.find((c) => c.property === 'segmented');

  // lil-gui writes the bound object before firing the handler.
  enabled.object[enabled.property] = true;
  const capture = installConsoleCapture('error', 'warn');
  try {
    await enabled.changed(true);
  } finally {
    capture.restore();
  }
  assert.ok(capture.messages.some((message) =>
    /Segmented POV: enable failed;.*would not start/.test(message)));

  assert.match(notices.at(-1), /Segmented POV enable failed:.*would not start/,
    'a console-only failure is invisible: the user sees the toggle flip back '
    + 'and cannot tell it from a mis-click, and the fault banner covers only '
    + 'latched runtime faults');
  assert.equal(enabled.object[enabled.property], false,
    'the failed switch leaves the bound state disabled');
});

test('segmented controls reconcile a mobile spawn and resize without a second pool', async (t) => {
  const gui = fakeGui('view');
  const created = [];
  const layout = { matches: false };
  const win = { matchMedia: () => layout };
  const segments = {
    active: false, count: 8, showBoundaries: false,
    destroyed: 0,
    create(count) { this.count = count; created.push(count); },
    destroy() { this.destroyed += 1; },
  };
  let finishWarm;
  t.mock.method(pageWarmer, 'warm', () => new Promise(resolve => { finishWarm = resolve; }));
  const notices = [];
  createSegmentedPovControls({ gui, segments, nav: { hardwareConcurrency: 8 }, win,
    showNotice: message => notices.push(message) });
  const controls = gui.folders[0].controllers;
  const enabled = controls.find(control => control.property === 'segmented');
  const count = controls.find(control => control.property === 'segments');
  enabled.object.segmented = true;
  const start = enabled.changed(true);
  layout.matches = true;
  finishWarm();
  await start;
  assert.deepEqual(created, [4]);
  assert.equal(count.object.segments, 4);
  assert.equal(segments.active, true);
  t.mock.method(pageWarmer, 'warm', async () => {});
  count.object.segments = 2;
  await count.changed(2);
  assert.deepEqual(created, [4, 2]);
  assert.equal(count.object.segments, 2);
  enabled.object.segmented = false;
  await enabled.changed(false);
  assert.equal(segments.active, false);
  assert.equal(segments.destroyed, 1);
  assert.deepEqual(notices, []);
});

test('the segmented controls have their own notice owner', async (t) => {
  const owners = [...SOURCE.matchAll(/const \w+_NOTICE = '([^']+)'/g)].map((match) => match[1]);
  assert.ok(owners.length > 1);
  assert.equal(new Set(owners).size, owners.length);

  const module = fakeWasmModule({
    definitions: [{ name: 'Speed', value: 1, min: 0, max: 2 }],
  });
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });
  t.mock.method(pageWarmer, 'warm', async () => {});
  t.mock.method(SegmentController.prototype, 'create', () => {
    throw new Error('a worker would not start');
  });
  const enabled = app.guis[0].folders
    .find((folder) => folder.namespace === 'Segmented POV').controllers
    .find((controller) => controller.property === 'segmented');
  enabled.object[enabled.property] = true;
  const capture = installConsoleCapture('error', 'warn');
  try {
    await enabled.changed(true);
  } finally {
    capture.restore();
  }
  const fallback = noticeText(app);
  assert.match(fallback, /Segmented POV enable failed:.*would not start/);

  const speed = app.guis.at(-1).controllers.find((c) => c.property === 'Speed');
  captureConsole(() => speed.setValue(1.5));
  assert.deepEqual(module.params.at(-1), ['Speed', 1.5],
    'the write must have reached the engine');
  assert.equal(noticeText(app), fallback,
    'sharing an owner tag with the param writer lets a slider nudge clear the '
    + 'segmented fallback notice');
});

test('a recording report reaches the shared notice element', async () => {
  const module = fakeWasmModule({
    definitions: [{ name: 'Speed', value: 1, min: 0, max: 2 }],
  });
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });
  const record = recordingControl(app, 'record');
  const format = recordingControl(app, 'recFormat');
  const recorder = app.driver.recorder;
  assert.ok(recorder, 'the load must have handed the controls a recorder');

  recorder.toggle = () => { queueMicrotask(() => recorder.onFormatFallback('webm')); return true; };
  captureConsole(() => record.object.record());
  await Promise.resolve();
  const started = noticeText(app);

  assert.match(started, /^Recording started\..*recording as WebM\./,
    'the tint, the readout and the button label are all visual, and the rig '
    + 'above injects the sink: what the page needs is that sink pointed at the '
    + 'one notice element, or the report reaches nobody');
  assert.equal(format.object.recFormat, 'Auto',
    'rewriting the Rec Format dropdown fires its onChange, which overwrites '
    + "the user's chosen container for the rest of the session");

  const speed = app.guis.at(-1).controllers.find((c) => c.property === 'Speed');
  captureConsole(() => speed.setValue(1.5));
  assert.equal(noticeText(app), started,
    'the owner tag belongs to the root: sharing one with the param writer lets '
    + 'a slider nudge clear a recording report');

  recorder.toggle = () => false;
  captureConsole(() => record.object.record());
  assert.equal(noticeText(app), 'Recording stopped.',
    'the end of a session is as unreported as its start without this');
});

test('a start that never began a session keeps the reason it was given', async () => {
  const app = await bootedApp({
    loadModule: () => Promise.resolve(fakeWasmModule()),
  });
  const record = recordingControl(app, 'record');
  const recorder = app.driver.recorder;

  recorder.toggle = () => {
    recorder.onError(new Error('no encoder'));
    return false;
  };
  captureConsole(() => record.object.record());

  assert.match(noticeText(app), /Recording failed to start:.*no encoder/,
    'the fault hook has already reported why, and the generic stop message '
    + 'carries the same owner tag, so writing it would replace the only '
    + 'explanation the user was given with one that is also untrue');
});

test('the discard path releases what the refused startup had already built', async () => {
  const module = fakeWasmModule({ refusedWidth: 288 });
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });

  assert.equal(module.deletes(), 1,
    'a WASM engine handle must be deleted, not merely dropped, and the startup '
    + 'that lost the disposal race owns everything it built: the page teardown '
    + 'and the discard path both release through EngineHost.dispose(), so '
    + 'whichever of them gets there frees it and neither can drift');
  assert.equal(app.driver.recorder, null,
    'the recorder the startup hung on the driver captures a stream from a '
    + 'canvas the teardown has already released');
});

test('the segment-count control marks the count no hardware produces', () => {
  const roomy = segmentCountControl(startApp({ nav: { hardwareConcurrency: 8 } }));
  assert.match(roomy.label, /^Segments \(6\b/,
    'the slider offers 6 segments, which the power-of-two firmware layout never '
    + 'runs; without the marker the per-segment overlay names boards that cannot exist');

  const tight = segmentCountControl(startApp({ nav: { deviceMemory: 2 } }));
  assert.match(tight.label, /^Segments \(max 2\b/,
    'a device held below the marked count reports the cap it is held to instead');
  assert.notEqual(tight.label, roomy.label, 'the marker follows the cap');
});

test('the segment-count slider carries the device cap as its own maximum', () => {
  const roomy = segmentCountControl(startApp({ nav: { hardwareConcurrency: 8 } }));
  assert.deepEqual(roomy.args, [2, 8, 2],
    'the cap must bound the control itself: the deep-link hydrator clamps against '
    + "the max passed to add(), and the pool's memory cost is what it bounds");

  const tight = segmentCountControl(startApp({ nav: { deviceMemory: 2 } }));
  assert.deepEqual(tight.args, [[2]],
    'the cap must read the device hints, not a constant');
  assert.ok(tight.object.segments <= 2,
    'the initial value must sit inside the range, or a capped device opens the '
    + 'GUI showing a count the slider cannot represent');
});

test('the spawn bounds the pool by the ceiling the device carries now', () => {
  const created = [];
  let requested = 8;
  let mobile = false;
  const spawn = createSegmentPoolSpawner(
    { create: (count) => created.push(count) },
    () => requested,
    { hardwareConcurrency: 8 },
    () => mobile);

  spawn();
  requested = 6;
  mobile = true;
  spawn();

  assert.deepEqual(created, [8, 4],
    'a rotation into the mobile layout must lower the next pool spawn');
});
test('the late-bound engine controls are re-applied once the engine exists', async () => {
  const module = fakeWasmModule();
  let deliver;
  const capture = installConsoleCapture('error', 'warn', 'log');
  const app = startApp({ loadModule: () => new Promise((resolve) => { deliver = resolve; }) });
  try {
    app.guis[0].controllers.find((c) => c.property === 'poleLod').setValue(1.5);
    deliver(module);
    await app.teardown.ready;
  } finally {
    capture.restore();
  }

  assert.deepEqual(module.poleLod, [1.5],
    'the Pole LOD onChange runs while host.engine is null, so the block that '
    + 'builds the engine must replay the binding; without it a ?view.poleLod '
    + 'deep link shows in the GUI but never reaches the engine');
});

test('engine resolutions without a named preset are omitted and reported', async () => {
  const capture = installConsoleCapture('warn', 'log');
  try {
    const app = startApp({
      loadModule: () => Promise.resolve(fakeWasmModule({ resolutions: [[96, 20], [7, 13]] })),
    });
    await app.teardown.ready;
    assert.deepEqual(resolutionControl(app).args[0], ['Holosphere (96x20)']);
    assert.deepEqual(app.driver.resolution, HOLOSPHERE);
    assert.ok(capture.messages.some((message) => message.includes('7x13')));
  } finally {
    capture.restore();
  }
});

test('the resolution dropdown offers only what the engine reports', async () => {
  const app = await bootedApp({
    loadModule: () => Promise.resolve(fakeWasmModule({ resolutions: [[96, 20]] })),
  });

  assert.deepEqual(resolutionControl(app).args[0], ['Holosphere (96x20)'],
    'an unsupported row the user can still pick applies nothing and reports a '
    + 'rejection instead');
  assert.deepEqual(app.driver.resolution, HOLOSPHERE,
    'a hydrated resolution the engine cannot build must be corrected before '
    + 'first paint, not left advertised by the GUI and the URL');
});

// Both lil-gui options() behaviours.
for (const optionsReplaces of [false, true]) {
  const branch = optionsReplaces ? 'a replaced' : 'an updated';
  test(`${branch} resolution dropdown still drives a switch`, async () => {
    const app = await bootedApp({
      optionsReplaces,
      loadModule: () => Promise.resolve(fakeWasmModule()),
    });
    assert.deepEqual(app.driver.resolution, PHANTASM);

    captureConsole(() => resolutionControl(app).setValue('Holosphere (96x20)'));

    assert.deepEqual(app.driver.resolution, HOLOSPHERE,
      "lil-gui's base Controller.options() destroys the receiver and returns a "
      + 'replacement that carries the name but no onChange, while an '
      + 'OptionController updates itself in place; a discarded return value '
      + 'leaves the live dropdown writing to nothing and the muted engine '
      + 'correction updating a detached <select>');
    app.driver.renderer.frame();
    assert.equal(app.driver.pixels.length, 96 * 20 * 3,
      'the display aliases are rebuilt over the resized engine buffer');
  });
}

test('a trapped resolution query stops the startup instead of booting on', async () => {
  let built = 0;
  const module = {
    DISPLAY_NORTH_PHI: 0,
    DISPLAY_SOUTH_PHI: Math.PI,
    HS_MODULE_DEAD: false,
    HolosphereEngine: class {
      constructor() { built++; }
      static isLive() { return false; }
      // HS_CHECK raises the flag ahead of its __builtin_trap(), so it is
      // already set when the RuntimeError reaches the caller.
      static getSupportedResolutions() {
        module.HS_MODULE_DEAD = true;
        throw new WebAssembly.RuntimeError('unreachable');
      }
      setPoleLod() {}
      setDisplayCaps() { return true; }
      getDisplayNorthPhi() { return 0; }
      getDisplaySouthPhi() { return Math.PI; }
      delete() {}
    },
  };
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });

  assert.equal(built, 1, 'the load must have built the engine before the query');
  const record = app.guis[0].folders
    .find((folder) => folder.namespace === 'Recording').controllers
    .find((controller) => controller.property === 'record');
  assert.equal(record.enabled, false,
    'the trap unwound nothing, so the shadow stack stays short and the release '
    + "link's -sASSERTIONS=0 makes the overrun silent: the startup must stop at "
    + 'the catch rather than run the recorder, the initial apply, and every '
    + 'module call after them');
  assert.equal(app.teardown.disposed(), true,
    'a dead module is terminal, so the panels must not stay live over a canvas '
    + 'nothing can render into');
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

test('a refused parameter write reports its reason and a later accepted edit clears it', async () => {
  const module = fakeWasmModule({
    definitions: [{ name: 'Speed', value: 1, min: 0, max: 2 }],
  });
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });
  const speed = app.guis.at(-1).controllers.find((c) => c.property === 'Speed');
  const accepted = module.HolosphereEngine.prototype.setParameter;
  module.HolosphereEngine.prototype.setParameter = () => ParamSetResult.INADMISSIBLE;
  captureConsole(() => speed.setValue(1.5));
  assert.match(noticeText(app), /Parameter "Speed" was rejected: INADMISSIBLE/);
  module.HolosphereEngine.prototype.setParameter = accepted;
  captureConsole(() => speed.setValue(1.25));
  assert.equal(noticeText(app), '');
  assert.deepEqual(module.params.at(-1), ['Speed', 1.25]);
});

test('startup defaults to full coverage despite compiled physical geometry', async () => {
  const module = fakeWasmModule();
  Object.assign(module, {
    DISPLAY_NORTH_PHI: 0.02 * Math.PI,
    DISPLAY_SOUTH_PHI: 0.98 * Math.PI,
  });
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });
  assert.deepEqual(module.caps, [[0, 0]]);
  assert.equal(app.driver.DISPLAY_NORTH_PHI, 0);
  assert.equal(app.driver.DISPLAY_SOUTH_PHI, Math.PI);
});

test('global cap edits survive module loading, paused redraw and resolution switches', async () => {
  let resolve;
  const loading = new Promise((done) => { resolve = done; });
  const app = startApp({ loadModule: () => loading });
  app.guis[0].controllers.find((c) => c.property === 'topCap').setValue(2);
  app.guis[0].controllers.find((c) => c.property === 'bottomCap').setValue(3);
  assert.equal(app.driver.dotMesh, null);
  const module = fakeWasmModule();
  module.ChainSnapshotRestoreResult = ChainSnapshotRestoreResult;
  resolve(module);
  await app.teardown.ready;
  assert.deepEqual(module.caps, [[2, 3]]);
  assert.equal(app.teardown.disposed(), false);
  app.driver.renderer.frame();
  assert.ok(app.driver.dotMesh.instanceColor.array.length > 0);
  assert.equal(app.driver.DISPLAY_NORTH_PHI, 0.02 * Math.PI);
  app.driver.paused = true;
  let draws = 0;
  module.HolosphereEngine.prototype.drawFrame = () => { draws++; };
  app.guis[0].controllers.find((c) => c.property === 'topCap').setValue(4);
  assert.equal(draws, 1);
  assert.equal(app.driver.DISPLAY_NORTH_PHI, 0.04 * Math.PI);
  assert.equal(app.driver.DISPLAY_SOUTH_PHI, 0.97 * Math.PI);
  assert.equal(app.driver.paused, true);
  const capsBefore = module.caps.length;
  const colorBefore = app.driver.dotMesh.instanceColor;
  app.guis[0].controllers.find((c) => c.property === 'resolution').setValue('Holosphere (96x20)');
  assert.equal(module.caps.length, capsBefore);
  assert.deepEqual(module.caps.at(-1), [4, 3]);
  assert.equal(app.driver.DISPLAY_NORTH_PHI, 0.04 * Math.PI);
  assert.equal(app.driver.DISPLAY_SOUTH_PHI, 0.97 * Math.PI);
  const color = app.driver.dotMesh.instanceColor;
  assert.notEqual(color, colorBefore);
  const versionBefore = color.version;
  app.driver.renderer.frame();
  assert.ok(color.version > versionBefore);
});

test('a rejected startup cap profile disposes the incompatible engine', async () => {
  const module = fakeWasmModule();
  module.HolosphereEngine.prototype.setDisplayCaps = () => false;
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });
  assert.equal(app.teardown.disposed(), true);
  assert.equal(module.deletes(), 1);
});

test('a rejected live cap edit leaves the displayed geometry unchanged', async () => {
  const module = fakeWasmModule();
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });
  module.HolosphereEngine.prototype.setDisplayCaps = () => false;
  const control = app.guis[0].controllers.find((c) => c.property === 'topCap');
  assert.throws(() => control.setValue(2), /Engine rejected display cap settings/);
  assert.equal(control.getValue(), 0);
  assert.equal(app.driver.DISPLAY_NORTH_PHI, 0);
  assert.equal(app.driver.DISPLAY_SOUTH_PHI, Math.PI);
});


test('a workbench missing document controls preserves its URL across rendered and failed frames', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const failingFrames of [0, 1]) {
    const module = fakeWasmModule({failingFrames});
    let releases = 0;
    module.ChainSnapshotRestoreResult = ChainSnapshotRestoreResult;
    module.HolosphereEngine.prototype.getShaderChainBindings = () => ({
      isValid: () => true,
      getSnapshot: () => ({schemaVersion: 2, chain: [
        {instance: 'project', operator: 'project.stereographic.v2'},
        {instance: 'sample', operator: 'sample.grid.v3'},
        {instance: 'colorize', operator: 'colorize.generated-palette.v3'},
      ], parameters: [], animationsPaused: false}),
      restoreSnapshot: () => ChainSnapshotRestoreResult.APPLIED,
      delete: () => { releases++; },
    });
    const app = await bootedApp({
      daydreamMode: 'shader-workbench', search: '?effect=ShaderChain',
      loadModule: () => Promise.resolve(module),
    });
    t.mock.timers.tick(URL_FLUSH_DEBOUNCE_MS * 2);
    assert.deepEqual(app.urlWrites, []);
    captureConsole(() => app.driver.renderer.frame());
    t.mock.timers.tick(URL_FLUSH_DEBOUNCE_MS * 2);
    assert.deepEqual(app.urlWrites, []);
    assert.equal(app.teardown.disposed(), false);
    assert.ok(releases > 0);
  }
});

test('a refused effect reset preserves edits and a later reset restores defaults', async () => {
  const module = fakeWasmModule({ definitions: [
    { name: 'Speed', value: 0.2, min: 0, max: 1, animated: true },
  ] });
  const app = await bootedApp({ loadModule: async () => module });
  const panel = app.guis.at(-1);
  panel.ctrl('Speed').setValue(0.75);
  assert.deepEqual(module.params.at(-1), ['Speed', 0.75]);
  const setEffect = module.engine.setEffect;
  module.engine.setEffect = () => EffectSetResult.UNKNOWN_EFFECT;
  captureConsole(() => panel.ctrl('reset').getValue()());
  assert.equal(panel.destroyed, false);
  assert.equal(panel.ctrl('Speed').getValue(), 0.75);
  assert.equal(noticeText(app), 'Effect reset was rejected. The panel still shows the current values.');
  assert.equal(app.elements.get('apply-notice-body').hidden, false);

  module.engine.setEffect = setEffect;
  panel.ctrl('reset').getValue()();

  assert.equal(panel.destroyed, true);
  assert.equal(app.guis.at(-1).ctrl('Speed').getValue(), 0.2);
  assert.equal(noticeText(app), '');
  assert.equal(app.elements.get('apply-notice-body').hidden, true);
});

test('the preset selector preserves state on refusal and pauses an accepted preset', async () => {
  const module = fakeWasmModule();
  module.HolosphereEngine.prototype.getPresetCount = () => 2;
  const app = await bootedApp({ loadModule: async () => module });
  const panel = app.guis.at(-1);
  const selectPreset = module.engine.selectPreset;
  module.engine.selectPreset = () => false;
  panel.ctrl('presetIndex').setValue(1);
  assert.equal(module.engine.getPresetIndex(), 0);
  assert.equal(panel.ctrl('presetIndex').getValue(), 0);
  assert.equal(module.engine.getAnimationsPaused(), false);
  assert.equal(panel.ctrl('pause').getValue(), false);

  module.engine.selectPreset = selectPreset;
  panel.ctrl('presetIndex').setValue(1);

  assert.equal(module.engine.getPresetIndex(), 1);
  assert.equal(module.engine.getAnimationsPaused(), true);
  assert.equal(panel.ctrl('pause').getValue(), true);
  assert.equal(noticeText(app), '');
});


test('a pooled effect switch sizes the preset row from the incoming effect', async (t) => {
  const presetCounts = { IslamicStars: 24, Fishbowl: 1, Comets: 12 };
  const module = fakeWasmModule();
  module.HolosphereEngine.prototype.setEffect = function (name) {
    this.effect = name;
    return EffectSetResult.INSTALLED;
  };
  module.HolosphereEngine.prototype.getPresetCount = function () {
    return presetCounts[this.effect] ?? 0;
  };
  t.mock.getter(SegmentController.prototype, 'ownsDisplay', () => true);
  t.mock.getter(SegmentController.prototype, 'active', () => true);
  t.mock.method(SegmentController.prototype, 'setEffect', function () {
    this.refreshPresetState();
  });
  const app = await bootedApp({ loadModule: async () => module });
  const presetChoices = () => {
    const control = app.guis.at(-1).ctrl('presetIndex');
    return control ? Object.keys(control.args[0]).length : 0;
  };
  for (const name of ['IslamicStars', 'Fishbowl', 'Comets', 'IslamicStars']) {
    app.elements.get('effect-sidebar').querySelectorAll('[data-effect]')
      .find((entry) => entry.dataset.effect === name).onclick();
    assert.equal(presetChoices(), presetCounts[name], name);
  }
});


test('segmented slider and pool follow viewport layout changes and release the listener', async (t) => {
  const gui = fakeGui('view');
  let changed;
  let removed;
  const query = {
    matches: false,
    addEventListener(type, handler) { changed = handler; },
    removeEventListener(type, handler) { removed = handler; },
  };
  const created = [];
  const segments = { active: false, count: 8, showBoundaries: false,
    create(count) { this.count = count; created.push(count); }, destroy() {} };
  t.mock.method(pageWarmer, 'warm', async () => {});
  const spawn = createSegmentedPovControls({ gui, segments, nav: { hardwareConcurrency: 8 },
    win: { matchMedia: () => query }, showNotice() {} });
  const controls = gui.folders[0].controllers;
  const count = controls.find(control => control.property === 'segments');
  assert.equal(count.args[1], 8);
  assert.equal(count.label, 'Segments (6 = sim only)');
  query.matches = true;
  changed();
  assert.equal(count.args[1], 4);
  assert.equal(count.label, 'Segments (max 4 here)');
  assert.equal(count.object.segments, 4);
  segments.active = true;
  await spawn.respawn();
  assert.deepEqual(created, [4]);
  query.matches = false;
  changed();
  assert.equal(count.args[1], 8);
  assert.equal(count.label, 'Segments (6 = sim only)');
  spawn.dispose();
  assert.equal(removed, changed);
});
