/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import createHolosphereModule from "./holosphere_wasm.js";
import { Daydream, SLOW_FRAME_MS } from "./driver.js";
import { GUI, resetGUI } from "gui";
import { EffectSidebar } from "./sidebar.js";
import { AppState, URLSync } from "./state.js";
import { VideoRecorder } from "./recorder.js";
import { SegmentController } from "./segment_controller.js";
import { refreshPixelView as computePixelView } from "./pixel_view.js";
import { resolveParamSync } from "./param_sync.js";

///////////////////////////////////////////////////////////////////////////////
//
// Failure-handling doctrine (boundary between this file and the engine layers):
//
//   * This main-thread UI layer DEGRADES GRACEFULLY. When an engine call that
//     depends on user/config input fails (setEffect, setResolution,
//     getEffectSizes, getArenaMetrics, ...), it logs via console.error/warn,
//     keeps the last good state, and returns — never white-screening the user
//     over a bad effect name or an unsupported resolution.
//   * The engine/protocol/pure layers TRAP. segment_layout.js validates its
//     inputs with `throw`, segment_controller.composite() throws on an
//     out-of-bounds blit, and the WASM module fail-fasts on a broken invariant.
//     These are programmer/contract errors that must not be silently absorbed.
//
// Rule of thumb: degrade where the failure is the user's (recoverable input);
// trap where the failure is ours (a violated invariant). The graceful catches
// below are deliberate, not missing error handling.
//
///////////////////////////////////////////////////////////////////////////////

const HiResFavorites = [
  "BZReactionDiffusion",
  "ChaoticStrings",
  "Comets",
  "DreamBalls",
  "MeshFeedback",
  "FlowField",
  "Flyby",
  "GnomonicStars",
  "GSReactionDiffusion",
  "HankinSolids",
  "HopfFibration",
  "IslamicStars",
  "Liquid2D",
  "MindSplatter",
  "MobiusGrid",
  "PetalFlow",
  "Raymarch",
  "RingSpin",
  "SphericalHarmonics",
  "SplineFlow",
  "DistortedRing",
  "ShapeShifter",
  "Thrusters",
  "Voronoi",
];

const LoResFavorites = [
  "BZReactionDiffusion",
  "ChaoticStrings",
  "Comets",
  "Dynamo",
  "FlowField",
  "GnomonicStars",
  "GSReactionDiffusion",
  "HankinSolids",
  "IslamicStars",
  "Liquid2D",
  "MobiusGrid",
  "PetalFlow",
  "Raymarch",
  "RingShower",
  "RingSpin",
  "SplineFlow",
  "DistortedRing",
  "ShapeShifter",
  "Thrusters",
  "Voronoi",
];

// Resolution presets and effect lists per resolution
const resolutionPresets = {
  "Holosphere (20x96)": { h: 20, w: 96, dotSize: 2 },
  "Phantasm (144x288)": { h: 144, w: 288, dotSize: 0.25 },
};

const effectsByResolution = {
  "Holosphere (20x96)": LoResFavorites,
  "Phantasm (144x288)": HiResFavorites,
};

let wasmModule = null;
let wasmEngine = null;
let wasmMemoryView = null;
let wasmAdapter = null;
// Constructed once daydream's canvas exists (see below). Until then it is null;
// the recording controls all guard with `if (recorder)` / `recorder?.`.
let recorder = null;

/**
 * Re-fetch the WASM pixel view when missing or detached (heap growth can detach
 * the underlying ArrayBuffer, leaving a zero-length view), and re-point the two
 * display aliases at it so source, displayed attribute, and Daydream.pixels match.
 * @returns {void}
 */
function refreshPixelView() {
  // Load-bearing: a non-detached view is never stale. Emscripten grows the heap
  // by detaching the old ArrayBuffer in place (byteLength drops to 0) and binding
  // the WASM memory to a fresh one, so the ONLY way a previously-fetched view
  // stops pointing at live pixel memory is detachment — which the byteLength
  // guard catches. A still-attached wasmMemoryView therefore aliases current
  // memory and needs no re-fetch; re-fetching every frame would be wasted work.
  const { view, refreshed } = computePixelView(
    wasmMemoryView, () => wasmEngine.getPixels());
  if (refreshed) {
    // Re-point all three display aliases at the fresh view so source, the
    // displayed instanceColor attribute, and Daydream.pixels stay in lockstep.
    wasmMemoryView = view;
    daydream.dotMesh.instanceColor.array = view;
    Daydream.pixels = view;
  }
}

