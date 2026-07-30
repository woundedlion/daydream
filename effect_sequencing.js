/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * DOM/engine-free sequencing helpers for daydream.js's effect and resolution
 * apply path, extracted so the "apply the effect directly vs let the
 * effect-change subscription fire it" decision, the switch/rollback transaction
 * that drives it, and the param/value skew guard can be unit-tested without a
 * WASM engine, lil-gui, or a browser. applyResolution(), syncGUI()/export() and
 * the appState subscription route through here so those rules live in one tested
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
 * Copy the writable values and animation state from an applied effect GUI.
 * @param {Object|null|undefined} effect - Active effect control state.
 * @returns {{paramValues: Array<[string, any]>, animationsPaused: boolean}|null}
 */
export function snapshotEffectControlState(effect) {
  if (!effect?.controllerByName) return null;
  const paramValues = [];
  for (const name of effect.writableParamNames || []) {
    const controller = effect.controllerByName.get(name);
    if (controller) paramValues.push([name, controller.getValue()]);
  }
  return {
    paramValues,
    animationsPaused: Boolean(effect.animationState?.pause),
  };
}

/**
 * Restore a copied effect state through the rebuilt GUI controllers.
 * @param {Object|null|undefined} effect - Rebuilt effect control state.
 * @param {{paramValues: Array<[string, any]>, animationsPaused: boolean}|null} snapshot
 * @returns {void}
 */
export function restoreEffectControlState(effect, snapshot) {
  if (!effect?.controllerByName || !snapshot) return;
  const pauseController = effect.pauseController;
  if (snapshot.animationsPaused && pauseController) pauseController.setValue(true);
  for (const [name, value] of snapshot.paramValues) {
    const controller = effect.controllerByName.get(name);
    if (controller) controller.setValue(value);
  }
  if (!snapshot.animationsPaused && pauseController) pauseController.setValue(false);
}

/**
 * Apply the initial resolution/effect state before dismissing the loader.
 * @param {Function} apply - Applies initial state; false means rejected.
 * @param {Function} onSuccess - Runs only after the initial state applies.
 * @returns {void}
 */
export function applyInitialState(apply, onSuccess) {
  if (apply() === false) {
    throw new Error('Initial resolution/effect initialization was rejected.');
  }
  onSuccess();
}

/**
 * Classify a switch transaction's outcome into what the app should report. A
 * rejected switch whose rollback succeeded is logged only — the previous state
 * is back and the page is usable. A failed rollback leaves state, URL, and
 * engine possibly disagreeing, so it additionally earns the fatal banner.
 * @param {string} label - What switched, for the log lines ("Effect"/"Resolution").
 * @param {{applied: boolean, failure: any, recoveryFailure: any}} result - A
 *   runSwitchTransaction() outcome.
 * @returns {{logs: Array<{message: string, error: any}>, fatal: string|null}}
 *   Console lines to emit in order, and the fatal-banner text when there is one.
 */
export function switchFailureReport(label, result) {
  const logs = [];
  if (result.failure) {
    logs.push({ message: `${label} switch failed:`, error: result.failure });
  }
  if (!result.recoveryFailure) return { logs, fatal: null };
  logs.push({ message: `${label} rollback failed:`, error: result.recoveryFailure });
  return {
    logs,
    fatal: `${label} change failed and the previous state could not be restored. `
      + 'Reload the page.',
  };
}

/**
 * Subscribe the effect and resolution switch transactions to an app state.
 *
 * Every effect/resolution change runs as a transaction: apply it, and on
 * rejection put the previous effect, resolution, URL, and effect control values
 * back. Rollback re-enters appState, so the subscription mutes itself for the
 * duration — isRestoring() exposes that window to applyResolution(), which feeds
 * it to planResolutionApply() to decide whether an effect correction can reach
 * applyEffect() through the subscription or must be applied by hand.
 *
 * A rejected resolution switch also re-asserts the URL after the current task,
 * because the rollback's appState write lands before the URL writer has flushed
 * the rejected value.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {{get: Function, set: Function, update: Function, subscribe: Function}}
 *   deps.appState - The state to subscribe to and roll back.
 * @param {() => any} deps.getActiveEffect - Reads the live effect control record;
 *   called again after each rollback apply, which rebuilds it.
 * @param {(preserveParams?: boolean) => boolean|void} deps.applyEffect - Applies
 *   the state's effect; false means rejected.
 * @param {(preserveParams?: boolean) => boolean|void} deps.applyResolution -
 *   Applies the state's resolution; false means rejected.
 * @param {() => string} deps.currentUrl - Snapshots the URL to restore.
 * @param {(url: string) => void} deps.restoreUrl - Puts a snapshotted URL back.
 * @param {(resolution: string) => void} deps.showResolution - Points the
 *   resolution control at a rolled-back value.
 * @param {() => void} deps.syncResolutionUrl - Re-asserts the applied resolution
 *   in the URL.
 * @param {(message: string, error: any) => void} deps.logError - Console sink.
 * @param {(message: string) => void} deps.showFatal - Fatal-banner sink.
 * @returns {{isRestoring: () => boolean, dispose: () => void}} The mute-window
 *   query, and an idempotent unsubscribe.
 */
