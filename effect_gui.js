/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The effect panel's whole lifecycle — build, mount, per-frame value sync,
 * Export, and teardown — with lil-gui, the engine, the worker pool, the
 * clipboard, and the document injected. daydream.js owns only the wiring that
 * names those collaborators, so the panel's rules (which control an engine
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

/**
 * Add the lil-gui control one engine parameter definition calls for. A readonly
 * (engine-written telemetry) param becomes a session control: the engine refuses
 * to set it, so seeding it from a URL and writing it back is meaningless.
 * @param {Object} gui - The effect GUI to add to.
 * @param {Object} state - The GUI-bound value object.
 * @param {Object} p - The parameter definition.
 * @returns {Object} The created controller.
 */
export function addParamControl(gui, state, p) {
  const kind = paramControlKind(p);
  const add = p.readonly
    ? (...args) => gui.addSession(...args)
    : (...args) => gui.add(...args);
  let controller;
  if (kind === 'boolean') {
    controller = add(state, p.name);
  } else if (kind === 'enum') {
    // Dropdown of labels whose values are the option indices the engine expects.
    controller = add(state, p.name, enumChoices(p.options));
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
 * @param {() => ArrayLike<number>|null} deps.engineParamValues - The main
 *   engine's per-frame value stream.
 * @param {(name: string, value: number) => void} deps.setEngineParam - Writes one
 *   parameter to the main engine.
 * @param {(name: string, value: number) => void} deps.setWorkerParam - Writes one
 *   parameter to the worker pool.
 * @param {(paused: boolean) => void} deps.setAnimationsPaused - Freezes/resumes
 *   animation-driven params on every engine.
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
 * @param {() => Object|null} deps.clipboard - The clipboard API, or null on an
 *   insecure/older context.
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
  engineParamValues,
  setEngineParam,
  setWorkerParam,
  setAnimationsPaused,
  engineAnimationsPaused,
  applyEffect,
  guiContainer,
  activeElement,
  isMobile,
  dragTarget,
  clipboard,
  logWarn = (...args) => console.warn(...args),
}) {
  let activeEffect = null;
  // Throttle the param/value length-skew warning to once per skew episode.
  let skewLogged = false;

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
    if (segmentsOwnDisplay()) return segmentParamValues();
    // The main engine's value stream describes whatever effect it last loaded;
    // pairing it with a snapshot from an earlier load binds sliders to another
    // effect's values, which equal parameter counts would hide.
    if (activeEffect
        && paramGenerationStale(activeEffect.paramGeneration, paramGeneration())) {
      return null;
    }
    return engineParamValues();
  }

  /**
   * Push the engine's per-frame parameter values back into the effect GUI so
   * animation-driven params track live, without clobbering controllers the user
   * is actively editing.
   * @returns {void}
   */
  function sync() {
    if (!activeEffect || !activeEffect.controllerByName) return;
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
    const values = liveParamValues();
    const board = clipboard();
    const blocked = paramExportBlocker(
      values, fx.paramNames.length, Boolean(board));
    if (blocked) {
      logWarn(blocked);
      flashExport(EXPORT_FAILED);
      return;
    }

    board.writeText(formatExportParams(params, values)).then(() => {
      if (activeEffect !== fx) return;
      flashExport(EXPORT_COPIED);
    }).catch((err) => {
      logWarn('Export: clipboard write failed', err);
      if (activeEffect !== fx) return;
      flashExport(EXPORT_FAILED);
    });
  }

  /**
   * Add the effect GUI's Reset and Export buttons.
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
  function addPauseToggle(fx, params) {
    const animationState = { pause: false };
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
      controller = fx.gui.add(animationState, 'pause').name('Pause Animation');
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
  function addParamControllers(fx, params, pause) {
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

      const controller = addParamControl(fx.gui, state, p);
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
      activeEffect = {
        gui: createGui(),
        activeDragEnds: new Set(),
        animationPauseApplied: false,
      };
      // Identity of this GUI's effect record, so async continuations can tell
      // whether a switch has since replaced it.
      const fx = activeEffect;

      const params = getParameterDefinitions();
      // Stamp the snapshot with the engine's effect-load generation so a later
      // value read can prove it describes these definitions.
      fx.paramGeneration = paramGeneration();

      addEffectActions(fx, params);
      const pause = addPauseToggle(fx, params);
      addParamControllers(fx, params, pause);
    },

    /**
     * Mount the active effect GUI in the page's GUI container.
     * @returns {void}
     */
    mount() {
      if (!activeEffect || !activeEffect.gui) return;

      // Driver's container-width isMobile, not window.innerWidth (differs for a
      // narrow container in a wide window).
      if (isMobile()) activeEffect.gui.close();

      const container = guiContainer();
      if (!container) return;
      const dom = activeEffect.gui.domElement;
      dom.classList.add('effect-gui');
      dom.classList.remove('global-gui');
      container.appendChild(dom);
    },

    /**
     * Tear down the active effect GUI and clear the effect record. The drag's
     * pointerup/pointercancel listeners live on the drag target, not the GUI DOM,
     * so destroying the GUI mid-drag would leave them dangling — drain them first.
     * @returns {void}
     */
    destroy() {
      if (activeEffect && activeEffect.gui) {
        // A pending Export flash would otherwise fire into a destroyed controller.
        clearTimeout(activeEffect.exportFlashTimer);
        activeEffect.exportFlashTimer = null;
        if (activeEffect.activeDragEnds) {
          for (const end of activeEffect.activeDragEnds) {
            dragTarget.removeEventListener('pointerup', end);
            dragTarget.removeEventListener('pointercancel', end);
          }
          activeEffect.activeDragEnds.clear();
        }
        const dom = activeEffect.gui.domElement;
        if (dom && dom.parentNode) dom.parentNode.removeChild(dom);
        // Only lil-gui's own teardown is tolerated to throw; a leaked listener set
        // or a detached DOM node above is a real bug and should surface, not be
        // muffled.
        try {
          activeEffect.gui.destroy();
        } catch (e) {
          logWarn("GUI destroy warning:", e);
        }
      }
      activeEffect = null;
    },
  };
}
