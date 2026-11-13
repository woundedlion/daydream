/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream } from "./driver.js";

/**
 * Give the canvas a keyboard route to the orbit controls, which OrbitControls
 * itself exposes only to pointer input: arrow keys rotate about the orbit
 * target, +/- dolly in and out.
 * @param {import('./driver.js').Daydream} driver - Display state.
 */
export function setupKeyboardOrbit(driver) {
  const offset = new THREE.Vector3();
  const spherical = new THREE.Spherical();

  // :focus-visible promotes a pointer-focused element the moment any key is
  // pressed, so a global shortcut (space) would ring the whole viewport.
  // Latch the arrival modality instead: keyboard focus rings and orbits,
  // pointer focus does neither, keeping the global arrow-key frame step.
  driver.onCanvasFocus = () => {
    driver.canvas.classList.toggle(
      "keyboard-focus", driver.canvas.matches(":focus-visible"));
  };
  driver.onCanvasBlur = () => {
    driver.canvas.classList.remove("keyboard-focus");
  };

  driver.onCanvasKeyDown = (/** @type {KeyboardEvent} */ e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (!driver.canvas.classList.contains("keyboard-focus")) return;
    if (driver.paused && e.key === "ArrowRight" && !e.shiftKey) return;

    let dTheta = 0;
    let dPhi = 0;
    let dolly = 1;
    switch (e.key) {
      case "ArrowLeft": dTheta = -Daydream.KEY_ORBIT_STEP; break;
      case "ArrowRight": dTheta = Daydream.KEY_ORBIT_STEP; break;
      case "ArrowUp": dPhi = -Daydream.KEY_ORBIT_STEP; break;
      case "ArrowDown": dPhi = Daydream.KEY_ORBIT_STEP; break;
      case "+": case "=": dolly = 1 / Daydream.KEY_ZOOM_STEP; break;
      case "-": case "_": dolly = Daydream.KEY_ZOOM_STEP; break;
      default: return;
    }

    offset.copy(driver.camera.position).sub(driver.controls.target);
    spherical.setFromVector3(offset);
    spherical.theta += dTheta;
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi + dPhi,
      driver.controls.minPolarAngle,
      driver.controls.maxPolarAngle
    );
    spherical.radius = THREE.MathUtils.clamp(
      spherical.radius * dolly,
      driver.controls.minDistance,
      driver.controls.maxDistance
    );
    spherical.makeSafe(); // keeps phi off the poles, where the orbit basis degenerates
    driver.camera.position
      .copy(driver.controls.target)
      .add(offset.setFromSpherical(spherical));
    driver.camera.lookAt(driver.controls.target);
    driver.controls.update();
    driver.needsRender = true;

    e.preventDefault();
    // Else the window handler also reads ArrowRight as a paused frame step.
    e.stopPropagation();
  };

  driver.canvas.addEventListener("keydown", driver.onCanvasKeyDown);
  driver.canvas.addEventListener("focus", /** @type {EventListener} */ (driver.onCanvasFocus));
  driver.canvas.addEventListener("blur", /** @type {EventListener} */ (driver.onCanvasBlur));
}

/** Bind the viewport reset button, double-click, and interruption listeners.
 * @param {import('./driver.js').Daydream} driver - Display state.
 */
export function setupViewReset(driver) {
  driver.viewResetFrame = 0;
  driver.resetViewButton = driver.doc.getElementById('reset-view');
  driver.onResetView = () => driver.resetView();
  driver.onCancelViewReset = () => driver.cancelViewReset();
  driver.resetViewButton?.addEventListener('click', driver.onResetView);
  driver.canvas.addEventListener('dblclick', driver.onResetView);
  driver.canvas.addEventListener('keydown', driver.onCancelViewReset);
  driver.controls.addEventListener('start', driver.onCancelViewReset);
}

/** Return to the default orientation and center while preserving zoom.
 * @param {import('./driver.js').Daydream} driver - Display state.
 */
export function resetView(driver) {
  driver.cancelViewReset();
  const target = driver.controls.target.clone();
  const orbit = new THREE.Spherical().setFromVector3(
    driver.camera.position.clone().sub(target));
  const started = driver.win.performance.now();
  const duration = driver.win.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0 : Daydream.VIEW_RESET_MS;
  const offset = new THREE.Vector3();
  const spherical = new THREE.Spherical();
  const animate = (/** @type {number} */ now) => {
    const progress = duration === 0 ? 1 : THREE.MathUtils.clamp((now - started) / duration, 0, 1);
    const remaining = (1 - progress) ** 3;
    spherical.set(orbit.radius, Math.PI / 2 + (orbit.phi - Math.PI / 2) * remaining,
      orbit.theta * remaining);
    driver.controls.target.copy(target).multiplyScalar(remaining);
    driver.camera.position.copy(driver.controls.target).add(offset.setFromSpherical(spherical));
    driver.controls.update();
    driver.needsRender = true;
    driver.viewResetFrame = progress < 1 ? driver.win.requestAnimationFrame(animate) : 0;
  };
  animate(started);
}

/** Cancel an in-flight return to the default orientation.
 * @param {import('./driver.js').Daydream} driver - Display state.
 */
export function cancelViewReset(driver) {
  if (driver.viewResetFrame) driver.win.cancelAnimationFrame(driver.viewResetFrame);
  driver.viewResetFrame = 0;
}

/**
 * Keyboard handler: space toggles pause; right-arrow single-steps while
 * paused; left/right select presets while running.
 * @param {import('./driver.js').Daydream} driver - Display state.
 * @param {KeyboardEvent} e - The keydown event driving playback or presets.
 * @param {(delta: number) => boolean} [movePreset] - Selects an adjacent preset.
 */
export function keydown(driver, e, movePreset = () => false) {
  // An Alt/Ctrl/Meta chord is the browser's or the OS's — Ctrl+Space and
  // Cmd+Space among them — so no playback shortcut claims one.
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (e.repeat) return;
    driver.paused = !driver.paused;
    if (!driver.paused) driver.stepFrames = 0;
  } else if (driver.paused && e.key === "ArrowRight") {
    driver.stepFrames++;
    e.preventDefault();
  } else if (!driver.paused && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    const delta = e.key === "ArrowLeft" ? -1 : 1;
    if (movePreset(delta)) e.preventDefault();
  }
}