export function createSwitchCoordinator({
  appState,
  getActiveEffect,
  applyEffect,
  applyResolution,
  currentUrl,
  restoreUrl,
  showResolution,
  syncResolutionUrl,
  logError,
  showFatal,
}) {
  let restoring = false;

  // Rollback writes appState, so mute the subscription for its duration or the
  // restore would be handled as a fresh switch.
  const runMuted = (restore) => {
    restoring = true;
    try {
      restore();
    } finally {
      restoring = false;
    }
  };

  const restoreEffect = (effect, url, effectState) => runMuted(() => {
    appState.set('effect', effect);
    restoreUrl(url);
    if (applyEffect(true) === false) {
      throw new Error(`Effect rollback to "${effect}" was rejected.`);
    }
    restoreEffectControlState(getActiveEffect(), effectState);
  });

  const restoreResolution = (resolution, effect, url, effectState) => runMuted(() => {
    appState.update({ resolution, effect });
    showResolution(resolution);
    restoreUrl(url);
    if (applyResolution(true) === false) {
      throw new Error(`Resolution rollback to "${resolution}" was rejected.`);
    }
    restoreEffectControlState(getActiveEffect(), effectState);
  });

  const report = (label, result) => {
    const { logs, fatal } = switchFailureReport(label, result);
    for (const { message, error } of logs) logError(message, error);
    if (fatal) showFatal(fatal);
  };

  const onChange = (key, value, old) => {
    if (restoring) return;
    if (key === 'effect') {
      const previousUrl = currentUrl();
      const previousEffectState = snapshotEffectControlState(getActiveEffect());
      report('Effect', runSwitchTransaction(
        () => applyEffect(),
        () => restoreEffect(old, previousUrl, previousEffectState),
      ));
    } else if (key === 'resolution') {
      const previousEffect = appState.get('effect');
      const previousUrl = currentUrl();
      const previousEffectState = snapshotEffectControlState(getActiveEffect());
      const result = runSwitchTransaction(
        () => applyResolution(),
        () => restoreResolution(old, previousEffect, previousUrl, previousEffectState),
      );
      if (!result.applied) queueMicrotask(syncResolutionUrl);
      report('Resolution', result);
    }
  };

  let unsubscribe = appState.subscribe(onChange);
  return {
    isRestoring: () => restoring,
    dispose() {
      if (!unsubscribe) return;
      unsubscribe();
      unsubscribe = null;
    },
  };
}

/**
 * Plan how applyResolution() should re-apply the effect after a resolution
 * change. The requested effect is kept when the new resolution offers it, else
 * corrected to the list's first entry (resolveActiveEffect). A correction runs
 * appState.set('effect', …), which synchronously fires applyEffect() through its
 * subscription, so calling applyEffect() as well would double-apply. A muted
 * subscription applies nothing, so the caller must then do it itself.
 * @param {Array<string>} availableEffects - Effects offered at the new resolution.
 * @param {string} currentEffect - The requested/active effect name.
 * @param {boolean} [subscriberMuted=false] - True while the effect subscription is
 *   suppressed (rollback), so a correction cannot re-apply the effect.
 * @returns {{nextEffect: string, effectChanged: boolean, applyDirectly: boolean}}
 *   The effect to activate, whether it differs from currentEffect, and whether the
 *   caller must call applyEffect() itself.
 */
