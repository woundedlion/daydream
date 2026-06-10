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

/**
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
 * @returns {{ scene, camera, renderer, controls, sphere, lights, resize, dispose }}
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

  // Resize handling
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

  // Animation loop
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

/**
 * Copy text to the clipboard using the async Clipboard API, falling back to
 * the legacy execCommand path for non-secure contexts / older browsers.
 *
 * Feedback (button labels, "Copied!" spans, etc.) is left to the caller so
 * each tool keeps its own UI; this only performs the copy.
 *
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} Whether the copy succeeded
 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // Secure-context or permissions failure — fall through to the legacy path.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (err) {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}
