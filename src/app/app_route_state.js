/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {AppState, URLSync} from './state.js';
import {canonicalEffectId} from '../effects/effect_identity.js';
import {DEFAULT_EFFECT, favoritesFor, resolutionPresets, SHADER_DOCUMENT_EFFECTS, WORKBENCH_EFFECTS}
  from '../effects/effect_roster.js';

/** @param {Pick<import('./app_context.js').PageContext, 'shaderWorkbench'|'routeParams'|'win'>} deps */
export function createRouteState({shaderWorkbench, routeParams, win}) {
  // Seed plain defaults; URLSync hydrates these from the query string through
  // its validators.
  const knownEffects = new Set((shaderWorkbench
    ? WORKBENCH_EFFECTS
    : Object.values(resolutionPresets).flatMap((preset) => preset.favorites)
  ).map(canonicalEffectId));
  const appState = new AppState({
    effect: canonicalEffectId(shaderWorkbench ? 'ShaderChain' : DEFAULT_EFFECT),
    view: null,
    resolution: "Phantasm (288x144)",
  });
  const syncRoute = () => appState.set('view', !shaderWorkbench
    && SHADER_DOCUMENT_EFFECTS.includes(canonicalEffectId(appState.get('effect')))
    ? 'simulator' : null);
  const disposeEffectRoute = appState.subscribe((key) => { if (key === 'effect') syncRoute(); });
  const urlSync = new URLSync(appState, ['effect', 'resolution', 'view'], {
    resolution: (v) => Object.hasOwn(resolutionPresets, v),
    effect: (v) => knownEffects.has(canonicalEffectId(v)),
    view: (v) => !shaderWorkbench && v === 'simulator',
  }, win);
  appState.set('effect', canonicalEffectId(appState.get('effect')));
  syncRoute();
  let workbenchUrlPending = shaderWorkbench;
  if (workbenchUrlPending) urlSync.suspend();
  const releaseWorkbenchUrl = () => {
    if (!workbenchUrlPending) return;
    workbenchUrlPending = false;
    urlSync.resume();
  };
  for (const key of ['view.povPresentation', 'view.povExposureMs']) {
    if (routeParams.has(key)) urlSync.setParam(key, null);
  }
  const availableEffects = (/** @type {string} */ resolution) => shaderWorkbench
    ? WORKBENCH_EFFECTS.map(canonicalEffectId) : favoritesFor(resolution).map(canonicalEffectId);

  return {appState, urlSync, releaseWorkbenchUrl, disposeEffectRoute, availableEffects};
}