export function planResolutionApply(availableEffects, currentEffect,
                                    subscriberMuted = false) {
  const nextEffect = resolveActiveEffect(availableEffects, currentEffect);
  const effectChanged = nextEffect !== currentEffect;
  return {
    nextEffect,
    effectChanged,
    applyDirectly: !effectChanged || subscriberMuted,
  };
}

/**
 * Select the resolution presets the engine reports it can build.
 * @param {Object<string, {w: number, h: number}>} presets - Preset label to its
 *   pixel dimensions.
 * @param {Array<Array<number>>|null|undefined} supported - `[w, h]` rows the
 *   engine reports; null/empty when it does not report them.
 * @returns {{labels: string[], unlabeled: string[]}} The preset labels to offer,
 *   in table order, and any engine row (as `WxH`) no preset covers. Every preset
 *   is offered when the engine reports nothing, or when no preset matches a
 *   reported row — an unusable list must not empty the dropdown.
 */
export function offeredResolutions(presets, supported) {
  const labels = Object.keys(presets);
  if (!supported || supported.length === 0) return { labels, unlabeled: [] };
  const rows = new Set(Array.from(supported, ([w, h]) => `${w}x${h}`));
  const key = (label) => `${presets[label].w}x${presets[label].h}`;
  const offered = labels.filter((label) => rows.has(key(label)));
  if (offered.length === 0) return { labels, unlabeled: [] };
  const covered = new Set(offered.map(key));
  return {
    labels: offered,
    unlabeled: Array.from(rows).filter((row) => !covered.has(row)),
  };
}

/**
 * The effect list a resolution preset offers.
 * @param {Object<string, {favorites?: Array<string>}>} presets - Preset label to
 *   its definition.
 * @param {string} resolution - A preset label.
 * @returns {Array<string>|null} That preset's list, or null when the preset is
 *   unknown or carries none — the caller substitutes a default list rather than
 *   leaving the sidebar and the effect switch with nothing to offer.
 */
export function resolutionEffects(presets, resolution) {
  return presets[resolution]?.favorites ?? null;
}

/**
 * Correct a resolution the engine turned out not to offer. The hydrated value
 * comes from the URL or the seeded default, both chosen before the engine
 * reported which presets it can build.
 * @param {Array<string>} labels - The offered preset labels, in table order.
 * @param {string} current - The hydrated/active resolution.
 * @returns {string|null} The label to switch to, or null when current is offered
 *   (nothing to correct) and when nothing at all is offered (no better value).
 */
export function resolutionCorrection(labels, current) {
  if (labels.length === 0 || labels.includes(current)) return null;
  return labels[0];
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

/**
 * Why the Export action cannot copy the live parameter values, if it cannot. A
 * heap-growth detach leaves the value view zero-length, the segmented source is
 * null before the first frame, as is a read that no longer matches the GUI's
 * snapshot, and the clipboard API is absent on insecure/older contexts. Any of
 * those would copy an all-zero, foreign, or unwritable preset.
 * @param {ArrayLike<number>|null|undefined} values - The live value stream.
 * @param {number} expectedLength - Length of the effect's cached paramNames list.
 * @param {boolean} hasClipboard - Whether the clipboard API is available.
 * @returns {string|null} The warning to log, or null when the copy may proceed.
 */
export function paramExportBlocker(values, expectedLength, hasClipboard) {
  if (!values || values.length === 0) {
    return 'Export: no parameter values matching the current effect; skipping copy';
  }
  if (paramValueSkew(expectedLength, values.length)) {
    return `Export: param/value length skew (${expectedLength} vs ${values.length}); skipping copy`;
  }
  if (!hasClipboard) return 'Export: clipboard API unavailable (insecure context?)';
  return null;
}

/**
 * Whether the engine's live value stream still describes the effect the GUI's
 * parameter-definition snapshot was taken from. The engine bumps a generation
 * counter on every effect load, so an unequal pair means a load landed between
 * the snapshot and this read and the values must not be bound by index. Length
 * alone cannot decide it: equal parameter counts are common across the roster,
 * so a switch between two same-sized effects passes paramValueSkew() while
 * describing different parameters.
 * @param {number|undefined} snapshotGeneration - Generation recorded when the
 *   parameter definitions were read.
 * @param {number|undefined} streamGeneration - Generation read alongside the values.
 * @returns {boolean} True when the two describe different effect loads.
 */
export function paramGenerationStale(snapshotGeneration, streamGeneration) {
  return snapshotGeneration !== streamGeneration;
}
