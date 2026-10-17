//
// daydream.js's composition root: start(deps) builds the whole app against
// injected seams (document, page target, navigator, driver, GUI factory,
// module loader).
import { canonicalEffectId } from '../src/effects/effect_identity.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installConsoleCapture } from './helpers/fake_console.js';
import { fakeElement, restoreDocumentAfterEach } from './helpers/fake_dom.js';
import { fakeWasmModule, trackedStartApp } from './helpers/fake_app.js';
import { Daydream } from '../src/renderer/driver.js';

restoreDocumentAfterEach();
const startApp = trackedStartApp();

test('start assembles the app and hands back its teardown', () => {
  const { teardown, guis, listeners } = startApp();

  assert.equal(typeof teardown.dispose, 'function');
  assert.equal(teardown.disposed(), false);
  assert.equal(guis[0].namespace, 'view',
    "the global GUI root must keep the 'view' namespace its deep links are built from");
  assert.deepEqual(listeners.map(({ type }) => type),
    ['keydown', 'error', 'unhandledrejection', 'pagehide']);
});

test('a dismiss button that mounts after startup still clears the notice', () => {
  const { docListeners, elements, queried } = startApp();
  const clicks = docListeners.filter(({ type }) => type === 'click');
  assert.equal(clicks.length, 1,
    'the dismiss click is delegated to the document, not bound to one element');

  // Markup injected after construction: a different element under the same id.
  const dismiss = fakeElement('button');
  elements.set('apply-notice-dismiss', dismiss);
  const body = elements.get('apply-notice-body');
  body.hidden = false;
  elements.get('apply-notice-text').textContent = 'Effect change was rejected.';

  const before = queried.length;
  clicks[0].handler({ target: dismiss });

  assert.equal(body.hidden, true);
  assert.equal(elements.get('apply-notice-text').textContent, '');

  // Every id this path resolves at click time, pinned against the real markup.
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const resolved = queried.slice(before);
  assert.ok(resolved.length > 0, 'the click resolved no id, so nothing is pinned');
  for (const id of resolved)
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
});

test('the global GUI carries the controls a deep link names', () => {
  const { guis } = startApp();
  const root = guis[0];

  assert.deepEqual(root.controllers.map((c) => c.property),
    ['resolution', 'testAll', 'labelAxes', 'cullBackSphere', 'showPip', 'povFidelity',
      'povPresentation', 'povExposureMs', 'povResponseScale', 'showSweepBoundary', 'sweepPosition',
      'columnFillOverlap', 'poleLod', 'topCap', 'bottomCap']);
  const segments = root.folders.find((f) => f.namespace === 'Segmented POV');
  assert.ok(segments, 'the segmented folder name is a deep-link key segment');
  assert.deepEqual(segments.controllers.map((c) => c.property),
    ['segmented', 'segments', 'boundaries']);
  for (const prop of ['segmented', 'segments'])
    assert.equal(segments.controllers.find((c) => c.property === prop).session, undefined,
      `'${prop}' must stay deep-linked (add, not addSession)`);
  const recording = root.folders.find((f) => f.namespace === 'Recording');
  assert.deepEqual(recording.controllers.map((c) => c.property),
    ['recQuality', 'recResolution', 'recFormat', 'record']);
});

test('POV fidelity defaults off and toggling it requests a repaint', () => {
  const { guis, driver } = startApp();
  const control = guis[0].controllers.find((c) => c.property === 'povFidelity');
  assert.equal(control.getValue(), false);
  control.setValue(true);
  assert.equal(driver.povFidelity, true);
  assert.equal(driver.invalidated, true);
});

test('camera presentation and exposure are persistent view controls', () => {
  const { guis, driver } = startApp();
  for (const [name, initial, selected] of [
    ['povPresentation', 'raw', 'camera'], ['povExposureMs', 125, 250], ['povResponseScale', 1, 2],
  ]) {
    driver.invalidated = false;
    const control = guis[0].controllers.find((c) => c.property === name);
    assert.equal(control.getValue(), initial);
    assert.equal(control.session, undefined);
    assert.ok(guis[0].collectUrlKeys().includes(`view.${name}`));
    control.setValue(selected);
    assert.equal(driver[name], selected);
    assert.equal(driver.invalidated, true);
  }
});

