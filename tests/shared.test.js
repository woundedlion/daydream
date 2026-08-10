//
// shared.js's own export is initScene; showFatalError et al. are re-exports
// covered by their source modules' tests (banner.test.js, clipboard.test.js,
// cpp_format.test.js). three + three/addons are redirected onto fake_three.js
// by loader hooks, so initScene builds a whole scene here without a WebGL
// context and dispose() can be checked step by step. dispose() carries an
// ordering invariant: the frame loop and the resize listener must both be
// stopped before any GPU object is released, or a queued frame renders against
// disposed resources.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import {
  log, Mesh, PerspectiveCamera, Scene, WebGLRenderer, OrbitControls,
} from './fake_three.js';

// Same URL this file's static import above resolved, so shared.js and the
// assertions below share one module instance — and one `log`. The hook is
// process-wide and never deregistered, which is only safe because `node --test`
// gives each test file its own process.
register('./three_loader_hooks.js', import.meta.url, {
  data: { fakeThreeUrl: import.meta.resolve('./fake_three.js') },
});

const { capPixelRatio, getCssColor, initScene } = await import('../tools/shared.js');

const RAF_ID = 7;

const saved = {
  document: globalThis.document,
  window: globalThis.window,
  getComputedStyle: globalThis.getComputedStyle,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
  log.length = 0;
});

/** Stub document.getElementById against a fixed id->element map. */
function stubDocument(byId) {
  globalThis.document = {
    documentElement: {},
    getElementById: (id) => byId[id] || null,
  };
}

/** Stub getComputedStyle over a fixed custom-property map. */
function stubComputedStyle(props) {
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (name) => props[name] ?? '',
  });
}

/**
 * Install the DOM and animation globals initScene needs, then build a scene.
 * requestAnimationFrame parks its callback instead of running it, so the loop
 * advances exactly one frame; nextFrame() runs the parked one on demand.
 * @param {Object} [opts] - Options forwarded to initScene.
 * @returns {Object} initScene's handles plus the canvas, the mutable container,
 *          the listener record, nextFrame() and the ids passed to
 *          cancelAnimationFrame.
 */
function mountScene(opts = {}) {
  const canvas = {};
  const container = { clientWidth: 640, clientHeight: 480 };
  const listeners = { added: [], removed: [] };
  const cancelled = [];
  let parkedFrame = null;
  stubDocument({ viewport: container, gl: canvas });
  globalThis.window = {
    devicePixelRatio: 2,
    addEventListener(type, fn) { listeners.added.push([type, fn]); },
    removeEventListener(type, fn) {
      listeners.removed.push([type, fn]);
      log.push('removeEventListener');
    },
  };
  globalThis.requestAnimationFrame = (fn) => { parkedFrame = fn; return RAF_ID; };
  globalThis.cancelAnimationFrame = (id) => {
    cancelled.push(id);
    log.push('cancelAnimationFrame');
  };
  const nextFrame = () => parkedFrame();
  return {
    canvas, container, listeners, cancelled, nextFrame,
    ...initScene('viewport', 'gl', opts),
  };
}

test('capPixelRatio preserves low-density displays and caps high-density displays', () => {
  assert.equal(capPixelRatio(0.75), 0.75);
  assert.equal(capPixelRatio(1), 1);
  assert.equal(capPixelRatio(3), 1);
});

test('getCssColor reads a six-digit token off the document root', () => {
  stubDocument({});
  stubComputedStyle({ '--slate-900': ' #0f172a ', '--bare': 'A1B2C3' });
  assert.equal(getCssColor('--slate-900'), 0x0f172a);
  assert.equal(getCssColor('--bare'), 0xa1b2c3);
});

test('getCssColor returns undefined for an unset or malformed token', () => {
  stubDocument({});
  stubComputedStyle({ '--accent': 'rgb(1, 2, 3)', '--short': '#abc' });
  assert.equal(getCssColor('--accent'), undefined);
  assert.equal(getCssColor('--short'), undefined);
  assert.equal(getCssColor('--absent'), undefined);
});

test('getCssColor returns undefined without a styled document', () => {
  stubDocument({});
  assert.equal(getCssColor('--slate-900'), undefined,
    'a DOM with no getComputedStyle must not throw');
  delete globalThis.document;
  stubComputedStyle({ '--slate-900': '#0f172a' });
  assert.equal(getCssColor('--slate-900'), undefined);
});

test('initScene takes its default background from the --slate-900 token', () => {
  stubComputedStyle({ '--slate-900': '#123456' });
  assert.equal(mountScene().scene.background.hex, 0x123456);
});

test('initScene falls back to the slate-900 literal when the token is unset', () => {
  assert.equal(mountScene().scene.background.hex, 0x0f172a);
  stubComputedStyle({});
  assert.equal(mountScene().scene.background.hex, 0x0f172a);
});