/**
 * Push the engine's per-frame parameter values back into the effect GUI so
 * animation-driven params track live, without clobbering controllers the user
 * is actively editing.
 * @returns {void}
 */
function syncGUI() {
  if (!activeEffect || !activeEffect.controllerByName) return;

  // Zero-copy view over WASM memory (see wasm.cpp getParamValues). Like
  // getPixels(), heap growth can detach the buffer and leave a zero-length
  // view; it is fetched fresh and consumed synchronously here, but guard anyway
  // so a detached/stale view skips this frame rather than silently mis-reading.
  const values = wasmEngine.getParamValues();
  if (values.length === 0) return;

  // values[i] is the i-th parameter in getParameterDefinitions() order (which
  // getParamValues() mirrors); paramNames was captured from the same iteration
  // at GUI-build time, so names[i] labels values[i]. Look the controller up by
  // that name so the controller-build order is decoupled from the value-stream
  // order.
  const names = activeEffect.paramNames;
  const n = Math.min(names.length, values.length);
  for (let i = 0; i < n; i++) {
    const c = activeEffect.controllerByName.get(names[i]);
    if (!c) continue;

    // Skip if the user is editing this controller. A focused text input shows up
    // in activeElement, but lil-gui sliders drag via a non-focusable div (verified
    // in the lil-gui source), so a drag is invisible to the focus check — the
    // _dragging flag, set by the pointerdown/up guard at GUI-build time, covers it.
    const isEditing =
      c._dragging || c.domElement.contains(document.activeElement);

    // The bool-coercion / skip-while-editing / skip-if-unchanged decision lives
    // in the DOM-free resolveParamSync (param_sync.js) so it can be unit-tested.
    const { update, value } = resolveParamSync(
      c.getValue(), values[i], c.isBoolean, isEditing);
    if (!update) continue;
    c.object[c.property] = value;
    c.updateDisplay();
  }
}

///////////////////////////////////////////////////////////////////////////////
// Instances
///////////////////////////////////////////////////////////////////////////////

const daydream = new Daydream();
let activeEffect;

///////////////////////////////////////////////////////////////////////////////
// Centralized State
///////////////////////////////////////////////////////////////////////////////

const urlParams = new URLSearchParams(window.location.search);
const initialEffect = urlParams.get('effect');
const initialResolution = urlParams.get('resolution');

const appState = new AppState({
  effect: initialEffect || 'IslamicStars',
  resolution: (initialResolution && resolutionPresets[initialResolution]) ? initialResolution : "Phantasm (144x288)",
});
// Validate ?resolution= in the sync layer so a garbage value can't overwrite
// the validated default above — applyResolution() silently no-ops on an unknown
// key, which would otherwise leave the engine at its blank startup resolution.
const urlSync = new URLSync(appState, ['effect', 'resolution'], {
  resolution: (v) => Boolean(resolutionPresets[v]),
});

// Segmented-POV worker pipeline (own state + lifecycle). wasmEngine and
// wasmMemoryView are reassignable, so they're passed as lazy getters.
const segments = new SegmentController({
  resolutionPresets,
  appState,
  getWasmEngine: () => wasmEngine,
  refreshPixelView,
  getMemoryView: () => wasmMemoryView,
});

///////////////////////////////////////////////////////////////////////////////
// Reactive Handlers — subscribe to appState
///////////////////////////////////////////////////////////////////////////////

/**
 * Tear down the current effect GUI and build a new one for the active effect.
 * @param {boolean} [preserveParams=false] - When true, keep the existing per-effect
 *   param URL entries (used during initial hydration); when false, clear them since
 *   they don't apply to the newly selected effect.
 * @returns {void}
 */
