/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {captureDisplayFrame} from './driver_capture.js';


/**
 * Render the main sphere view into its viewport. Assumes the scissor test is
 * already enabled by the caller.
 * @param {import('./driver.js').Daydream} driver - Display state.
 */
export function renderMainView(driver) {
  driver.renderer.setViewport(
    driver.mainViewport.x,
    driver.mainViewport.y,
    driver.mainViewport.width,
    driver.mainViewport.height
  );
  driver.renderer.setScissor(
    driver.mainViewport.x,
    driver.mainViewport.y,
    driver.mainViewport.width,
    driver.mainViewport.height
  );

  // render() clears the scissored viewport itself: a THREE.Color scene
  // background forces a clear to that color before the pass.
  driver.renderer.render(driver.scene, driver.camera);
}

/**
 * Render the picture-in-picture corner view: the sphere seen from the antipode
 * of the main camera. Skipped while showPip is off, in a compact viewport,
 * under headless automation (navigator.webdriver), and while recording.
 * @param {import('./driver.js').Daydream} driver - Display state.
 */
export function renderPip(driver) {
  if (!driver.showPip || driver.compactViewport || driver.nav.webdriver ||
      driver.recorder?.isRecording) return;

  driver.renderer.setViewport(
    driver.pipViewport.x,
    driver.pipViewport.y,
    driver.pipViewport.width,
    driver.pipViewport.height
  );
  driver.renderer.setScissor(
    driver.pipViewport.x,
    driver.pipViewport.y,
    driver.pipViewport.width,
    driver.pipViewport.height
  );
  const target = driver.controls.target;
  driver.pipCamera.position.copy(target).sub(driver.camera.position).add(target);
  driver.pipCamera.lookAt(target);
  if (driver.cullUniforms) {
    driver.cullUniforms.uCameraPos.value.copy(driver.pipCamera.position);
  }
  driver.renderer.render(driver.scene, driver.pipCamera);
}


/** @param {import('./driver.js').Daydream} driver @param {boolean} captureDue */
export function renderDisplayViews(driver, captureDue) {
  driver.xAxis.visible = driver.labelAxes;
  driver.yAxis.visible = driver.labelAxes;
  driver.zAxis.visible = driver.labelAxes;

  driver.updateCullUniforms();

  driver.renderer.setScissorTest(true);
  driver.renderMainView();

  captureDisplayFrame(driver, captureDue);

  driver.refreshLabels();
  if (driver.labelPool.activeCount > 0) {
    driver.labelRenderer.render(driver.scene, driver.camera);
  }

  driver.renderPip();
  driver.renderer.setScissorTest(false);
}
