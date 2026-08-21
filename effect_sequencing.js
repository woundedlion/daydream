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

/** @typedef {import('./holosphere_wasm.js').HolosphereEngine} HolosphereEngine */
/** @typedef {import('./holosphere_wasm.js').HolosphereModule} HolosphereModule */

/** One lil-gui control, as the effect panel hands it out. @typedef {{getValue: () => any, setValue: (value: any) => void}} ParamController */

/**
 * The live effect panel's control record. Absent members are the states the
 * panel publishes before or without a built GUI.
 * @typedef {Object} EffectControlRecord
 * @property {Map<string, ParamController>} [controllerByName] - Control per engine parameter.
 * @property {string[]} [writableParamNames] - Parameters the engine accepts writes for.
 * @property {ParamController} [pauseController] - The panel's pause toggle.
 * @property {{pause: boolean}} [animationState] - Live animation state.
 */

/** @typedef {{paramValues: Array<[string, any]>, animationsPaused: boolean}} EffectControlSnapshot */

/** @typedef {{applied: boolean, failure: any, recoveryFailure: any}} SwitchOutcome */

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
 * @param {EffectControlRecord|null|undefined} effect - Active effect control state.
 * @param {() => boolean} [usesFullConfigSnapshot] - Whether the live effect
 *   persists through the exhaustive versioned snapshot API.
 * @returns {EffectControlSnapshot|null}
 */
