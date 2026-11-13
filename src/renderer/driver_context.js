/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Wire WebGL context-loss / -restore handling on the canvas: on loss, flag
 * contextLost (render() then stops issuing GL calls), end any recording, and
 * show a reload prompt.
 * @param {import('./driver.js').Daydream} driver - Display state.
 */
export function setupContextLossHandling(driver) {
  driver.contextLost = false;

  const overlay = driver.doc.createElement("div");
  overlay.className = "loading-overlay error context-lost-overlay";
  overlay.setAttribute("role", "alert");
  overlay.tabIndex = -1;
  overlay.style.display = "none";
  // Shares classes with bootstrap's load-failure overlay.
  const title = driver.doc.createElement("span");
  title.className = "load-error-title";
  title.textContent = "GPU context lost";
  driver.contextLostDetail = driver.doc.createElement("span");
  driver.contextLostDetail.className = "load-error-detail";
  const reload = driver.doc.createElement("button");
  reload.type = "button";
  reload.className = "context-lost-reload";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => driver.win.location.reload());
  overlay.append(title, driver.contextLostDetail, reload);
  driver.canvasParent.appendChild(overlay);
  driver.contextLostOverlay = overlay;

  driver.onContextLost = (/** @type {Event} */ e) => {
    e.preventDefault(); // signal intent to handle a restore
    driver.contextLost = true;
    const reason = /** @type {WebGLContextEvent} */ (e).statusMessage || "no reason reported";
    console.error(`[daydream] WebGL context lost: ${reason}`);
    /** @type {HTMLElement} */ (driver.contextLostDetail).textContent =
      `${reason}. The GPU process was likely reset — reload to recover.`;
    overlay.style.display = "flex";
    overlay.focus({ preventScroll: true });
    // The canvas feeds no more frames into the capture stream.
    driver.recorder?.abort(`WebGL context lost (${reason}).`);
  };

  driver.onContextRestored = () => {
    driver.contextLost = false;
    console.warn("[daydream] WebGL context restored");
    if (overlay.contains(driver.doc.activeElement))
      driver.canvas.focus({ preventScroll: true });
    overlay.style.display = "none";
    // Repaint so instanceColor/instanceMatrix re-upload even while paused.
    driver.needsRender = true;
  };

  driver.canvas.addEventListener("webglcontextlost", driver.onContextLost, false);
  driver.canvas.addEventListener(
    "webglcontextrestored", /** @type {EventListener} */ (driver.onContextRestored), false);
}