test('exposure is enabled only for the active camera presentation and keeps its value', () => {
  const { guis, driver } = startApp();
  const control = (name) => guis[0].controllers.find((c) => c.property === name);
  const exposure = control('povExposureMs');
  assert.equal(exposure.disabled, true);
  control('povFidelity').setValue(true);
  assert.equal(exposure.disabled, true);
  control('povPresentation').setValue('camera');
  assert.equal(exposure.disabled, false);
  exposure.setValue(187);
  control('povPresentation').setValue('raw');
  assert.equal(exposure.disabled, true);
  assert.equal(exposure.getValue(), 187);
  control('povFidelity').setValue(false);
  control('povPresentation').setValue('camera');
  assert.equal(exposure.disabled, true);
  Object.defineProperty(driver, 'sweepPosition',
    Object.getOwnPropertyDescriptor(Daydream.prototype, 'sweepPosition'));
  control('sweepPosition').setValue(25);
  assert.equal(driver.povFidelity, true);
  assert.equal(exposure.disabled, false);
  assert.equal(exposure.getValue(), 187);
  control('povFidelity').setValue(false);
  assert.equal(exposure.disabled, true);
});

test('hydrated POV controls initialize response availability after all values load', () => {
  for (const povFidelity of [false, true]) {
    for (const povPresentation of ['raw', 'camera', 'visual']) {
      const { guis } = startApp({
        hydratedView: { povFidelity, povPresentation, povExposureMs: 187, povResponseScale: 1.3 },
      });
      const exposure = guis[0].controllers.find((c) => c.property === 'povExposureMs');
      assert.equal(exposure.disabled, !(povFidelity && povPresentation === 'camera'));
      assert.equal(exposure.getValue(), 187);
      assert.ok(guis[0].collectUrlKeys().includes('view.povExposureMs'));
      const response = guis[0].controllers.find((c) => c.property === 'povResponseScale');
      assert.equal(response.disabled, !(povFidelity && povPresentation === 'visual'));
      assert.equal(response.getValue(), 1.3);
      assert.ok(guis[0].collectUrlKeys().includes('view.povResponseScale'));
    }
  }
});

test('visual response controls follow mode, fidelity, and sweep inspection', () => {
  const { guis, driver } = startApp();
  const control = (name) => guis[0].controllers.find((c) => c.property === name);
  const response = control('povResponseScale');
  assert.equal(response.disabled, true);
  control('povPresentation').setValue('visual');
  assert.equal(response.disabled, true);
  Object.defineProperty(driver, 'sweepPosition',
    Object.getOwnPropertyDescriptor(Daydream.prototype, 'sweepPosition'));
  control('sweepPosition').setValue(25);
  assert.equal(response.disabled, false);
  assert.equal(control('povExposureMs').disabled, true);
  response.setValue(1.5);
  control('povPresentation').setValue('camera');
  assert.equal(response.disabled, true);
  assert.equal(response.getValue(), 1.5);
  assert.equal(control('povExposureMs').disabled, false);
  control('povPresentation').setValue('visual');
  control('povFidelity').setValue(false);
  assert.equal(response.disabled, true);
});

test('the sweep boundary defaults off and persists as a view control', () => {
  const { guis, driver } = startApp();
  const control = guis[0].controllers.find((c) => c.property === 'showSweepBoundary');
  assert.equal(control.label, 'Show arm positions');
  assert.equal(control.getValue(), false);
  assert.equal(control.session, undefined);
  assert.ok(guis[0].collectUrlKeys().includes('view.showSweepBoundary'));
  control.setValue(true);
  assert.equal(driver.showSweepBoundary, true);
  assert.equal(driver.invalidated, true);
});

test('sweep inspection stays out of shared URLs', () => {
  const { guis } = startApp({ search: '?view.sweepPosition=75' });
  const control = guis[0].controllers.find((c) => c.property === 'sweepPosition');
  assert.equal(control.session, true);
  assert.equal(control.getValue(), 0);
  assert.ok(!guis[0].collectUrlKeys().includes('view.sweepPosition'));
});

test('a workbench-only effect deep link is handed to the workbench page', () => {
  for (const effect of ['ShaderChain', 'alien-brain']) {
    const app = startApp({ search: `?effect=${effect}` });
    assert.deepEqual(app.replaced, [`/tools/shader.html?effect=${canonicalEffectId(effect)}`]);
    assert.equal(app.guis.length, 0);
    assert.deepEqual(app.listeners, []);
    assert.equal(app.teardown.disposed(), false);
    app.teardown.dispose();
    assert.equal(app.teardown.disposed(), true);
  }
});