export function snapshotEffectControlState(effect,
                                           usesFullConfigSnapshot = () => false) {
  if (!effect?.controllerByName) return null;
  /** @type {Array<[string, any]>} */
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
 * @param {EffectControlRecord|null|undefined} effect - Rebuilt effect control state.
 * @param {EffectControlSnapshot|null} snapshot - What snapshotEffectControlState() held.
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
 * @param {SwitchOutcome} result - A runSwitchTransaction() outcome.
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
 * duration — mute() opens that window for callers who write appState and apply
 * it themselves, as applyResolution() does for an off-list effect correction.
 * Mute windows nest: an inner one restores the outer's state rather than
 * ending it.
 *
 * A rejected resolution switch also re-asserts the URL after the current task,
 * because the rollback's appState write lands before the URL writer has flushed
 * the rejected value.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {{get: Function, set: Function, update: Function, subscribe: Function}}
 *   deps.appState - The state to subscribe to and roll back.
 * @param {() => EffectControlRecord|null} deps.getActiveEffect - Reads the live effect control record;
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
  const runMuted = (/** @type {() => void} */ restore) => {
    const outer = restoring;
    restoring = true;
    try {
      restore();
    } finally {
      restoring = outer;
    }
  };

  const restoreEffect = (
    /** @type {string} */ effect,
    /** @type {string} */ url,
    /** @type {EffectControlSnapshot|null} */ effectState,
  ) => runMuted(() => {
    appState.set('effect', effect);
    restoreUrl(url);
    if (applyEffect(true) !== ApplyResult.APPLIED) {
      throw new Error(`Effect rollback to "${effect}" was rejected.`);
    }
    restoreEffectControlState(getActiveEffect(), effectState);
  });

  const restoreResolution = (
    /** @type {string} */ resolution,
    /** @type {string} */ effect,
    /** @type {string} */ url,
    /** @type {EffectControlSnapshot|null} */ effectState,
  ) => runMuted(() => {
    appState.update({ resolution, effect });
    showResolution(resolution);
    restoreUrl(url);
    if (applyResolution(true) !== ApplyResult.APPLIED) {
      throw new Error(`Resolution rollback to "${resolution}" was rejected.`);
    }
    restoreEffectControlState(getActiveEffect(), effectState);
  });

  const report = (/** @type {string} */ label, /** @type {SwitchOutcome} */ result) => {
    const { logs, notice, fatal } = switchFailureReport(label, result);
    for (const { message, error } of logs) logError(message, error);
    showNotice(notice);
    if (fatal) showFatal(fatal);
  };

  const onChange = (
    /** @type {string} */ key, /** @type {any} */ value, /** @type {any} */ old) => {
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
 * @param {() => HolosphereEngine|null} deps.getEngine - The main WASM engine, null until
 *   the module finishes loading (the GUI and sidebar are built either way).
 * @param {() => HolosphereModule} deps.getModule - The loaded WASM module, for its
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
 * @param {{active: boolean, refreshPresetState: () => void,
 *   setEffect: (effect: string) => void,
 *   setResolution: (w: number, h: number) => void}} deps.segments - The SegmentController.
 * @param {{setStrobeColumns: (strobe: boolean) => void, invalidate: () => void,
 *   updateResolution: (w: number, h: number, dotSize: number) => void}} deps.driver -
 *   The Daydream driver.
 * @param {{setActive: (effect: string) => void,
 *   setEffects: (names: string[], sizes: Record<string, number>|null) => void}}
 *   deps.sidebar - The effect sidebar.
 * @param {(write: () => void) => void} deps.muteSubscription - Runs an appState
 *   write with the switch subscription muted, for state this pipeline applies
 *   itself.
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
  muteSubscription,
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
    if (!engine) return false;
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

    if (getEngine() && segments.active) segments.refreshPresetState();

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
   * @returns {string} ApplyResult.APPLIED, else ApplyResult.REJECTED. REJECTED is
   *   not a no-op: only the two early rejections — an unknown preset name, and an
   *   engine setResolution rejection — leave everything as it was. A refused
   *   effect correction or a rejected applyEffect returns REJECTED after the
   *   engine, worker pool, driver and sidebar have already moved to the new
   *   resolution, so recovery is the caller's rollback re-apply, not a return
   *   here; reverting appState alone leaves those mutations standing.
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

    /** @type {Record<string, number>|null} */
    let effectSizes = null;
    if (engine) {
      try { effectSizes = engine.getEffectSizes(); }
      catch (e) { logWarn('getEffectSizes failed (sidebar sizes unavailable):', e); }
    }
    sidebar.setEffects(offered, effectSizes);

    // Done after updateResolution()/setEffects() so the re-apply builds against
    // the resized dot mesh and the refreshed sidebar.
    const { nextEffect, effectChanged } =
      planResolutionApply(offered, appState.get('effect'));
    if (effectChanged) {
      // Muted: an un-muted set opens a nested effect transaction inside this
      // one, whose rollback re-applies an effect this resolution does not offer
      // and so fails, reporting the unrecoverable banner. The resolution
      // transaction's own rollback recovers instead.
      muteSubscription(() => appState.set('effect', nextEffect));
      if (appState.get('effect') !== nextEffect) return ApplyResult.REJECTED;
    }

    // A correction's param URL entries belong to the effect it dropped.
    if (applyEffect(preserveParams && !effectChanged) !== ApplyResult.APPLIED) {
      return ApplyResult.REJECTED;
    }

    driver.invalidate();
    return ApplyResult.APPLIED;
  }

  return { applyEffect, applyResolution };
}

/**
 * Plan how applyResolution() should re-apply the effect after a resolution
 * change. The requested effect is kept when the new resolution offers it, else
 * corrected to the list's first entry (resolveActiveEffect). The caller writes
 * the correction with the switch subscription muted and applies it itself, so a
 * refused correction rejects the resolution change instead of opening a nested
 * effect transaction inside it.
 * @param {Array<string>} availableEffects - Effects offered at the new resolution.
 * @param {string} currentEffect - The requested/active effect name.
 * @returns {{nextEffect: string, effectChanged: boolean}} The effect to activate
 *   and whether it differs from currentEffect.
 */
export function planResolutionApply(availableEffects, currentEffect) {
  const nextEffect = resolveActiveEffect(availableEffects, currentEffect);
  return { nextEffect, effectChanged: nextEffect !== currentEffect };
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
  const key = (/** @type {string} */ label) => `${presets[label].w}x${presets[label].h}`;
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
  const preset = Object.hasOwn(presets, resolution) ? presets[resolution] : null;
  return preset?.favorites ?? null;
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