function applyEffect(preserveParams = false) {
  if (activeEffect && activeEffect.gui) {
    try {
      // Tear down any in-progress slider drag: its pointerup/pointercancel
      // listeners live on `window` (not on the GUI DOM), so destroying the GUI
      // mid-drag (effect auto-switch / resolution change) would otherwise leave
      // them dangling, holding the destroyed controller until the next release.
      if (activeEffect.activeDragEnds) {
        for (const end of activeEffect.activeDragEnds) {
          window.removeEventListener('pointerup', end);
          window.removeEventListener('pointercancel', end);
        }
        activeEffect.activeDragEnds.clear();
      }
      const dom = activeEffect.gui.domElement;
      if (dom && dom.parentNode) dom.parentNode.removeChild(dom);
      activeEffect.gui.destroy();
    } catch (e) {
      console.warn("GUI destroy warning:", e);
    }
  }
  activeEffect = null;

  // Clear the OLD effect's per-effect param URL entries (they don't apply to
  // the new effect), unless we are initializing. Preserve the global controls'
  // keys: the global GUI (resolution, axes, segmented-POV, recording…) survives
  // an effect switch with its controllers still set, so its URL params must too
  // — otherwise sharing a link drops whichever global state predates the switch.
  if (!preserveParams) {
    resetGUI(['resolution', 'effect', ...guiInstance.collectUrlKeys()]);
  }

  if (wasmEngine) {
    // setEffect() returns false for an unknown/stale effect name; the engine
    // resets to a blank state on failure, so surface it and skip building a GUI
    // for an effect that doesn't exist (mirrors the setResolution guard below).
    if (wasmEngine.setEffect(appState.get('effect')) === false) {
      console.error(`setEffect("${appState.get('effect')}") failed; effect unavailable.`);
      // The early return skips the end-of-function sidebar/worker sync. Run it
      // here so the highlight and worker pool track appState instead of stranding
      // on the previous effect (engine is blank, activeEffect stays null — no GUI
      // is built for a nonexistent effect). Keeps every surface consistent.
      if (segments.workers.length > 0) segments.setEffect(appState.get('effect'));
      sidebar.setActive(appState.get('effect'));
      return;
    }
    activeEffect = { gui: new GUI({ autoPlace: false }), activeDragEnds: new Set() };

    // Get Params from C++
    const params = wasmEngine.getParameterDefinitions();

    // Reset + Export buttons at top of effect folder
    const effectActions = {
      /**
       * Rebuild the effect GUI from the engine's current state, discarding edits.
       * @returns {void}
       */
      reset() { applyEffect(); },
      /**
       * Copy the current parameter values to the clipboard as a C++ brace-init
       * list of float literals, then flash the Export button to confirm.
       * @returns {void}
       */
      export() {
        const values = wasmEngine.getParamValues();
        const items = [];
        for (let i = 0; i < params.length; i++) {
          const v = (i < values.length) ? values[i] : 0;
          items.push(v.toFixed(4) + 'f');
        }
        const cpp = '{ ' + items.join(', ') + ' }';
        navigator.clipboard.writeText(cpp).then(() => {
          exportCtrl.name('\u2713 Copied!');
          setTimeout(() => exportCtrl.name('Export'), 1500);
        }).catch((err) => {
          // Insecure context or denied permission: surface the failure on the
          // button instead of an unhandled rejection with no user feedback.
          console.warn('Export: clipboard write failed', err);
          exportCtrl.name('\u2717 Copy failed');
          setTimeout(() => exportCtrl.name('Export'), 1500);
        });
      }
    };
    activeEffect.gui.add(effectActions, 'reset').name('Reset');
    const exportCtrl = activeEffect.gui.add(effectActions, 'export').name('Export');

    // Standard "Pause Animation" toggle — shown only when the effect has at
    // least one animation-driven param. Grabbing such a slider auto-engages it
    // (the animation freezes so the user's value takes over); untoggle resumes.
    const hasAnimated = params.some(p => p.animated);
    const animState = { pause: false };
    let pauseController = null;
    /**
     * Pause or resume animation-driven params on both the main engine and the
     * segment-worker pool, keeping the local toggle state in sync.
     * @param {boolean} v - True to freeze animations, false to resume.
     * @returns {void}
     */
    const setPaused = (v) => {
      animState.pause = v;
      wasmEngine.setAnimationsPaused(v);
      segments.setAnimationsPaused(v);
    };
    if (hasAnimated) {
      pauseController = activeEffect.gui.add(animState, 'pause').name('Pause Animation');
      pauseController.onChange(setPaused);
    }

    // Build GUI. syncGUI() binds the engine's per-frame value stream back to
    // these controllers by parameter NAME, not array index — paramNames records
    // the value-stream order (getParamValues mirrors getParameterDefinitions) so
    // a C++ param reorder can't silently mis-bind sliders.
    const state = {};
    activeEffect.paramNames = [];
    activeEffect.controllerByName = new Map();

    params.forEach(p => {
      state[p.name] = p.value;

      let controller;
      const isBool = (typeof p.value === 'boolean');

      if (isBool) {
        controller = activeEffect.gui.add(state, p.name);
      } else {
        controller = activeEffect.gui.add(state, p.name, p.min, p.max).decimals(3);
      }
      controller.isBoolean = isBool;
      activeEffect.paramNames.push(p.name);
      activeEffect.controllerByName.set(p.name, controller);

      // Read-only telemetry: keep it updating live (syncGUI) but block editing.
      if (p.readonly) {
        if (typeof controller.disable === 'function') controller.disable();
      } else {
        // Drag guard for syncGUI. lil-gui sliders drag via a non-focusable div,
        // so the engine's per-frame value stream would otherwise fight an
        // in-progress drag. Flag the controller for the duration of the drag; the
        // window listeners are attached per-drag and removed on release. They are
        // also registered on the owning effect's activeDragEnds set so a GUI
        // destroyed mid-drag (applyEffect teardown) removes them too — otherwise
        // they dangle on `window` until the next release.
        controller.domElement.addEventListener('pointerdown', () => {
          controller._dragging = true;
          const fx = activeEffect; // effect that owns this controller/drag
          const end = () => {
            controller._dragging = false;
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            if (fx && fx.activeDragEnds) fx.activeDragEnds.delete(end);
          };
          if (fx && fx.activeDragEnds) fx.activeDragEnds.add(end);
          window.addEventListener('pointerup', end);
          window.addEventListener('pointercancel', end);
        });
      }

      // Push the GUI's initial value into the engine. DeepLinkGUI.add() may have
      // overridden state[p.name] from a ?param=value deep link, but nothing fires
      // onChange on load — without this the slider shows the URL value while the
      // engine still renders the effect default. Skip read-only telemetry, which
      // flows engine → GUI, never the reverse.
      if (!p.readonly) {
        const initVal = isBool ? (state[p.name] ? 1.0 : 0.0) : state[p.name];
        if (wasmEngine.setParameter(p.name, initVal) === false)
          console.warn(`setParameter("${p.name}") rejected as unknown.`);
        // Workers are synced by segments.setEffect() below, which snapshots these
        // just-applied engine values and re-applies them AFTER the worker rebuilds
        // the effect. A per-param broadcast here would arrive BEFORE that rebuild
        // and be wiped by it — the same ordering trap the init path documents.
      }

      controller.onChange(v => {
        const floatVal = (typeof v === 'boolean') ? (v ? 1.0 : 0.0) : v;
        // setParameter returns false on an unknown name; surface it (the UI
        // degrades gracefully — see the doctrine note at the top of this file).
        if (wasmEngine.setParameter(p.name, floatVal) === false)
          console.warn(`setParameter("${p.name}") rejected as unknown.`);
        segments.setParameter(p.name, floatVal);
        // No manual URL write: DeepLinkGUI.add()'s _attachUrlWriter redirected
        // this onChange into a user slot that runs *ahead* of the preserved URL
        // writer, so the value is persisted to the deep-link URL automatically
        // after this handler returns. Effect params are top-level, so the URL
        // key is just p.name, cleared on effect switch via resetGUI.
        // Touching an animated slider takes over from the animation.
        if (p.animated && pauseController && !animState.pause) {
          setPaused(true);
          pauseController.updateDisplay();
        }
      });
    });
  }

  // Collapse the effect GUI on mobile using the driver's container-width
  // isMobile, the same source the renderer uses, rather than a separate
  // window.innerWidth probe that disagrees on a narrow container in a wide
  // window.
  if (activeEffect && activeEffect.gui && daydream.isMobile) {
    activeEffect.gui.close();
  }

  // Attach new effect's GUI to container
  if (activeEffect && activeEffect.gui) {
    const guiContainer = document.getElementById('gui-container');
    if (guiContainer) {
      activeEffect.gui.domElement.classList.add('effect-gui');
      activeEffect.gui.domElement.classList.remove('global-gui');
      guiContainer.appendChild(activeEffect.gui.domElement);
    }
  }

  if (segments.workers.length > 0) {
    segments.setEffect(appState.get('effect'));
  }

  sidebar.setActive(appState.get('effect'));
}

