/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The effect panel's whole lifecycle — build, mount, per-frame value sync,
 * Export, and teardown — with lil-gui, the engine, the worker pool, the
 * copy operation, and the document injected. daydream.js owns only the wiring
 * that names those collaborators, so the panel's rules (which control an engine
 * parameter maps to, which value stream feeds the sliders, what blocks an
 * Export, what a destroyed GUI must release) are unit-testable without a
 * browser or a WASM engine.
 */

import {
  resolveParamSync,
  enumChoices,
  paramControlKind,
  engineParamValue,
  paramExportBlocker,
  paramGenerationStale,
  paramValueSkew,
} from "./param_sync.js";
import { formatExportParams } from "./tools/export_params.js";

// How long a transient button label (Export status) stays before reverting.
export const FLASH_MS = 1500;
// Transient Export button labels.
export const EXPORT_COPIED = '\u2713 Copied!';
export const EXPORT_FAILED = '\u2717 Copy failed';
const RESERVED_CONTROL_NAMES = new Set([
  'reset', 'export', 'presetPosition', 'previousPreset', 'nextPreset', 'pause'
]);

/**
 * Add the lil-gui control one engine parameter definition calls for. A readonly
 * (engine-written telemetry) param becomes a session control: the engine refuses
 * to set it, so seeding it from a URL and writing it back is meaningless.
 * @param {Object} gui - The effect GUI to add to.
 * @param {Object} state - The GUI-bound value object.
 * @param {Object} p - The parameter definition.
 * @param {boolean} [hydrate=true] - Whether a matching deep link may seed it.
 * @returns {Object} The created controller.
 */
export function addParamControl(gui, state, p, hydrate = true) {
  const kind = paramControlKind(p);
  const add = p.readonly
    ? (...args) => gui.addSession(...args)
    : !hydrate && typeof gui.addUnhydrated === 'function'
      ? (...args) => gui.addUnhydrated(...args)
    : (...args) => gui.add(...args);
  let controller;
  if (kind === 'boolean') {
    controller = add(state, p.name);
  } else if (kind === 'enum') {
    // Dropdown of labels whose values are the option indices the engine expects.
    controller = add(state, p.name, enumChoices(p.options));
  } else if (kind === 'integer') {
    // The engine truncates a fractional write, so offer only what it can hold.
    controller = add(state, p.name, p.min, p.max, 1).decimals(0);
  } else {
    controller = add(state, p.name, p.min, p.max).decimals(3);
  }
  controller.isBoolean = (kind === 'boolean');
  return controller;
}

