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

import { SRGBColorSpace } from "three";

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
  "Test",
  "TestShapes",
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
  "Test",
  "TestShapes",
  "Thrusters",
  "Voronoi",
];

// Resolution presets and effect lists per resolution
const resolutionPresets = {
  "Holosphere (20x96)": { h: 20, w: 96, size: 2 },
  "Phantasm (144x288)": { h: 144, w: 288, size: 0.25 },
};

const effectsByResolution = {
  "Holosphere (20x96)": LoResFavorites,
  "Phantasm (144x288)": HiResFavorites,
};

let wasmModule = null;
let wasmEngine = null;
let wasmMemoryView = null;
let wasmAdapter = null;
const recorder = new VideoRecorder(document.querySelector('#canvas-container canvas') || document.createElement('canvas'));

// ── Segmented POV Simulation (Web Workers) ──────────────────────────────────
// N Web Workers each load their own isolated WASM module instance.
// All workers render their segment in parallel on each frame.
// Frame time = max(segment times), not sum.
let segmentModeActive = false;
let segmentCount = 4;
let showSegmentBoundaries = true;

let segmentWorkers = [];       // Web Worker instances
let segmentResults = [];       // per-segment frame results {pixels, y0, y1, elapsed, arenaMetrics}
let segmentTimings = [];       // ms per segment (worker-measured)
let segmentRenderUs = [];      // µs rasterization time per segment
let segmentArenas = [];        // per-segment arena metrics
let segmentPending = 0;        // count of outstanding render responses
let segmentFrameStart = 0;     // wall-clock start of parallel render
let segmentWallTime = 0;       // wall-clock time from dispatch to last worker response
let segmentFrameResolve = null; // promise resolve for current frame
let segmentReady = false;      // true when all workers are initialized

function createSegmentWorkers(numSegments) {
  destroySegmentWorkers();

  const res = resolutionPresets[appState.get('resolution')];
  if (!res) return;

  segmentWorkers = [];
  segmentResults = new Array(numSegments).fill(null);
  segmentTimings = new Array(numSegments).fill(0);
  segmentRenderUs = new Array(numSegments).fill(0);
  segmentArenas = new Array(numSegments).fill(null);
  segmentReady = false;

  let readyCount = 0;

  // Snapshot the main engine's current param values so freshly-spawned (or
  // resized) workers build their effect with the user's tuned values, not the
  // effect defaults. Sent once in the init message; ongoing changes are still
  // broadcast live via workerSetParameter. Flattened to {name, value} (bools
  // encoded as 1/0) so it survives structured-clone postMessage.
  let initialParams = [];
  if (wasmEngine) {
    const defs = wasmEngine.getParameterDefinitions();
    for (let i = 0; i < defs.length; i++) {
      const p = defs[i];
      const v = (typeof p.value === 'boolean') ? (p.value ? 1.0 : 0.0) : p.value;
      initialParams.push({ name: p.name, value: v });
    }
  }

  for (let i = 0; i < numSegments; i++) {
    const worker = new Worker('./segment_worker.js', { type: 'module' });

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        readyCount++;
        if (readyCount === numSegments) {
          segmentReady = true;
          console.log(`[Segmented] All ${numSegments} workers ready`);
        }
      } else if (msg.type === 'effectReady') {
        // Worker finished loading effect, no action needed
      } else if (msg.type === 'frame') {
        segmentResults[msg.segId] = {
          pixels: msg.pixels ? new Uint16Array(msg.pixels) : null,
          x0: msg.x0, x1: msg.x1,
          y0: msg.y0, y1: msg.y1,
          quadW: msg.quadW, quadH: msg.quadH,
        };
        segmentTimings[msg.segId] = msg.elapsed;
        segmentRenderUs[msg.segId] = msg.renderUs || 0;
        segmentArenas[msg.segId] = msg.arenaMetrics;
        segmentPending--;
        if (segmentPending === 0 && segmentFrameResolve) {
          segmentFrameResolve();
          segmentFrameResolve = null;
        }
      }
    };

    worker.postMessage({
      type: 'init',
      segId: i,
      totalSegs: numSegments,
      w: res.w,
      h: res.h,
      effectName: appState.get('effect'),
      params: initialParams,
    });

    segmentWorkers.push(worker);
  }

  console.log(`[Segmented] Spawning ${numSegments} workers...`);
}