test('initScene throws when the container element is absent', () => {
  stubDocument({});
  assert.throws(() => initScene('viewport', 'gl'),
    /container element #viewport not found/);
});

test('initScene throws when the canvas element is absent', () => {
  stubDocument({ viewport: { clientWidth: 640, clientHeight: 480 } });
  assert.throws(() => initScene('viewport', 'gl'),
    /canvas element #gl not found/);
});

test('initScene returns the handles the tool pages destructure', () => {
  const s = mountScene();

  assert.ok(s.scene instanceof Scene);
  assert.ok(s.camera instanceof PerspectiveCamera);
  assert.ok(s.renderer instanceof WebGLRenderer);
  assert.ok(s.controls instanceof OrbitControls);
  assert.ok(s.sphere instanceof Mesh);
  assert.deepEqual(s.lights, []);
  assert.equal(typeof s.resize, 'function');
  assert.equal(typeof s.dispose, 'function');

  assert.equal(s.renderer.domElement, s.canvas);
  assert.deepEqual(s.renderer.size, [640, 480]);
  assert.equal(s.renderer.pixelRatio, 1, 'the renderer must take the capped ratio');
  assert.equal(s.controls.camera, s.camera);
  assert.equal(s.controls.domElement, s.canvas);
  assert.deepEqual(s.scene.children, [s.sphere]);
  assert.equal(s.renderer.renders, 1, 'the loop must paint one frame on start');
  assert.deepEqual(s.listeners.added, [['resize', s.resize]]);
});

test('initScene returns the light rig it added when lights are requested', () => {
  const s = mountScene({ lights: true, showSphere: false });

  assert.equal(s.lights.length, 3);
  assert.deepEqual(s.scene.children, s.lights);
});

test('the default resize retracks the container size and re-caps the pixel ratio', () => {
  const s = mountScene();

  s.container.clientWidth = 1024;
  s.container.clientHeight = 256;
  globalThis.window.devicePixelRatio = 0.5;
  s.resize();
  assert.equal(s.camera.aspect, 1024 / 256);
  assert.equal(s.camera.projectionUpdates, 1, 'a new aspect is inert until the matrix is rebuilt');
  assert.deepEqual(s.renderer.size, [1024, 256]);
  assert.equal(s.renderer.pixelRatio, 0.5, 'resize must re-read devicePixelRatio');

  // A display that changes density mid-session, e.g. a window dragged to a
  // high-DPI monitor.
  globalThis.window.devicePixelRatio = 3;
  s.resize();
  assert.equal(s.renderer.pixelRatio, 1, 'resize must cap the ratio it re-reads');

  // A collapsed container must not drive the aspect to 0, Infinity or NaN.
  s.container.clientWidth = 0;
  s.container.clientHeight = 0;
  s.resize();
  assert.equal(s.camera.aspect, 1);
  assert.deepEqual(s.renderer.size, [0, 0]);
});

test('an onResize handler replaces the default and receives the scene handles', () => {
  const seen = [];
  const s = mountScene({ onResize: (handles) => seen.push(handles) });
  assert.deepEqual(s.listeners.added, [['resize', s.resize]]);

  s.container.clientWidth = 1024;
  s.container.clientHeight = 256;
  s.resize();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].scene, s.scene);
  assert.equal(seen[0].camera, s.camera);
  assert.equal(seen[0].renderer, s.renderer);
  assert.equal(seen[0].controls, s.controls);
  // Replaces, not augments: the default aspect/size update must not also run.
  assert.equal(s.camera.aspect, 640 / 480);
  assert.equal(s.camera.projectionUpdates, 0);
  assert.deepEqual(s.renderer.size, [640, 480]);
});

test('the frame loop runs onAnimate before the render and onAfterRender after it', () => {
  const order = [];
  let s = null;
  // Frame 1 runs inside initScene, before `s` exists, so it reports no render
  // count; frame 2 brackets a render whose count the handles expose.
  const mark = (tag) => () => order.push(`${tag}:${s ? s.renderer.renders : '-'}`);
  s = mountScene({ onAnimate: mark('animate'), onAfterRender: mark('afterRender') });

  assert.deepEqual(order, ['animate:-', 'afterRender:-']);
  assert.equal(s.renderer.renders, 1);
  assert.equal(s.controls.updates, 1);

  s.nextFrame();
  assert.deepEqual(order.slice(2), ['animate:1', 'afterRender:2']);
  assert.equal(s.controls.updates, 2, 'the loop must keep driving the controls');
});

test('dispose stops the frame loop and the resize listener before releasing GPU objects', () => {
  const s = mountScene();
  s.dispose();

  assert.deepEqual(log, [
    'cancelAnimationFrame',
    'removeEventListener',
    'controls.dispose',
    'renderer.dispose',
    'geometry.dispose',
    'material.dispose',
    'scene.clear',
  ]);
  assert.deepEqual(s.cancelled, [RAF_ID], 'the pending frame handle must be cancelled');
  assert.deepEqual(s.listeners.removed, [['resize', s.resize]],
    'dispose must remove the listener initScene added');
  assert.deepEqual(s.scene.children, []);
});

test('dispose skips the sphere teardown when no reference sphere was built', () => {
  const s = mountScene({ showSphere: false });
  assert.equal(s.sphere, null);

  s.dispose();
  assert.deepEqual(log, [
    'cancelAnimationFrame',
    'removeEventListener',
    'controls.dispose',
    'renderer.dispose',
    'scene.clear',
  ]);
});
