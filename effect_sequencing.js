/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * daydream.js's effect and resolution apply path: the apply pipeline itself, the
 * switch/rollback transaction that drives it, the "apply the effect directly vs
 * let the effect-change subscription fire it" decision, and the resolution
 * preset and effect-list rules. Every engine, driver, GUI, and sidebar
 * collaborator arrives injected, so nothing here imports a WASM engine, lil-gui,
 * or a browser and the whole path is unit-testable, mirroring resolveParamSync().
 */

import { resolveActiveEffect } from "./sidebar_logic.js";

/**
 * Outcome of an effect/resolution apply, mirroring the engine's ParamSetResult
 * enum. Only APPLIED counts as applied, so a function that falls off its end
 * reads as a rejection rather than as success.
 * @enum {string}
 */
export const ApplyResult = Object.freeze({
  APPLIED: 'APPLIED',
  REJECTED: 'REJECTED',
});

/**
 * Apply a synchronous state switch and restore the previous applied state when
 * it rejects or throws.
 * @param {() => string} apply - Applies the requested state, returning an
 *   ApplyResult; anything but APPLIED is a rejection.
 * @param {Function} rollback - Restores the previous applied state.
 * @returns {{applied: boolean, failure: any|null, recoveryFailure: any|null}}
 */
export function runSwitchTransaction(apply, rollback) {
  let failure = null;
  try {
    if (apply() === ApplyResult.APPLIED) {
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
 *
 * An effect that persists through the full-config snapshot API is carried across
 * the rollback's panel rebuild whole, by the panel itself. Replaying its
 * parameters one at a time on top of that restore would drive the effect through
 * the intermediate combinations the bridge refuses — a ShaderBall left with
 * requestedValue and acceptedValue split — so the param list is left empty and
 * only the pause state is carried here.
 *
 * @param {Object|null|undefined} effect - Active effect control state.
 * @param {() => boolean} [usesFullConfigSnapshot] - Whether the live effect
 *   persists through the exhaustive versioned snapshot API.
 * @returns {{paramValues: Array<[string, any]>, animationsPaused: boolean}|null}
 */
export function snapshotEffectControlState(effect,
                                           usesFullConfigSnapshot = () => false) {
  if (!effect?.controllerByName) return null;
  const paramValues = [];
  if (!usesFullConfigSnapshot()) {
    for (const name of effect.writableParamNames || []) {
      const controller = effect.controllerByName.get(name);
      if (controller) paramValues.push([name, controller.getValue()]);
    }
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
  // Restoring an animated param trips effect_gui's take-over auto-pause. Pausing
  // first makes that a no-op; resuming after the loop undoes one it did fire.
  if (snapshot.animationsPaused && pauseController) pauseController.setValue(true);
  for (const [name, value] of snapshot.paramValues) {
    const controller = effect.controllerByName.get(name);
    if (controller) controller.setValue(value);
  }
  if (!snapshot.animationsPaused && pauseController) pauseController.setValue(false);
}

/**
 * Apply the initial resolution/effect state before dismissing the loader.
 * @param {() => string} apply - Applies initial state, returning an ApplyResult.
 * @param {Function} onSuccess - Runs only after the initial state applies.
 * @returns {void}
 */
export function applyInitialState(apply, onSuccess) {
  if (apply() !== ApplyResult.APPLIED) {
    throw new Error('Initial resolution/effect initialization was rejected.');
  }
  onSuccess();
}

/**
 * Classify a switch transaction's outcome into what the app should report. A
 * rejected switch whose rollback succeeded is reported to the user while the
 * previous state remains usable. A failed rollback leaves state, URL, and
 * engine possibly disagreeing, so it additionally earns the fatal banner.
 * @param {string} label - What switched, for the log lines ("Effect"/"Resolution").
 * @param {{applied: boolean, failure: any, recoveryFailure: any}} result - A
 *   runSwitchTransaction() outcome.
 * @returns {{logs: Array<{message: string, error: any}>, notice: string|null,
 *   fatal: string|null}} Console lines and user-visible messages.
 */
export function switchFailureReport(label, result) {
  const logs = [];
  if (result.failure) {
    logs.push({ message: `${label} switch failed:`, error: result.failure });
  }
  if (!result.recoveryFailure) {
    const notice = result.applied ? null
      : `${label} change was rejected. The previous value was restored.`;
    return { logs, notice, fatal: null };
  }
  logs.push({ message: `${label} rollback failed:`, error: result.recoveryFailure });
  return {
    logs,
    notice: null,
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
 * @param {(preserveParams?: boolean) => string} deps.applyEffect - Applies the
 *   state's effect, returning an ApplyResult.
 * @param {(preserveParams?: boolean) => string} deps.applyResolution - Applies
 *   the state's resolution, returning an ApplyResult.
 * @param {() => string} deps.currentUrl - Snapshots the URL to restore.
 * @param {(url: string) => void} deps.restoreUrl - Puts a snapshotted URL back.
 * @param {(resolution: string) => void} deps.showResolution - Points the
 *   resolution control at a rolled-back value.
 * @param {() => void} deps.syncResolutionUrl - Re-asserts the applied resolution
 *   in the URL.
 * @param {(message: string, error: any) => void} deps.logError - Console sink.
 * @param {(message: string|null) => void} deps.showNotice - Recoverable error sink.
 * @param {(message: string) => void} deps.showFatal - Fatal-banner sink.
 * @param {() => boolean} [deps.usesFullConfigSnapshot] - Whether the live effect
 *   persists through the exhaustive versioned snapshot API, which the panel
 *   rebuild restores whole; its parameters are then not replayed one at a time.
 * @returns {{isRestoring: () => boolean, mute: (write: () => void) => void,
 *   dispose: () => void}} The mute-window query, a muted-write helper for state
 *   the caller applies itself, and an idempotent unsubscribe.
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
  showNotice,
  showFatal,
  usesFullConfigSnapshot = () => false,
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
    if (applyEffect(true) !== ApplyResult.APPLIED) {
      throw new Error(`Effect rollback to "${effect}" was rejected.`);
    }
    restoreEffectControlState(getActiveEffect(), effectState);
  });

  const restoreResolution = (resolution, effect, url, effectState) => runMuted(() => {
    appState.update({ resolution, effect });
    showResolution(resolution);
    restoreUrl(url);
    if (applyResolution(true) !== ApplyResult.APPLIED) {
      throw new Error(`Resolution rollback to "${resolution}" was rejected.`);
    }
    restoreEffectControlState(getActiveEffect(), effectState);
  });

  const report = (label, result) => {
    const { logs, notice, fatal } = switchFailureReport(label, result);
    for (const { message, error } of logs) logError(message, error);
    showNotice(notice);
    if (fatal) showFatal(fatal);
  };

  const onChange = (key, value, old) => {
    if (restoring) return;
    if (key === 'effect') {
      const previousUrl = currentUrl();
      const previousEffectState =
        snapshotEffectControlState(getActiveEffect(), usesFullConfigSnapshot);
      report('Effect', runSwitchTransaction(
        () => applyEffect(),
        () => restoreEffect(old, previousUrl, previousEffectState),
      ));
    } else if (key === 'resolution') {
      const previousEffect = appState.get('effect');
      const previousUrl = currentUrl();
      const previousEffectState =
        snapshotEffectControlState(getActiveEffect(), usesFullConfigSnapshot);
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
    mute: runMuted,
    dispose() {
      if (!unsubscribe) return;
      unsubscribe();
      unsubscribe = null;
    },
  };
}

/**
 * Build the effect and resolution apply path — the two functions every switch,
 * rollback, and initial hydration routes through.
 *
 * A rejected apply returns ApplyResult.REJECTED and leaves the engine, the
 * driver, and the worker pool as they were, so createSwitchCoordinator() can put
 * the previous state back; nothing here writes appState except the off-list
 * effect correction planResolutionApply() asks for.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {{get: Function, set: Function}} deps.appState - The applied state.
 * @param {() => Object|null} deps.getEngine - The main WASM engine, null until
 *   the module finishes loading (the GUI and sidebar are built either way).
 * @param {() => Object|null} deps.getModule - The loaded WASM module, for its
 *   EffectSetResult/ResolutionSetResult enums; non-null whenever getEngine()
 *   answers an engine.
 * @param {() => void} deps.invalidateEngineView - Drops the cached pixel view so
 *   the next refresh re-fetches it after a resize.
 * @param {Object<string, {w: number, h: number, dotSize: number}>} deps.presets -
 *   Resolution presets by label.
 * @param {(resolution: string) => Array<string>} deps.availableEffects - The
 *   effect list a resolution offers.
 * @param {{destroy: Function, build: Function, mount: Function,
 *   applyAnimationPause: Function}} deps.effectGui - The effect panel controller.
 * @param {() => void} deps.clearEffectParamUrl - Drops the outgoing effect's
 *   param URL entries.
 * @param {Object} deps.segments - The SegmentController.
 * @param {Object} deps.driver - The Daydream driver.
 * @param {Object} deps.sidebar - The effect sidebar.
 * @param {() => boolean} deps.isRestoring - Whether the effect subscription is
 *   muted (a rollback in progress).
 * @param {(message: string, error?: any) => void} [deps.logError] - Console sink.
 * @param {(message: string, error?: any) => void} [deps.logWarn] - Console sink.
 * @returns {{applyEffect: (preserveParams?: boolean) => string,
 *   applyResolution: (preserveParams?: boolean) => string}}
 */
export function createApplyPipeline({
  appState,
  getEngine,
  getModule,
  invalidateEngineView,
  presets,
  availableEffects,
  effectGui,
  clearEffectParamUrl,
  segments,
  driver,
  sidebar,
  isRestoring,
  logError = (...args) => console.error(...args),
  logWarn = (...args) => console.warn(...args),
}) {
  /**
   * Point the engine at the state's effect and mirror its strobe layout onto the
   * driver.
   * @returns {boolean} False when the engine rejected the effect.
   */
  function selectEngineEffect() {
    const engine = getEngine();
    const effect = appState.get('effect');
    // Compare against the enum value, never by truthiness (every
    // Module.EffectSetResult value is a truthy object).
    const applied =
      engine.setEffect(effect) === getModule().EffectSetResult.INSTALLED;
    driver.setStrobeColumns(engine.strobeColumns());
    if (!applied) {
      logError(`setEffect("${effect}") failed; effect unavailable.`);
    }
    return applied;
  }

  /**
   * Tear down the current effect GUI and build a new one for the active effect.
   * @param {boolean} [preserveParams=false] - When true, keep the existing
   *   per-effect param URL entries (used during initial hydration); when false,
   *   clear them since they don't apply to the newly selected effect.
   * @returns {string} ApplyResult.REJECTED when the engine rejected the effect
   *   (the caller must revert appState so UI/URL don't advertise an unapplied
   *   effect), else ApplyResult.APPLIED.
   */
  function applyEffect(preserveParams = false) {
    // A rejected effect leaves the engine unchanged, so return before the worker
    // broadcast below: sending the rejected name would diverge them from main.
    if (getEngine() && !selectEngineEffect()) return ApplyResult.REJECTED;

    effectGui.destroy();
    if (!preserveParams) clearEffectParamUrl();
    if (getEngine()) effectGui.build();
    effectGui.mount();

    // Gated on segmented mode, not on a live pool: a faulted pool can hold no
    // workers, and setEffect() is the trigger that rebuilds it from appState.
    if (segments.active) {
      segments.setEffect(appState.get('effect'));
    }

    effectGui.applyAnimationPause();

    sidebar.setActive(appState.get('effect'));
    return ApplyResult.APPLIED;
  }

  /**
   * Apply a resolution change: resize geometry, refresh sidebar list, then
   * re-apply effect.
   * @param {boolean} [preserveParams=false] - When true, keep the active effect's
   *   param URL entries through the re-apply (only if the effect is still
   *   offered; an off-list effect is corrected to the list's first entry,
   *   dropping its effect-specific URL entries regardless).
   * @returns {string} ApplyResult.REJECTED when the resolution was not applied —
   *   an unknown preset name, or an engine rejection — so the caller must revert
   *   appState and UI/URL don't advertise an unapplied value, else
   *   ApplyResult.APPLIED.
   */
  function applyResolution(preserveParams = false) {
    const resolution = appState.get('resolution');
    // Own keys only: an inherited name ("constructor") would otherwise resolve to
    // a preset with no dimensions and resize the engine to undefined.
    const p = Object.hasOwn(presets, resolution) ? presets[resolution] : null;
    if (!p) {
      logError(`Unknown resolution preset "${resolution}"; keeping current.`);
      return ApplyResult.REJECTED;
    }

    const engine = getEngine();
    if (engine) {
      // Only UNSUPPORTED rejects; RESIZED and ALREADY_ACTIVE both leave the
      // requested size active.
      if (engine.setResolution(p.w, p.h)
          === getModule().ResolutionSetResult.UNSUPPORTED) {
        logError(`Unsupported resolution ${p.w}x${p.h}; keeping current.`);
        return ApplyResult.REJECTED;
      }
      invalidateEngineView();
    }

    // Gated on segmented mode, not on a live pool: a faulted pool can hold no
    // workers, and setResolution() is the trigger that rebuilds it from appState.
    if (segments.active) {
      segments.setResolution(p.w, p.h);
    }

    const offered = availableEffects(resolution);

    driver.updateResolution(p.w, p.h, p.dotSize);

    let effectSizes = null;
    if (engine) {
      try { effectSizes = engine.getEffectSizes(); }
      catch (e) { logWarn('getEffectSizes failed (sidebar sizes unavailable):', e); }
    }
    sidebar.setEffects(offered, effectSizes);

    // Done after updateResolution()/setEffects() because appState.set('effect',…)
    // synchronously fires applyEffect(), which would otherwise build against the
    // pre-resize dot mesh / stale sidebar.
    const { nextEffect, effectChanged, applyDirectly } =
      planResolutionApply(offered, appState.get('effect'), isRestoring());
    if (effectChanged) {
      appState.set('effect', nextEffect);
      if (appState.get('effect') !== nextEffect) return ApplyResult.REJECTED;
    }

    if (applyDirectly) {
      if (applyEffect(preserveParams) !== ApplyResult.APPLIED) {
        return ApplyResult.REJECTED;
      }
    }

    driver.invalidate();
    return ApplyResult.APPLIED;
  }

  return { applyEffect, applyResolution };
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
