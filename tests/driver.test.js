// @ts-nocheck
//
// driver.js's three.js lifecycle: the DOM-free sizing/LOD helpers, plus the
// rebuild (setupDots) and teardown (dispose) paths driven over a fake mesh via
// prototype.call, so no WebGL context is needed. Both paths carry an
// ordering invariant — instanceColor.array must be nulled before
// InstancedMesh.dispose(), because that array may alias WASM memory. The
// context-loss handlers run against the shared fake DOM.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Daydream, dotDetailFor, fitDistance } from '../driver.js';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './fake_dom.js';

restoreDocumentAfterEach();

// ---------------------------------------------------------------------------
// dotDetailFor
// ---------------------------------------------------------------------------

test('dotDetailFor decays the segment count as the pixel count rises', () => {
  assert.equal(dotDetailFor(0), 30);
  assert.equal(dotDetailFor(96 * 20), 28);
  assert.equal(dotDetailFor(288 * 144), 8);
});

test('dotDetailFor floors at 3 segments however large the grid', () => {
  assert.equal(dotDetailFor(100000), 3);
  assert.equal(dotDetailFor(1e9), 3);
});

test('dotDetailFor is monotonically non-increasing', () => {
  let previous = dotDetailFor(0);
  for (let n = 1000; n <= 200000; n += 1000) {
    const detail = dotDetailFor(n);
    assert.ok(detail <= previous, `detail rose at ${n}: ${previous} -> ${detail}`);
    previous = detail;
  }
});

// ---------------------------------------------------------------------------
// fitDistance
// ---------------------------------------------------------------------------

// Half-angle the sphere must subtend for the fit to be correct.
const halfFovRad = THREE.MathUtils.degToRad(Daydream.CAMERA_FOV / 2);

test('fitDistance frames the sphere at 85% of the view height when wide', () => {
  const d = fitDistance(16 / 9, 0, Infinity);
  const visibleHeight = 2 * Math.tan(halfFovRad) * d;
  assert.ok(Math.abs(Daydream.SPHERE_RADIUS * 2 / visibleHeight - 0.85) < 1e-12);
});

test('fitDistance is height-driven for any aspect >= 1', () => {
  const square = fitDistance(1, 0, Infinity);
  assert.ok(Math.abs(fitDistance(3, 0, Infinity) - square) < 1e-12);
});

test('fitDistance backs off by 1/aspect on a portrait viewport', () => {
  const square = fitDistance(1, 0, Infinity);
  assert.ok(Math.abs(fitDistance(0.5, 0, Infinity) - square * 2) < 1e-9);
});

test('fitDistance clamps into the orbit-control range', () => {
  assert.equal(fitDistance(1, 5000, 6000), 5000);
  assert.equal(fitDistance(1, 1, 10), 10);
});

// ---------------------------------------------------------------------------
// setupDots / dispose
// ---------------------------------------------------------------------------

/**
 * Stand-in for an InstancedMesh already in the scene. Every teardown step
 * appends to `log`, and mesh.dispose() records whether instanceColor.array was
 * already detached when it ran.
 * @param {Array<string>} log - Ordered event sink.
 * @returns {Object} Fake mesh exposing geometry/instanceColor/dispose.
 */
function fakeMesh(log) {
  let colors = new Uint16Array(3);
  const instanceColor = {
    get array() { return colors; },
    set array(v) { colors = v; log.push(v === null ? 'detach' : 'attach'); },
  };
  return {
    instanceColor,
    geometry: { dispose: () => log.push('geometry.dispose') },
    dispose: () =>
      log.push(`mesh.dispose(${colors === null ? 'detached' : 'attached'})`),
  };
}

/** Minimal `this` for setupDots: a scene stub, the grid, and the old mesh.
 * @param {Object} mesh - Existing dot mesh the rebuild must tear down.
 * @param {Array<string>} log - Ordered event sink.
 * @returns {Object} Context object for prototype.call.
 */
