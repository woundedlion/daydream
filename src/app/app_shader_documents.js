/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createShaderDocumentController} from '../workbench/shader/shader_documents.js';
import {canonicalEffectId} from '../effects/effect_identity.js';

/** @param {import('./app_context.js').EffectContext} deps */
export function createAppShaderDocuments({doc, win, host, loaded, releaseWorkbenchUrl, effectGui,
  daydream, paramFilterRef, requestedEffect, appState, shaderWorkbench, engineControls}) {
  const {setAnimationsPaused} = engineControls;
  const shaderDocuments = shaderWorkbench ? createShaderDocumentController({
    doc,
    onOriginalLinkReleased: releaseWorkbenchUrl,
    getEngine: () => host.engine,
    getModule: () => loaded.module,
    selectEffect: (effect) => {
      const canonical = canonicalEffectId(effect);
      appState.set('effect', canonical);
      return appState.get('effect') === canonical;
    },
    syncEffectGui: () => effectGui.sync(),
    invalidate: () => daydream.invalidate(),
    getAnimationsPaused: () => host.engine?.getAnimationsPaused() ?? null,
    setAnimationsPaused,
    setParamFilter: (filter) => { paramFilterRef.current = filter; },
    initialEffect: requestedEffect,
    win,
  }) : null;

  return shaderDocuments;
}
