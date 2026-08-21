/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/lissajous.html: the curve preview's state, its
 * sliders, and the C++ initializer it exports.
 */
import * as THREE from 'three';
import { initScene, bootstrapTool, wireCopyBlock } from './shared.js';
import { createSlider } from './slider.js';
import { createFrameScheduler, onPageTeardown } from './page_lifecycle.js';
import {
  MAX_RATIONAL_TERM,
  lissajous,
  snapToRationalRatio,
  lissajousCodeString,
  domainClosureWarning,
} from './lissajous_math.js';

const TWO_PI = 2 * Math.PI;

// --- Configuration and State ---
const config = {
  C1: { min: 1, max: 100, step: 0.01, default: 12, scale: 100, label: "C₁" },
  C2: { min: 1, max: 100, step: 0.01, default: 5, scale: 100, label: "C₂" },
  A: { min: 0, max: TWO_PI, step: TWO_PI / 1000, default: 0, scale: 1000 / TWO_PI, label: "A (rad)" },
  Duration: { min: 0, max: (MAX_RATIONAL_TERM * TWO_PI), step: TWO_PI / 500, default: TWO_PI, scale: 1000 / TWO_PI, label: "Domain" },
  // scale: 1 — Samples is a raw integer count, not a scaled fixed-point value
  Samples: { min: 200, max: 10000, step: 1, default: 4000, scale: 1, label: "Samples" }
};

const state = {
  C1: config.C1.default,
  C2: config.C2.default,
  A: config.A.default,
  Duration: config.Duration.default,
  Samples: config.Samples.default,
  isRationalLocked: false // whether the rational-ratio constraint is locked
};

let scene, line;

// The curve's appearance never varies, so one material serves every rebuild.
const lineMaterial = new THREE.LineBasicMaterial({
  color: 0x818cf8,
  // linewidth is a no-op in the WebGL renderer (always 1px); omitted.
  transparent: true,
  opacity: 0.9,
  depthWrite: false,
  depthTest: false // Always on top effect
});

// --- Lissajous Function ---
// lissajous(m1, m2, a, t) lives in ./lissajous_math.js (imported above); the
// preview and the engine share its m1/m2/a/t argument order, and the
// exported LissajousParams initializer lists m1/m2/a/domain in that order.

// --- THREE.js Setup ---
const initThree = () => {
  // Camera moved closer than the default to make the curve fill the space.
  const result = initScene('canvasContainer', 'threeCanvas', {
    cameraPosition: [1.5, 1.5, 3],
  });
  scene = result.scene;

  // The scaffold's dispose() stops the render loop and detaches the resize
  // listener; cancelling the pending frame keeps a queued rebuild from
  // running against the disposed scene.
  onPageTeardown(() => {
    scheduleUpdate.cancel();
    line?.geometry.dispose();
    lineMaterial.dispose();
    result.dispose();
  });

  regenerateCurve();
};

const regenerateCurve = () => {
  if (line) {
    scene.remove(line);
    line.geometry.dispose();
  }

  const points = [];
  // state.Samples is already a rounded integer (set via Math.round on every
  // slider change), so no parseInt/string round-trip is needed.
  const segments = state.Samples;
  const domain = state.Duration;

  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * domain;
    const point = lissajous(state.C1, state.C2, state.A, t);
    points.push(point);
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  line = new THREE.Line(geometry, lineMaterial);
  line.renderOrder = 1;
  scene.add(line);
};

// Coalesce rebuilds into one per animation frame: slider oninput fires on
// every pointer tick during a drag, and each rebuild resamples up to
// config.Samples.max curve points.
const scheduleUpdate = createFrameScheduler(() => {
  regenerateCurve();
  updateCodeSnippet();
});

// --- RATIONAL CONSTRAINT LOGIC ---
// findBestRationalRatio and the snapToRationalRatio closing-domain core live
// in ./lissajous_math.js (imported above); this section keeps only the DOM
// read/write wiring around them.

/**
     * Snaps the active frequency (C1 or C2) to maintain a simple rational ratio with the passive frequency.
     * @param {string} activeId 'C1' or 'C2'.
     * @param {number} rawNewValue The raw slider value from the input event.
     */