function setupCtx(mesh, log) {
  return {
    W: 8,
    H: 4,
    DOT_SIZE: 3,
    dotMesh: mesh,
    scene: {
      add: () => log.push('scene.add'),
      remove: () => log.push('scene.remove'),
    },
  };
}

/** Minimal `this` for dispose: every field a dispose branch guards on is populated.
 * @param {Object} mesh - Dot mesh to release.
 * @param {Array<string>} log - Ordered event sink.
 * @returns {Object} Context object for prototype.call.
 */
function disposeCtx(mesh, log) {
  const axis = (name) => ({
    name,
    geometry: { dispose: () => log.push(`${name}.geometry.dispose`) },
  });
  return {
    resizeObserver: { disconnect: () => log.push('observer.disconnect') },
    canvas: { removeEventListener: (type) => log.push(`canvas.off:${type}`) },
    onContextLost: () => {},
    onContextRestored: () => {},
    onCanvasKeyDown: () => {},
    onCanvasFocus: () => {},
    onCanvasBlur: () => {},
    contextLostOverlay: { remove: () => log.push('overlay.remove') },
    scene: { remove: (obj) => log.push(`scene.remove:${obj?.name ?? 'dotMesh'}`) },
    dotMesh: mesh,
    pixels: mesh.instanceColor.array,
    dotMaterial: { dispose: () => log.push('material.dispose') },
    xAxis: axis('xAxis'),
    yAxis: axis('yAxis'),
    zAxis: axis('zAxis'),
    axisMaterial: { dispose: () => log.push('axisMaterial.dispose') },
    controls: { dispose: () => log.push('controls.dispose') },
    labelRenderer: { domElement: { remove: () => log.push('labelLayer.remove') } },
    renderer: {
      setAnimationLoop: () => log.push('renderer.stopLoop'),
      dispose: () => log.push('renderer.dispose'),
    },
  };
}

test('setupDots tears the old mesh down before building the new one', () => {
  const log = [];
  const ctx = setupCtx(fakeMesh(log), log);
  Daydream.prototype.setupDots.call(ctx);

  assert.deepEqual(log.slice(0, 4), [
    'scene.remove', 'geometry.dispose', 'detach', 'mesh.dispose(detached)',
  ]);
  assert.equal(log.at(-1), 'scene.add');
});

test('setupDots sizes the rebuilt mesh from the instance grid', () => {
  const log = [];
  const ctx = setupCtx(fakeMesh(log), log);
  Daydream.prototype.setupDots.call(ctx);

  // node --test loads three twice, so instanceof across the driver boundary never holds
  assert.equal(ctx.dotMesh.isInstancedMesh, true);
  assert.equal(ctx.dotMesh.count, 8 * 4);
  assert.equal(ctx.dotMesh.frustumCulled, false);
  assert.equal(ctx.dotGeometry.parameters.radius, 3);
  assert.equal(ctx.dotGeometry.parameters.widthSegments, dotDetailFor(8 * 4));
});

test('setupDots builds the cull uniforms once and reuses the material', () => {
  const log = [];
  const ctx = setupCtx(fakeMesh(log), log);
  Daydream.prototype.setupDots.call(ctx);
  const material = ctx.dotMaterial;
  const uniforms = ctx.cullUniforms;

  ctx.dotMesh = fakeMesh(log);
  Daydream.prototype.setupDots.call(ctx);
  assert.equal(ctx.dotMaterial, material);
  assert.equal(ctx.cullUniforms, uniforms);
});

test('dispose detaches instanceColor before disposing the mesh', () => {
  const log = [];
  const ctx = disposeCtx(fakeMesh(log), log);
  Daydream.prototype.dispose.call(ctx);

  const detach = log.indexOf('detach');
  const disposed = log.indexOf('mesh.dispose(detached)');
  assert.ok(detach >= 0 && disposed > detach);
  assert.ok(log.indexOf('geometry.dispose') < detach);
});

