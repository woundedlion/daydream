// @ts-nocheck
//
// driver.js's three.js lifecycle: the DOM-free sizing/LOD helpers, plus the
// rebuild (setupDots) and teardown (dispose) paths driven over a fake mesh via
// prototype.call, so no WebGL context or DOM is needed. Both paths carry an
// ordering invariant — instanceColor.array must be nulled before
// InstancedMesh.dispose(), because that array may alias WASM memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Daydream, dotDetailFor, fitDistance } from '../driver.js';

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

/** Minimal `this` for dispose: everything it touches, nulled where optional.
 * @param {Object} mesh - Dot mesh to release.
 * @param {Array<string>} log - Ordered event sink.
 * @returns {Object} Context object for prototype.call.
 */
function disposeCtx(mesh, log) {
  return {
    resizeObserver: { disconnect: () => log.push('observer.disconnect') },
    canvas: { removeEventListener: () => log.push('canvas.off') },
    onContextLost: () => {},
    onContextRestored: () => {},
    contextLostOverlay: { remove: () => log.push('overlay.remove') },
    scene: { remove: () => log.push('scene.remove') },
    dotMesh: mesh,
    pixels: mesh.instanceColor.array,
    dotMaterial: { dispose: () => log.push('material.dispose') },
    xAxis: null,
    yAxis: null,
    zAxis: null,
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

  for (const step of ['observer.disconnect', 'canvas.off', 'overlay.remove',
                      'material.dispose', 'axisMaterial.dispose',
                      'controls.dispose', 'labelLayer.remove',
                      'renderer.dispose']) {
    assert.ok(log.includes(step), `dispose skipped ${step}`);
  }
  assert.ok(log.indexOf('renderer.stopLoop') < log.indexOf('renderer.dispose'));
});

test('dispose leaves no dangling mesh or pixel buffer', () => {
  const log = [];
  const ctx = disposeCtx(fakeMesh(log), log);
  Daydream.prototype.dispose.call(ctx);

  assert.equal(ctx.dotMesh, null);
  assert.equal(ctx.dotMaterial, null);
  assert.equal(ctx.pixels, null);
});
