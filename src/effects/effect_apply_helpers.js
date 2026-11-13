/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {import('../../generated/holosphere_wasm.js').HolosphereEngine} HolosphereEngine */

/** @param {Pick<Parameters<typeof import('./effect_sequencing.js').createApplyPipeline>[0],
 * 'appState'|'getEngine'|'getModule'|'driver'|'onColumnDefault'|'logError'>} deps */
export function createEffectSelector({appState, getEngine, getModule, driver,
  onColumnDefault = () => {}, logError = (...args) => console.error(...args)}) {
  /** @type {HolosphereEngine|null} */
  let strobeEngine = null;
  /** @type {string|null} */
  let strobeEffect = null;

  /**
   * Point the engine at the state's effect and mirror its strobe layout onto the
   * driver.
   * @returns {boolean} False when the engine rejected the effect.
   */
  function selectEngineEffect() {
    const engine = /** @type {HolosphereEngine} */ (getEngine());
    const effect = appState.get('effect');
    // Compare against the enum value, never by truthiness (every
    // Module.EffectSetResult value is a truthy object).
    const applied =
      engine.setEffect(effect) === getModule().EffectSetResult.INSTALLED;
    if (applied && (engine !== strobeEngine || effect !== strobeEffect)) {
      driver.setStrobeColumns(engine.strobeColumns());
      onColumnDefault();
      strobeEngine = engine;
      strobeEffect = effect;
    }
    if (!applied) {
      logError(`setEffect("${effect}") failed; effect unavailable.`);
    }
    return applied;
  }

  return selectEngineEffect;
}

/** @param {HolosphereEngine|null} engine @param {(error: unknown) => boolean} moduleDead
 * @param {(message: string, error?: unknown) => void} logWarn */
export function readSidebarMetrics(engine, moduleDead, logWarn) {
  /** @type {Record<string, number>|null} */
  let effectSizes = null;
  /** @type {Record<string, number>|null} */
  let presetCounts = null;
  if (engine) {
    // Sidebar queries are cosmetic, but a trapped module rethrows.
    try { effectSizes = engine.getEffectSizes(); }
    catch (e) {
      if (moduleDead(e)) throw e;
      logWarn('getEffectSizes failed (sidebar sizes unavailable):', e);
    }
    try { presetCounts = engine.getEffectPresetCounts(); }
    catch (e) {
      if (moduleDead(e)) throw e;
      logWarn('getEffectPresetCounts failed (sidebar preset counts unavailable):', e);
    }
  }
return {effectSizes, presetCounts};
}