test('dispose releases the observer, listeners, and GPU resources', () => {
  const log = [];
  const ctx = disposeCtx(fakeMesh(log), log);
  Daydream.prototype.dispose.call(ctx);

  for (const step of ['observer.disconnect', 'canvas.off:webglcontextlost',
                      'canvas.off:webglcontextrestored', 'canvas.off:keydown',
                      'canvas.off:focus', 'canvas.off:blur',
                      'overlay.remove', 'material.dispose', 'axisMaterial.dispose',
                      'controls.dispose', 'labelLayer.remove',
                      'renderer.dispose']) {
    assert.ok(log.includes(step), `dispose skipped ${step}`);
  }
  assert.ok(log.indexOf('renderer.stopLoop') < log.indexOf('renderer.dispose'));
});

test('dispose removes each axis from the scene and frees its geometry', () => {
  const log = [];
  const ctx = disposeCtx(fakeMesh(log), log);
  Daydream.prototype.dispose.call(ctx);

  for (const name of ['xAxis', 'yAxis', 'zAxis']) {
    assert.ok(log.includes(`scene.remove:${name}`), `${name} left in the scene`);
    assert.ok(log.includes(`${name}.geometry.dispose`), `${name} geometry leaked`);
  }
});

test('dispose leaves no dangling mesh or pixel buffer', () => {
  const log = [];
  const ctx = disposeCtx(fakeMesh(log), log);
  Daydream.prototype.dispose.call(ctx);

  assert.equal(ctx.dotMesh, null);
  assert.equal(ctx.dotMaterial, null);
  assert.equal(ctx.pixels, null);
});

// ---------------------------------------------------------------------------
// stepSimulation / render: the detached-pixel-view contract
// ---------------------------------------------------------------------------

/**
 * Builds a typed-array view whose backing ArrayBuffer has been detached, as
 * Emscripten heap growth leaves a previously-fetched pixel view.
 * @returns {Uint16Array} A view over a detached buffer.
 */
function detachedView() {
  const buf = new ArrayBuffer(8);
  const view = new Uint16Array(buf);
  buf.transfer();
  return view;
}

/**
 * Stand-in for an InstancedBufferAttribute with three.js's real upload
 * semantics: needsUpdate is write-only and only ever bumps version, so once an
 * upload is flagged nothing can unflag it. `version` is what WebGLAttributes
 * compares, so tests assert on it rather than on a readable flag.
 * @param {Uint16Array} array - Backing color array.
 * @returns {Object} Attribute stub exposing array/version/needsUpdate.
 */
function fakeColorAttribute(array) {
  return {
    array,
    version: 0,
    set needsUpdate(value) { if (value === true) this.version++; },
  };
}

/** Minimal `this` for stepSimulation: a running sim over the given color array.
 * @param {Uint16Array} colors - Array the dot mesh's instanceColor aliases.
 * @returns {Object} Context object for prototype.call.
 */
function stepCtx(colors) {
  return {
    paused: false,
    stepFrames: 0,
    pixels: colors,
    dotMesh: { instanceColor: fakeColorAttribute(colors) },
    updateStats: () => {},
  };
}

test('stepSimulation flags the color upload on a normal frame', () => {
  const ctx = stepCtx(new Uint16Array(4));
  assert.equal(Daydream.prototype.stepSimulation.call(ctx, { drawFrame: () => {} }), true);
  assert.equal(ctx.dotMesh.instanceColor.version, 1);
});

test('stepSimulation adds no upload flag when a mid-frame heap growth detached the view', () => {
  const ctx = stepCtx(new Uint16Array(4));
  // daydream.js's adapter flags the upload, then syncGUI() -> getParamValues()
  // grows the heap and detaches the view it just flagged.
  const effect = {
    drawFrame: () => {
      ctx.dotMesh.instanceColor.needsUpdate = true;
      ctx.dotMesh.instanceColor.array = detachedView();
    },
  };

  assert.equal(Daydream.prototype.stepSimulation.call(ctx, effect), true);
  assert.equal(ctx.dotMesh.instanceColor.version, 1, 'driver flagged a detached array');
});

/** Minimal `this` for render(): a paused sim with a pending repaint.
 * @param {Uint16Array} colors - Array the dot mesh's instanceColor aliases.
 * @param {Array<string>} log - Ordered event sink.
 * @returns {Object} Context object for prototype.call.
 */