function destroySegmentWorkers() {
  for (const w of segmentWorkers) {
    w.terminate();
  }
  segmentWorkers = [];
  segmentResults = [];
  segmentTimings = [];
  segmentRenderUs = [];
  segmentArenas = [];
  segmentReady = false;
  segmentPending = 0;
  segmentFrameResolve = null;
  segmentRenderInFlight = false;
}

/** Tell all workers to set a new effect. */
function workerSetEffect(name) {
  for (const w of segmentWorkers) {
    w.postMessage({ type: 'setEffect', name });
  }
}

/** Tell all workers to set a parameter. */
function workerSetParameter(name, value) {
  for (const w of segmentWorkers) {
    w.postMessage({ type: 'setParameter', name, value });
  }
}

/** Tell all workers to update segment count. */
function workerSetSegment(numSegments) {
  for (let i = 0; i < segmentWorkers.length; i++) {
    segmentWorkers[i].postMessage({ type: 'setSegment', segId: i, totalSegs: numSegments });
  }
}

/** Tell all workers to update resolution. */
function workerSetResolution(w, h) {
  for (const worker of segmentWorkers) {
    worker.postMessage({ type: 'setResolution', w, h });
  }
}

/**
 * Dispatch parallel render to all workers.
 * Returns a Promise that resolves when all workers have responded.
 */
function renderSegmentsParallel() {
  return new Promise((resolve) => {
    segmentPending = segmentWorkers.length;
    segmentFrameStart = performance.now();
    segmentFrameResolve = () => {
      // Measure wall time when the LAST worker responds
      segmentWallTime = performance.now() - segmentFrameStart;
      resolve();
    };
    for (const w of segmentWorkers) {
      w.postMessage({ type: 'render' });
    }
  });
}

/** Composite segment results into the display buffer (quadrant model). */
function compositeSegments() {
  refreshPixelView();
  const dst = wasmMemoryView;
  if (!dst) return;

  dst.fill(0);

  const w = Daydream.W;
  const h = Daydream.H;

  // Copy each quadrant's pixel rectangle into the right position
  for (let s = 0; s < segmentResults.length; s++) {
    const r = segmentResults[s];
    if (!r || !r.pixels) continue;

    const qw = r.quadW;
    let srcIdx = 0;
    for (let y = r.y0; y < r.y1; y++) {
      const dstRowStart = y * w * 3;
      for (let x = r.x0; x < r.x1; x++) {
        const dstIdx = dstRowStart + x * 3;
        dst[dstIdx]     = r.pixels[srcIdx++];
        dst[dstIdx + 1] = r.pixels[srcIdx++];
        dst[dstIdx + 2] = r.pixels[srcIdx++];
      }
    }
  }

  // Draw segment boundary lines (cyan markers) on both X and Y splits
  if (showSegmentBoundaries) {
    // Collect unique Y and X boundaries
    const yBounds = new Set();
    const xBounds = new Set();
    for (const r of segmentResults) {
      if (!r) continue;
      if (r.y0 > 0) yBounds.add(r.y0);
      xBounds.add(r.x0);
    }

    // Horizontal boundary lines (full width)
    for (const boundaryY of yBounds) {
      if (boundaryY >= h) continue;
      const rowStart = boundaryY * w * 3;
      for (let x = 0; x < w; x++) {
        const idx = rowStart + x * 3;
        dst[idx]     = 0;     // R
        dst[idx + 1] = 65535; // G (cyan)
        dst[idx + 2] = 65535; // B
      }
    }

    // Vertical boundary lines (full height)
    for (const boundaryX of xBounds) {
      if (boundaryX >= w) continue;
      for (let y = 0; y < h; y++) {
        const idx = (y * w + boundaryX) * 3;
        dst[idx]     = 0;     // R
        dst[idx + 1] = 65535; // G (cyan)
        dst[idx + 2] = 65535; // B
      }
    }
  }
}