/**
 * Build the effect GUI controller for the app's active effect.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {() => Object} deps.createGui - Makes an empty effect GUI root.
 * @param {() => Array<Object>} deps.getParameterDefinitions - Reads the engine's
 *   parameter definitions for the effect it currently has loaded.
 * @param {() => number|undefined} deps.paramGeneration - Reads the engine's
 *   effect-load generation, stamped onto each definitions snapshot.
 * @param {() => boolean} deps.segmentsOwnDisplay - Whether the worker pool owns
 *   the display, making its values (not the idle main engine's) the live ones.
 * @param {() => ArrayLike<number>|null} deps.segmentParamValues - The pool's
 *   per-frame value stream.
 * @param {() => number|null|undefined} [deps.segmentParamGeneration] - Schema
 *   generation paired with segment 0's value stream.
 * @param {() => ArrayLike<number>|null} deps.engineParamValues - The main
 *   engine's per-frame value stream.
 * @param {(name: string, value: number) => void} deps.setEngineParam - Writes one
 *   parameter to the main engine.
 * @param {(name: string, value: number) => void} deps.setWorkerParam - Writes one
 *   parameter to the worker pool.
 * @param {(paused: boolean) => void} deps.setAnimationsPaused - Freezes/resumes
 *   animation-driven params on every engine.
 * @param {() => number} deps.getPresetCount - Number of presets on the live effect.
 * @param {() => number} deps.getPresetIndex - Selected preset on the live effect.
 * @param {(index: number) => boolean} deps.synchronizePreset - Mirrors a live
 *   worker preset into the engine that owns GUI parameter definitions.
 * @param {(index: number) => boolean} deps.selectPreset - Selects one preset on every engine.
 * @param {() => boolean|undefined} deps.engineAnimationsPaused - Reads the main
 *   engine's animation-pause state, undefined on a module without the accessor.
 * @param {() => void} deps.applyEffect - Rebuilds the panel from engine state
 *   (the Reset button).
 * @param {() => Object|null} deps.guiContainer - The element the panel mounts in.
 * @param {() => Object|null} deps.activeElement - The document's focused element.
 * @param {() => boolean} deps.isMobile - Whether to mount the panel collapsed.
 * @param {{addEventListener: Function, removeEventListener: Function}}
 *   deps.dragTarget - Where the drag-end listeners live (the window): a lil-gui
 *   drag continues outside the control's own DOM.
 * @param {(text: string) => Promise<boolean>} deps.copyText - Copies text using
 *   the browser's available clipboard path.
 * @param {(message: string, error?: any) => void} [deps.logWarn] - Console sink.
 * @returns {{active: () => Object|null, liveParamValues: () => ArrayLike<number>|null,
 *   build: () => void, applyAnimationPause: () => void, mount: () => void,
 *   sync: () => void, destroy: () => void}}
 */