function renderCtx(colors, log) {
  return {
    contextLost: false,
    paused: true,
    stepFrames: 0,
    timeAccumulator: 0,
    frameInterval: 1 / 30,
    needsRender: true,
    labelAxes: false,
    hadLabels: false,
    recorder: null,
    clock: { getDelta: () => 0 },
    advanceFrameClock: Daydream.prototype.advanceFrameClock,
    controls: { update: () => log.push('controls.update') },
    dotMesh: { instanceColor: fakeColorAttribute(colors) },
    xAxis: {}, yAxis: {}, zAxis: {},
    labelPool: { activeCount: 0 },
    labelRenderer: { render: () => log.push('labelRenderer.render') },
    renderer: { setScissorTest: (on) => log.push(`scissor:${on}`) },
    updateCullUniforms: () => log.push('updateCullUniforms'),
    renderMainView: () => log.push('renderMainView'),
    refreshLabels: () => log.push('refreshLabels'),
    renderPip: () => log.push('renderPip'),
  };
}

test('render repaints a pending frame while paused', () => {
  const log = [];
  const ctx = renderCtx(new Uint16Array(4), log);
  Daydream.prototype.render.call(ctx, null);

  assert.ok(log.includes('renderMainView'));
  assert.equal(ctx.needsRender, false);
});

test('render holds the repaint while instanceColor aliases a detached view', () => {
  const log = [];
  const ctx = renderCtx(detachedView(), log);
  Daydream.prototype.render.call(ctx, null);

  // renderer.render() would throw on the attribute size check.
  assert.ok(!log.includes('renderMainView'), 'rendered from a detached array');
  assert.ok(!log.includes('scissor:true'));
  assert.equal(ctx.needsRender, true, 'repaint was dropped instead of deferred');
});

// ---------------------------------------------------------------------------
// setupContextLossHandling
// ---------------------------------------------------------------------------

/**
 * Minimal `this` for setupContextLossHandling, with a fake document installed so
 * the overlay can be built. Registered listeners land in `handlers`.
 * @param {Object} [recorder] - Recorder stand-in, or null/omitted for no session.
 * @returns {Object} Context object for prototype.call.
 */
function contextLossCtx(recorder = null) {
  installDocument({ createElement: (tag) => fakeElement(tag) });
  const handlers = {};
  return {
    handlers,
    recorder,
    canvasParent: fakeElement(),
    canvas: { addEventListener: (type, fn) => { handlers[type] = fn; } },
  };
}

/**
 * Runs `body` with console.error/warn captured, so the handlers' diagnostics are
 * asserted instead of printed into the suite output.
 * @param {Function} body - Code to run under the capture.
 * @returns {Array<string>} One joined message per call.
 */
function captureConsole(body) {
  const messages = [];
  const record = (...args) => messages.push(args.map(String).join(' '));
  const err = mock.method(console, 'error', record);
  const warn = mock.method(console, 'warn', record);
  try { body(); } finally { err.mock.restore(); warn.mock.restore(); }
  return messages;
}

test('setupContextLossHandling starts unlost behind a hidden overlay', () => {
  const ctx = contextLossCtx();
  Daydream.prototype.setupContextLossHandling.call(ctx);

  assert.equal(ctx.contextLost, false);
  assert.equal(typeof ctx.handlers.webglcontextlost, 'function');
  assert.equal(typeof ctx.handlers.webglcontextrestored, 'function');
  assert.ok(ctx.canvasParent.children.includes(ctx.contextLostOverlay),
    'the overlay never reached the canvas parent');
  assert.equal(ctx.contextLostOverlay.style.display, 'none');
});