/**
 * Apply a resolution change: resize geometry, refresh sidebar list, then re-apply effect.
 * @param {boolean} [preserveParams=false] - Forwarded to applyEffect(); when true,
 *   preserve the current effect's param URL entries through the re-apply.
 * @returns {void}
 */
function applyResolution(preserveParams = false) {
  const resolution = appState.get('resolution');
  const p = resolutionPresets[resolution];
  if (!p) return;

  if (wasmEngine) {
    // setResolution returns false for a size the WASM factory can't build; keep
    // the current (valid) resolution rather than driving the engine blank.
    if (wasmEngine.setResolution(p.w, p.h) === false) {
      console.error(`Unsupported resolution ${p.w}x${p.h}; keeping current.`);
      return;
    }
    wasmMemoryView = null; // Force refreshPixelView to re-fetch after resize
  }

  if (segments.workers.length > 0) {
    segments.setResolution(p.w, p.h);
  }

  // Fall back to the hi-res list for an unmapped resolution key.
  const availableEffects = effectsByResolution[resolution] || HiResFavorites;

  daydream.updateResolution(p.h, p.w, p.dotSize);

  let effectSizes = null;
  if (wasmEngine) {
    try { effectSizes = wasmEngine.getEffectSizes(); }
    catch (e) { console.warn('getEffectSizes failed (sidebar sizes unavailable):', e); }
  }
  sidebar.setEffects(availableEffects, effectSizes);

  // If the current effect isn't offered at the new resolution, switch to the first
  // one. Do this AFTER updateResolution()/setEffects(): appState.set('effect', …)
  // synchronously fires the effect subscriber -> applyEffect(), which builds the
  // effect GUI. Running it first would construct that GUI against the pre-resize
  // dot mesh / stale sidebar (a mid-resize double-apply).
  let effectChanged = false;
  if (!availableEffects.includes(appState.get('effect'))) {
    appState.set('effect', availableEffects[0]);
    effectChanged = true;
  }

  // Apply the current effect in the new resolution (if not already handled by effect switch)
  if (!effectChanged) {
    applyEffect(preserveParams);
  }

  // The resolution change rebuilt the dot mesh and reframed the camera without
  // moving OrbitControls, so request a repaint for on-demand rendering (covers
  // the case where the sim is paused and wouldn't otherwise repaint).
  daydream.invalidate();
}

