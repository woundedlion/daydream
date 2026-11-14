/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createFrameLoopGuard} from './frame_loop_guard.js';
import {showFatalError, clearFatalError} from '../shared/banner.js';

/** @param {import('./app_context.js').BootContext & {
 * getTeardown: () => import('./app_teardown.js').AppTeardown|null}} deps */
export function startAppFrameLoop({daydream, host, recording, getTeardown}) {
  daydream.startFrameLoop(createFrameLoopGuard({
    frame: () => {
      if (host.adapter) {
        daydream.render(host.adapter);
      }
      recording.tick();
    },
    report: showFatalError,
    clearReport: clearFatalError,
    moduleDead: (error) => host.moduleDead(error),
    onModuleDead: () => getTeardown()?.dispose(),
  }));

}