test('a lost context claims the restore, shows the reason, and aborts the recording', () => {
  const aborted = [];
  const ctx = contextLossCtx({ abort: (message) => aborted.push(message) });
  Daydream.prototype.setupContextLossHandling.call(ctx);

  let prevented = false;
  const messages = captureConsole(() => ctx.handlers.webglcontextlost({
    preventDefault: () => { prevented = true; },
    statusMessage: 'GPU process reset',
  }));

  assert.equal(prevented, true, 'the browser only restores a context the page claimed');
  assert.equal(ctx.contextLost, true);
  assert.equal(ctx.contextLostOverlay.style.display, 'flex');
  assert.match(ctx.contextLostDetail.textContent, /GPU process reset/);
  assert.equal(aborted.length, 1, 'the frozen recording was left running');
  assert.match(aborted[0], /GPU process reset/);
  assert.match(messages.join('\n'), /WebGL context lost: GPU process reset/);
});

test('a lost context with no recorder or reason still reports the loss', () => {
  const ctx = contextLossCtx();
  Daydream.prototype.setupContextLossHandling.call(ctx);

  const messages = captureConsole(
    () => ctx.handlers.webglcontextlost({ preventDefault: () => {} }));

  assert.equal(ctx.contextLost, true);
  assert.match(ctx.contextLostDetail.textContent, /no reason reported/);
  assert.match(messages.join('\n'), /no reason reported/);
});

test('a restored context clears the flag and forces a repaint', () => {
  const ctx = contextLossCtx();
  Daydream.prototype.setupContextLossHandling.call(ctx);

  captureConsole(() => {
    ctx.handlers.webglcontextlost({ preventDefault: () => {} });
    ctx.handlers.webglcontextrestored();
  });

  assert.equal(ctx.contextLost, false);
  assert.equal(ctx.contextLostOverlay.style.display, 'none');
  assert.equal(ctx.needsRender, true, 'the canvas would stay dark while paused');
});

// ---------------------------------------------------------------------------
// setupKeyboardOrbit
// ---------------------------------------------------------------------------

/** Minimal `this` for setupKeyboardOrbit: a canvas recording its class list.
 * @param {Object} state - Mutable `{ focusVisible }` the fake `matches` reads.
 * @returns {Object} Context object exposing `handlers` and `classes`.
 */
function orbitCtx(state) {
  const handlers = {};
  const classes = new Set();
  return {
    handlers,
    classes,
    canvas: {
      classList: {
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
        contains: (c) => classes.has(c),
        remove: (c) => classes.delete(c),
      },
      matches: () => state.focusVisible,
      addEventListener: (type, fn) => { handlers[type] = fn; },
    },
  };
}

test('a pointer-focused canvas stays unringed when a later keypress promotes it', () => {
  const state = { focusVisible: false };
  const ctx = orbitCtx(state);
  Daydream.prototype.setupKeyboardOrbit.call(ctx);

  ctx.handlers.focus();
  state.focusVisible = true; // any keydown promotes :focus-visible

  let defaultPrevented = false;
  ctx.handlers.keydown({
    key: 'ArrowLeft', preventDefault: () => { defaultPrevented = true; },
  });

  assert.equal(ctx.classes.has('keyboard-focus'), false);
  assert.equal(defaultPrevented, false, 'arrow key was stolen from the frame step');
});

test('a keyboard-focused canvas rings and orbits until it loses focus', () => {
  const state = { focusVisible: true };
  const ctx = orbitCtx(state);
  ctx.camera = new THREE.PerspectiveCamera();
  ctx.camera.position.set(0, 0, 100);
  ctx.controls = {
    target: new THREE.Vector3(),
    minPolarAngle: 0,
    maxPolarAngle: Math.PI,
    minDistance: 1,
    maxDistance: 1000,
    update: () => {},
  };
  Daydream.prototype.setupKeyboardOrbit.call(ctx);

  ctx.handlers.focus();
  assert.equal(ctx.classes.has('keyboard-focus'), true);

  ctx.handlers.keydown({
    key: 'ArrowLeft', preventDefault: () => {}, stopPropagation: () => {},
  });
  assert.ok(Math.abs(ctx.camera.position.x) > 1e-6, 'arrow key did not orbit');
  assert.equal(ctx.needsRender, true);

  ctx.handlers.blur();
  assert.equal(ctx.classes.has('keyboard-focus'), false);
});
