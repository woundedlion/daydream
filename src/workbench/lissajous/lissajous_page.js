/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/lissajous.html: the curve preview's state, its
 * sliders, and the C++ initializer it exports.
 */
import * as THREE from 'three';
import { initScene, bootstrapTool, wireCopyBlock } from '../shared.js';
import { createSlider } from '../../shared/slider.js';
import { createFrameScheduler, onPageTeardown } from '../../shared/page_lifecycle.js';
import {
  MAX_RATIONAL_TERM,
  lissajous,
  snapToRationalRatio,
  lissajousCodeString,
  domainClosureWarning,
} from './lissajous_math.js';

const TWO_PI = 2 * Math.PI;

const config = {
  C1: { min: 1, max: 100, step: 0.01, default: 12, scale: 100, label: "C₁" },
  C2: { min: 1, max: 100, step: 0.01, default: 5, scale: 100, label: "C₂" },
  A: { min: 0, max: TWO_PI, step: TWO_PI / 1000, default: 0, scale: 1000 / TWO_PI, label: "A (rad)" },
  Duration: { min: TWO_PI / 500, max: (MAX_RATIONAL_TERM * TWO_PI), step: TWO_PI / 500, default: TWO_PI, scale: 1000 / TWO_PI, label: "Domain" },
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

// One material serves every rebuild.
const lineMaterial = new THREE.LineBasicMaterial({
  color: 0x818cf8,
  transparent: true,
  opacity: 0.9,
  depthWrite: false,
  depthTest: false // Always on top effect
});

const initThree = () => {
  const result = initScene('canvasContainer', 'threeCanvas');
  scene = result.scene;

  // Cancel the pending frame so a queued rebuild cannot run against the
  // disposed scene.
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

// Coalesce rebuilds into one per animation frame.
const scheduleUpdate = createFrameScheduler(() => {
  regenerateCurve();
  updateCodeSnippet();
});

/**
 * Snaps the active frequency (C1 or C2) to maintain a simple rational ratio with the passive frequency.
 * @param {string} activeId 'C1' or 'C2'.
 * @param {number} rawNewValue The raw slider value from the input event.
 */
const snapFrequencies = (activeId, rawNewValue) => {
  if (!state.isRationalLocked) return;

  const passiveId = activeId === 'C1' ? 'C2' : 'C1';
  const passiveC = state[passiveId];

  const activeConfig = config[activeId];
  const rawActiveC = rawNewValue / activeConfig.scale;

  // Snap to the closest simple rational ratio within the slider's range and
  // compute the closing domain.
  const { snappedActiveC, closingPeriod: newDomain } = snapToRationalRatio(
    rawActiveC, passiveC, MAX_RATIONAL_TERM,
    { min: activeConfig.min, max: activeConfig.max });

  state[activeId] = snappedActiveC;

  // The readout shows the snapped frequency, which the thumb's step grid may not hold.
  sliderHandles[activeId].setValue(snappedActiveC);
  sliderHandles[activeId].setReadout(snappedActiveC);

  sliderHandles.Duration.setValue(newDomain);
  state.Duration = newDomain;
  // The readout shows the closing domain, which the thumb's step grid may miss
  // by up to half a step.
  sliderHandles.Duration.setReadout(state.Duration);

  scheduleUpdate();
};


const updateCodeSnippet = () => {
  const codeOutput = document.getElementById('lissajous_code_output');
  if (!codeOutput) return;

  const code = lissajousCodeString(state.C1, state.C2, state.A, state.Duration);
  if (codeOutput.textContent !== code) codeOutput.textContent = code;

  const warning = document.getElementById('domain_closure_warning');
  if (!warning) return;
  const text = domainClosureWarning(state.C2, state.Duration);
  if (text === null) {
    if (warning.textContent !== '') warning.textContent = '';
    warning.classList.add('hidden');
  } else {
    warning.classList.remove('hidden');
    if (warning.textContent !== text) warning.textContent = text;
  }
};


// Slider handles by config id.
const sliderHandles = {};

const mountSlider = (id, params) => {
  // Samples is a whole count; other readouts show 3 decimals, finer than the
  // step grid.
  const decimals = id === 'Samples' ? 0 : 3;
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

    state[id] = id === 'Samples' ? Math.round(newValue) : newValue;

    if ((id === 'C1' || id === 'C2') && state.isRationalLocked) {
      snapFrequencies(id, rawValue);
    } else {
      sliderHandles[id].setValue(state[id]);
      scheduleUpdate();
    }
  });
};

const init = () => {
  Object.keys(config).forEach(id => {
    mountSlider(id, config[id]);
  });

  const rationalLockCheckbox = document.getElementById('rational_lock');
  if (rationalLockCheckbox) {
    const onRationalLockChange = (e) => {
      state.isRationalLocked = e.target.checked;

      const durationSlider = document.getElementById('Duration_slider');
      const durationContainer = document.getElementById('Duration_container');
      if (!durationSlider || !durationContainer) return;

      if (state.isRationalLocked) {
        // snapFrequencies computes the domain while the lock holds.
        durationSlider.disabled = true;
        durationContainer.classList.add('opacity-50');

        snapFrequencies('C1', parseFloat(document.getElementById('C1_slider').value));

      } else {
        durationSlider.disabled = false;
        durationContainer.classList.remove('opacity-50');

        scheduleUpdate();
      }
    };
    rationalLockCheckbox.addEventListener('change', onRationalLockChange);
    onPageTeardown(() => rationalLockCheckbox.removeEventListener('change', onRationalLockChange));
  }


  onPageTeardown(wireCopyBlock({
    source: document.getElementById('lissajous_code_output'),
    button: document.getElementById('copy_code_button'),
    prompt: document.getElementById('copy_code_prompt'),
    block: document.getElementById('code_pre_block'),
  }));

  updateCodeSnippet();
  initThree();
};

bootstrapTool(init, 'Lissajous tool');