appState.subscribe((key, value, old) => {
  if (key === 'effect') {
    applyEffect();
  } else if (key === 'resolution') {
    applyResolution();
  }
});

///////////////////////////////////////////////////////////////////////////////
// Initialize WASM
///////////////////////////////////////////////////////////////////////////////

createHolosphereModule().then(module => {
  wasmModule = module;
  wasmEngine = new module.HolosphereEngine();

  // Apply the resolution hydrated from state/URL before first paint. Mirror
  // applyResolution()'s guard: setResolution returns false for a size the WASM
  // factory can't build, leaving the engine at its previous resolution. Log it
  // so a hydrated/hand-edited preset the engine rejects is visible rather than
  // silently diverging from the geometry. applyResolution(true) below re-runs
  // with the same preset and self-heals (keeps the current valid resolution).
  const p = resolutionPresets[appState.get('resolution')];
  if (p && wasmEngine.setResolution(p.w, p.h) === false) {
    console.error(`Init: unsupported resolution ${p.w}x${p.h} from hydrated preset; ` +
      `keeping the engine's current resolution.`);
  }

  // Don't setEffect here. The effect name is hydrated from the URL and may be
  // stale or hand-edited, but applyResolution(true) at the end of init already
  // validates it against this resolution's allow-list (correcting appState) and
  // performs the single setEffect + GUI build — self-healing a blank render on
  // its own (applyEffect logs if the engine still rejects the name). Setting it
  // here would only re-run the effect constructor an extra time before first
  // paint. Nothing below reads the effect or renders until applyResolution()
  // (the animation loop can't fire mid-synchronous-init), so deferring is safe.

  // Create persistent adapter object (avoids per-frame allocation). Segmented
  // mode is pipelined inside SegmentController.tick(): it displays frame N-1's
  // composite while frame N renders in parallel on the workers.
  wasmAdapter = {
    /**
     * Per-frame entry the driver calls: render (segmented or single-engine),
     * republish the pixel view, then mirror engine params back into the GUI.
     * @returns {void}
     */
    drawFrame() {
      if (segments.active) {
        // Composite the previous frame + dispatch the next (no-op while the
        // workers are still spawning). Runs AFTER driver.render() cleared the
        // buffer, so the composite overwrites the clear.
        segments.tick();
      } else {
        // Normal mode: single engine renders full canvas
        wasmEngine.drawFrame();
        refreshPixelView();
        // refreshPixelView() must leave the three pixel-buffer aliases pointing
        // at the one WASM view: wasmMemoryView (the rendered source), Daydream.pixels
        // (the buffer driver.render() clears each frame), and instanceColor.array
        // (the attribute THREE displays). composite() asserts this same invariant on
        // the segment path; assert it here too so a future divergence — e.g. a resize
        // that re-points only some of the three — fails loudly instead of silently
        // displaying a stale buffer that the engine never rendered into.
        if (Daydream.pixels !== wasmMemoryView ||
            daydream.dotMesh.instanceColor.array !== wasmMemoryView) {
          throw new Error(
            "drawFrame: display-buffer alias broken after refreshPixelView() — " +
            "Daydream.pixels / instanceColor.array / wasmMemoryView diverged; the " +
            "rendered WASM buffer is not the one being cleared and displayed");
        }
        daydream.dotMesh.instanceColor.needsUpdate = true;
        // Segment-stats visibility is owned by SegmentController.updateStats(),
        // invoked on the segmented-mode toggle — no per-frame DOM work needed here.
      }
      syncGUI();
    },
    /**
     * Report the engine's current arena allocation metrics for the driver's HUD.
     * @returns {Object} The WASM engine's arena metrics snapshot.
     */
    getArenaMetrics() {
      return wasmEngine.getArenaMetrics();
    },
    /**
     * Whether the buffer holds a real frame the recorder may capture this tick.
     * Single-engine mode always renders the full canvas in drawFrame(); segmented
     * mode composites a frame late, so report false until (and on any tick where)
     * a composite has not landed — otherwise the recorder captures the cleared
     * (black) buffer left by driver.render()'s fill(0).
     * @returns {boolean} True when the displayed buffer is a real rendered frame.
     */
    captureReady() {
      return segments.active ? segments.frameComposited : true;
    }
  };

  console.log("Wasm Engine Loaded");

  // Construct the recorder now that daydream's canvas exists (no throwaway
  // placeholder canvas at module-eval time).
  recorder = new VideoRecorder(daydream.canvas);
  // Track the driver's frame cadence (Daydream.FPS) instead of the recorder's
  // hardcoded default, so elapsed-time accounting stays correct if FPS changes.
  recorder.frameInterval = daydream.frameInterval;
  daydream.recorder = recorder;

  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) loadingOverlay.remove();

  // Run initial resolution setup now that WASM is ready
  applyResolution(true);
}).catch(err => {
  // Nothing renders without the engine, so a load/instantiation failure must
  // be surfaced — otherwise the loading overlay spins forever and the rejection
  // goes unhandled. Turn the overlay into an explicit error state.
  console.error('Failed to load the Holosphere WASM engine:', err);
  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) {
    loadingOverlay.classList.add('error');
    loadingOverlay.innerHTML =
      '<span class="load-error-title">Failed to load the rendering engine.</span>' +
      '<span class="load-error-detail"></span>';
    const detail = loadingOverlay.querySelector('.load-error-detail');
    // textContent (not innerHTML) so an arbitrary error message can't inject markup.
    if (detail) detail.textContent = (err && err.message) ? err.message : String(err);
  }
});

