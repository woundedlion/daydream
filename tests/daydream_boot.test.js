//
// daydream.js is the app's composition root. tests/daydream_start.test.js drives
// start(deps) up to the point the WASM load is kicked off, and
// tests/app_lifecycle.test.js drives the factories it composes. What is left
// here is the half of the boot that only runs once a module lands — the engine
// the load builds, the initial apply, the recorder the controls are handed, the
// resolution dropdown narrowed to what the engine reports, and the release paths
// a discard racing that startup takes — plus the two control blocks start()
// lifts out, driven through their factories. Each case asserts on what the page
// ends up showing or holding, so it survives a re-shaping of start() and reds a
// wrong one.
//
// Four cases below still read the source, because nothing a started app or an
// injected factory exposes can see what they pin: the module-evaluation version
// guard, which runs before there is an app; the owner tag the root hands the
// segmented controls, which only a real worker pool could raise a notice
// through; and the two halves of the workbench init rejection, whose controller
// the fake document carries none of the element ids for. Each is anchored on the
// call site rather than the factory definition above it, and each says which
// failure it stands in for.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeElement, restoreDocumentAfterEach } from './fake_dom.js';
import { URL_FLUSH_DEBOUNCE_MS } from '../state.js';
import {
  EffectSetResult, ParamSetResult, ResolutionSetResult,
} from './fake_engine.js';
import { captureConsole, installConsoleCapture } from './fake_console.js';
import {
  createRecordingControls,
  createSegmentedPovControls,
} from '../daydream.js';
import {
  createSegmentPoolSpawner,
  fakeGui,
  startApp as startUntrackedApp,
  segmentCountControl,
  SHADER_DOCUMENT_EFFECTS,
} from './fake_app.js';

restoreDocumentAfterEach();
const startedApps = [];
afterEach(() => {
  while (startedApps.length > 0) {
    const app = startedApps.pop();
    app.teardown.dispose();
    app.restore();
  }
});

/** Starts an app registered for per-case cleanup. @returns {Object} The app fakes. */
function startApp(options) {
  const app = startUntrackedApp(options);
  startedApps.push(app);
  return app;
}

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
  readFileSync(new URL('../daydream.js', import.meta.url), 'utf8'));

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

test('the shader-document roster names exactly the documents that ship', () => {
  const manifest = JSON.parse(readFileSync(
    new URL('../shader/patterns/shaderball_migration.json', import.meta.url),
    'utf8'));

  assert.deepEqual([...SHADER_DOCUMENT_EFFECTS].sort(),
    Object.keys(manifest.source_documents).sort(),
    'the workbench offers exactly the source_documents the manifest lists, '
    + 'while this roster is what routes ?effect=<id> to the workbench page and '
    + 'what the URL validator admits: a document in one and not the other '
    + 'ships with a deep link that silently falls back to the default effect');
});

/**
 * Slices from `at` to the first `sentinel` after it, asserting the sentinel is
 * present so a drifted terminator fails instead of widening the window.
 * @param {number} at - Start index.
 * @param {string} sentinel - Terminator text, excluded from the slice.
 * @returns {string} The block text.
 */
function sliceTo(at, sentinel) {
  const end = SOURCE.indexOf(sentinel, at);
  assert.ok(end > at, `daydream.js: no ${JSON.stringify(sentinel)} after index ${at}`);
  return SOURCE.slice(at, end);
}

/**
 * A module the composition root can boot all the way through: enough engine
 * surface for the initial resolution apply, the effect panel and one rendered
 * frame, with the contract-pinned enums so identity comparison behaves as it
 * does against embind. The counters are what a case reads the constructions,
 * handle releases, Pole LOD replays and parameter writes off.
 * @param {{resolutions?: Array<Array<number>>, definitions?: Array<Object>,
 *   refusedWidth?: ?number, failingFrames?: number}} [options] - The resolutions
 *   the engine reports it can build, the parameter definitions the effect panel
 *   is built from, a width setResolution rejects, and a count of leading
 *   drawFrame calls that throw.
 * @returns {Object} The module double.
 */
