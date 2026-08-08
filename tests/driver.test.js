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
import { Daydream, dotDetailFor, fitDistance, MOBILE_BREAKPOINT_PX } from '../driver.js';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './fake_dom.js';
import { fakeColorAttribute } from './fake_three.js';

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
// setCanvasSize
// ---------------------------------------------------------------------------

/**
 * Runs `body` with a global window reporting `dpr`, restoring whatever was there
 * (usually nothing, under node) afterwards.
 * @param {number} dpr - devicePixelRatio the renderer should read.
 * @param {Function} body - Code to run under the stubbed window.
 * @returns {*} Whatever `body` returned.
 */
function withDevicePixelRatio(dpr, body) {
  const had = 'window' in globalThis;
  const saved = globalThis.window;
  globalThis.window = { devicePixelRatio: dpr };
  try { return body(); } finally {
    if (had) globalThis.window = saved; else delete globalThis.window;
  }
}

/**
 * Minimal `this` for setCanvasSize: real perspective cameras (so aspect and the
 * projection matrix behave), an orbit stand-in at the class's distance limits,
 * and viewports seeded to a sentinel so an untouched one is visible.
 * @param {number} width - Container client width.
 * @param {number} height - Container client height.
 * @returns {Object} Context object for prototype.call.
 */
function sizeCtx(width, height) {
  const camera = new THREE.PerspectiveCamera(
    Daydream.CAMERA_FOV, 1, Daydream.CAMERA_NEAR, Daydream.CAMERA_FAR);
  camera.position.set(0, 0, Daydream.CAMERA_Z);
  const sized = [];
  const sentinel = () => ({ x: -1, y: -1, width: -1, height: -1 });
  return {
    sized,
    canvasParent: { clientWidth: width, clientHeight: height },
    mainViewport: sentinel(),
    pipViewport: sentinel(),
    isMobile: null,
    fittedDistance: 0,
    needsRender: false,
    camera,
    pipCamera: new THREE.PerspectiveCamera(
      Daydream.CAMERA_FOV, 3, Daydream.CAMERA_NEAR, Daydream.CAMERA_FAR),
    controls: {
      target: new THREE.Vector3(),
      minDistance: Daydream.CAMERA_NEAR + Daydream.SPHERE_RADIUS,
      maxDistance: Daydream.CAMERA_FAR - Daydream.SPHERE_RADIUS,
    },
    renderer: {
      pixelRatio: null,
      setPixelRatio(r) { this.pixelRatio = r; },
      setSize: (w, h) => sized.push(`renderer:${w}x${h}`),
    },
    labelRenderer: { setSize: (w, h) => sized.push(`labels:${w}x${h}`) },
  };
}

/** Resizes the container and re-runs the layout.
 * @param {Object} ctx - Context from sizeCtx().
 * @param {number} width - New container client width.
 * @param {number} height - New container client height.
 * @param {number} [dpr=1] - devicePixelRatio for this pass.
 * @returns {void}
 */
function resize(ctx, width, height, dpr = 1) {
  ctx.canvasParent.clientWidth = width;
  ctx.canvasParent.clientHeight = height;
  withDevicePixelRatio(dpr, () => Daydream.prototype.setCanvasSize.call(ctx));
}

/** Orbit radius the context's camera currently sits at.
 * @param {Object} ctx - Context from sizeCtx().
 * @returns {number} Distance from the orbit target.
 */
const orbitRadius = (ctx) => ctx.camera.position.distanceTo(ctx.controls.target);

/** Fraction of the view height the sphere's diameter covers at the current fit.
 * @param {Object} ctx - Context from sizeCtx().
 * @returns {number} Vertical coverage, 0..1.
 */
function verticalCoverage(ctx) {
  const visibleHeight = 2 * Math.tan(halfFovRad) * orbitRadius(ctx);
  return Daydream.SPHERE_RADIUS * 2 / visibleHeight;
}

test('setCanvasSize leaves everything alone on a 0-sized container', () => {
  const ctx = sizeCtx(0, 0);
  resize(ctx, 0, 0);

  // aspect = 0/0 would poison the projection matrix for every later frame.
  assert.equal(ctx.camera.aspect, 1);
  assert.deepEqual(ctx.mainViewport, { x: -1, y: -1, width: -1, height: -1 });
  assert.deepEqual(ctx.sized, []);
  assert.equal(ctx.needsRender, false);

  resize(ctx, 1200, 0);
  assert.deepEqual(ctx.sized, [], 'a zero-height container still laid out');
});

