/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {import('../../generated/holosphere_wasm.js').HolosphereModule} HolosphereModule */
/** @typedef {import('../engine/engine_host.js').EngineHost & {module: HolosphereModule, engine: import('../../generated/holosphere_wasm.js').HolosphereEngine}} LoadedHost */
/** @typedef {import('../renderer/driver.js').Daydream & import('../engine/display_aliases.js').DisplayDriver} ReadyDisplay */
/**
 * @typedef {object} PageContext
 * @property {Document} doc
 * @property {Window & typeof globalThis} win
 * @property {Navigator} nav
 * @property {() => import('../renderer/driver.js').Daydream} createDriver
 * @property {(options: ConstructorParameters<typeof import('../ui/gui.js').GUI>[0], namespace: string) => import('../ui/gui.js').GUI} createGui
 * @property {() => Promise<HolosphereModule>} loadModule
 * @property {boolean} shaderWorkbench
 * @property {URLSearchParams} routeParams
 * @property {string|null} requestedEffect
 */
/** @typedef {PageContext & ReturnType<typeof import('./app_instances.js').createAppInstances> & ReturnType<typeof import('./app_route_state.js').createRouteState>} AppContext */
/** @typedef {AppContext & {segments: import('../segments/segment_controller.js').SegmentController, applyNotice: ReturnType<typeof import('../ui/apply_notice.js').createApplyNotice>}} AppServices */
/** @typedef {AppServices & {shell: ReturnType<typeof import('./app_shell.js').createAppShell>, engineControls: ReturnType<typeof import('./app_engine_controls.js').createEngineControls>}} PanelContext */
/** @typedef {PanelContext & ReturnType<typeof import('./app_effects.js').createAppEffects>} EffectContext */
/** @typedef {EffectContext & ReturnType<typeof import('./app_controls.js').createAppControls>} BootContext */

export {};