export function createEffectGui({
  createGui,
  getParameterDefinitions,
  paramGeneration,
  segmentsOwnDisplay,
  segmentParamValues,
  segmentParamGeneration = () => undefined,
  engineParamValues,
  setEngineParam,
  setWorkerParam,
  setAnimationsPaused,
  getPresetCount,
  getPresetIndex,
  synchronizePreset,
  selectPreset,
  engineAnimationsPaused,
  applyEffect,
  guiContainer,
  activeElement,
  isMobile,
  dragTarget,
  copyText,
  logWarn = (...args) => console.warn(...args),
}) {
  let activeEffect = null;
  // Throttle the param/value length-skew warning to once per skew episode.
  let skewLogged = false;
  let rebuildFailureGeneration;

  /**
   * Live per-frame parameter values for the active effect. Once the worker pool
   * owns the display the main engine is no longer stepped, so its values are
   * stale; source from segment 0's worker instead (the pool drops its values on
   * an effect switch and fences the stream on renderGen). May be null or
   * zero-length if the WASM view detached on heap growth — callers must guard.
   * @returns {ArrayLike<number>|null} Null when no stream describes the GUI's
   *   current parameter snapshot.
   */
  function liveParamValues() {
    // The main engine's value stream describes whatever effect it last loaded;
    // pairing it with a snapshot from an earlier load binds sliders to another
    // effect's values, which equal parameter counts would hide. The main engine
    // also owns the parameter definitions in segmented mode, even though segment
    // 0 owns the live values, so this identity check precedes the source choice.
    if (activeEffect
        && paramGenerationStale(activeEffect.paramGeneration, paramGeneration())) {
      return null;
    }
    if (segmentsOwnDisplay()) {
      const valuesGeneration = segmentParamGeneration();
      if (valuesGeneration != null
          && paramGenerationStale(activeEffect?.paramGeneration, valuesGeneration)) {
        return null;
      }
      return segmentParamValues();
    }
    return engineParamValues();
  }

  function adoptPauseDisplay(fx, paused) {
    if (paused === undefined || paused === fx.pause.animationState.pause) return;
    fx.pause.animationState.pause = paused;
    fx.pause.controller?.updateDisplay();
  }

  function adoptPresetDisplay(fx, count, index) {
    if (!fx.preset || count <= 0) return;
    const position = `${index + 1} / ${count}`;
    if (fx.preset.state.presetPosition === position) return;
    fx.preset.state.presetPosition = position;
    fx.preset.controller.updateDisplay();
  }

  /**
   * Push the engine's per-frame parameter values back into the effect GUI so
   * animation-driven params track live, without clobbering controllers the user
   * is actively editing.
   * @returns {void}
   */
  function sync() {
    if (!activeEffect || !activeEffect.controllerByName) return;
    const presetCount = getPresetCount();
    const presetIndex = getPresetIndex();
    if (!synchronizePreset(presetIndex)) return;
    if (paramGenerationStale(activeEffect.paramGeneration, paramGeneration())) {
      if (!rebuildSchema()) return;
    }
    adoptPauseDisplay(activeEffect, engineAnimationsPaused());
    adoptPresetDisplay(activeEffect, presetCount, presetIndex);
    if (!activeEffect.hasLiveParams) return;

    const values = liveParamValues();
    if (!values || values.length === 0) return;

    const names = activeEffect.paramNames;
    // A names/values length skew means the cached param list drifted from the
    // engine's value stream (e.g. a stale list after an async effect change);
    // skip rather than silently mis-bind sliders by index, mirroring the Export
    // action's check.
    if (paramValueSkew(names.length, values.length)) {
      if (!skewLogged) {
        logWarn(`Effect GUI: param/value length skew (${names.length} vs ${values.length}); skipping sync`);
        skewLogged = true;
      }
      return;
    }
    skewLogged = false;
    const n = names.length;
    for (let i = 0; i < n; i++) {
      const c = activeEffect.controllerByName.get(names[i]);
      if (!c) continue;

      // lil-gui sliders drag via a non-focusable div, invisible to activeElement,
      // so dragging covers an in-progress drag.
      const isEditing =
        c.dragging || c.domElement.contains(activeElement());

      const { update, value } = resolveParamSync(
        c.getValue(), values[i], c.isBoolean, isEditing);
      if (!update) continue;
      c.object[c.property] = value;
      c.updateDisplay();
    }
  }

  /**
   * Write the live parameter values to the clipboard as a C++ brace-init list.
   * @param {Object} fx - The effect record owning the Export button.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @param {(label: string) => void} flashExport - Shows a transient Export label.
   * @returns {void}
   */
  function exportParams(fx, params, flashExport) {
    let values = liveParamValues();
    if ((!values || values.length === 0)
        && !paramGenerationStale(fx.paramGeneration, paramGeneration())) {
      values = fx.paramNames.map((name) =>
        engineParamValue(fx.controllerByName.get(name).getValue()));
    }
    const blocked = paramExportBlocker(
      values, fx.paramNames.length, typeof copyText === 'function');
    if (blocked) {
      logWarn(blocked);
      flashExport(EXPORT_FAILED);
      return;
    }

    let text;
    try {
      text = formatExportParams(params, values);
    } catch (err) {
      logWarn('Export: parameter formatting failed', err);
      flashExport(EXPORT_FAILED);
      return;
    }

    copyText(text).then((copied) => {
      if (activeEffect !== fx) return;
      if (copied) {
        flashExport(EXPORT_COPIED);
      } else {
        logWarn('Export: clipboard copy failed');
        flashExport(EXPORT_FAILED);
      }
    }).catch((err) => {
      logWarn('Export: clipboard copy failed', err);
      if (activeEffect !== fx) return;
      flashExport(EXPORT_FAILED);
    });
  }

  /**
   * Add the effect GUI's Reset, Export, and preset navigation buttons.
   * @param {Object} fx - The effect record being built.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @returns {void}
   */
  function addEffectActions(fx, params) {
    /**
     * Flash a transient status label on the Export button, restoring the default
     * label after the flash window. Supersedes any flash still pending for this
     * GUI.
     * @param {string} label - The transient button label to show.
     * @returns {void}
     */
    const flashExport = (label) => {
      clearTimeout(fx.exportFlashTimer);
      exportCtrl.name(label);
      fx.exportFlashTimer = setTimeout(() => exportCtrl.name('Export'), FLASH_MS);
    };

    const effectActions = {
      /**
       * Rebuild the effect GUI from the engine's current state, discarding edits.
       * @returns {void}
       */
      reset() { applyEffect(); },
      /**
       * Copy the current parameter values to the clipboard as a C++ brace-init
       * list of float literals, then flash the outcome on the Export button.
       * @returns {void}
       */
      export() { exportParams(fx, params, flashExport); }
    };
    fx.gui.add(effectActions, 'reset').name('Reset');
    const exportCtrl = fx.gui.add(effectActions, 'export').name('Export');
    const presetCount = getPresetCount();
    if (presetCount > 0) {
      effectActions.presetPosition = `${getPresetIndex() + 1} / ${presetCount}`;
      const addPosition = typeof fx.gui.addSession === 'function'
        ? (...args) => fx.gui.addSession(...args)
        : (...args) => fx.gui.add(...args);
      const position = addPosition(effectActions, 'presetPosition')
        .name('Preset').disable();
      fx.preset = { state: effectActions, controller: position };
      const move = (delta) => {
        const count = getPresetCount();
        if (count <= 0) return;
        const index = (getPresetIndex() + delta + count) % count;
        if (!selectPreset(index)) return;
        adoptPresetDisplay(fx, count, index);
        adoptPauseDisplay(fx, engineAnimationsPaused() ?? true);
      };
      effectActions.previousPreset = () => move(-1);
      effectActions.nextPreset = () => move(1);
      const previous = fx.gui.add(effectActions, 'previousPreset')
        .name('Previous Preset');
      const next = fx.gui.add(effectActions, 'nextPreset').name('Next Preset');
      previous.domElement.classList.add('preset-nav-previous');
      next.domElement.classList.add('preset-nav-next');
    }
  }

  /**
   * Add the "Pause Animation" toggle, offered only when the effect has an
   * animated param.
   * @param {Object} fx - The effect record being built.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @returns {{animationState: {pause: boolean}, controller: Object|null,
   *   setPaused: (v: boolean) => void}} The toggle's state, its controller (null
   *   when no param animates), and its state transition.
   */
  function addPauseToggle(fx, params, initialPause = false, hydrate = true) {
    const animationState = { pause: Boolean(initialPause) };
    /**
     * Adopt a pause transition, applying it immediately after initial hydration
     * has been committed to the rebuilt renderers.
     * @param {boolean} v - True to freeze animations, false to resume.
     * @returns {void}
     */
    let controller = null;
    const transitionPaused = (v) => {
      animationState.pause = Boolean(v);
      if (fx.animationPauseApplied) setAnimationsPaused(animationState.pause);
    };
    const setPaused = (v) => {
      const paused = Boolean(v);
      if (controller) {
        controller.setValue(paused);
      } else {
        transitionPaused(paused);
      }
    };
    if (params.some(p => p.animated)) {
      const add = !hydrate && typeof fx.gui.addUnhydrated === 'function'
        ? (...args) => fx.gui.addUnhydrated(...args)
        : (...args) => fx.gui.add(...args);
      controller = add(animationState, 'pause').name('Pause Animation');
      controller.onChange(transitionPaused);
    }
    fx.animationState = animationState;
    fx.pauseController = controller;
    return { animationState, controller, setPaused };
  }

  /**
   * Flag a controller as dragging until the pointer is released, so sync()'s
   * value stream doesn't fight the drag. The drag-end listeners live on the drag
   * target, so they join the effect record's set for a GUI destroyed mid-drag to
   * drain.
   * @param {Object} fx - The effect record owning the controller.
   * @param {Object} controller - The controller to track.
   * @returns {void}
   */
  function trackDragState(fx, controller) {
    controller.domElement.addEventListener('pointerdown', () => {
      controller.dragging = true;
      const end = () => {
        controller.dragging = false;
        dragTarget.removeEventListener('pointerup', end);
        dragTarget.removeEventListener('pointercancel', end);
        fx.activeDragEnds.delete(end);
      };
      fx.activeDragEnds.add(end);
      dragTarget.addEventListener('pointerup', end);
      dragTarget.addEventListener('pointercancel', end);
    });
  }

  /**
   * Re-seat the pause toggle on the engine's own animation state after a
   * parameter write: the engine pauses animation-driven params implicitly when
   * one of them is written. The toggle's transition carries the adopted state on
   * to the worker pool, whose engines each keep their own copy.
   * @param {{animationState: {pause: boolean}, controller: Object|null,
   *   setPaused: (v: boolean) => void}} pause - The effect's pause toggle.
   * @param {Object} written - The definition of the parameter just written.
   * @returns {void}
   */
  function adoptEnginePause(pause, written) {
    if (!pause.controller) return;
    // undefined on a module without the accessor
    const paused = engineAnimationsPaused()
      ?? (written.animated || pause.animationState.pause);
    if (paused !== pause.animationState.pause) pause.setPaused(paused);
  }

  /**
   * Build one controller per engine parameter, recording the value-stream order.
   * A ?param=value deep link reaches the engine through the GUI's load-time
   * onChange replay.
   * @param {Object} fx - The effect record being built.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @param {{animationState: Object, controller: Object|null, setPaused: Function}}
   *   pause - The effect's pause toggle.
   * @returns {void}
   */
  function addParamControllers(fx, params, pause, previousParamNames = null) {
    // paramNames records the value-stream order; sync() binds by name, not
    // index, so a C++ param reorder can't mis-bind sliders.
    const state = {};
    fx.paramNames = [];
    fx.writableParamNames = [];
    fx.controllerByName = new Map();
    // animated (animation-driven) and readonly (engine telemetry) are the only
    // params the engine rewrites per frame; a set without them lets sync skip.
    fx.hasLiveParams = params.some(p => p.animated || p.readonly);

    params.forEach(p => {
      state[p.name] = p.value;

      const controller = addParamControl(
        fx.gui, state, p, !previousParamNames?.has(p.name));
      fx.paramNames.push(p.name);
      fx.controllerByName.set(p.name, controller);

      if (p.readonly) {
        if (typeof controller.disable === 'function') controller.disable();
        return;
      }
      fx.writableParamNames.push(p.name);
      trackDragState(fx, controller);

      controller.onChange(v => {
        const value = engineParamValue(v);
        setEngineParam(p.name, value);
        setWorkerParam(p.name, value);
        adoptEnginePause(pause, p);
      });
    });
  }

  /**
   * Construct one effect record without publishing or mounting it. Keeping the
   * old record live until this succeeds makes a schema rebuild atomic from the
   * panel's point of view.
   * @param {{initialPause?: boolean, hydratePause?: boolean,
   *   previousParamNames?: Set<string>|null}} [options] - Rebuild state.
   * @returns {Object} A complete, unmounted effect record.
   */
  function createEffectRecord({
    initialPause = false,
    hydratePause = true,
    previousParamNames = null,
  } = {}) {
    const fx = {
      gui: createGui(),
      activeDragEnds: new Set(),
      animationPauseApplied: false,
    };

    try {
      const params = getParameterDefinitions();
      const reservedParams = params
        .filter((p) => RESERVED_CONTROL_NAMES.has(p.name))
        .map((p) => p.name);
      if (reservedParams.length > 0) {
        logWarn(`Engine parameter names conflict with effect controls: ${reservedParams.join(', ')}`);
      }
      // Stamp before controls are attached: URL replay can synchronously write
      // engine params and make this snapshot stale, which the next sync must see.
      fx.paramGeneration = paramGeneration();

      addEffectActions(fx, params);
      const pause = addPauseToggle(fx, params, initialPause, hydratePause);
      addParamControllers(fx, params, pause, previousParamNames);
      fx.pause = pause;
      return fx;
    } catch (error) {
      disposeEffect(fx);
      throw error;
    }
  }

  /**
   * Release one effect record without changing which record is published.
   * @param {Object|null} fx - Record to release.
   * @returns {void}
   */
  function disposeEffect(fx) {
    if (!fx?.gui) return;
    clearTimeout(fx.exportFlashTimer);
    fx.exportFlashTimer = null;
    if (fx.activeDragEnds) {
      for (const end of fx.activeDragEnds) {
        dragTarget.removeEventListener('pointerup', end);
        dragTarget.removeEventListener('pointercancel', end);
      }
      fx.activeDragEnds.clear();
    }
    const dom = fx.gui.domElement;
    if (dom?.parentNode) dom.parentNode.removeChild(dom);
    try {
      fx.gui.destroy();
    } catch (e) {
      logWarn("GUI destroy warning:", e);
    }
  }

  /**
   * Replace a stale parameter schema without reloading the effect. Definitions
   * always come from the main engine; segmented workers only supply live values.
   * @returns {boolean} True when a replacement record was installed.
   */
  function rebuildSchema() {
    const previous = activeEffect;
    if (!previous) return false;

    const generation = paramGeneration();
    const wasMounted = Boolean(previous.gui?.domElement?.parentNode);
    const preservedPause = engineAnimationsPaused()
      ?? Boolean(previous.animationState?.pause);
    let next;
    try {
      next = createEffectRecord({
        initialPause: preservedPause,
        hydratePause: false,
        previousParamNames: new Set(previous.paramNames),
      });
    } catch (error) {
      if (rebuildFailureGeneration !== generation) {
        logWarn('Effect GUI: parameter-schema rebuild failed', error);
        rebuildFailureGeneration = generation;
      }
      return false;
    }

    // URL replay for newly revealed controls may itself pause the engine. Read
    // the actual state after all parameter callbacks, and update only the new
    // toggle model while it is still detached so preservation emits no write.
    const actualPause = engineAnimationsPaused() ?? preservedPause;
    next.pause.setPaused(actualPause);
    next.animationPauseApplied = previous.animationPauseApplied;

    disposeEffect(previous);
    activeEffect = next;
    rebuildFailureGeneration = undefined;
    skewLogged = false;
    if (wasMounted) mountEffect(next);
    return true;
  }

  /**
   * Mount one effect record in the current GUI container.
   * @param {Object} fx - Record to mount.
   * @returns {void}
   */
  function mountEffect(fx) {
    if (!fx?.gui) return;
    if (isMobile()) fx.gui.close();
    const container = guiContainer();
    if (!container) return;
    const dom = fx.gui.domElement;
    dom.classList.add('effect-gui');
    dom.classList.remove('global-gui');
    container.appendChild(dom);
  }

  return {
    /**
     * The live effect record, or null when no effect GUI is built.
     * @returns {Object|null} The active effect record.
     */
    active() { return activeEffect; },

    liveParamValues,
    sync,

    /**
     * Commit the hydrated pause state after every renderer has rebuilt its
     * effect. Subsequent GUI transitions apply immediately.
     * @returns {void}
     */
    applyAnimationPause() {
      if (!activeEffect?.animationState) return;
      activeEffect.animationPauseApplied = true;
      setAnimationsPaused(Boolean(activeEffect.animationState.pause));
    },

    /**
     * Build the effect GUI for the engine's current effect and install it as the
     * active effect record.
     * @returns {void}
     */
    build() {
      activeEffect = createEffectRecord();
    },

    /**
     * Mount the active effect GUI in the page's GUI container.
     * @returns {void}
     */
    mount() {
      mountEffect(activeEffect);
    },

    /**
     * Tear down the active effect GUI and clear the effect record. The drag's
     * pointerup/pointercancel listeners live on the drag target, not the GUI DOM,
     * so destroying the GUI mid-drag would leave them dangling — drain them first.
     * @returns {void}
     */
    destroy() {
      disposeEffect(activeEffect);
      activeEffect = null;
    },
  };
}
