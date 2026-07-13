/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * DOM/engine-free sequencing helpers for daydream.js's effect and resolution
 * apply path, extracted so the "apply the effect directly vs let the
 * effect-change subscription fire it" decision and the param/value skew guard can
 * be unit-tested without a WASM engine, lil-gui, or a browser. applyResolution()
 * and syncGUI()/export() route through here so those rules live in one tested
 * place, mirroring resolveParamSync().
 */

import { resolveActiveEffect } from "./sidebar_logic.js";

/**
 * Apply a synchronous state switch and restore the previous applied state when
 * it rejects or throws.
 * @param {Function} apply - Applies the requested state; false means rejected.
 * @param {Function} rollback - Restores the previous applied state.
 * @returns {{applied: boolean, failure: any|null, recoveryFailure: any|null}}
 */
export function runSwitchTransaction(apply, rollback) {
  let failure = null;
  try {
    if (apply() !== false) {
      return { applied: true, failure: null, recoveryFailure: null };
    }
  } catch (error) {
    failure = error;
  }

  try {
    rollback();
    return { applied: false, failure, recoveryFailure: null };
  } catch (error) {
    return { applied: false, failure, recoveryFailure: error };
  }
}

/**
 * Plan how applyResolution() should re-apply the effect after a resolution
 * change. The requested effect is kept when the new resolution offers it, else
 * corrected to the list's first entry (resolveActiveEffect). When that correction
 * changes the effect, appState.set('effect', …) synchronously fires applyEffect()
 * through its subscription, so the caller must NOT also call applyEffect()
 * directly — doing both double-applies. applyDirectly captures that: build the
 * GUI directly only when the effect did not change.
 * @param {Array<string>} availableEffects - Effects offered at the new resolution.
 * @param {string} currentEffect - The requested/active effect name.
 * @returns {{nextEffect: string, effectChanged: boolean, applyDirectly: boolean}}
 *   The effect to activate, whether it differs from currentEffect, and whether the
 *   caller must call applyEffect() itself (true only when the effect is unchanged).
 */
export function planResolutionApply(availableEffects, currentEffect) {
  const nextEffect = resolveActiveEffect(availableEffects, currentEffect);
  const effectChanged = nextEffect !== currentEffect;
  return { nextEffect, effectChanged, applyDirectly: !effectChanged };
}

/**
 * Whether the cached param-name list has drifted out of length with the engine's
 * per-frame value stream. A skew means the two can no longer be paired by index,
 * so syncGUI() and export() must skip rather than mis-bind sliders.
 * @param {number} namesLength - Length of the effect's cached paramNames list.
 * @param {number} valuesLength - Length of the engine's live value stream.
 * @returns {boolean} True when the lengths differ (do not pair them).
 */
export function paramValueSkew(namesLength, valuesLength) {
  return namesLength !== valuesLength;
}
