/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** The render loop's per-frame failure containment and dead-module latch. */

import { errorDetail } from '../shared/banner.js';

/**
 * Collaborators the frame loop guard wraps and reports through.
 * @typedef {Object} FrameLoopGuardDeps
 * @property {() => void} frame - The per-frame body.
 * @property {(message: string) => void} report - Renders the failure banner.
 * @property {(message: string) => void} [clearReport] - Clears a recovered failure.
 * @property {(...args: *) => void} [logError] - Console sink for the throw.
 * @property {(error?: *) => boolean} [moduleDead] - Reads the engine module's death
 *   flag; polled before and after every frame, so it must be cheap.
 * @property {() => void} [onModuleDead] - Releases the app once the module is
 *   dead. Runs after the banner, which the release leaves standing.
 */

// Consecutive clean frames that re-arm the render-loop guard's report, about a
// second of rendering at display rate.
export const FRAME_GUARD_REARM_FRAMES = 60;

// The banner a trapped module raises, from the render loop and from a startup
// call alike.
export const MODULE_TRAP_NOTICE = 'The rendering engine hit an unrecoverable'
  + ' internal error and has been shut down. Reload the page to start it again.'
  + ' See the browser console for details.';

/**
 * Wrap the render loop's per-frame body so a throw cannot freeze the page, and
 * stop the loop for good once the engine module reports itself dead.
 *
 * Reports re-arm after FRAME_GUARD_REARM_FRAMES clean frames. A dead module
 * stops the loop permanently and releases the app.
 *
 * @param {FrameLoopGuardDeps} deps - Injected collaborators.
 * @returns {() => void} The guarded callback for setAnimationLoop.
 */
export function createFrameLoopGuard({
  frame,
  report,
  clearReport = () => {},
  logError = console.error,
  moduleDead = () => false,
  onModuleDead = () => {},
}) {
  let reported = false;
  let failureMessage = '';
  let clean = 0;
  let dead = false;

  /** @param {string} message */
  function reportNotice(message) {
    try { report(message); }
    catch (error) { logError('Render error reporting failed:', error); }
  }

  /**
   * Poll the module's death flag and, the first time it reads dead, latch it:
   * banner, release, no further frames.
   * @returns {void}
   */
  function checkDead(/** @type {*} */ error = undefined) {
    if (dead || !moduleDead(error)) return;
    // Latched before the release, so a throwing release still stops the loop.
    dead = true;
    logError('Render loop stopped: the rendering engine trapped.');
    reportNotice(MODULE_TRAP_NOTICE);
    onModuleDead();
  }

  return () => {
    checkDead();
    if (dead) return;
    try {
      frame();
      if (reported && ++clean >= FRAME_GUARD_REARM_FRAMES && !moduleDead()) {
        clearReport(failureMessage);
        reported = false;
        clean = 0;
      }
    } catch (e) {
      checkDead(e);
      if (dead) return;
      clean = 0;
      if (!reported) {
        reported = true;
        logError('Render loop frame failed:', e);
        failureMessage = `The render loop hit an error. ${errorDetail(e)}`
          + ' See the browser console for details.';
        reportNotice(failureMessage);
      }
    }
    checkDead();
  };
}