test('setCanvasSize fits the renderer, label layer, and camera to the container', () => {
  const ctx = sizeCtx(1200, 800);
  resize(ctx, 1200, 800);

  assert.deepEqual(ctx.mainViewport, { x: 0, y: 0, width: 1200, height: 800 });
  assert.deepEqual(ctx.sized, ['renderer:1200x800', 'labels:1200x800']);
  assert.equal(ctx.camera.aspect, 1200 / 800);
  assert.equal(ctx.needsRender, true);
});

test('setCanvasSize switches to the compact layout at the breakpoint', () => {
  const wide = sizeCtx(MOBILE_BREAKPOINT_PX + 1, 600);
  resize(wide, MOBILE_BREAKPOINT_PX + 1, 600);
  assert.equal(wide.isMobile, false);

  const narrow = sizeCtx(MOBILE_BREAKPOINT_PX, 600);
  resize(narrow, MOBILE_BREAKPOINT_PX, 600);
  assert.equal(narrow.isMobile, true);
});

test('setCanvasSize anchors a square PiP to the top-right corner', () => {
  const ctx = sizeCtx(1200, 800);
  resize(ctx, 1200, 800);

  const { x, y, width, height } = ctx.pipViewport;
  assert.equal(width, height, 'the PiP viewport is not square');
  assert.equal(height, Math.floor(800 * 0.3), 'the PiP is not 30% of the smaller dimension');
  assert.equal(x + width, 1200, 'the PiP is not flush with the right edge');
  assert.equal(y, 0);
  assert.equal(ctx.pipCamera.aspect, 1, 'a non-square PiP camera distorts the corner view');
});

test('setCanvasSize sizes the PiP off the short side on a portrait container', () => {
  const ctx = sizeCtx(400, 1000);
  resize(ctx, 400, 1000);

  assert.equal(ctx.pipViewport.width, Math.floor(400 * 0.3));
});

test('setCanvasSize frames the sphere on the first layout', () => {
  const ctx = sizeCtx(1200, 800);
  resize(ctx, 1200, 800);

  assert.ok(Math.abs(verticalCoverage(ctx) - 0.85) < 1e-12);
  // setLength rescales the radius only, so the starting orbit direction survives.
  assert.equal(ctx.camera.position.x, 0);
  assert.equal(ctx.camera.position.y, 0);
});

test('setCanvasSize backs the camera off when the container turns portrait', () => {
  const ctx = sizeCtx(1200, 800);
  resize(ctx, 1200, 800);
  const landscape = orbitRadius(ctx);

  resize(ctx, 800, 1200);
  assert.ok(orbitRadius(ctx) > landscape, 'a portrait view clipped the sphere');
  // Width is the binding dimension below aspect 1, so the sphere covers 85% of it.
  assert.ok(Math.abs(verticalCoverage(ctx) / ctx.camera.aspect - 0.85) < 1e-9);
});

test('setCanvasSize preserves a user zoom across a later resize', () => {
  const ctx = sizeCtx(1200, 800);
  resize(ctx, 1200, 800);
  const fitted = ctx.fittedDistance;

  ctx.camera.position.setLength(fitted * 1.8); // the user dollied out
  resize(ctx, 800, 1200);

  assert.ok(Math.abs(orbitRadius(ctx) - fitted * 1.8) < 1e-9,
    'the resize stole the user zoom');
  assert.equal(ctx.fittedDistance, fitted, 'a preserved zoom moved the fit anchor');
});

test('setCanvasSize re-fits a radius still within a permille of the fit', () => {
  const ctx = sizeCtx(1200, 800);
  resize(ctx, 1200, 800);
  const fitted = ctx.fittedDistance;

  // Float noise from the orbit controls, not a user zoom: snapped back.
  ctx.camera.position.setLength(fitted * (1 + 5e-4));
  resize(ctx, 1200, 800, 2);
  assert.ok(Math.abs(orbitRadius(ctx) - fitted) < 1e-9, 'sub-permille drift was read as a zoom');

  // A tenfold larger offset is a deliberate zoom and survives the same resize.
  ctx.camera.position.setLength(fitted * (1 + 5e-3));
  resize(ctx, 1200, 800, 1);
  assert.ok(Math.abs(orbitRadius(ctx) - fitted * (1 + 5e-3)) < 1e-9,
    'a real zoom was snapped back to the fit');
});