///////////////////////////////////////////////////////////////////////////////
// GUI + Sidebar Setup
///////////////////////////////////////////////////////////////////////////////

const guiInstance = new GUI({ autoPlace: false });
guiInstance.domElement.classList.add('global-gui');
// Start the global GUI collapsed on mobile, keyed off the driver's container-
// width isMobile (the same source the renderer and effect-GUI collapse use)
// rather than a separate window.innerWidth probe.
if (daydream.isMobile) {
  guiInstance.close();
}
// Guard the container lookup: a page/embed lacking #gui-container must degrade
// gracefully (no global GUI) rather than throw here and white-screen the whole
// app before the rest of the scene initializes.
const guiContainer = document.getElementById('gui-container');
if (guiContainer) {
  guiContainer.appendChild(guiInstance.domElement);
} else {
  console.warn('daydream: #gui-container not found; skipping global GUI mount.');
}

guiInstance.add({ resolution: appState.get('resolution') }, 'resolution', Object.keys(resolutionPresets))
  .name('Resolution')
  .onChange((v) => appState.set('resolution', v));

const sidebar = new EffectSidebar(
  document.getElementById('effect-sidebar'),
  (name) => appState.set('effect', name)
);

let testAllInterval = null;
guiInstance.add({ testAll: false }, 'testAll').name('Test All').onChange((v) => {
  if (v) {
    testAllInterval = setInterval(() => {
      const currentList = effectsByResolution[appState.get('resolution')];
      // Skip the tick if the active resolution has no effect list (unmapped):
      // otherwise currentList.indexOf below throws on undefined.
      if (!currentList || currentList.length === 0) return;
      const currentEffect = appState.get('effect');
      const currentIndex = currentList.indexOf(currentEffect);
      const nextIndex = (currentIndex + 1) % currentList.length;
      appState.set('effect', currentList[nextIndex]);
    }, 1000);
  } else {
    clearInterval(testAllInterval);
    testAllInterval = null;
  }
});


