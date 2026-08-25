//
// daydream.js is the app's composition root. Its assembly is executed in
// tests/daydream_start.test.js, which drives start(deps) against fakes, and the
// factories it composes are driven in tests/app_lifecycle.test.js — the Pole LOD
// late-bind, the keydown guard, the module-load handlers, the teardown order.
// What is left here is which closure the root hands each factory: a value only a
// source read can see, so those cases read it, and each names the failure it
// prevents. The engine-death and segmented-POV blocks below are driven instead:
// a started app reaches the latch, the teardown and the switch coordinator
// through their effects, which is what a source read was standing in for.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeElement, restoreDocumentAfterEach } from './fake_dom.js';
import { URL_FLUSH_DEBOUNCE_MS } from '../state.js';
import { EffectSetResult, ResolutionSetResult } from './fake_engine.js';
import { captureConsole, installConsoleCapture } from './fake_console.js';
import { createRecordingControls } from '../daydream.js';
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

test('catalog effects are offered at both simulator resolutions', () => {
  for (const effect of ['AshCloud', 'HyperLattice']) {
    for (const roster of ['HiResFavorites', 'LoResFavorites']) {
      const at = SOURCE.indexOf(`const ${roster} = [`);
      assert.ok(at >= 0, `daydream.js must still define ${roster}`);
      assert.match(sliceTo(at, '\n];'), new RegExp(`"${effect}"`),
        `${roster} must offer ${effect}`);
    }
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
 * Extracts the text between a call's parentheses, skipping parens that sit
 * inside strings or template literals.
 * @param {string} src - Comment-blanked source text.
 * @param {number} open - Index of the opening '('.
 * @returns {string} The argument-list text.
 */
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  assert.fail(`daydream.js: unbalanced parentheses from index ${open}`);
}

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

const WASM_INIT = 'createModuleLoadHandlers(';

/**
 * The dependency block wiring the WASM module promise, including the startup
 * handler that builds the engine.
 * @returns {string} The argument source.
 */
function wasmReadyBlock() {
  const at = SOURCE.indexOf(WASM_INIT);
  assert.ok(at >= 0, `daydream.js must still wire the engine load through ${WASM_INIT}`);
  return balanced(SOURCE, at + WASM_INIT.length - 1);
}

/**
 * A WASM module carrying only what the composition root touches before its
 * first apply: the engine constructor, its two statics, and the Pole LOD write
 * the load replays. The initial resolution apply then finds no setResolution
 * and is refused, which disposes the app it had already moved — so a case sees
 * a root that built its engine and then released everything it owned.
 * @returns {Object} The module, with engines() counting the constructions.
 */
function fakeWasmModule() {
  let built = 0;
  return {
    HS_MODULE_DEAD: false,
    engines: () => built,
    HolosphereEngine: class {
      constructor() { built++; }
      static isLive() { return false; }
      static getSupportedResolutions() { return [[96, 20]]; }
      setPoleLod() {}
      delete() {}
    },
  };
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

/**
 * A module the composition root can boot all the way through: enough engine
 * surface for the initial resolution apply, the effect panel and one rendered
 * frame, with the contract-pinned enums so identity comparison behaves as it
 * does against embind.
 * @returns {Object} The module.
 */
function bootableWasmModule() {
  const pixels = new Uint16Array(288 * 144 * 3);
  return {
    HS_MODULE_DEAD: false,
    EffectSetResult,
    ResolutionSetResult,
    HolosphereEngine: class {
      static isLive() { return false; }
      static getSupportedResolutions() { return [[288, 144], [96, 20]]; }
      setResolution() { return ResolutionSetResult.RESIZED; }
      setEffect() { return EffectSetResult.INSTALLED; }
      setPoleLod() {}
      setAnimationsPaused() {}
      getAnimationsPaused() { return false; }
      getPresetCount() { return 0; }
      getPresetIndex() { return 0; }
      getParameterDefinitions() { return []; }
      getParamValues() { return new Float32Array(0); }
      getParamGeneration() { return 1; }
      getEffectSizes() { return {}; }
      getEffectPresetCounts() { return {}; }
      getArenaMetrics() { return {}; }
      strobeColumns() { return false; }
      drawFrame() {}
      getPixels() { return pixels; }
      getBufferLength() { return pixels.length; }
      delete() {}
    },
  };
}

/** Waits out one URL-flush debounce window. @returns {Promise<void>} */
const settleUrl = () =>
  new Promise((resolve) => setTimeout(resolve, URL_FLUSH_DEBOUNCE_MS * 2));

test('the migrated ShaderBall URL is written only once a frame has applied it', async () => {
  const app = await bootedApp({
    daydreamMode: 'shader-workbench',
    search: '?effect=ShaderBall',
    loadModule: () => Promise.resolve(bootableWasmModule()),
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
  const module = fakeWasmModule();
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
  assert.match(SOURCE, /SEGMENT_CONTROLLER_API_VERSION/,
    'a fresh daydream.js must require a named export absent from stale cached controllers');
  assert.match(SOURCE,
    /SEGMENT_CONTROLLER_API_VERSION !== EXPECTED_SEGMENT_CONTROLLER_API_VERSION/,
    'a controller from a different API generation must fail inside bootstrap');
});

test('the param writer and the switch coordinator own the notice separately', () => {
  const consequence = 'both announce through the one notice element, so each '
    + 'must tag its writes with an owner of its own; sharing a tag lets a slider '
    + 'nudge clear a switch rejection';
  assert.match(SOURCE, /applyNotice\.show\(message, PARAM_NOTICE\)/, consequence);
  assert.match(SOURCE, /applyNotice\.show\(null, PARAM_NOTICE\)/, consequence);
  assert.match(SOURCE, /showNotice:\s*\(message\)\s*=>\s*applyNotice\.show\(message, SWITCH_NOTICE\)/,
    consequence);
  assert.notEqual(
    SOURCE.match(/PARAM_NOTICE = '([^']*)'/)?.[1],
    SOURCE.match(/SWITCH_NOTICE = '([^']*)'/)?.[1],
    'the two owner tags must differ',
  );
});

test('a segmented-POV spawn failure is announced, not only logged', () => {
  // The call site, not the definition above it: the owner tag is the root's.
  const wired = SOURCE.lastIndexOf('createSegmentedPovControls(');
  assert.ok(wired >= 0, 'the segmented controls must stay wired to their factory');
  const at = SOURCE.indexOf('createSegmentedFallback(');
  assert.ok(at >= 0, 'the segmented fallback must stay wired to its factory');
  const args = balanced(SOURCE, SOURCE.indexOf('(', at));
  assert.match(args, /showNotice,/, 'the fallback must reach the notice sink');
  assert.match(balanced(SOURCE, SOURCE.indexOf('(', wired)),
    /showNotice:\s*\(message\)\s*=>\s*applyNotice\.show\(message, SWITCH_NOTICE\)/,
    'a console-only failure is invisible: the user sees the toggle flip back '
    + 'and cannot tell it from a mis-click, the fault banner covers only latched '
    + 'runtime faults, and the switch owner tag is what keeps a parameter write '
    + 'from clearing the notice');
  assert.match(args, /showToggle:\s*\(on\)\s*=>\s*segEnabledCtrl\.setValue\(on\)/,
    'setValue (not updateDisplay) is what makes the deep-link writer drop '
    + 'segmented=true from the URL');
});

test('a recording start or stop is announced, not only styled', () => {
  const at = SOURCE.indexOf('const recordState = {');
  assert.ok(at >= 0, 'the record toggle must stay a named binding');
  const body = sliceTo(at, '\n  }};');
  assert.match(body, /showNotice\(/,
    'the canvas tint, the duration readout, and the button label are all '
    + 'visual: without a notice a screen-reader user gets no report that the '
    + 'session started or ended');
  assert.match(
    balanced(SOURCE, SOURCE.indexOf('(', SOURCE.lastIndexOf('createRecordingControls('))),
    /showNotice:\s*\(message\)\s*=>\s*applyNotice\.show\(message, RECORD_NOTICE\)/,
    'the owner tag belongs to the root: sharing one with the param writer '
    + 'lets a slider nudge clear a recording report');
  assert.match(body, /Recording started\./);
  assert.match(body, /Recording stopped\./);
  assert.match(body, /!wasRecording && !isRecording/,
    'a start that never began a session has already reported why through '
    + 'onError, and the generic stop message carries the same owner tag, so '
    + 'writing it here replaces the only explanation the user was given with '
    + 'one that is also untrue');
});

test('a refused recording container is announced, not silently substituted', () => {
  const at = SOURCE.indexOf('recorder.onFormatFallback =');
  assert.ok(at >= 0, 'the format-fallback hook must stay wired');
  const body = sliceTo(at, '\n      };');
  assert.doesNotMatch(body, /setValue/,
    'rewriting the Rec Format dropdown fires its onChange, which overwrites '
    + "the user's chosen container for the rest of the session");
  assert.match(body, /formatFallback =/,
    'the hook fires inside toggle(), whose caller raises the record notice '
    + 'under the same owner tag: a notice written here would be replaced');
  const record = sliceTo(SOURCE.indexOf('const recordState = {'), '\n  }};');
  assert.match(record, /formatFallback = ''/,
    'a stale detail would be appended to a later session that encoded fine');
  assert.match(record, /\$\{formatFallback\}/,
    'without this the fallback reaches the user as nothing at all: on Firefox '
    + 'an MP4 request records WebM with no report');
});

test('a recorder fault reports its reason, not just an un-tinted canvas', () => {
  const at = SOURCE.indexOf('recorder.onError =');
  assert.ok(at >= 0, 'the recorder fault hook must stay wired');
  const body = sliceTo(at, '\n      };');
  assert.match(body, /\(err\)/,
    'the hook is handed the reason; dropping the parameter throws it away');
  assert.match(body, /showNotice\(/,
    'an encoder fault, a failed start, and a cancelled Save dialog all reach '
    + 'the user as the Record button flicking back, which reads as a mis-click '
    + 'unless the reason is announced');
  assert.match(body, /showRecording\(false\)/,
    'the session is already gone: the button must stop offering to stop it');
  assert.match(body, /failed to start/,
    'the hook also fires for a start that never produced a session, where '
    + '"Recording stopped" names something that never happened');
});

test('the discard path frees an engine built after disposal', () => {
  const body = wasmReadyBlock();
  assert.match(body, /discardStartup:/,
    'a startup that loses the disposal race owns everything it built; dispose() '
    + 'has already run and will not revisit it');
  assert.match(body, /host\.dispose\(\)/,
    'a WASM engine handle must be deleted, not merely dropped, and the release '
    + 'that deletes it is EngineHost.dispose() — the same one the page teardown '
    + 'runs, so the two paths cannot drift');
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
test('the late-bound engine controls are re-applied once the engine exists', () => {
  assert.match(wasmReadyBlock(), /poleLod\.replay\(\)/,
    'the Pole LOD onChange runs while host.engine is null, so the block that '
    + 'builds the engine must replay the binding; without it a ?view.poleLod '
    + 'deep link shows in the GUI but never reaches the engine');
});

test('narrowing the resolution options rebinds the controller and its handler', () => {
  const consequence = "lil-gui's base Controller.options() destroys the receiver "
    + 'and returns a replacement that carries the name but no onChange (only an '
    + 'OptionController updates itself in place); syncResolutionOptions runs on '
    + 'every boot, so a discarded return value would leave the live dropdown '
    + 'writing to nothing and setValue() updating a detached <select>';
  assert.match(SOURCE, /let resolutionController/, consequence);
  assert.match(SOURCE, /resolutionController = resolutionController\.options\([^)]*\)\s*\.onChange\(setResolution\)/,
    consequence);
  assert.match(SOURCE, /const setResolution = \(v\) => appState\.set\('resolution', v\)/,
    'the replacement must re-attach the same handler the original carried, or '
    + 'the dropdown and the muted engine correction diverge');
});

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
  assert.match(wasmReadyBlock(),
    /shaderDocuments\?\.init\(\)\s*\.catch\(/,
    'init() is async and the surrounding catch only sees a synchronous throw, '
    + 'so a dropped rejection reaches the page-failure listener and covers a '
    + 'running simulator with the fatal banner');
  assert.match(wasmReadyBlock(),
    /workbench could not be initialized: \$\{[^}]+\}`,\s*CONFIG_NOTICE/,
    'the workbench half must report through the shader config notice, the '
    + 'owner tag its other messages carry');
});