/** Update the per-segment stats overlay. */
function updateSegmentStats() {
  const el = document.getElementById('segment-stats');
  if (!el) return;

  const globalStatsDesktop = document.getElementById('global-stats-desktop');
  const globalStatsMobile = document.getElementById('stats-bar');

  if (!segmentModeActive) {
    el.style.display = 'none';
    if (globalStatsDesktop) globalStatsDesktop.style.display = '';
    if (globalStatsMobile) globalStatsMobile.style.display = '';
    return;
  }

  if (globalStatsDesktop) globalStatsDesktop.style.display = 'none';
  if (globalStatsMobile) globalStatsMobile.style.display = 'none';
  el.style.display = '';

  const fmtKB = (x) => (x / 1024).toFixed(1);
  const numSegs = segmentCount;

  let rows = '';
  for (let s = 0; s < numSegs; s++) {
    const r = segmentResults[s];
    const timing = segmentTimings[s] || 0;
    const slowClass = timing > SLOW_FRAME_MS ? ' slow' : '';

    // Per-segment arena from worker
    const a = segmentArenas[s];
    let arenaStr = '<td>-</td><td>-</td><td>-</td>';
    if (a) {
      arenaStr = `<td>${fmtKB(a.scratch_arena_a.high_water_mark)}</td>`
               + `<td>${fmtKB(a.scratch_arena_b.high_water_mark)}</td>`
               + `<td>${fmtKB(a.persistent_arena.usage)}</td>`;
    }

    const rangeStr = r
      ? `x[${r.x0}\u2013${r.x1}] y[${r.y0}\u2013${r.y1}]`
      : '?';

    const renderMs = segmentRenderUs[s] || 0;
    rows += `<tr>`
         + `<td class="seg-label">Seg ${s}</td>`
         + `<td style="color:#555;font-size:0.8em">${rangeStr}</td>`
         + `<td class="seg-time${slowClass}">${timing.toFixed(1)} ms</td>`
         + `<td class="seg-time">${renderMs.toFixed(1)} ms</td>`
         + arenaStr
         + `</tr>`;
  }

  const maxTime = Math.max(...segmentTimings);
  const wallClass = segmentWallTime > SLOW_FRAME_MS ? ' slow' : '';

  el.innerHTML = `<table>`
    + `<tr><th></th><th>Range</th><th>Compute</th><th>Render</th><th>Scr A</th><th>Scr B</th><th>Persist</th></tr>`
    + rows
    + `<tr style="border-top:1px solid #333"><td class="seg-label">max</td><td></td>`
    + `<td class="seg-time">${maxTime.toFixed(1)} ms</td><td></td><td colspan="3"></td></tr>`
    + `<tr><td class="seg-label">wall</td><td></td>`
    + `<td class="seg-time${wallClass}">${segmentWallTime.toFixed(1)} ms</td><td></td><td colspan="3"></td></tr>`
    + `</table>`;
}

// Guard WASM memory view — spec-correct detached buffer check
function refreshPixelView() {
  if (!wasmMemoryView || wasmMemoryView.buffer.byteLength === 0) {
    wasmMemoryView = wasmEngine.getPixels();
    daydream.dotMesh.instanceColor.array = wasmMemoryView;
    Daydream.pixels = wasmMemoryView;
  }
}

