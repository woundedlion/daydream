// daydream.js's composition root once its WASM module lands, plus the control
// blocks start() lifts out, driven through their factories.
//
// Notice owner names are checked against the composition source.
import { currentChainSnapshot } from './helpers/chain_snapshot.js';
import { canonicalEffectId, effectDisplayName } from '../src/effects/effect_identity.js';
import {
  DEFAULT_EFFECT, favoritesFor, resolutionPresets, SHADER_DOCUMENT_EFFECTS,
} from '../src/effects/effect_roster.js';
import { EFFECT_IDENTITIES } from '../generated/engine_contract.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeElement, restoreDocumentAfterEach } from './helpers/fake_dom.js';
import { getActiveURLSync, URL_FLUSH_DEBOUNCE_MS } from '../src/app/state.js';
import { pageWarmer } from '../src/segments/module_warmer.js';
import { SegmentController } from '../src/segments/segment_controller.js';
import {
  EffectSetResult, ParamSetResult, ResolutionSetResult, ChainSnapshotRestoreResult, unpinnedEngineMethods,
} from './helpers/fake_engine.js';
import { captureConsole, installConsoleCapture } from './helpers/fake_console.js';

import { FPS } from '../src/renderer/frame_constants.js';

import { fakeWasmModule, noticeText, trackedStartApp, segmentCountControl } from './helpers/fake_app.js';


restoreDocumentAfterEach();
const startApp = trackedStartApp();

// The two simulator presets, as the driver is told to size itself to them.
const PHANTASM = [288, 144, 0.25];
const HOLOSPHERE = [96, 20, 2];

const HIGH_RES = 'Phantasm (288x144)';
const offeredIds = (resolution) => favoritesFor(resolution).map(canonicalEffectId);
// An effect the high-res sidebar offers that is not a shader document, with a
// display name distinct from its canonical id.
const SIMULATOR_EFFECT = EFFECT_IDENTITIES.find(({ id, display_name }) => id !== display_name
  && offeredIds(HIGH_RES).includes(id) && !SHADER_DOCUMENT_EFFECTS.includes(id));

test('the sidebar offers each resolution its declared effect list', async () => {
  const app = await bootedApp({
    loadModule: () => Promise.resolve(fakeWasmModule()),
  });
  const sorted = (ids) => [...ids].sort();
  assert.deepEqual(sorted(offeredEffects(app)), sorted(offeredIds(HIGH_RES)));
  for (const resolution of Object.keys(resolutionPresets)) {
    captureConsole(() => resolutionControl(app).setValue(resolution));
    assert.deepEqual(sorted(offeredEffects(app)), sorted(offeredIds(resolution)), resolution);
  }
});

