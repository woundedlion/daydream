// The composition root's handling of a rejected shader-workbench init, with the
// document controller replaced by a module mock.
import { mock, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { restoreDocumentAfterEach } from './helpers/fake_dom.js';
import { installConsoleCapture } from './helpers/fake_console.js';
import { getActiveURLSync, URL_FLUSH_DEBOUNCE_MS } from '../src/app/state.js';
import { canonicalEffectId } from '../src/effects/effect_identity.js';
import { MODULE_TRAP_NOTICE } from '../src/app/app_lifecycle.js';

let initFailure = null;
let initResult = null;
let preserveLink = false;
let callbacks;
beforeEach(() => { initFailure = null; initResult = null; preserveLink = false; });
afterEach(() => mock.timers.reset());
let controllers = 0;
mock.module('../src/workbench/shader/shader_documents.js', {
  namedExports: {
    createShaderDocumentController: (dependencies) => {
      callbacks = dependencies;
      controllers += 1;
      return {
        init: () => initFailure ? Promise.reject(initFailure()) : initResult,
        preservesOriginalLink: () => preserveLink,
        dispose() {},
      };
    },
  },
});
const { fakeWasmModule, noticeText, trackedStartApp } = await import('./helpers/fake_app.js');

restoreDocumentAfterEach();
const startApp = trackedStartApp();

/**
 * Boots the workbench page with a document controller whose init() rejects
 * with what `fail` returns, and lets the rejection settle.
 * @param {(module: Object) => Error} fail - Builds the rejection reason.
 * @returns {Promise<{app: Object, module: Object, messages: string[]}>} The booted app, module and console messages.
 */
async function bootRejectedWorkbench(fail) {
  const module = fakeWasmModule();
  initFailure = () => fail(module);
  const before = controllers;
  const capture = installConsoleCapture('error', 'warn', 'log');
  try {
    const app = startApp({
      daydreamMode: 'shader-workbench', loadModule: () => Promise.resolve(module),
    });
    await app.teardown.ready;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controllers, before + 1, 'the workbench page builds its controller');
    return { app, module, messages: capture.messages };
  } finally {
    capture.restore();
  }
}

const fatalBanner = () => globalThis.document.body.children
  .find((child) => child.id === 'fatal-error-overlay');

test('a failed workbench init reports through its notice, not the page-failure banner', async () => {
  const { app } = await bootRejectedWorkbench(() => new Error('boom'));
  assert.equal(noticeText(app), 'The shader workbench could not be initialized: Error: boom');
  assert.equal(app.elements.get('apply-notice-body').hidden, false);
  assert.equal(fatalBanner(), undefined);
  assert.equal(app.teardown.disposed(), false);
});

test('a workbench init that trapped the module releases the app', async () => {
  const { app, messages } = await bootRejectedWorkbench((module) => {
    module.HS_MODULE_DEAD = true;
    return new WebAssembly.RuntimeError('unreachable');
  });
  assert.equal(app.teardown.disposed(), true);
  assert.equal(noticeText(app), '', 'a dead module is not reported as a workbench failure');
  assert.match(messages.join('\n'), /Startup stopped: the rendering engine trapped/);
  const overlay = app.elements.get('loading-overlay');
  assert.equal(overlay.classList.contains('error'), true);
  assert.ok(overlay.children.some((child) => child.textContent === MODULE_TRAP_NOTICE));
});

test('a resolved workbench init releases pending URL writes', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let resolve;
  initResult = new Promise((done) => { resolve = done; });
  const app = startApp({ daydreamMode: 'shader-workbench',
    search: '?effect=ShaderChain', loadModule: async () => fakeWasmModule() });
  await app.teardown.ready;
  mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
  assert.deepEqual(app.urlWrites, []);
  resolve(true);
  await new Promise((done) => setImmediate(done));
  mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
  assert.equal(app.urlWrites.length, 1);
});

test('a column edit during workbench initialization supersedes the initial override', async () => {
  mock.timers.enable({apis: ['setTimeout']});
  let resolve;
  initResult = new Promise((done) => { resolve = done; });
  const module = fakeWasmModule();
  module.HolosphereEngine.prototype.strobeColumns = () => true;
  const app = startApp({daydreamMode: 'shader-workbench',
    search: '?effect=AlienBrain&view.noBlackColumns=true', hydratedView: {noBlackColumns: true},
    loadModule: async () => module});
  await app.teardown.ready;
  assert.equal(callbacks.selectEffect('ShaderChain'), true);
  const control = app.guis[0].controllers.find((entry) => entry.property === 'noBlackColumns');
  control.setValue(true);
  control.setValue(false);
  resolve(true);
  await new Promise((done) => setImmediate(done));
  assert.equal(app.driver.noBlackColumns, false);
});

test('release of the original link resumes URL writes once', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  preserveLink = true;
  initResult = Promise.resolve(true);
  const app = startApp({ daydreamMode: 'shader-workbench',
    search: '?effect=ShaderChain', loadModule: async () => fakeWasmModule() });
  await app.teardown.ready;
  await new Promise((done) => setImmediate(done));
  mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
  assert.deepEqual(app.urlWrites, []);
  callbacks.onOriginalLinkReleased();
  mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
  assert.equal(app.urlWrites.length, 1);
  callbacks.onOriginalLinkReleased();
  mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
  assert.equal(app.urlWrites.length, 1);
});

test('workbench effect selection resolves a legacy alias to its canonical URL identity', async () => {
  initResult = Promise.resolve(true);
  const module = fakeWasmModule();
  const selected = [];
  module.HolosphereEngine.prototype.setEffect = (effect) => {
    selected.push(effect);
    return module.EffectSetResult.INSTALLED;
  };
  const app = startApp({ daydreamMode: 'shader-workbench',
    search: '?effect=ShaderChain', loadModule: async () => module });
  await app.teardown.ready;
  await new Promise((done) => setImmediate(done));
  assert.equal(callbacks.selectEffect('AshCloud'), true);
  assert.equal(selected.at(-1), canonicalEffectId('AshCloud'));
  getActiveURLSync().flush();
  assert.equal(new URL(app.urlWrites.at(-1), 'https://example.test').searchParams.get('effect'),
    canonicalEffectId('AshCloud'));
});

test('a constructor that traps marks boot failure with the module remedy', async () => {
  const module = fakeWasmModule();
  module.HolosphereEngine = class {
    static isLive() { return false; }
    constructor() {
      module.HS_MODULE_DEAD = true;
      throw new WebAssembly.RuntimeError('unreachable');
    }
  };
  const capture = installConsoleCapture('error', 'warn', 'log');
  try {
    const app = startApp({ loadModule: async () => module });
    await app.teardown.ready;
    assert.equal(app.teardown.disposed(), true);
    assert.ok(app.elements.get('loading-overlay').children
      .some((child) => child.textContent === MODULE_TRAP_NOTICE));
    assert.ok(capture.messages.some((message) => /Failed to initialize/.test(message)));
  } finally { capture.restore(); }
});


test('workbench global arrows leave compiled presets under toolbar control', async () => {
  initResult = Promise.resolve(true);
  const module = fakeWasmModule();
  module.HolosphereEngine.prototype.getPresetCount = () => 3;
  const app = startApp({ daydreamMode: 'shader-workbench', loadModule: async () => module });
  await app.teardown.ready;
  await new Promise((resolve) => setImmediate(resolve));
  const move = [];
  app.driver.keydown = (event, movePreset) => move.push(movePreset(1));
  app.listeners.find(({ type }) => type === 'keydown').handler({ key: 'ArrowRight' });
  assert.deepEqual(move, [false]);
});