function fakeWasmModule({
  resolutions = [[288, 144], [96, 20]],
  definitions = [],
  refusedWidth = null,
  failingFrames = 0,
} = {}) {
  let framesToFail = failingFrames;
  const pixels = new Uint16Array(288 * 144 * 3);
  let built = 0;
  let deleted = 0;
  const poleLod = [];
  const params = [];
  return {
    HS_MODULE_DEAD: false,
    EffectSetResult,
    ParamSetResult,
    ResolutionSetResult,
    engines: () => built,
    deletes: () => deleted,
    poleLod,
    params,
    HolosphereEngine: class {
      constructor() { built++; }
      static isLive() { return false; }
      static getSupportedResolutions() { return resolutions; }
      setResolution(w) {
        return w === refusedWidth
          ? ResolutionSetResult.UNSUPPORTED : ResolutionSetResult.RESIZED;
      }
      setEffect() { return EffectSetResult.INSTALLED; }
      setParameter(name, value) {
        params.push([name, value]);
        return ParamSetResult.APPLIED;
      }
      setPoleLod(v) { poleLod.push(v); }
      setAnimationsPaused() {}
      getAnimationsPaused() { return false; }
      getPresetCount() { return 0; }
      getPresetIndex() { return 0; }
      getParameterDefinitions() { return definitions.map((d) => ({ ...d })); }
      getParamValues() { return new Float32Array(0); }
      getParamGeneration() { return 1; }
      getEffectSizes() { return {}; }
      getEffectPresetCounts() { return {}; }
      getArenaMetrics() { return {}; }
      strobeColumns() { return false; }
      drawFrame() {
        if (framesToFail > 0) {
          framesToFail -= 1;
          throw new Error('engine drawFrame failed');
        }
      }
      getPixels() { return pixels; }
      getBufferLength() { return pixels.length; }
      delete() { deleted++; }
    },
  };
}

/** @returns {string} The text the shared notice element is showing. */
function noticeText(app) {
  return app.elements.get('apply-notice-text').textContent;
}

/** @returns {Array<string>} The effects the sidebar is offering. */
function offeredEffects(app) {
  return app.elements.get('effect-sidebar')
    .querySelectorAll('[data-effect]').map((option) => option.dataset.effect);
}

/** @returns {Object} The live resolution dropdown on the global GUI root. */
function resolutionControl(app) {
  return app.guis[0].controllers.find((c) => c.property === 'resolution');
}

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
    await new Promise((resolve) => setTimeout(resolve, 0));
    return app;
  } finally {
    capture.restore();
  }
}

/** Waits out one URL-flush debounce window. @returns {Promise<void>} */
const settleUrl = () =>
  new Promise((resolve) => setTimeout(resolve, URL_FLUSH_DEBOUNCE_MS * 2));

test('the migrated ShaderBall URL is written only once a frame has applied it', async () => {
  const app = await bootedApp({
    daydreamMode: 'shader-workbench',
    search: '?effect=ShaderBall',
    loadModule: () => Promise.resolve(fakeWasmModule()),
  });
  const notice = app.elements.get('apply-notice-text');
  await settleUrl();

  assert.equal(app.teardown.disposed(), false, 'the module must have booted');
  assert.deepEqual(app.urlWrites, [],
    'the suspension brackets the whole migration: until the engine has the new '
    + 'effect, a URL advertising it is a link that reopens on something the app '
    + 'never applied');
  assert.equal(notice.textContent, '',
    'the notice reports a migration that has happened, not one that is pending');

  app.driver.renderer.frame();
  await settleUrl();

  assert.equal(app.urlWrites.length, 1,
    'the release sits in the adapter frame callback, which is what makes the '
    + 'migrated effect reach the URL at all; released from anywhere a run can '
    + 'skip -- a pool composite, say -- the suspension never lifts and every '
    + 'later deep-link write is stranded for the session');
  assert.match(app.urlWrites[0], /[?&]effect=Shader(&|$)/,
    'the live identity is what a shared link must carry');
  assert.equal(notice.textContent, 'ShaderBall is now Shader; opened with defaults.',
    'the rename is only discoverable through the notice the release raises');
});

test('a first frame that throws still releases the migrated URL', async () => {
  const app = await bootedApp({
    daydreamMode: 'shader-workbench',
    search: '?effect=ShaderBall',
    loadModule: () => Promise.resolve(fakeWasmModule({ failingFrames: 1 })),
  });
  await settleUrl();
  assert.deepEqual(app.urlWrites, [], 'the migration is suspended until a frame');

  // The frame guard catches and keeps the loop armed, so nothing else ever
  // revisits the suspension.
  captureConsole(() => app.driver.renderer.frame());
  await settleUrl();

  assert.equal(app.urlWrites.length, 1,
    'a frame that throws must not strand the suspension: every later deep-link '
    + 'write is held for the session behind it');
  assert.match(app.urlWrites[0], /[?&]effect=Shader(&|$)/);
});


