//
// daydream.js's composition root, driven for real: start(deps) builds the whole
// app against injected seams (document, page target, navigator, driver, GUI
// factory, module loader), so the wiring is executed here rather than read out
// of the source. What each factory does with what it is handed is covered in
// tests/app_lifecycle.test.js; this is the assembly.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, restoreDocumentAfterEach } from './fake_dom.js';
import { startApp as startUntrackedApp } from './fake_app.js';

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

test('start assembles the app and hands back its teardown', () => {
  const { teardown, guis, listeners } = startApp();

  assert.equal(typeof teardown.dispose, 'function');
  assert.equal(teardown.disposed(), false);
  assert.equal(guis[0].namespace, 'view',
    "the global GUI root must keep the 'view' namespace its deep links are built from");
  assert.deepEqual(listeners.map(([type]) => type),
    ['keydown', 'error', 'unhandledrejection', 'pagehide']);
});

test('a dismiss button that mounts after startup still clears the notice', () => {
  const { docListeners, elements } = startApp();
  const clicks = docListeners.filter(([type]) => type === 'click');
  assert.equal(clicks.length, 1,
    'the dismiss click is delegated to the document, not bound to one element');

  // Markup injected after construction: a different element under the same id.
  const dismiss = fakeElement('button');
  elements.set('apply-notice-dismiss', dismiss);
  const body = elements.get('apply-notice-body');
  body.hidden = false;
  elements.get('apply-notice-text').textContent = 'Effect change was rejected.';

  clicks[0][1]({ target: dismiss });

  assert.equal(body.hidden, true);
  assert.equal(elements.get('apply-notice-text').textContent, '');
});

test('the global GUI carries the controls a deep link names', () => {
  const { guis } = startApp();
  const root = guis[0];

  assert.deepEqual(root.controllers.map((c) => c.property),
    ['resolution', 'testAll', 'labelAxes', 'cullBackSphere', 'showPip',
      'columnFillOverlap', 'poleLod']);
  const segments = root.folders.find((f) => f.namespace === 'Segmented POV');
  assert.ok(segments, 'the segmented folder name is a deep-link key segment');
  assert.deepEqual(segments.controllers.map((c) => c.property),
    ['segmented', 'segments', 'boundaries']);
  const recording = root.folders.find((f) => f.namespace === 'Recording');
  assert.deepEqual(recording.controllers.map((c) => c.property),
    ['recQuality', 'recResolution', 'recFormat', 'record']);
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
  const [, onKeyDown] = listeners.find(([type]) => type === 'keydown');

  onKeyDown({ key: ' ', target: {}, preventDefault() {} });
  assert.equal(driver.keys.length, 1, 'the global handler must dispatch to the driver');
});

test('the teardown releases the page listeners and the GUI it built', () => {
  const { teardown, driver, guis, listeners } = startApp();

  teardown.dispose();
  assert.equal(teardown.disposed(), true);
  assert.deepEqual(listeners, [], 'every page listener must be removed');
  assert.equal(guis[0].destroyed, true, 'the global GUI must be destroyed');
  assert.equal(driver.disposed, true, 'the driver owns GPU buffers');
});

test('a failed engine load reports and disarms the Test All ticker', async () => {
  const { guis, elements } = startApp({
    loadModule: () => Promise.reject(new Error('no wasm')),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const testAll = guis[0].controllers.find((c) => c.property === 'testAll');
  assert.equal(testAll.enabled, false,
    'without an engine the ticker would spin for the page lifetime');
  assert.ok(elements.get('loading-overlay').classList.contains('error'),
    'the failure must reach the overlay, not only the console');
});
