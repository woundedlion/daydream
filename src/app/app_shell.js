/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {EffectSidebar} from '../ui/sidebar.js';
import {MOBILE_MEDIA_QUERY} from '../shared/layout.js';
import {resolutionPresets} from '../effects/effect_roster.js';
import {offeredResolutions, resolutionCorrection} from '../effects/effect_sequencing.js';
/** @typedef {import('./app_context.js').HolosphereModule} HolosphereModule */

/** @param {import('./app_context.js').AppServices} deps */
export function createAppShell({doc, win, createGui, appState, shaderWorkbench}) {
  const guiInstance = createGui({ autoPlace: false, title: 'View' }, 'view');
  guiInstance.domElement.classList.add('global-gui');
  if (win.matchMedia?.(MOBILE_MEDIA_QUERY).matches ?? false) {
    guiInstance.close();
  }
  const guiContainer = doc.getElementById('gui-container');
  if (guiContainer) {
    guiContainer.appendChild(guiInstance.domElement);
  } else {
    console.warn('daydream: #gui-container not found; skipping global GUI mount.');
  }

  const setResolution = (/** @type {string} */ v) => appState.set('resolution', v);
  // Reassigned when syncResolutionOptions narrows the offered rows.
  let resolutionController = guiInstance
    .addSession({ resolution: appState.get('resolution') }, 'resolution', Object.keys(resolutionPresets))
    .name('Resolution')
    .onChange(setResolution);

  const sidebarContainer = doc.getElementById('effect-sidebar');
  if (!sidebarContainer && !shaderWorkbench) {
    console.warn('daydream: #effect-sidebar not found; the effect list is not shown.');
  }
  const sidebar = new EffectSidebar(
    sidebarContainer ?? doc.createElement('div'),
    (/** @type {string} */ name) => appState.set('effect', name)
  );

  /**
   * Narrow the resolution dropdown to the rows the engine reports it can build,
   * correcting the active resolution when the hydrated one is not among them.
   * @param {HolosphereModule} module - The loaded WASM module.
   * @param {ReturnType<typeof import('../effects/effect_sequencing.js').createSwitchCoordinator>} switches - Apply transaction.
   * @param {(error: unknown) => boolean} abandonOnModuleDeath - Trapped-module handler.
   * @returns {boolean} Whether the module survived the query; false leaves the
   *   app released and the rest of the startup unrun.
   */
  function syncResolutionOptions(module, switches, abandonOnModuleDeath) {
    let supported = null;
    try { supported = module.HolosphereEngine.getSupportedResolutions(); }
    catch (e) {
      console.warn('getSupportedResolutions failed (offering every preset):', e);
      if (abandonOnModuleDeath(e)) return false;
    }

    const { labels, unlabeled } = offeredResolutions(resolutionPresets, supported);
    if (unlabeled.length > 0) {
      console.warn(`Engine resolutions with no preset (not offered): ${unlabeled.join(', ')}`);
    }
    resolutionController = resolutionController.options(labels).onChange(setResolution);

    const current = appState.get('resolution');
    const corrected = resolutionCorrection(labels, current);
    if (corrected !== null) {
      console.warn(`Resolution "${current}" is not supported by the engine; using "${corrected}".`);
      // Muted: the onChange carries the correction into appState and the URL;
      // applyInitialState performs the apply.
      switches.mute(() => resolutionController.setValue(corrected));
    }
    return true;
  }

  return {guiInstance, sidebar, syncResolutionOptions,
    showResolution: (/** @type {string} */ resolution) => resolutionController.setValue(resolution)};
}
