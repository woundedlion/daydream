/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createAppTeardown} from './app_lifecycle.js';

/** @param {import('./app_context.js').BootContext & {
 * shaderDocuments: ReturnType<typeof import('./app_shader_documents.js').createAppShaderDocuments>}} deps */
export function createSimulatorTeardown({win, onKeyDown, pageFailureListeners, onApplyNoticeDismiss,
  doc, switches, disposeEffectRoute, testAllTicker, applyNotice, effectGui,
  shaderDocuments, shell, host, urlSync, display, segments, segSpawn, recording}) {
  const {guiInstance, sidebar} = shell;
  return createAppTeardown({
    pageTarget: win,
    listeners: [
      ["keydown", onKeyDown],
      ...pageFailureListeners,
      ["click", onApplyNoticeDismiss, doc],
    ],
    switches,
    releaseAppServices: () => { disposeEffectRoute(); testAllTicker.stop(); applyNotice.clear(); },
    effectGui,
    shaderDocuments,
    globalGui: guiInstance,
    host,
    urlSync,
    sidebar,
    driver: display,
    segments,
    strandSegmentWork: () => segSpawn?.dispose(),
    removeOverlay: () => recording.removeOverlay(),
  });


}