test('the workbench page builds no segmented POV controls', () => {
  const { guis } = startApp({ daydreamMode: 'shader-workbench' });

  assert.equal(
    guis[0].folders.find((f) => f.namespace === 'Segmented POV'), undefined,
    'workbench effects are programmed through setShaderChain and no worker '
    + 'message carries that program, so a pool would composite a preview built '
    + 'from a bare ShaderChain; offering the controls at all -- or leaving them '
    + 'deep-linkable -- ships that silent difference');
});

test('the record button is offered only once an engine exists', () => {
  const { guis } = startApp();
  const record = guis[0].folders
    .find((f) => f.namespace === 'Recording').controllers
    .find((c) => c.property === 'record');

  assert.equal(record.enabled, false,
    'recording needs the recorder the module-ready path builds');
});

test('a keydown on the page target reaches the driver', () => {
  const { driver, listeners } = startApp();
  const { handler: onKeyDown } = listeners.find(({ type }) => type === 'keydown');

  onKeyDown({ key: ' ', target: {}, preventDefault() {} });
  assert.equal(driver.keys.length, 1, 'the global handler must dispatch to the driver');
});

test('the teardown releases the page listeners and the GUI it built', () => {
  const { teardown, driver, guis, listeners, docListeners } = startApp();

  teardown.dispose();
  assert.equal(teardown.disposed(), true);
  assert.deepEqual(listeners, [], 'every page listener must be removed');
  assert.deepEqual(docListeners, [], 'every document listener must be removed');
  assert.equal(guis[0].destroyed, true, 'the global GUI must be destroyed');
  assert.equal(driver.disposed, true, 'the driver owns GPU buffers');
});

test('a failed engine load reports and disarms the Test All ticker', async (t) => {
  const cancelTicker = t.mock.method(globalThis, 'clearInterval');
  const captured = installConsoleCapture('error');
  let app;
  try {
    app = startApp({ loadModule: () => Promise.reject(new Error('no wasm')) });
    app.guis[0].controllers.find((c) => c.property === 'testAll').setValue(true);
    await app.teardown.ready;
  } finally {
    captured.restore();
  }

  assert.match(captured.messages.join('|'),
    /Failed to initialize the Holosphere renderer[\s\S]*no wasm/,
    'the load failure must name the renderer and carry the underlying error');

  const testAll = app.guis[0].controllers.find((c) => c.property === 'testAll');
  assert.equal(testAll.getValue(), false);
  assert.equal(cancelTicker.mock.calls.length, 1);
  assert.equal(testAll.enabled, false,
    'without an engine the ticker would spin for the page lifetime');
  assert.ok(app.elements.get('loading-overlay').classList.contains('error'),
    'the failure must reach the overlay, not only the console');
});


test('retired shader identities are absent from simulator routing', () => {
  for (const effect of ['Shader', 'ShaderBall', 'ShaderWorkbench']) {
    const app = startApp({search: `?effect=${effect}`});
    assert.deepEqual(app.replaced, []);
    assert.equal(app.guis.length, 1);
  }
});

test('legacy simulator links and explicit canonical simulator links retain their route', () => {
  for (const search of ['?effect=AlienBrain', '?effect=alien-brain&view=simulator',
    '?effect=Comets', '?effect=comets']) {
    const app = startApp({ search });
    assert.deepEqual(app.replaced, []);
    assert.ok(app.guis.length > 0);
  }
});

test('authoring page accepts legacy and canonical document aliases', () => {
  for (const effect of ['AlienBrain', 'alien-brain']) {
    const app = startApp({daydreamMode: 'shader-workbench', search: `?effect=${effect}`});
    assert.deepEqual(app.replaced, []);
    assert.ok(app.guis.length > 0);
  }
});


test('GSReactionDiffusion has no Pause Presets control', async () => {
  const app = startApp({ search: '?effect=GSReactionDiffusion', loadModule: async () => fakeWasmModule() });
  await app.teardown.ready;
  const panel = app.guis.find((gui) => gui.namespace === 'fx');
  assert.ok(panel);
  assert.equal(panel.controllers.some((controller) => controller.property === 'pause'), false);
});
