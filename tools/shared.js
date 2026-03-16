/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Shared Three.js scene setup for tool pages.
 *
 * Centralizes the common boilerplate: renderer, camera, OrbitControls,
 * reference sphere, resize handling, and animation loop.
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
 * @param {number} [opts.cameraDistance=3] - Initial camera distance
 * @param {Function} [opts.onAnimate] - Callback called every frame before render
 * @returns {{ scene, camera, renderer, controls, sphere }}
 */
export function initScene(containerId, canvasId, opts = {}) {
  const {
    background = 0x0f172a,
    sphereOpacity = 0.2,
    showSphere = true,
    cameraDistance = 3,
    onAnimate = null,
  } = opts;

  const container = document.getElementById(containerId);
  const canvas = document.getElementById(canvasId);
  const width = container.clientWidth;
  const height = container.clientHeight;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  camera.position.set(
    cameraDistance * 0.5,
    cameraDistance * 0.5,
    cameraDistance
  );

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 2;
  controls.maxDistance = 10;
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

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

  // Resize handling
  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  // Animation loop
  const animate = () => {
    requestAnimationFrame(animate);
    if (onAnimate) onAnimate();
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  return { scene, camera, renderer, controls, sphere };
}

/** Current Three.js version string used across all tools. */
export const THREE_VERSION = '0.160.0';