/**
 * A MediaRecorder stand-in as VideoRecorder presents one: a toggle that flips
 * the session, the settings the controls push, and the two hooks they wire.
 * @param {?string} [refusedAs] - Container extension the browser substitutes,
 *   reported through onFormatFallback from inside the start toggle.
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
      if (this.isRecording && refusedAs) this.onFormatFallback(refusedAs);
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
  const driver = { frameInterval: 62.5, labelAxes, recorder: null };
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

test('the record toggle announces the session and the container it settled on', () => {
  const rig = recordingRig({ labelAxes: true });
  assert.equal(rig.button.enabled, false,
    'there is no recorder to start until the module load builds one');
  rig.settings.recFormat = 'MP4';

  const recorder = rig.attach(fakeRecorder('webm'));

  assert.equal(rig.button.enabled, true);
  assert.equal(recorder.frameInterval, 62.5,
    'the recorder locks its capture rate to the driver frame interval');
  assert.equal(recorder.format, 'mp4',
    'a format chosen before the load must replay into the recorder it built');
  assert.equal(rig.driver.recorder, recorder,
    'the driver captures through the recorder, so it must be handed it');

  rig.button.object.record();

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

  rig.controls.removeOverlay();
  assert.equal(rig.canvasEl.children.length, 0,
    'the overlay belongs to the controls, so the page teardown drops it');
});

test('a recorder fault reports its reason and stops offering to stop', () => {
  const rig = recordingRig();
  const recorder = rig.attach(fakeRecorder());

  recorder.onError(new Error('the encoder died'));
  assert.match(rig.notices.at(-1), /^Recording failed to start: .*the encoder died/,
    'the hook also fires for a start that never produced a session, where '
    + '"Recording stopped" names something that never happened');

  rig.button.object.record();
  recorder.onError(new Error('the encoder died'));

  assert.match(rig.notices.at(-1), /^Recording stopped: .*the encoder died/);
  assert.equal(rig.canvasEl.classList.contains('recording'), false,
    'the session is already gone: the button must stop offering to stop it');
  assert.equal(rig.button.label, '\u25cf Record');
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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

test('the page-failure surface is the shared one, and it is torn down', () => {
  const { teardown, listeners, win } = startApp();
  const failureListeners = () => listeners.filter(
    ([type]) => type === 'error' || type === 'unhandledrejection');

  assert.deepEqual(failureListeners().map(([type]) => type),
    ['error', 'unhandledrejection'],
    'a synchronous throw from an animation frame, a lil-gui onChange, or a DOM '
    + 'listener is console-only without the error listener the shared surface '
    + 'installs alongside the rejection one');

  const [, onError] = failureListeners()[0];
  const { messages } = captureConsole(
    () => onError({ target: win, error: new Error('boom') }));
  assert.match(messages.join('\n'), /simulator error:.*boom/,
    'the surface must be raised under the page label, or a report from the '
    + 'simulator is indistinguishable from one from a tool page');

  teardown.dispose();
  assert.deepEqual(failureListeners(), [],
    'a listener that outlives the page discard reports into a dead app');
});

test('the composition root rejects a stale segmented-controller module', () => {
  assert.match(SOURCE,
    /SEGMENT_CONTROLLER_API_VERSION !== EXPECTED_SEGMENT_CONTROLLER_API_VERSION/,
    'a controller from a different API generation must fail at module '
    + 'evaluation, before there is an app for a case to drive');
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

test('a segmented-POV failure is announced and returns the toggle', async () => {
  const gui = fakeGui('view');
  const notices = [];
  let refusals = 1;
  const segments = {
    active: false,
    count: 2,
    showBoundaries: false,
    destroy() {
      // A pool that refuses once: the fallback tears down again on its way
      // through, and a second throw would escape it rather than be reported.
      if (refusals-- > 0) throw new Error('a worker would not stop');
    },
    updateStats() {},
  };
  createSegmentedPovControls({
    gui,
    segments,
    nav: { hardwareConcurrency: 8 },
    driver: { isMobile: false },
    showNotice: (message) => notices.push(message),
  });
  const enabled = gui.folders.find((f) => f.namespace === 'Segmented POV')
    .controllers.find((c) => c.property === 'segmented');

  // The handler as lil-gui fires it, leaving `value` untouched until the
  // fallback writes it back.
  let settled;
  captureConsole(() => { settled = enabled.changed(false); });
  await settled;

  assert.match(notices.at(-1), /Segmented POV teardown failed:.*would not stop/,
    'a console-only failure is invisible: the user sees the toggle flip back '
    + 'and cannot tell it from a mis-click, and the fault banner covers only '
    + 'latched runtime faults');
  assert.equal(enabled.value, false,
    'setValue (not updateDisplay) is what makes the deep-link writer drop '
    + 'segmented=true from the URL');
});

test('the segmented controls report under the switch owner tag', () => {
  // The call site, not the definition above it: the owner tag is the root's.
  const at = SOURCE.lastIndexOf('createSegmentedPovControls(');
  assert.ok(at >= 0, 'the segmented controls must stay wired to their factory');
  assert.match(sliceTo(at, '\n  });'),
    /showNotice:\s*\(message\)\s*=>\s*applyNotice\.show\(message, SWITCH_NOTICE\)/,
    'the owner tag is what keeps a parameter write from clearing the fallback '
    + 'notice, and only a real worker pool could raise one through a booted '
    + 'app, so the fakes cannot reach this');
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

  recorder.toggle = () => { recorder.onFormatFallback('webm'); return true; };
  captureConsole(() => record.object.record());
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

test('the segmented POV deep-link keys keep the names shared links carry', () => {
  const consequence = 'a deep link carries view.Segmented POV.<prop>, built from '
    + "the root namespace, the folder's display name and the bound property: "
    + 'changing any of the three silently invalidates every link already shared';
  const { guis } = startApp();

  assert.equal(guis[0].namespace, 'view', consequence);
  const segFolder = guis[0].folders.find((folder) => folder.namespace === 'Segmented POV');
  assert.ok(segFolder, consequence);
  for (const prop of ['segmented', 'segments']) {
    const control = segFolder.controllers.find((c) => c.property === prop);
    assert.ok(control, `${consequence}; '${prop}' must stay bound`);
    assert.equal(control.session, undefined,
      `${consequence}; '${prop}' must also stay deep-linked (add, not addSession)`);
  }
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
  assert.deepEqual(tight.args, [2, 2, 2],
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
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    capture.restore();
  }

  assert.deepEqual(module.poleLod, [1.5],
    'the Pole LOD onChange runs while host.engine is null, so the block that '
    + 'builds the engine must replay the binding; without it a ?view.poleLod '
    + 'deep link shows in the GUI but never reaches the engine');
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

// Both lil-gui options() behaviours, which tests/lil_gui_contract.test.js pins
// against the real widget: the narrowing runs on every boot, so the dropdown
// the page is left with has to still drive a switch under either.
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
  });
}

test('a trapped resolution query stops the startup instead of booting on', async () => {
  let built = 0;
  const module = {
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

test('a workbench init that trapped the module releases the app', () => {
  const at = SOURCE.indexOf('shaderDocuments?.init().catch(');
  assert.ok(at >= 0, 'the workbench init rejection must stay handled');
  assert.match(sliceTo(at, 'CONFIG_NOTICE);'), /abandonOnModuleDeath\(\)/,
    'a trap is terminal for the whole module, not for the call that tripped it: '
    + 'without the death read the rejection is reported as an ordinary workbench '
    + 'failure and the simulator keeps calling into a shortened shadow stack');
});

test('a failed workbench init reports without the page-failure banner', () => {
  const at = SOURCE.indexOf('shaderDocuments?.init().catch(');
  assert.ok(at >= 0,
    'init() is async and the surrounding catch only sees a synchronous throw, '
    + 'so a dropped rejection reaches the page-failure listener and covers a '
    + 'running simulator with the fatal banner');
  assert.match(sliceTo(at, 'CONFIG_NOTICE);'),
    /workbench could not be initialized: \$\{[^}]+\}`,\s*$/,
    'the workbench half must report through the shader config notice, the '
    + 'owner tag its other messages carry');
});
