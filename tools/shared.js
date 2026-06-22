/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Shared Three.js scene setup for tool pages.
 *
 * Centralizes the common boilerplate: renderer, camera, OrbitControls,
 * optional reference sphere / light rig, resize handling, and animation loop.
 *
 * Usage:
 *   import { initScene } from '../tools/shared.js';
 *   const { scene, camera, renderer, controls } = initScene('canvasContainer', 'threeCanvas', {
 *     background: 0x0f172a,
 *     sphereOpacity: 0.2,
 *   });
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// The clipboard helpers live in their own dependency-free module so non-3D
// pages can import them without pulling Three.js in. Re-exported here for the
// scene-based callers that already depend on this module.
export { copyToClipboard, copyWithFeedback } from './clipboard.js';

/**
 * Render a visible error banner across the top of the page. Tool pages that
 * boot a WASM engine call this from their bootstrap catch so a missing or
 * failed-to-load artifact surfaces to the user, instead of leaving a blank
 * canvas with only a console line (mirrors the segmented view's fault overlay).
 * Idempotent — repeated calls update the single banner.
 *
 * @param {string} message - Human-readable failure description.
 */
export function showFatalError(message) {
  const existing = document.getElementById('fatal-error-overlay');
  const el = existing || document.createElement('div');
  el.id = 'fatal-error-overlay';
  el.textContent = `⚠ ${message}`; // textContent, not innerHTML — no injection
  Object.assign(el.style, {
    position: 'fixed', top: '0', left: '0', right: '0', zIndex: '9999',
    padding: '12px 16px', background: '#7f1d1d', color: '#fff',
    font: '14px/1.4 system-ui, sans-serif', textAlign: 'center',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
  });
  if (!existing && document.body) document.body.appendChild(el);
}

/**
 * Build a ready-to-run Three.js scene (renderer, perspective camera,
 * OrbitControls, optional reference sphere / light rig) wired into the given
 * DOM elements, then start the animation loop. Returns handles plus a dispose()
 * to tear it back down.
 *
 * @param {string} containerId - ID of the parent container div
 * @param {string} canvasId - ID of the canvas element
 * @param {object} [opts] - Optional configuration
 * @param {number} [opts.background=0x0f172a] - Scene background color
 * @param {number} [opts.sphereOpacity=0.2] - Opacity of reference sphere wireframe
 * @param {boolean} [opts.showSphere=true] - Whether to show a reference sphere
 * @param {number} [opts.cameraDistance=3] - Initial camera distance (ignored if cameraPosition is set)
 * @param {number[]} [opts.cameraPosition] - Explicit initial camera position [x, y, z]
 * @param {number} [opts.near=0.1] - Camera near plane
 * @param {number} [opts.far=1000] - Camera far plane
 * @param {number} [opts.minDistance=2] - OrbitControls minimum distance
 * @param {number} [opts.maxDistance=10] - OrbitControls maximum distance
 * @param {boolean} [opts.alpha=false] - Whether the renderer keeps a transparent buffer
 * @param {boolean} [opts.autoRotate=false] - OrbitControls auto-rotation
 * @param {number} [opts.autoRotateSpeed=2.0] - Auto-rotation speed
 * @param {boolean} [opts.lights=false] - Add the standard ambient + directional + rim light rig
 * @param {Function} [opts.onAnimate] - Callback run every frame before controls.update()
 * @param {Function} [opts.onAfterRender] - Callback run every frame after the render
 * @param {Function} [opts.onResize] - Custom resize handler (replaces the default aspect/size update)
 * @returns {{scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, controls: OrbitControls, sphere: (THREE.Mesh|null), lights: Array<THREE.Light>, resize: Function, dispose: Function}} Scene handles, the resize callback, and a dispose() to tear the scene down.
 */
export function initScene(containerId, canvasId, opts = {}) {
  const {
    background = 0x0f172a,
    sphereOpacity = 0.2,
    showSphere = true,
    cameraDistance = 3,
    cameraPosition = null,
    near = 0.1,
    far = 1000,
    minDistance = 2,
    maxDistance = 10,
    alpha = false,
    autoRotate = false,
    autoRotateSpeed = 2.0,
    lights = false,
    onAnimate = null,
    onAfterRender = null,
    onResize = null,
  } = opts;

  const container = document.getElementById(containerId);
  const canvas = document.getElementById(canvasId);
  // Fail with a clear, id-naming error rather than the opaque
  // "Cannot read clientWidth of null" a wrong id otherwise throws three lines
  // down — matching the guarded-lookup discipline in slider.js / createSlider.
  if (!container) {
    throw new Error(`initScene: container element #${containerId} not found`);
  }
  if (!canvas) {
    throw new Error(`initScene: canvas element #${canvasId} not found`);
  }
  const width = container.clientWidth;
  const height = container.clientHeight;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);

  const camera = new THREE.PerspectiveCamera(45, width / height, near, far);
  if (cameraPosition) {
    camera.position.set(cameraPosition[0], cameraPosition[1], cameraPosition[2]);
  } else {
    camera.position.set(cameraDistance * 0.5, cameraDistance * 0.5, cameraDistance);
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = minDistance;
  controls.maxDistance = maxDistance;
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.autoRotate = autoRotate;
  controls.autoRotateSpeed = autoRotateSpeed;

  let sphere = null;
  if (showSphere) {
    const geo = new THREE.SphereGeometry(1.0, 64, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x334155,
      wireframe: true,
      transparent: true,
      opacity: sphereOpacity,
    });
    sphere = new THREE.Mesh(geo, mat);
    sphere.renderOrder = 0;
    scene.add(sphere);
  }

  const lightRig = [];
  if (lights) {
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);
    lightRig.push(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 1);
    directional.position.set(5, 10, 7);
    scene.add(directional);
    lightRig.push(directional);

    const rim = new THREE.SpotLight(0x3b82f6, 5);
    rim.position.set(-5, 0, -5);
    scene.add(rim);
    lightRig.push(rim);
  }

  const defaultResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  const resize = onResize
    ? () => onResize({ scene, camera, renderer, controls })
    : defaultResize;
  window.addEventListener('resize', resize);

  let rafId = 0;
  const animate = () => {
    rafId = requestAnimationFrame(animate);
    if (onAnimate) onAnimate();
    controls.update();
    renderer.render(scene, camera);
    if (onAfterRender) onAfterRender();
  };
  animate();

  // Stop the render loop and detach the resize listener. Tool pages are
  // long-lived so this rarely matters, but it mirrors the dispose discipline
  // in driver.js / daydream.js and gives callers an off switch.
  const dispose = () => {
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', resize);
    controls.dispose();
    renderer.dispose();
  };

  return { scene, camera, renderer, controls, sphere, lights: lightRig, resize, dispose };
}