test('the default effect starts at every resolution and explicit effects override it', async () => {
  for (const resolution of Object.keys(resolutionPresets)) {
    const explicit = favoritesFor(resolution).find((name) => name !== DEFAULT_EFFECT
      && !SHADER_DOCUMENT_EFFECTS.includes(canonicalEffectId(name)));
    assert.ok(explicit, resolution);
    for (const effect of [null, explicit]) {
      const module = fakeWasmModule();
      const installed = [];
      module.HolosphereEngine.prototype.setEffect = (name) => {
        installed.push(name);
        return EffectSetResult.INSTALLED;
      };
      const query = new URLSearchParams();
      if (resolution !== HIGH_RES) query.set('resolution', resolution);
      if (effect) query.set('effect', effect);
      const app = await bootedApp({ search: query.size ? `?${query}` : '',
        loadModule: async () => module });
      assert.equal(installed.at(-1), canonicalEffectId(effect ?? DEFAULT_EFFECT));
      assert.deepEqual(app.replaced, []);
    }
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

test('the View pause control holds rendering and clears queued steps on resume', async () => {
  const app = await bootedApp({ loadModule: async () => fakeWasmModule() });
  const pause = app.guis[0].controllers.find((control) => control.property === 'paused');
  assert.ok(pause);
  pause.setValue(true);
  assert.equal(app.driver.paused, true);
  app.driver.stepFrames = 2;
  pause.setValue(false);
  assert.equal(app.driver.paused, false);
  assert.equal(app.driver.stepFrames, 0);
});

test('the effect pause toggle writes both the main engine and segment controller', async (t) => {
  const module = fakeWasmModule({definitions: [
    {name: 'Speed', value: 0.2, min: 0, max: 1, animated: true},
  ]});
  const enginePauses = [];
  const poolPauses = [];
  const setPaused = module.HolosphereEngine.prototype.setAnimationsPaused;
  t.mock.method(module.HolosphereEngine.prototype, 'setAnimationsPaused', function (paused) {
    enginePauses.push(paused);
    return setPaused.call(this, paused);
  });
  t.mock.method(SegmentController.prototype, 'setAnimationsPaused', (paused) => poolPauses.push(paused));
  const app = await bootedApp({loadModule: async () => module});
  enginePauses.length = 0;
  poolPauses.length = 0;
  const pause = app.guis.at(-1).ctrl('pause');
  pause.setValue(true);
  pause.setValue(false);
  assert.deepEqual(enginePauses, [true, false]);
  assert.deepEqual(poolPauses, [true, false]);
  assert.equal(module.engine.getAnimationsPaused(), false);
});

test('a booted recorder captures at the driver frame rate', async () => {
  const app = startApp({ loadModule: async () => fakeWasmModule() });
  app.driver.frameInterval = 1 / 24;
  await app.teardown.ready;
  const { recorder } = app.driver;
  assert.ok(recorder, 'the module load did not hand the driver a recorder');
  assert.equal(recorder.frameInterval, app.driver.frameInterval);
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

test('an effect switch preserves view deep-link parameters', async (t) => {
  const app = await bootedApp({ search: '?view.poleLod=1.5&fx.stale=2',
    loadModule: async () => fakeWasmModule(),
  });
  t.mock.timers.enable({apis: ['setTimeout']});
  const option = app.elements.get('effect-sidebar').querySelectorAll('[data-effect]')
    .find((entry) => entry.dataset.effect === canonicalEffectId('Raymarch'));
  assert.ok(option);
  assert.ok(app.guis[0].collectUrlKeys().includes('view.poleLod'), app.guis[0].collectUrlKeys().join(', '));
  option.onclick();
  t.mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
  const query = new URL(app.urlWrites.at(-1), 'https://example.test').searchParams;
  assert.equal(query.get('view.poleLod'), '1.5', app.urlWrites.join('\n'));
  assert.equal(query.has('fx.stale'), false);
});

for (const change of ['effect', 'resolution']) {
  test(`a ${change} switch keeps the column-layout URL consistent with the display`, async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    for (const strobe of [false, true]) {
      const module = fakeWasmModule();
      module.HolosphereEngine.prototype.strobeColumns = () => strobe;
      const app = await bootedApp({
        search: `?view.noBlackColumns=${strobe}`,
        hydratedView: {noBlackColumns: strobe},
        loadModule: async () => module,
      });
      assert.equal(app.driver.noBlackColumns, strobe);
      getActiveURLSync().schedule();
      t.mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
      const initial = new URL(app.urlWrites.at(-1), 'https://example.test').searchParams;
      assert.equal(initial.get('view.noBlackColumns'), String(strobe));
      if (change === 'effect') {
        app.elements.get('effect-sidebar').querySelectorAll('[data-effect]')
          .find((entry) => entry.dataset.effect === canonicalEffectId('Raymarch')).onclick();
      } else {
        resolutionControl(app).setValue('Holosphere (96x20)');
      }
      t.mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
      const query = new URL(app.urlWrites.at(-1), 'https://example.test').searchParams;
      if (change === 'effect') {
        assert.equal(app.driver.noBlackColumns, !strobe);
        assert.equal(query.has('view.noBlackColumns'), false);
      } else {
        assert.equal(app.driver.noBlackColumns, strobe);
        assert.equal(query.get('view.noBlackColumns'), String(strobe));
      }
    }
  });
}

test('the workbench restores a column override after its initial effect switch', async (t) => {
  const {default: createModule} = await import('../generated/holosphere_wasm.js');
  const module = await createModule({print: () => {}});
  const documentIds = ['shader-document-select', 'shader-preset-select', 'shader-document-open',
    'shader-document-save', 'shader-document-file', 'shader-document-status'];
  t.mock.method(globalThis, 'fetch', async (url) => ({ok: true, text: async () => readFileSync(url, 'utf8')}));
  const app = await bootedApp({daydreamMode: 'shader-workbench',
    search: '?effect=AlienBrain&view.noBlackColumns=true', hydratedView: {noBlackColumns: true},
    documentIds, loadModule: async () => module});
  for (let attempts = 0; attempts < 1000 && !app.elements.get('shader-document-status').textContent; attempts++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(app.elements.get('shader-document-status').textContent, /Alien Brain/);
  assert.equal(app.driver.noBlackColumns, true);
  getActiveURLSync().flush();
  assert.equal(new URL(app.urlWrites.at(-1), 'https://example.test').searchParams.get('view.noBlackColumns'), 'true');
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













test('a failed engine load disposes the app through the retained teardown', async () => {
  const app = await bootedApp({ loadModule: () => Promise.reject(new Error('no wasm')) });

  assert.equal(app.teardown.disposed(), true,
    'the load handlers must reach the teardown the root built after them, or a '
    + 'page with no engine keeps its listeners, its GUI and its driver');
  assert.deepEqual(app.listeners, [],
    'a listener that outlives the failed load reports into a dead app');
});

test('a WASM link failure reports a load failure and the stale module remedy', async () => {
  const capture = installConsoleCapture('error', 'warn', 'log');
  try {
    const app = startApp({
      loadModule: () => Promise.reject(new WebAssembly.RuntimeError('Aborted(LinkError: incompatible module)')),
    });
    await app.teardown.ready;
    const overlay = app.elements.get('loading-overlay');
    assert.equal(overlay.querySelector('.load-error-title').textContent,
      'Failed to load the rendering engine.');
    assert.match(overlay.querySelector('.load-error-remedy').textContent,
      /Reload re-fetches the whole module graph/);
  } finally {
    capture.restore();
  }
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

  assert.deepEqual(failureListeners().map(({ type }) => type).sort(),
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



test('the segmented controls have their own notice owner', async (t) => {
  const source = readFileSync(new URL('../src/app/daydream.js', import.meta.url), 'utf8');
  const owners = [...source.matchAll(/const \w+_NOTICE = '([^']+)'/g)].map((match) => match[1]);
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

  recorder.toggle = () => {
    recorder.onStarted();
    queueMicrotask(() => recorder.onFormatFallback('webm'));
    return true;
  };
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
  assert.match(noticeText(app), /Recording stopped/,
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

test('a refused startup releases the engine and recorder through teardown', async () => {
  const module = fakeWasmModule({ refusedWidth: 288 });
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });
  assert.equal(module.deletes(), 1);
  assert.equal(app.docListeners.some(({type}) => type === 'visibilitychange'), false);
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
      setTemporalSampling() {}
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

test('the same parameter rejection is re-announced once per pointer gesture', async (t) => {
  const module = fakeWasmModule({
    definitions: [{ name: 'Speed', value: 1, min: 0, max: 2 }],
  });
  const app = await bootedApp({ loadModule: () => Promise.resolve(module) });
  const speed = app.guis.at(-1).controllers.find((c) => c.property === 'Speed');
  t.mock.method(module.HolosphereEngine.prototype, 'setParameter', () => ParamSetResult.INADMISSIBLE);
  const begin = () => speed.domElement.dispatch('pointerdown', { isPrimary: true, button: 0, pointerId: 1 });
  const end = () => app.listeners.find(({type}) => type === 'pointerup')
    .handler({type: 'pointerup', pointerId: 1});
  const edit = (value) => captureConsole(() => speed.setValue(value));

  begin();
  edit(1.2);
  const first = noticeText(app);
  assert.match(first, /Speed.*was rejected/);
  edit(1.3);
  assert.equal(noticeText(app), first);
  end();

  begin();
  edit(1.4);
  const second = noticeText(app);
  assert.notEqual(second, first, 'a new gesture rewrites the notice so it is announced again');
  assert.match(second, /Speed.*was rejected/);
  edit(1.5);
  assert.equal(noticeText(app), second);
  end();
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

function capBootRig() {
  let resolve;
  const loading = new Promise((done) => { resolve = done; });
  const app = startApp({ loadModule: () => loading });
  app.guis[0].controllers.find((c) => c.property === 'topCap').setValue(2);
  app.guis[0].controllers.find((c) => c.property === 'bottomCap').setValue(3);
  const module = fakeWasmModule();
  module.ChainSnapshotRestoreResult = ChainSnapshotRestoreResult;
  return {app, module, async finish() { resolve(module); await app.teardown.ready; }};
}

async function pausedCapRig() {
  const rig = capBootRig();
  await rig.finish();
  const {app, module} = rig;
  app.driver.renderer.frame();
  app.driver.paused = true;
  let draws = 0;
  module.HolosphereEngine.prototype.drawFrame = () => { draws++; };
  app.guis[0].controllers.find(c => c.property === 'topCap').setValue(4);
  return {...rig, get draws() { return draws; }};
}

test('global cap edits made during module loading reach the first display', async () => {
  const rig = capBootRig();
  const {app, module} = rig;
  assert.equal(app.driver.dotMesh, null);
  await rig.finish();
  assert.deepEqual(module.caps, [[2, 3]]);
  assert.equal(app.teardown.disposed(), false);
  app.driver.renderer.frame();
  assert.ok(app.driver.dotMesh.instanceColor.array.length > 0);
  assert.equal(app.driver.DISPLAY_NORTH_PHI, 0.02 * Math.PI);
});

test('a global cap edit redraws paused geometry once', async () => {
  const rig = await pausedCapRig();
  const {app} = rig;
  assert.equal(rig.draws, 1);
  assert.equal(app.driver.DISPLAY_NORTH_PHI, 0.04 * Math.PI);
  assert.equal(app.driver.DISPLAY_SOUTH_PHI, 0.97 * Math.PI);
  assert.equal(app.driver.paused, true);
});

test('resolution switches preserve the current global caps and refresh the color buffer', async () => {
  const {app, module} = await pausedCapRig();
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
      getSnapshot: () => currentChainSnapshot(),
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
  assert.equal(panel.destroyed, 0);
  assert.equal(panel.ctrl('Speed').getValue(), 0.75);
  assert.match(noticeText(app), /Effect reset was rejected/);
  assert.equal(app.elements.get('apply-notice-body').hidden, false);

  module.engine.setEffect = setEffect;
  panel.ctrl('reset').getValue()();

  assert.equal(panel.destroyed, 1);
  assert.equal(app.guis.at(-1).ctrl('Speed').getValue(), 0.2);
  assert.equal(noticeText(app), '');
  assert.equal(app.elements.get('apply-notice-body').hidden, true);
});

async function presetBootRig() {
  const module = fakeWasmModule();
  module.HolosphereEngine.prototype.getPresetCount = () => 2;
  const app = await bootedApp({ loadModule: async () => module });
  const panel = app.guis.at(-1);
  return {app, module, panel};
}

test('the preset selector preserves state when a preset is refused', async () => {
  const {module, panel} = await presetBootRig();
  module.engine.selectPreset = () => false;
  panel.ctrl('presetIndex').setValue(1);
  assert.equal(module.engine.getPresetIndex(), 0);
  assert.equal(panel.ctrl('presetIndex').getValue(), 0);
  assert.equal(module.engine.getAnimationsPaused(), false);
  assert.equal(panel.ctrl('pause').getValue(), false);

});

test('the preset selector pauses an accepted preset', async () => {
  const {app, module, panel} = await presetBootRig();
  panel.ctrl('presetIndex').setValue(1);

  assert.equal(module.engine.getPresetIndex(), 1);
  assert.equal(module.engine.getAnimationsPaused(), true);
  assert.equal(panel.ctrl('pause').getValue(), true);
  assert.equal(noticeText(app), '');
});

test('the recorder watches visibility on the injected document until teardown', async () => {
  const decoy = fakeElement('document');
  const app = await bootedApp({ loadModule: async () => {
    globalThis.document = decoy;
    return fakeWasmModule();
  } });
  assert.equal(decoy.listeners.some(({ type }) => type === 'visibilitychange'), false);
  assert.equal(app.docListeners.some(({ type }) => type === 'visibilitychange'), true);

  app.teardown.dispose();
  assert.equal(app.docListeners.some(({ type }) => type === 'visibilitychange'), false,
    'the app teardown disposes the recorder');
});

async function pooledPresetRig(t) {
  const [many, single, some] = favoritesFor(HIGH_RES);
  const presetCounts = { [many]: 24, [single]: 1, [some]: 12 };
  const module = fakeWasmModule();
  module.HolosphereEngine.prototype.setEffect = function (name) {
    this.effect = name;
    return EffectSetResult.INSTALLED;
  };
  module.HolosphereEngine.prototype.getPresetCount = function () {
    return presetCounts[effectDisplayName(this.effect)] ?? 0;
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
  return {app, presetCounts, presetChoices, sequence: [many, single, some, many]};
}

test('a pooled effect switch sizes the preset row from the incoming effect', async (t) => {
  const {app, presetCounts, presetChoices, sequence} = await pooledPresetRig(t);
  for (const name of sequence) {
    app.elements.get('effect-sidebar').querySelectorAll('[data-effect]')
      .find((entry) => entry.dataset.effect === canonicalEffectId(name)).onclick();
    assert.equal(presetChoices(), presetCounts[name], name);
  }
});

test('a pooled effect switch offers pause only for a preset bank', async (t) => {
  const {app, presetCounts, sequence} = await pooledPresetRig(t);
  for (const name of sequence) {
    app.elements.get('effect-sidebar').querySelectorAll('[data-effect]')
      .find((entry) => entry.dataset.effect === canonicalEffectId(name)).onclick();
    assert.equal(Boolean(app.guis.at(-1).ctrl('pause')), presetCounts[name] > 1, name);
  }
});

test('simulator shares canonical identity, preserves display metadata and reloads its route', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const document = offeredIds(HIGH_RES).find((id) => SHADER_DOCUMENT_EFFECTS.includes(id));
  assert.ok(document);
  const app = await bootedApp({search: `?effect=${SIMULATOR_EFFECT.display_name}&fx.Speed=0.7`,
    loadModule: async () => fakeWasmModule()});
  const option = app.elements.get('effect-sidebar').querySelectorAll('[data-effect]')
    .find((entry) => entry.dataset.effect === document);
  assert.ok(option);
  assert.equal(option.getAttribute('aria-label').startsWith(`${effectDisplayName(document)}, `), true);
  option.onclick();
  t.mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
  const shared = new URL(app.urlWrites.at(-1), 'https://example.test');
  assert.equal(shared.searchParams.get('effect'), document);
  assert.equal(shared.searchParams.get('view'), 'simulator');
  const reload = startApp({search: shared.search});
  assert.deepEqual(reload.replaced, []);
  assert.ok(reload.guis.length > 0);
});

test('canonical and legacy URL normalization retains parameter keys', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const { id, display_name } = SIMULATOR_EFFECT;
  for (const effect of [display_name, id]) {
    const app = await bootedApp({search: `?effect=${effect}&fx.Speed=0.7`,
      loadModule: async () => fakeWasmModule({ definitions: [
        {name: 'Speed', value: 0.2, min: 0, max: 1, animated: false},
      ]})});
    getActiveURLSync().setParam('view.poleLod', 1.5);
    t.mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
    const query = new URL(app.urlWrites.at(-1), 'https://example.test').searchParams;
    assert.equal(query.get('effect'), id);
    assert.equal(query.get('fx.Speed'), '0.7');
    assert.equal(app.guis.at(-1).namespace, 'fx');
    const active = app.elements.get('effect-sidebar').querySelectorAll('[data-effect]')
      .find((entry) => entry.getAttribute('aria-selected') === 'true');
    assert.equal(active.dataset.effect, id);
  }
});



test('fidelity selects engine sampling before first draw and refreshes paused toggles once', async () => {
  for (const povFidelity of [false, true]) {
    const module = fakeWasmModule();
    const draws = [];
    module.HolosphereEngine.prototype.drawFrame = function () { draws.push(this.temporalSampling); };
    const app = startApp({ loadModule: () => Promise.resolve(module), hydratedView: { povFidelity } });
    await app.teardown.ready;
    assert.equal(module.engine.temporalSampling, povFidelity);
    app.driver.renderer.frame();
    assert.ok(draws.length > 0);
    assert.ok(draws.every((sampling) => sampling === povFidelity));
    const control = app.guis[0].controllers.find((c) => c.property === 'povFidelity');
    assert.equal(control.label, `POV fidelity (${FPS} Hz)`);
    app.driver.paused = true;
    const before = draws.length;
    control.setValue(!povFidelity);
    assert.equal(module.engine.temporalSampling, !povFidelity);
    assert.deepEqual(draws.slice(before), [!povFidelity]);
    assert.equal(app.driver.paused, true);
    control.changed(!povFidelity);
    assert.equal(draws.length, before + 1);
    app.teardown.dispose();
  }
});