test('setCanvasSize re-fits after a rotation, which leaves the radius alone', () => {
  const ctx = sizeCtx(1200, 800);
  resize(ctx, 1200, 800);
  const fitted = ctx.fittedDistance;

  ctx.camera.position.set(fitted, 0, 0); // orbited, same radius
  resize(ctx, 800, 1200);

  assert.ok(ctx.fittedDistance > fitted, 'rotation blocked the portrait re-fit');
  assert.ok(Math.abs(ctx.camera.position.x - ctx.fittedDistance) < 1e-9,
    're-fitting rotated the camera');
  assert.equal(ctx.camera.position.y, 0);
});

test('setCanvasSize caps the pixel ratio at the CSS resolution', () => {
  const ctx = sizeCtx(1200, 800);

  resize(ctx, 1200, 800, 3);
  assert.equal(ctx.renderer.pixelRatio, 1, 'a 3x display rendered at 3x fill cost');

  resize(ctx, 1200, 800, 0.75);
  assert.equal(ctx.renderer.pixelRatio, 0.75, 'a sub-1x display was upscaled');
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
  const handlers = {
    onContextLost: () => {},
    onContextRestored: () => {},
    onCanvasKeyDown: () => {},
    onCanvasFocus: () => {},
    onCanvasBlur: () => {},
  };
  // Pre-registered exactly as setupContextLossHandling() and
  // setupKeyboardOrbit() register them, so a removal that drifts on handler
  // identity or capture flag throws in fakeElement instead of leaving the
  // listener on a canvas the page is done with.
  const canvas = fakeElement('canvas');
  canvas.addEventListener('webglcontextlost', handlers.onContextLost, false);
  canvas.addEventListener('webglcontextrestored', handlers.onContextRestored, false);
  canvas.addEventListener('keydown', handlers.onCanvasKeyDown);
  canvas.addEventListener('focus', handlers.onCanvasFocus);
  canvas.addEventListener('blur', handlers.onCanvasBlur);
  return {
    resizeObserver: { disconnect: () => log.push('observer.disconnect') },
    canvas,
    ...handlers,
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
      forceContextLoss: () => log.push('renderer.loseContext'),
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

  for (const step of ['observer.disconnect',
                      'overlay.remove', 'material.dispose', 'axisMaterial.dispose',
                      'controls.dispose', 'labelLayer.remove',
                      'renderer.dispose', 'renderer.loseContext']) {
    assert.ok(log.includes(step), `dispose skipped ${step}`);
  }
  assert.deepEqual(ctx.canvas.listeners, [],
    'a listener outlived the canvas it was bound to');
  assert.ok(log.indexOf('renderer.stopLoop') < log.indexOf('renderer.dispose'));
  assert.ok(log.indexOf('renderer.dispose') < log.indexOf('renderer.loseContext'),
    'the drawing context was released before the renderer freed its objects');
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
    recorder: null,
    heldCaptures: 0,
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

/** Recorder stand-in counting the frames a session was asked to capture.
 * @param {Array<string>} [log] - Ordered event sink shared with renderCtx().
 * @returns {Object} Recorder exposing `frames` and captureFrame().
 */
function fakeRecorder(log) {
  return { frames: 0, captureFrame() { this.frames++; log?.push('captureFrame'); } };
}

/** Turns a render context into one whose clock releases a simulation tick.
 * @param {Object} ctx - Context from renderCtx().
 * @param {Array<string>} [log] - Ordered event sink shared with renderCtx().
 * @returns {Object} The same context, running with one interval accrued.
 */
function runningCtx(ctx, log) {
  ctx.paused = false;
  ctx.timeAccumulator = 1; // clamped to the backlog cap, then one interval consumed
  ctx.stepSimulation = () => true;
  ctx.recorder = fakeRecorder(log);
  return ctx;
}

test('render captures one frame per advanced tick, after painting it', () => {
  const log = [];
  const ctx = runningCtx(renderCtx(new Uint16Array(4), log), log);
  Daydream.prototype.render.call(ctx, null);

  assert.equal(ctx.recorder.frames, 1);
  assert.deepEqual(
    log.filter((e) => e === 'renderMainView' || e === 'captureFrame'),
    ['renderMainView', 'captureFrame'],
    'captured a canvas this task had not painted');
});

test('a tick whose repaint a heap growth held captures on the next repaint', () => {
  const log = [];
  const ctx = runningCtx(renderCtx(detachedView(), log), log);
  Daydream.prototype.render.call(ctx, null);

  assert.ok(!log.includes('renderMainView'), 'rendered from a detached array');
  assert.equal(ctx.needsRender, true);
  assert.equal(ctx.recorder.frames, 0, 'blitted a canvas this task never painted');
  assert.equal(ctx.heldCaptures, 1);

  // The next drawFrame re-points the alias, so the deferred frame lands with it.
  ctx.dotMesh.instanceColor.array = new Uint16Array(4);
  ctx.timeAccumulator = 1;
  Daydream.prototype.render.call(ctx, null);

  assert.ok(log.includes('renderMainView'));
  // The track is locked one frame per tick; dropping one shortens the video.
  assert.equal(ctx.recorder.frames, 2, 'an advanced tick produced no video frame');
  assert.equal(ctx.heldCaptures, 0);
});

test('a held repaint that advanced no tick captures nothing', () => {
  const log = [];
  const ctx = renderCtx(detachedView(), log);
  ctx.recorder = fakeRecorder(log);
  Daydream.prototype.render.call(ctx, null);

  assert.equal(ctx.recorder.frames, 0);
  assert.equal(ctx.heldCaptures, 0);
});

test('a held tick honours captureReady before capturing', () => {
  const log = [];
  const ctx = runningCtx(renderCtx(detachedView(), log), log);
  Daydream.prototype.render.call(ctx, { captureReady: () => false });

  assert.equal(ctx.recorder.frames, 0, 'captured the cleared pre-composite buffer');
  assert.equal(ctx.heldCaptures, 0, 'deferred a capture captureReady refused');
});

// ---------------------------------------------------------------------------
// renderPip
// ---------------------------------------------------------------------------

/** Minimal `this` for renderPip: a desktop view with the toggle on.
 * @param {Array<string>} log - Ordered event sink.
 * @returns {Object} Context object for prototype.call.
 */
function pipCtx(log) {
  return {
    showPip: true,
    isMobile: false,
    recorder: null,
    pipViewport: { x: 70, y: 0, width: 30, height: 30 },
    camera: {
      position: new THREE.Vector3(0, 40, 90),
      quaternion: new THREE.Quaternion(0, 1, 0, 0),
    },
    pipCamera: {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
    },
    renderer: {
      setViewport: (...a) => log.push(`viewport:${a.join(',')}`),
      setScissor: (...a) => log.push(`scissor:${a.join(',')}`),
      render: () => log.push('render'),
    },
  };
}

/**
 * Runs `body` with navigator.webdriver set, as a headless automation driver
 * leaves it, restoring the real navigator afterwards.
 * @param {Function} body - Code to run under the stubbed navigator.
 * @returns {void}
 */
function withWebdriver(body) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator',
    { value: { webdriver: true }, configurable: true });
  try { body(); } finally { Object.defineProperty(globalThis, 'navigator', saved); }
}

test('renderPip draws the corner view into its own scissored viewport', () => {
  const log = [];
  const ctx = pipCtx(log);
  Daydream.prototype.renderPip.call(ctx);

  assert.deepEqual(log, ['viewport:70,0,30,30', 'scissor:70,0,30,30', 'render']);
});

test('renderPip points the PiP camera at the main camera pose', () => {
  const log = [];
  const ctx = pipCtx(log);
  Daydream.prototype.renderPip.call(ctx);

  assert.deepEqual(ctx.pipCamera.position.toArray(), ctx.camera.position.toArray());
  assert.deepEqual(ctx.pipCamera.quaternion.toArray(), ctx.camera.quaternion.toArray());
});

test('renderPip skips the second mesh pass while the toggle is off', () => {
  const log = [];
  const ctx = pipCtx(log);
  ctx.showPip = false;
  Daydream.prototype.renderPip.call(ctx);

  assert.deepEqual(log, [], 'the toggle did not suppress the PiP pass');
});

test('renderPip stays suppressed on mobile and while recording', () => {
  for (const suppress of [
    (ctx) => { ctx.isMobile = true; },
    (ctx) => { ctx.recorder = { isRecording: true }; },
  ]) {
    const log = [];
    const ctx = pipCtx(log);
    suppress(ctx);
    Daydream.prototype.renderPip.call(ctx);
    assert.deepEqual(log, []);
  }
});

test('renderPip stays suppressed under headless automation', () => {
  const log = [];
  const ctx = pipCtx(log);
  withWebdriver(() => Daydream.prototype.renderPip.call(ctx));

  assert.deepEqual(log, []);
});

test('a live recording suppresses the PiP even with the toggle on', () => {
  const log = [];
  const ctx = pipCtx(log);
  ctx.recorder = { isRecording: false };
  Daydream.prototype.renderPip.call(ctx);
  assert.ok(log.includes('render'));

  log.length = 0;
  ctx.recorder.isRecording = true;
  Daydream.prototype.renderPip.call(ctx);
  assert.deepEqual(log, []);
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
  assert.equal(ctx.contextLostOverlay.getAttribute('role'), 'alert');
  assert.equal(ctx.contextLostOverlay.tabIndex, -1);
  assert.equal(ctx.contextLostOverlay.style.display, 'none');
});

test('a lost context claims the restore, shows the reason, and aborts the recording', () => {
  const aborted = [];
  const ctx = contextLossCtx({ abort: (message) => aborted.push(message) });
  Daydream.prototype.setupContextLossHandling.call(ctx);
  const focusCalls = [];
  ctx.contextLostOverlay.focus = (options) => focusCalls.push(options);

  let prevented = false;
  const messages = captureConsole(() => ctx.handlers.webglcontextlost({
    preventDefault: () => { prevented = true; },
    statusMessage: 'GPU process reset',
  }));

  assert.equal(prevented, true, 'the browser only restores a context the page claimed');
  assert.equal(ctx.contextLost, true);
  assert.equal(ctx.contextLostOverlay.style.display, 'flex');
  assert.deepEqual(focusCalls, [{ preventScroll: true }]);
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

  let propagationStopped = false;
  ctx.handlers.keydown({
    key: 'ArrowLeft',
    preventDefault: () => {},
    stopPropagation: () => { propagationStopped = true; },
  });
  assert.ok(Math.abs(ctx.camera.position.x) > 1e-6, 'arrow key did not orbit');
  assert.equal(ctx.needsRender, true);
  assert.equal(propagationStopped, true,
    'the window handler reads the same arrow key as a paused frame step');

  ctx.handlers.blur();
  assert.equal(ctx.classes.has('keyboard-focus'), false);
});

// ---------------------------------------------------------------------------
// precomputeMatrices / updateResolution
// ---------------------------------------------------------------------------

/** Minimal `this` for precomputeMatrices: a grid and a mesh recording its matrices.
 * @param {number} w - Grid width in pixels.
 * @param {number} h - Grid height in pixels.
 * @returns {Object} Context object for prototype.call, carrying the matrix log.
 */
function matricesCtx(w, h) {
  const matrices = [];
  return {
    W: w,
    H: h,
    H_OFFSET: Daydream.H_OFFSET,
    pixels: null,
    matrices,
    dotMesh: {
      count: w * h,
      instanceColor: null,
      instanceMatrix: { needsUpdate: false },
      setMatrixAt: (i, m) => { matrices[i] = m.clone(); },
    },
  };
}

/** Instance position for pixel index `i`.
 * @param {Object} ctx - Context from matricesCtx() after the call.
 * @param {number} i - Instance index.
 * @returns {THREE.Vector3} The dot centre.
 */
const dotAt = (ctx, i) =>
  new THREE.Vector3().setFromMatrixPosition(ctx.matrices[i]);

test('precomputeMatrices places one dot per pixel on the sphere surface', () => {
  const ctx = matricesCtx(8, 5);
  Daydream.prototype.precomputeMatrices.call(ctx);

  assert.equal(ctx.matrices.length, 8 * 5);
  for (let i = 0; i < 8 * 5; i++) {
    assert.ok(Math.abs(dotAt(ctx, i).length() - Daydream.SPHERE_RADIUS) < 1e-4,
      `instance ${i} left the sphere surface`);
  }
});

test('precomputeMatrices faces every dot outward', () => {
  const ctx = matricesCtx(8, 5);
  Daydream.prototype.precomputeMatrices.call(ctx);

  for (let i = 0; i < 8 * 5; i++) {
    const e = ctx.matrices[i].elements;
    // The injected shader hides a dot by its outward normal and extends it along
    // local +x, so local +z must be the surface normal.
    const forward = new THREE.Vector3(e[8], e[9], e[10]).normalize();
    assert.ok(forward.dot(dotAt(ctx, i).normalize()) > 1 - 1e-6,
      `instance ${i} faces into the sphere`);
  }
});

test('precomputeMatrices lays rows out north to south and columns apart', () => {
  const ctx = matricesCtx(8, 5);
  Daydream.prototype.precomputeMatrices.call(ctx);

  for (let y = 1; y < 5; y++) {
    assert.ok(dotAt(ctx, y * 8).y < dotAt(ctx, (y - 1) * 8).y,
      `row ${y} did not descend`);
  }
  const seen = new Set();
  for (let x = 0; x < 8; x++) {
    const p = dotAt(ctx, 8 + x);
    seen.add(`${p.x.toFixed(5)},${p.z.toFixed(5)}`);
  }
  assert.equal(seen.size, 8, 'columns of one row shared a position');
});

test('precomputeMatrices allocates a zeroed color buffer the driver aliases', () => {
  const ctx = matricesCtx(8, 5);
  Daydream.prototype.precomputeMatrices.call(ctx);

  const attribute = ctx.dotMesh.instanceColor;
  assert.equal(attribute.itemSize, 3);
  assert.equal(attribute.array.length, 8 * 5 * 3);
  assert.ok(attribute.array.every((v) => v === 0));
  assert.equal(ctx.pixels, attribute.array, 'driver.pixels does not alias the buffer');
});

test('precomputeMatrices keeps an existing color buffer rather than reallocating', () => {
  const ctx = matricesCtx(8, 5);
  const wasmView = new Uint16Array(8 * 5 * 3).fill(7);
  ctx.dotMesh.instanceColor =
    new THREE.InstancedBufferAttribute(wasmView, 3, true);
  Daydream.prototype.precomputeMatrices.call(ctx);

  // Reallocating would strand the engine, which writes through this same view.
  assert.equal(ctx.dotMesh.instanceColor.array, wasmView);
  assert.equal(ctx.pixels, wasmView);
  assert.ok(wasmView.every((v) => v === 0), 'the reused buffer kept a stale frame');
});

test('precomputeMatrices flags both instance attributes for upload', () => {
  const ctx = matricesCtx(8, 5);
  Daydream.prototype.precomputeMatrices.call(ctx);

  assert.equal(ctx.dotMesh.instanceMatrix.needsUpdate, true);
  assert.equal(ctx.dotMesh.instanceColor.version, 1);
});

test('precomputeMatrices tolerates a driver with no mesh yet', () => {
  const ctx = matricesCtx(8, 5);
  ctx.dotMesh = null;
  Daydream.prototype.precomputeMatrices.call(ctx);

  assert.equal(ctx.pixels, null);
});

test('updateResolution rebuilds the mesh and buffer at the new grid', () => {
  const log = [];
  const ctx = setupCtx(fakeMesh(log), log);
  ctx.H_OFFSET = Daydream.H_OFFSET;
  ctx.setupDots = Daydream.prototype.setupDots;
  ctx.precomputeMatrices = Daydream.prototype.precomputeMatrices;
  ctx.invalidate = Daydream.prototype.invalidate;

  Daydream.prototype.updateResolution.call(ctx, 12, 6, 5);

  assert.equal(ctx.W, 12);
  assert.equal(ctx.H, 6);
  assert.equal(ctx.DOT_SIZE, 5);
  assert.equal(ctx.dotMesh.count, 12 * 6);
  assert.equal(ctx.dotGeometry.parameters.radius, 5);
  assert.equal(ctx.pixels.length, 12 * 6 * 3);
  // The rebuilt buffer is black; without a repaint the pre-resize image sticks.
  assert.equal(ctx.needsRender, true);
});

// ---------------------------------------------------------------------------
// updateCullUniforms
// ---------------------------------------------------------------------------

/** Minimal `this` for updateCullUniforms: a bound material's uniform block.
 * @returns {Object} Context object for prototype.call.
 */
function cullCtx() {
  return {
    W: 96,
    DOT_SIZE: Daydream.DEFAULT_DOT_SIZE,
    camera: { position: new THREE.Vector3(3, -4, 12) },
    cullBackSphere: false,
    strobeColumns: true,
    columnFillOverlap: 1.15,
    cullUniforms: {
      uCameraPos: { value: new THREE.Vector3() },
      uCullThreshold: { value: NaN },
      uColumnFillArc: { value: NaN },
    },
  };
}

/** Stable serialization of a context: own keys in order, Vector3s flattened.
 * three.js objects defeat structuredClone, so compare projections instead.
 * @param {Object} ctx - Context object to project.
 * @returns {string} String that differs if any reachable field changed.
 */
function cullCtxProjection(ctx) {
  return JSON.stringify(ctx, (key, value) =>
    value && value.isVector3 ? value.toArray() : value);
}

test('updateCullUniforms publishes the live camera position', () => {
  const ctx = cullCtx();
  Daydream.prototype.updateCullUniforms.call(ctx);

  assert.deepEqual(ctx.cullUniforms.uCameraPos.value.toArray(), [3, -4, 12]);
});

test('updateCullUniforms culls nothing until back-face culling is on', () => {
  const ctx = cullCtx();
  Daydream.prototype.updateCullUniforms.call(ctx);
  // The shader compares a normalized dot product, so nothing reaches below -1.
  assert.ok(ctx.cullUniforms.uCullThreshold.value < -1,
    'the far hemisphere was culled with the toggle off');

  ctx.cullBackSphere = true;
  Daydream.prototype.updateCullUniforms.call(ctx);
  const threshold = ctx.cullUniforms.uCullThreshold.value;
  assert.ok(threshold > -1 && threshold < 0,
    'culling kept the far hemisphere, or ate the visible one');
});

test('updateCullUniforms gap-fills columns only for a persisting effect', () => {
  const ctx = cullCtx();
  Daydream.prototype.updateCullUniforms.call(ctx);
  assert.equal(ctx.cullUniforms.uColumnFillArc.value, 0, 'strobed dots were smeared');

  ctx.strobeColumns = false;
  Daydream.prototype.updateCullUniforms.call(ctx);
  const arc = ctx.cullUniforms.uColumnFillArc.value;
  assert.ok(arc > 0);

  // The fill is a per-column half-arc: twice the columns, half the arc.
  ctx.W = 192;
  Daydream.prototype.updateCullUniforms.call(ctx);
  assert.ok(Math.abs(ctx.cullUniforms.uColumnFillArc.value - arc / 2) < 1e-9);

  // Overlap scales it linearly.
  ctx.W = 96;
  ctx.columnFillOverlap *= 2;
  Daydream.prototype.updateCullUniforms.call(ctx);
  assert.ok(Math.abs(ctx.cullUniforms.uColumnFillArc.value - arc * 2) < 1e-9);
});

test('updateCullUniforms is a no-op before the material has compiled', () => {
  const ctx = cullCtx();
  ctx.cullUniforms = null;
  const before = cullCtxProjection(ctx);
  Daydream.prototype.updateCullUniforms.call(ctx);
  assert.equal(cullCtxProjection(ctx), before,
    'the uncompiled-material path wrote to the context');
});

// ---------------------------------------------------------------------------
// refreshLabels
// ---------------------------------------------------------------------------

/** Minimal `this` for refreshLabels: a label pool recording what it was handed.
 * @param {THREE.Vector3} cameraPosition - Where the camera sits this frame.
 * @returns {Object} Context object for prototype.call, carrying `acquired`.
 */
function labelCtx(cameraPosition) {
  const acquired = [];
  return {
    acquired,
    labelAxes: true,
    camera: { position: cameraPosition },
    labelPool: {
      activeCount: 0,
      cleanups: 0,
      reset() { acquired.length = 0; },
      acquire(position, content) { acquired.push({ position, content }); },
      cleanup() { this.cleanups++; },
    },
  };
}

/** Label texts acquired this frame.
 * @param {Object} ctx - Context from labelCtx() after the call.
 * @returns {Array<string>} Acquired label contents.
 */
const labelTexts = (ctx) => ctx.acquired.map((a) => a.content);

test('refreshLabels acquires only the camera-facing axis ends', () => {
  const ctx = labelCtx(new THREE.Vector3(1, 1, 1).setLength(Daydream.CAMERA_Z));
  Daydream.prototype.refreshLabels.call(ctx);

  assert.deepEqual(labelTexts(ctx), ['X', 'Y', 'Z']);
  assert.equal(ctx.labelPool.cleanups, 1, 'surplus labels from last frame were left up');
});

test('refreshLabels keeps the visible set the same at any orbit distance', () => {
  const direction = new THREE.Vector3(0.25, 1, 0.4).normalize();

  const near = labelCtx(direction.clone().setLength(140));
  Daydream.prototype.refreshLabels.call(near);
  const far = labelCtx(direction.clone().setLength(900));
  Daydream.prototype.refreshLabels.call(far);

  assert.deepEqual(labelTexts(far), labelTexts(near));
  assert.ok(labelTexts(near).length > 0 && labelTexts(near).length < 6);
});

test('refreshLabels hands the pool the unscaled axis direction', () => {
  const ctx = labelCtx(new THREE.Vector3(0, 0, Daydream.CAMERA_Z));
  Daydream.prototype.refreshLabels.call(ctx);

  assert.deepEqual(labelTexts(ctx), ['Z']);
  assert.equal(ctx.acquired[0].position, Daydream.Z_AXIS);
});

test('refreshLabels acquires nothing while the axes are hidden', () => {
  const ctx = labelCtx(new THREE.Vector3(1, 1, 1).setLength(Daydream.CAMERA_Z));
  ctx.labelAxes = false;
  Daydream.prototype.refreshLabels.call(ctx);

  assert.deepEqual(labelTexts(ctx), []);
  assert.equal(ctx.labelPool.cleanups, 1, 'labels from the previous frame were stranded');
});

// ---------------------------------------------------------------------------
// keydown (pause / single-step)
// ---------------------------------------------------------------------------

/** Keydown event stand-in recording whether the default was prevented.
 * @param {string} key - The pressed key.
 * @returns {Object} Event with a `prevented` flag.
 */
function keyEvent(key) {
  return { key, prevented: false, preventDefault() { this.prevented = true; } };
}

test('space pauses and resumes, dropping any queued step on resume', () => {
  const ctx = { paused: false, stepFrames: 3 };

  const pause = keyEvent(' ');
  Daydream.prototype.keydown.call(ctx, pause);
  assert.equal(ctx.paused, true);
  // Space also scrolls the page on the mobile layout.
  assert.equal(pause.prevented, true);

  Daydream.prototype.keydown.call(ctx, keyEvent(' '));
  assert.equal(ctx.paused, false);
  assert.equal(ctx.stepFrames, 0, 'a queued step survived the resume');
});

test('right-arrow queues single frames only while paused', () => {
  const ctx = { paused: false, stepFrames: 0 };

  const running = keyEvent('ArrowRight');
  Daydream.prototype.keydown.call(ctx, running);
  assert.equal(ctx.stepFrames, 0);
  assert.equal(running.prevented, false, 'the arrow key was stolen from the orbit');

  ctx.paused = true;
  const stepped = keyEvent('ArrowRight');
  Daydream.prototype.keydown.call(ctx, stepped);
  Daydream.prototype.keydown.call(ctx, keyEvent('ArrowRight'));
  assert.equal(ctx.stepFrames, 2, 'held steps did not queue');
  assert.equal(stepped.prevented, true);
});

test('keydown ignores keys it does not own', () => {
  const ctx = { paused: true, stepFrames: 0 };
  const other = keyEvent('ArrowLeft');
  Daydream.prototype.keydown.call(ctx, other);

  assert.equal(ctx.paused, true);
  assert.equal(ctx.stepFrames, 0);
  assert.equal(other.prevented, false);
});