function syncGUI() {
  if (activeEffect && activeEffect.controllers) {
    const values = wasmEngine.getParamValues();
    for (let i = 0; i < activeEffect.controllers.length; i++) {
      if (i >= values.length) break;
      const c = activeEffect.controllers[i];

      // Skip if user is interacting
      if (c.domElement.contains(document.activeElement)) continue;

      let val = values[i];
      if (c.isBoolean) val = (val > 0.5);

      if (c.getValue() !== val) {
        c.object[c.property] = val;
        c.updateDisplay();
      }
    }
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
const urlSync = new URLSync(appState, ['effect', 'resolution']);

///////////////////////////////////////////////////////////////////////////////
// Reactive Handlers — subscribe to appState
///////////////////////////////////////////////////////////////////////////////

/** Tear down the current effect GUI and build a new one for the active effect. */
function applyEffect(preserveParams = false) {
  // Tear down existing GUI
  if (activeEffect && activeEffect.gui) {
    try {
      const dom = activeEffect.gui.domElement;
      if (dom && dom.parentNode) dom.parentNode.removeChild(dom);
      activeEffect.gui.destroy();
    } catch (e) {
      console.warn("GUI destroy warning:", e);
    }
  }
  activeEffect = null;

  // Clear existing params to avoid pollution, unless we are initializing
  if (!preserveParams) {
    resetGUI(['resolution', 'effect']);
  }

  if (wasmEngine) {
    wasmEngine.setEffect(appState.get('effect'));
    activeEffect = { gui: new GUI({ autoPlace: false }) };

    // Get Params from C++
    const params = wasmEngine.getParameterDefinitions();

    // Reset + Export buttons at top of effect folder
    const effectActions = {
      reset() { applyEffect(); },
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
        });
      }
    };
    activeEffect.gui.add(effectActions, 'reset').name('Reset');
    const exportCtrl = activeEffect.gui.add(effectActions, 'export').name('Export');

    // Build GUI
    const state = {};
    activeEffect.controllers = [];

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
      activeEffect.controllers.push(controller);

      controller.onChange(v => {
        const floatVal = (typeof v === 'boolean') ? (v ? 1.0 : 0.0) : v;
        wasmEngine.setParameter(p.name, floatVal);
        // Forward to workers
        workerSetParameter(p.name, floatVal);
      });
    });
  }

  if (activeEffect && activeEffect.gui && window.innerWidth < 900) {
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

  // Update workers with new effect
  if (segmentWorkers.length > 0) {
    workerSetEffect(appState.get('effect'));
  }

  // Update sidebar highlight
  sidebar.setActive(appState.get('effect'));
}

/** Apply a resolution change: resize geometry, refresh sidebar list, then re-apply effect. */
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

  // Update workers
  if (segmentWorkers.length > 0) {
    workerSetResolution(p.w, p.h);
  }

  // Update available effects based on resolution
  const availableEffects = effectsByResolution[resolution] || HiResFavorites;

  // If current effect isn't in the new list, switch to the first one
  let effectChanged = false;
  if (!availableEffects.includes(appState.get('effect'))) {
    appState.set('effect', availableEffects[0]);
    effectChanged = true;
  }

  daydream.updateResolution(p.h, p.w, p.size);

  // Update the sidebar options
  let effectSizes = null;
  if (wasmEngine) {
    try { effectSizes = wasmEngine.getEffectSizes(); } catch (e) { }
  }
  sidebar.setEffects(availableEffects, effectSizes);

  // Apply the current effect in the new resolution (if not already handled by effect switch)
  if (!effectChanged) {
    applyEffect(preserveParams);
  }
}

// Subscribe: react to state changes
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

let segmentRenderInFlight = false;