// Resolution setup runs once, after the WASM engine loads (see the
// createHolosphereModule().then handler above); nothing renders until
// wasmAdapter is set, so there is no need to set it up here.

guiInstance.add(daydream, 'labelAxes').name('Show Axes').onChange(() => daydream.invalidate());
guiInstance.add(daydream, 'cullBackSphere').name('Cull Back Sphere').onChange(() => daydream.invalidate());

// ── Segmented POV controls ──────────────────────────────────────────────────
const segFolder = guiInstance.addFolder('Segmented POV');
segFolder.close();
const segState = { segmented: segments.active, segments: segments.count, boundaries: segments.showBoundaries };
segFolder.add(segState, 'segmented').name('Enabled').onChange(v => {
  segments.active = v;
  if (v) {
    segments.create(segments.count);
  } else {
    segments.destroy();
    segments.updateStats();
  }
});
segFolder.add(segState, 'segments', 2, 8, 2).name('Segments').onChange(v => {
  segments.count = v;
  if (segments.active) {
    segments.create(segments.count);
  }
});
segFolder.add(segState, 'boundaries').name('Show Boundaries').onChange(v => {
  segments.showBoundaries = v;
});

// Video recording
const REC_RESOLUTIONS = { 'Native': null, '720p': 720, '1080p': 1080 };
const REC_FORMATS = { 'Auto': 'auto', 'MP4': 'mp4', 'WebM': 'webm' };
const recSettings = { _quality: 16, _resolution: 'Native', _format: 'Auto' };
Object.defineProperty(recSettings, 'quality', {
  get() { return this._quality; },
  set(v) {
    this._quality = v;
    if (recorder) recorder.bitrateMbps = v;
  }
});
Object.defineProperty(recSettings, 'recResolution', {
  get() { return this._resolution; },
  set(v) {
    this._resolution = v;
    if (recorder) {
      recorder.targetHeight = REC_RESOLUTIONS[v];
    }
  }
});
Object.defineProperty(recSettings, 'recFormat', {
  get() { return this._format; },
  set(v) {
    this._format = v;
    if (recorder) recorder.format = REC_FORMATS[v];
  }
});

