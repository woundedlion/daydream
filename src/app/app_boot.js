/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createModuleLoadHandlers} from './module_load.js';
import {createRenderAdapter} from './render_adapter.js';
import {MODULE_TRAP_NOTICE} from '../shared/engine_halt.js';
import {VideoRecorder} from '../recording/recorder.js';
import {applyInitialState} from '../effects/effect_sequencing.js';
import {reportBootFailure} from './bootstrap.js';
import {errorDetail} from '../shared/banner.js';
import {createDriverAliasGuard} from '../engine/display_aliases.js';
/** @typedef {import('./app_context.js').HolosphereModule} HolosphereModule */
const WORKBENCH_NOTICE = 'workbench';

/** @param {import('./app_context.js').BootContext & {shaderDocuments: ReturnType<typeof import('./app_shader_documents.js').createAppShaderDocuments>,
 * getTeardown: () => import('./app_teardown.js').AppTeardown|null}} deps */
export function createAppBoot({doc, win, host, loaded, daydream, display, segments, applyNotice,
  shell, switches, effectGui, viewDisplay, recording, apply, shaderDocuments,
  releaseWorkbenchUrl, testAllTicker, testAllController, getTeardown}) {
  /**
   * Release the app when a caught failure came from a trapped module, which has
   * no recovery path.
   * @param {unknown} error - Failure from the module.
   * @returns {boolean} Whether the module is dead and the app was released.
   */
  function abandonOnModuleDeath(error) {
    if (!host.moduleDead(error)) return false;
    console.error('Startup stopped: the rendering engine trapped.');
    reportBootFailure(MODULE_TRAP_NOTICE, { document: doc, location: win.location });
    getTeardown()?.dispose();
    return true;
  }

  const reportModuleFailure = (/** @type {unknown} */ err) => {
    console.error('Failed to initialize the Holosphere renderer:', err);
    // No engine: the Test All ticker would spin uselessly for the page lifetime.
    testAllTicker.stop();
    if (testAllController) {
      testAllController.setValue(false);
      testAllController.disable();
    }
    if (host.module && host.moduleDead(err)) {
      reportBootFailure(MODULE_TRAP_NOTICE, { document: doc, location: win.location });
      return;
    }
    reportBootFailure(err, {
      document: doc,
      location: win.location,
      title: 'Failed to load the rendering engine.',
    });
  };

  const moduleLoad = createModuleLoadHandlers({
    teardown: getTeardown,
    start: (/** @type {HolosphereModule} */ module) => {
      host.module = module;
      if (module.HolosphereEngine.isLive())
        throw new Error('HolosphereEngine is already live.');
      host.engine = new module.HolosphereEngine();
      loaded.engine.setTemporalSampling(daydream.povFidelity);

      // Push the Pole LOD and display caps set while host.engine was null.
      if (!viewDisplay.replay()) throw new Error('Engine rejected display cap settings.');

      if (!shell.syncResolutionOptions(module, switches, abandonOnModuleDeath)) return;

      const renderAdapter = createRenderAdapter({
        host: loaded,
        driver: display,
        segments,
        syncEffectGui: (advanced) => effectGui.sync(advanced),
        aliasGuard: createDriverAliasGuard(display, 'drawFrame'),
        beforeFrame: () => shaderDocuments?.stepPreview(),
      });
      host.adapter = renderAdapter;

      host.recorder = new VideoRecorder(daydream.canvas, { frameInterval: display.frameInterval, doc });
      recording.attach(host.recorder);

      const loadingOverlay = doc.getElementById('loading-overlay');
      try {
        // Apply the hydrated resolution with its params preserved and validate
        // the hydrated effect against its allow-list, before first paint.
        applyInitialState(
          () => apply.applyResolution({ preserveParams: true }),
          () => loadingOverlay?.remove(),
        );
        shaderDocuments?.init().then(() => {
          if (!shaderDocuments.preservesOriginalLink()) releaseWorkbenchUrl();
        }).catch((err) => {
          releaseWorkbenchUrl();
          console.error('The shader workbench could not be initialized:', err);
          if (abandonOnModuleDeath(err)) return;
          applyNotice.show(
            `The shader workbench could not be initialized: ${errorDetail(err)}`,
            WORKBENCH_NOTICE);
        }).finally(viewDisplay.finishColumnDefaults);
      } catch (err) {
        console.error('Initial resolution/effect could not be applied:', err);
        if (abandonOnModuleDeath(err)) return;
        const title = 'No supported resolution and effect could be applied.';
        reportBootFailure(err, { document: doc, location: win.location, title });
        getTeardown()?.dispose();
      }
    },
    reportFailure: reportModuleFailure,
  });

  return moduleLoad;
}