createHolosphereModule().then(module => {
  wasmModule = module;
  wasmEngine = new module.HolosphereEngine();

  // Sync resolution from state
  const p = resolutionPresets[appState.get('resolution')];
  if (p) {
    wasmEngine.setResolution(p.w, p.h);
  }

  // Set initial effect
  const effect = appState.get('effect');
  if (effect) {
    wasmEngine.setEffect(effect);
  }

  // Create persistent adapter object (avoids per-frame allocation)
  // Segmented mode is pipelined: display frame N-1's results while
  // frame N renders in parallel on the workers.
  let pendingSegmentFrame = false;  // true when workers have new results to display

  wasmAdapter = {
    drawFrame() {
      if (segmentModeActive && segmentReady && segmentWorkers.length > 0) {
        // 1. Apply the PREVIOUS frame's composite results synchronously.
        //    This runs AFTER driver.render() called pixels.fill(0),
        //    so the composite overwrites the cleared buffer.
        if (pendingSegmentFrame) {
          compositeSegments();
          updateSegmentStats();
          pendingSegmentFrame = false;
        }

        // 2. Dispatch NEXT frame's parallel render (fire-and-forget).
        //    Results arrive async; pendingSegmentFrame is set when done.
        if (!segmentRenderInFlight) {
          segmentRenderInFlight = true;
          renderSegmentsParallel().then(() => {
            pendingSegmentFrame = true;
            segmentRenderInFlight = false;
          });
        }
      } else if (!segmentModeActive) {
        // Normal mode: single engine renders full canvas
        wasmEngine.drawFrame();
        refreshPixelView();
        daydream.dotMesh.instanceColor.needsUpdate = true;
        // Hide segment stats if they were showing
        const segEl = document.getElementById('segment-stats');
        if (segEl) segEl.style.display = 'none';
      }
      syncGUI();
    },
    getArenaMetrics() {
      return wasmEngine.getArenaMetrics();
    }
  };

  console.log("Wasm Engine Loaded");

  // Wire recorder to the actual canvas now that daydream is ready
  recorder.canvas = daydream.canvas;
  daydream.recorder = recorder;

  // Remove loading overlay
  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) loadingOverlay.remove();

  // Run initial resolution setup now that WASM is ready
  applyResolution(true);
});

///////////////////////////////////////////////////////////////////////////////
// GUI + Sidebar Setup
///////////////////////////////////////////////////////////////////////////////

const guiInstance = new GUI({ autoPlace: false });
guiInstance.domElement.classList.add('global-gui');
if (window.innerWidth < 900) {
  guiInstance.close();
}
document.getElementById('gui-container').appendChild(guiInstance.domElement);

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
// createHolosphereModule().then handler above). It used to also run here
// synchronously with a null engine, but nothing renders until wasmAdapter is
// set (the animation loop is gated on it), so that early pass was redundant.

guiInstance.add(daydream, 'labelAxes').name('Show Axes');
guiInstance.add(daydream, 'cullBackSphere').name('Cull Back Sphere');

// ── Segmented POV controls ──────────────────────────────────────────────────
const segFolder = guiInstance.addFolder('Segmented POV');
segFolder.close();
const segState = { segmented: segmentModeActive, segments: segmentCount, boundaries: showSegmentBoundaries };
segFolder.add(segState, 'segmented').name('Enabled').onChange(v => {
  segmentModeActive = v;
  if (v) {
    createSegmentWorkers(segmentCount);
  } else {
    destroySegmentWorkers();
    updateSegmentStats();
  }
});
segFolder.add(segState, 'segments', 2, 8, 2).name('Segments').onChange(v => {
  segmentCount = v;
  if (segmentModeActive) {
    createSegmentWorkers(segmentCount);
  }
});
segFolder.add(segState, 'boundaries').name('Show Boundaries').onChange(v => {
  showSegmentBoundaries = v;
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
window.addEventListener("keydown", (e) => daydream.keydown(e));

daydream.renderer.setAnimationLoop(() => {
  if (wasmAdapter) {
    daydream.renderer.outputColorSpace = SRGBColorSpace;
    daydream.render(wasmAdapter);
  }
  // Update duration readout
  if (recorder?.isRecording) {
    durationEl.textContent = recorder.elapsedFormatted;
  }
});