// Duration readout element
const durationEl = document.createElement('div');
durationEl.className = 'rec-duration';
durationEl.style.display = 'none';
document.getElementById('canvas-container')?.appendChild(durationEl);

const recordState = { record: () => {
  if (!recorder) return;
  const canvasEl = document.getElementById('canvas-container');
  const nowRecording = recorder.toggle(appState.get('effect'));
  if (nowRecording) {
    canvasEl?.classList.add('recording');
    durationEl.style.display = '';
    recordCtrl.name('\u25a0 Stop');
  } else {
    canvasEl?.classList.remove('recording');
    durationEl.style.display = 'none';
    recordCtrl.name('\u25cf Record');
  }
}};

const recFolder = guiInstance.addFolder('Recording');
recFolder.close();
recFolder.add(recSettings, 'quality', 1, 20, 1).name('Rec Quality (Mbps)');
recFolder.add(recSettings, 'recResolution', Object.keys(REC_RESOLUTIONS)).name('Rec Resolution');
recFolder.add(recSettings, 'recFormat', Object.keys(REC_FORMATS)).name('Rec Format');
const recordCtrl = recFolder.add(recordState, 'record').name('\u25cf Record');
// Global playback shortcuts (Space = pause, ArrowRight = step) must not fire
// while the user is operating a control. The effect sidebar and lil-gui both
// implement their own Enter/Space/Arrow activation and call preventDefault but
// not stopPropagation, so the key still bubbles to this window listener —
// without a target guard, selecting an effect with Space, or any key on a
// focused gui control, also toggles the simulation. Ignore keydowns whose
// target sits inside an interactive element.
const INTERACTIVE_KEY_TARGET =
  'input, textarea, select, button, [contenteditable], .lil-gui, .effect-sidebar';
/**
 * Window keydown handler for global playback shortcuts. Ignores keys whose
 * target sits inside an interactive element (gui control, sidebar, input) so
 * activating those controls doesn't also toggle the simulation.
 * @param {KeyboardEvent} e - The keydown event.
 * @returns {void}
 */
const onKeyDown = (e) => {
  const t = e.target;
  if (t instanceof Element && t.closest(INTERACTIVE_KEY_TARGET)) return;
  daydream.keydown(e);
};
window.addEventListener("keydown", onKeyDown);

daydream.renderer.setAnimationLoop(() => {
  if (wasmAdapter) {
    daydream.render(wasmAdapter);
  }
  // Update duration readout
  if (recorder?.isRecording) {
    durationEl.textContent = recorder.elapsedFormatted;
  }
});

///////////////////////////////////////////////////////////////////////////////
// Teardown — release the listeners, timers and observers this module owns so a
// page discard leaves nothing firing into a dead scene. Symmetric with
// Daydream.dispose() and EffectSidebar.dispose().
///////////////////////////////////////////////////////////////////////////////

/**
 * Release the listeners, timers, and worker pool this module owns so a page
 * discard leaves nothing firing into a dead scene. Symmetric with
 * Daydream.dispose() and EffectSidebar.dispose().
 * @returns {void}
 */
function disposeApp() {
  window.removeEventListener("keydown", onKeyDown);
  if (testAllInterval !== null) {
    clearInterval(testAllInterval);
    testAllInterval = null;
  }
  // Finalize any in-progress recording before tearing the scene down: otherwise
  // the MediaRecorder, its capture stream, and the offscreen canvas leak and the
  // partial recording is never flushed/downloaded. stop() is a no-op when idle.
  recorder?.stop();
  // Drop the URL-sync subscription and cancel its pending debounced flush so a
  // discard can't leave the 200 ms timer firing history.replaceState into a
  // dead page.
  urlSync.dispose();
  sidebar.dispose();
  daydream.dispose();
  // Terminate the segment-worker pool too: each worker holds a live WASM
  // module, so a discard with Segmented POV enabled would leak N workers
  // until the tab closes. destroy() is a no-op when the pool is empty.
  segments.destroy();
}

// pagehide (not unload) so the bfcache path is respected: only tear down on a
// real discard, never when the page is merely frozen for back/forward cache.
window.addEventListener("pagehide", (e) => {
  if (!e.persisted) disposeApp();
});
