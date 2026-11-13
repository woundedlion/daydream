/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import {GlobalStatsView} from '../ui/global_stats_view.js';
import createHolosphereModule from '../../generated/holosphere_wasm.js';
import {Daydream} from '../renderer/driver.js';
import {GUI} from '../ui/gui.js';
import {createApplyNotice} from '../ui/apply_notice.js';
import {loadWithDeadline} from './app_lifecycle.js';
import {SEGMENT_CONTROLLER_API_VERSION} from '../segments/segment_controller.js';
import {StaleModuleError} from './bootstrap.js';
import {canonicalEffectId} from '../effects/effect_identity.js';
import {SHADER_DOCUMENT_EFFECTS} from '../effects/effect_roster.js';
import {createAppInstances} from './app_instances.js';
import {createRouteState} from './app_route_state.js';
import {createAppSegments} from './app_segments.js';
import {createAppShell} from './app_shell.js';
import {createEngineControls} from './app_engine_controls.js';
import {createAppEffects} from './app_effects.js';
import {createAppShaderDocuments} from './app_shader_documents.js';
import {createAppControls} from './app_controls.js';
import {createAppBoot} from './app_boot.js';
import {startAppFrameLoop} from './app_frame_loop.js';
import {createSimulatorTeardown} from './app_teardown.js';

/** @typedef {import('../../generated/holosphere_wasm.js').HolosphereModule} HolosphereModule */
/** @typedef {import('../../generated/holosphere_wasm.js').HolosphereEngine} HolosphereEngine */

const EXPECTED_SEGMENT_CONTROLLER_API_VERSION = 4;

if (SEGMENT_CONTROLLER_API_VERSION !== EXPECTED_SEGMENT_CONTROLLER_API_VERSION) {
  throw new StaleModuleError(
    'Cached segment_controller.js is incompatible; reload the simulator.');
}

/**
 * Builds the dedicated authoring route while preserving the incoming query.
 * @param {Location|URL|string} location - Current simulator location.
 * @param {string} [effect] - Effect the workbench opens on.
 * @returns {string} Same-origin workbench URL.
 */
export function shaderWorkbenchUrl(location, effect = 'ShaderChain') {
  const source = typeof location === 'string' || location instanceof URL
    ? location : location.href;
  const current = new URL(source);
  const url = new URL('tools/shader.html', current);
  url.search = current.search;
  url.hash = current.hash;
  url.searchParams.set('effect', canonicalEffectId(effect));
  url.searchParams.delete('view');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** @param {string|null} requested @param {string|null} view @returns {string|null} Effect redirected to its workbench. */
function workbenchRedirectEffect(requested, view) {
  if (requested === null) return null;
  const canonical = canonicalEffectId(requested);
  if (canonical === canonicalEffectId('ShaderChain')) return canonical;
  if (requested !== canonical || view === 'simulator') return null;
  return SHADER_DOCUMENT_EFFECTS.includes(canonical) ? canonical : null;
}

/** @typedef {ReturnType<typeof import('./app_lifecycle.js').createAppTeardown> & {ready: Promise<unknown>}} AppHandle */

/**
 * Builds the simulator: driver, engine host, state, GUI, sidebar, apply
 * pipeline, recording, and the page listeners, then kicks off the WASM load.
 * @param {Object} [dependencies] - Seams the page owns; each defaults to the real one.
 * @param {Document} [dependencies.doc] - Document the controls mount into.
 * @param {Window & typeof globalThis} [dependencies.win] - Page target for the global listeners.
 * @param {Navigator} [dependencies.nav] - Read for the segment-pool cap.
 * @param {() => Daydream} [dependencies.createDriver] - Builds the three.js driver.
 * @param {(options: ConstructorParameters<typeof GUI>[0], namespace: string) => GUI} [dependencies.createGui] - Builds a namespaced GUI root.
 * @param {() => Promise<HolosphereModule>} [dependencies.loadModule] - Resolves the WASM module.
 * @returns {AppHandle} The teardown handle; ready settles after module startup or failure reporting.
 */
export function start({
  doc = globalThis.document,
  win = /** @type {Window & typeof globalThis} */ (globalThis),
  nav = globalThis.navigator,
  createDriver = () => new Daydream({
    doc, win, nav, statsView: new GlobalStatsView(doc),
    pipOnRight: doc.documentElement?.dataset.daydreamMode === 'shader-workbench',
  }),
  createGui = (options, namespace) => new GUI(options, namespace, null, win),
  loadModule = createHolosphereModule,
} = {}) {
  const shaderWorkbench = doc.documentElement?.dataset.daydreamMode === 'shader-workbench';
  const routeParams = new URLSearchParams(win.location?.search ?? '');
  const requestedEffect = routeParams.get('effect');
  const workbenchEffect = workbenchRedirectEffect(requestedEffect, routeParams.get('view'));
  if (!shaderWorkbench && workbenchEffect) {
    win.location.replace(shaderWorkbenchUrl(win.location, workbenchEffect));
    let redirectDisposed = false;
    return {
      dispose() { redirectDisposed = true; },
      onPageHide() {},
      disposed: () => redirectDisposed,
      ready: Promise.resolve(),
    };
  }

  const page = {doc, win, nav, createDriver, createGui, loadModule,
    shaderWorkbench, routeParams, requestedEffect};
  const instances = createAppInstances(page);
  const route = createRouteState(page);
  const app = {...page, ...instances, ...route};
  const segments = createAppSegments(app);
  const applyNotice = createApplyNotice({doc});
  const services = {...app, segments, applyNotice};
  const shell = createAppShell(services);
  const engineControls = createEngineControls(services);
  const panels = {...services, shell, engineControls};
  const effects = createAppEffects(panels);
  const effectContext = {...panels, ...effects};
  const shaderDocuments = createAppShaderDocuments(effectContext);
  const controls = createAppControls(effectContext);
  effects.connectViewDisplay(controls.viewDisplay);
  const context = {...effectContext, ...controls, shaderDocuments};
  /** @type {ReturnType<typeof import('./app_lifecycle.js').createAppTeardown>|null} */
  let appTeardown = null;
  const getTeardown = () => appTeardown;
  const moduleLoad = createAppBoot({...context, getTeardown});
  startAppFrameLoop({...context, getTeardown});
  appTeardown = createSimulatorTeardown(context);
  const ready = loadWithDeadline(loadModule)
    .then(moduleLoad.onModuleReady)
    .then(() => {
      if (!shaderDocuments) controls.viewDisplay.finishColumnDefaults();
    }).catch(moduleLoad.onModuleFailed);
  return Object.assign(appTeardown, {ready});
}
