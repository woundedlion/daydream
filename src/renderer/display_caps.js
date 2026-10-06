/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Largest pole cap, in percent, the engine's setDisplayCaps accepts. */
export const MAX_DISPLAY_CAP_PERCENT = 25;

/**
 * Hold cap percentages until the engine loads and publish accepted geometry.
 * @param {{getEngine: () => Pick<import('../../generated/holosphere_wasm.js').HolosphereEngine,
 *   'setDisplayCaps'|'getDisplayNorthPhi'|'getDisplaySouthPhi'>|null,
 *   onChange: (geometry: {DISPLAY_NORTH_PHI:number,
 *   DISPLAY_SOUTH_PHI:number}) => void}} deps
 * @returns {{state: {topCap: number, bottomCap: number}, apply: () => boolean,
 *   replay: () => boolean}} Control state and its engine binding.
 */
export function createDisplayCapsBinding({ getEngine, onChange }) {
  const state = { topCap: 0, bottomCap: 0 };
  /** @returns {boolean} Whether the requested cap settings were accepted. */
  function apply() {
    if (![state.topCap, state.bottomCap].every((v) => Number.isFinite(v) && v >= 0 && v <= MAX_DISPLAY_CAP_PERCENT))
      return false;
    const engine = getEngine();
    if (!engine) return true;
    if (!engine.setDisplayCaps(state.topCap, state.bottomCap)) return false;
    onChange({
      DISPLAY_NORTH_PHI: engine.getDisplayNorthPhi(),
      DISPLAY_SOUTH_PHI: engine.getDisplaySouthPhi(),
    });
    return true;
  }
  return { state, apply, replay: apply };
}