const snapFrequencies = (activeId, rawNewValue) => {
  if (!state.isRationalLocked) return;

  const passiveId = activeId === 'C1' ? 'C2' : 'C1';
  const passiveC = state[passiveId];

  // 1. Convert the raw value from the slider input event back to the real float value
  const activeConfig = config[activeId];
  const newActiveC_Raw = rawNewValue / activeConfig.scale;

  // 2-3. Snap to the closest simple rational ratio and compute the closing
  // domain. The pure core (lissajous_math.js) handles the math; the DOM
  // read/write below stays inline. The snapped value scales the passive
  // frequency by up to MAX_RATIONAL_TERM, so the search is confined to the
  // slider's range: clamping its result afterwards would reopen the very
  // curve this just closed, while the domain below, the lock checkbox and
  // the closure warning all kept describing the unclamped ratio.
  const { snappedActiveC, closingPeriod: newDomain } = snapToRationalRatio(
    newActiveC_Raw, passiveC, MAX_RATIONAL_TERM,
    { min: activeConfig.min, max: activeConfig.max });

  // 4. Update the actual state.
  state[activeId] = snappedActiveC;

  // 5. Force the thumb to jump to the snapped position
  sliderHandles[activeId].setValue(snappedActiveC);

  // Update the Domain slider UI to reflect the new calculated domain. An
  // extreme ratio can put the closing period past the slider's range, and
  // then the value the control lands on is the domain in effect.
  const durationConfig = config.Duration;
  const shownDomain = sliderHandles.Duration.setValue(newDomain);
  state.Duration = newDomain < durationConfig.min || newDomain > durationConfig.max
    ? shownDomain
    : newDomain;

  // 6. Re-render the curve and update the code snippet
  scheduleUpdate();
};

// --- End RATIONAL CONSTRAINT LOGIC ---

// --- Code Snippet Updater ---
const updateCodeSnippet = () => {
  const codeOutput = document.getElementById('lissajous_code_output');
  if (!codeOutput) return;

  // Pure string building lives in lissajous_math.js; this stays DOM-only.
  codeOutput.textContent =
    lissajousCodeString(state.C1, state.C2, state.A, state.Duration);

  const warning = document.getElementById('domain_closure_warning');
  if (!warning) return;
  const text = domainClosureWarning(state.C2, state.Duration);
  warning.textContent = text ?? '';
  warning.classList.toggle('hidden', text === null);
};

// --- UI Setup ---

// Slider handles by config id, so code that computes a value (the rational
// snap) can drive the control it belongs to.
const sliderHandles = {};

const mountSlider = (id, params) => {
  // C1/C2 show 2 decimals; A and Duration show 3; Samples is a whole count.
  const decimals = id === 'Samples' ? 0 : (id === 'A' || id === 'Duration') ? 3 : 2;
  const scale = params.scale || 1;

  sliderHandles[id] = createSlider(`${id}_container`, {
    id,
    label: params.label,
    min: params.min,
    max: params.max,
    step: params.step,
    value: params.default,
    scale,
    decimals,
  }, (rawValue) => {
    const newValue = rawValue / scale;

    // 1. Update state based on input value first
    state[id] = id === 'Samples' ? Math.round(newValue) : newValue;

    if ((id === 'C1' || id === 'C2') && state.isRationalLocked) {
      // 2. Call snapping logic, which will recalculate state[id], update UI (slider/span), and re-render
      snapFrequencies(id, rawValue);
    } else {
      // 3. For unlocked controls, update UI and re-render normally.
      sliderHandles[id].setValue(state[id]);
      scheduleUpdate();
    }
  });
};

// --- Initialization ---
const init = () => {
  // Setup sliders first
  Object.keys(config).forEach(id => {
    mountSlider(id, config[id]);
  });

  // Set up the Rational Lock Checkbox
  const rationalLockCheckbox = document.getElementById('rational_lock');
  if (rationalLockCheckbox) {
    rationalLockCheckbox.addEventListener('change', (e) => {
      state.isRationalLocked = e.target.checked;

      const durationSlider = document.getElementById('Duration_slider');
      const durationContainer = document.getElementById('Duration_container');

      if (state.isRationalLocked) {

        // --- 1. Disable Domain Slider ---
        // The domain will be *calculated* by snapFrequencies, not just set to 2π
        durationSlider.disabled = true;
        durationContainer.classList.add('opacity-50');

        // --- 2. Snap Frequencies (which will also set the correct domain) ---
        // Use C1's current value as the starting point for snapping
        snapFrequencies('C1', parseFloat(document.getElementById('C1_slider').value));

      } else {
        // Re-enable the slider and remove visual dimming
        durationSlider.disabled = false;
        durationContainer.classList.remove('opacity-50');

        // Re-render, just in case
        scheduleUpdate();
      }
    });
  }


  // Initialize Copy Button logic
  wireCopyBlock({
    source: document.getElementById('lissajous_code_output'),
    button: document.getElementById('copy_code_button'),
    prompt: document.getElementById('copy_code_prompt'),
    block: document.getElementById('code_pre_block'),
  });

  updateCodeSnippet();
  initThree();
};

bootstrapTool(init, 'Lissajous tool');
