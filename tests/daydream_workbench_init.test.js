// The composition root's handling of a rejected shader-workbench init, with the
// document controller replaced by a module mock.
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreDocumentAfterEach } from './helpers/fake_dom.js';
import { installConsoleCapture } from './helpers/fake_console.js';
import { MODULE_TRAP_NOTICE } from '../src/app/app_lifecycle.js';

let initFailure = null;
let controllers = 0;
mock.module('../src/workbench/shader/shader_documents.js', {
  namedExports: {
    createShaderDocumentController: () => {
      controllers += 1;
      return {
        init: () => Promise.reject(initFailure()),
        preservesOriginalLink: () => false,
        dispose() {},
      };
    },
  },
});
const { fakeWasmModule, startApp } = await import('./helpers/fake_app.js');

restoreDocumentAfterEach();
const started = [];
afterEach(() => {
  while (started.length > 0) {
    const app = started.pop();
    app.teardown.dispose();
    app.restore();
  }
});

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
    started.push(app);
    await app.teardown.ready;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controllers, before + 1, 'the workbench page builds its controller');
    return { app, module, messages: capture.messages };
  } finally {
    capture.restore();
  }
}

const noticeText = (app) => app.elements.get('apply-notice-text').textContent;
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
