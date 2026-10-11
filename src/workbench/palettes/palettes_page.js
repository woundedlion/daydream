/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/palettes.html.
 */
import { copyToClipboard, wireCopyBlock } from '../../shared/clipboard.js';
import { replaceUrl } from '../../shared/url.js';
import { showFatalError, bootstrapTool } from '../../shared/banner.js';
import { linearRgbToHex } from '../../shared/color.js';
import {
  ProceduralPalette, GenerativePalette,
  proceduralPaletteCpp, proceduralParamsForViewport,
  generativePaletteCpp, setPaletteOps,
  NAMED_PROCEDURAL_PALETTES, proceduralPaletteParams,
  paletteGradientCss, prettyPaletteName, paletteAdjustmentSummary,
} from './palette_math.js';
import {
  createPaletteViewport,
  axisControlState, PALETTE_AXIS_CONTROLS,
  paletteTabFromSearch, paletteTabUrl, tablistKeyTarget,
  PALETTE_CONTROL_IDS,
  PALETTE_RECIPE_PRESETS, paletteRecipeAvailability,
  zoomRecipeWindow, paletteStripView, waveGraphLabel,
  stripDragIntent,
} from './palette_controls.js';
import { PaletteRecipeModel } from './palette_recipe_model.js';
import { mountProceduralSliders } from './procedural_sliders.js';
import { createColorStripPainter, drawWaveGraph } from './palette_canvas.js';
import { createHueKeyWheelPainter } from './palette_wheel.js';
import { createHueKeyWheel } from './hue_key_wheel_controller.js';
import { standDownIfHalted } from '../../shared/engine_halt.js';
import { wireFlyout } from '../../shared/flyout.js';
import { createFrameScheduler, onPageTeardown } from '../../shared/page_lifecycle.js';
import { createPointerDrag, innerRect } from '../../shared/pointer_drag.js';

let activeTab = 'procedural';

/** @param {string} tabName */
function switchTab(tabName, updateUrl = true) {
  activeTab = tabName;
  /** @type {HTMLElement} */ (document.getElementById('export_code_kind')).textContent = tabName === 'procedural'
    ? 'Row for HS_PROCEDURAL_PALETTE_LIST in palettes.h' : 'Recipe builder body';
  /** @type {HTMLElement} */ (document.querySelector('.palette-shell')).dataset.activeTab = tabName;
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tab-btn')).forEach(btn => {
    const selected = btn.dataset.tab === tabName;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    btn.tabIndex = selected ? 0 : -1;
  });
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tab-content')).forEach(content => {
    const selected = content.id === `tab-content-${tabName}`;
    content.classList.toggle('active', selected);
    content.hidden = !selected;
  });
  // Named Palettes loads procedural coefficients, so it only applies here.
  const palettesPanel = /** @type {HTMLElement} */ (document.getElementById('named_palettes_panel'));
  if (palettesPanel) palettesPanel.style.display = (tabName === 'procedural') ? '' : 'none';

  if (updateUrl)
    replaceUrl(paletteTabUrl(window.location.href, tabName));

  updatePalette();
}


const DEFAULT_PARAMS = {
  A_R: 0.500, A_G: 0.500, A_B: 0.500,
  B_R: 0.500, B_G: 0.500, B_B: 0.500,
  C_R: 1.000, C_G: 1.000, C_B: 1.000,
  D_R: 0.000, D_G: 0.330, D_B: 0.670
};

/** @type {ReturnType<typeof mountProceduralSliders>|null} */
let proceduralSliders = null;
/** @type {ProceduralPalette|GenerativePalette|null} */
let palette = null;
/** @type {(Omit<import('../../../generated/holosphere_wasm.js').PaletteOps, 'compileAndBakeV4'> & import('./palette_math.js').PaletteOps)|null} */
let paletteOps = null;
/** @type {import('../../../generated/holosphere_wasm.js').HolosphereModule|null} */
let wasmModule = null;
const recipeModel = new PaletteRecipeModel();
/** @type {Array<{name:string,randomHue:boolean,recipe:import('./palette_controls.js').PaletteRecipe}>} */
let effectPalettePresets = [];
const paletteViewport = createPaletteViewport();

/** @type {HTMLCanvasElement} */
let hueKeyWheelCanvas;
/** @type {CanvasRenderingContext2D|null} */
let hueKeyWheelCtx;
/** @type {ReturnType<typeof createHueKeyWheel>|null} */
let hueKeyWheel = null;

const FULL_VIEWPORT = Object.freeze({ start: 0, end: 1 });

function renderRecipeWindow() {
  const offsetSlider = /** @type {HTMLInputElement} */ (document.getElementById(PALETTE_CONTROL_IDS.offset));
  const spanSlider = /** @type {HTMLInputElement} */ (document.getElementById(PALETTE_CONTROL_IDS.span));
  const { offset, span } = recipeModel.window;
  spanSlider.value = String(span);
  offsetSlider.max = String(1 - span);
  offsetSlider.value = String(offset);
  /** @type {HTMLElement} */ (document.getElementById('gen_offset_value')).textContent = offset.toFixed(3);
  /** @type {HTMLElement} */ (document.getElementById('gen_span_value')).textContent = span.toFixed(3);
}

/** @param {number} startPosition @param {number} endPosition */
function zoomRecipeWindowControls(startPosition, endPosition) {
  const { offset, span } = zoomRecipeWindow(
    recipeModel.window, startPosition, endPosition);
  recipeModel.setWindow(offset, span);
  renderRecipeWindow();
  scheduleUpdate();
}

function visiblePhaseRange() {
  if (activeTab === 'procedural') return paletteViewport.value;
  const { offset, span } = (/** @type {GenerativePalette|null} */ (palette))?.canonicalRecipe?.input ?? recipeModel.window;
  return { start: offset, end: offset + span };
}

function zoomed() {
  return paletteStripView(visiblePhaseRange()).zoomed;
}

/** @param {'lightness'|'chroma'} axisName */
function axisControlElements(axisName) {
  const { minimum, maximum, curve, label, shortLabel } = PALETTE_AXIS_CONTROLS[axisName];
  return {
    label, shortLabel,
    curve: /** @type {HTMLSelectElement} */ (document.getElementById(curve)),
    minimum: /** @type {HTMLInputElement} */ (document.getElementById(minimum)),
    maximum: /** @type {HTMLInputElement} */ (document.getElementById(maximum)),
    minimumLabel: /** @type {HTMLElement} */ (document.getElementById(`${minimum}_label`)),
    maximumLabel: /** @type {HTMLElement} */ (document.getElementById(`${maximum}_label`)),
    minimumValue: /** @type {HTMLElement} */ (document.getElementById(`${minimum}_value`)),
    maximumValue: /** @type {HTMLElement} */ (document.getElementById(`${maximum}_value`)),
  };
}

/** @param {'lightness'|'chroma'} axisName */
function renderAxisControls(axisName) {
  const {
    label, shortLabel, curve, minimum, maximum, minimumLabel, maximumLabel,
    minimumValue, maximumValue,
  } = axisControlElements(axisName);
  const endpoints = recipeModel.axisEndpoints(axisName);
  const curveName = String(recipeModel.reading(PALETTE_AXIS_CONTROLS[axisName].reading));
  curve.value = String(curveName);
  minimum.min = maximum.min = '0';
  minimum.max = maximum.max = '1';
  minimum.value = String(endpoints.minimum);
  maximum.value = String(endpoints.maximum);
  const state = axisControlState({
    curve: curveName, minimum: endpoints.minimum, maximum: endpoints.maximum,
    label, shortLabel,
  });

  minimumLabel.textContent = state.minimumLabel;
  maximumLabel.textContent = state.maximumLabel;
  minimum.setAttribute('aria-label', state.minimumName);
  minimum.title = state.minimumName;
  maximum.setAttribute('aria-label', state.maximumName);
  maximum.title = state.maximumName;

  minimum.min = state.minimumMin;
  minimum.max = state.minimumMax;
  maximum.min = state.maximumMin;
  maximum.max = state.maximumMax;
  minimum.setAttribute('aria-valuetext', state.minimumText);
  maximum.setAttribute('aria-valuetext', state.maximumText);
  minimumValue.textContent = state.minimumText;
  maximumValue.textContent = state.maximumText;
}

/** @param {'lightness'|'chroma'} axisName @param {'minimum'|'maximum'} end @param {Event} event */
function handleAxisEndpointInput(axisName, end, event) {
  const value = Number((/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value);
  const { minimum, maximum } = recipeModel.axisEndpoints(axisName);
  if (end === 'minimum') recipeModel.setAxisEndpoints(axisName, value, maximum);
  else recipeModel.setAxisEndpoints(axisName, minimum, value);
  renderRecipeControls();
  scheduleUpdate();
}

/** @param {'lightness'|'chroma'} axisName @param {Event} event */
function handleAxisCurveChange(axisName, event) {
  recipeModel.setAxisCurve(axisName, (/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value);
  renderRecipeControls();
  scheduleUpdate();
}

// Recipe readings shown on a slider: its element, the factor from the
// reading's unit to the slider's, how many decimals the mirror label shows,
// and the unit it is labelled in.
/** @type {Array<{reading: import('./palette_recipe_model.js').PaletteAmountReading,id:string,scale:number,digits:number,suffix:string}>} */
const RECIPE_SLIDER_DEFINITIONS = [
  { reading: 'spreadTurns', id: PALETTE_CONTROL_IDS.spreadDegrees, scale: 360, digits: 1, suffix: '°' },
  { reading: 'sweepTurns', id: PALETTE_CONTROL_IDS.sweepTurns, scale: 1, digits: 1, suffix: '' },
  { reading: 'hueTorsion', id: PALETTE_CONTROL_IDS.hueTorsion, scale: 1, digits: 1, suffix: '' },
  { reading: 'headroom', id: PALETTE_CONTROL_IDS.headroom, scale: 1, digits: 2, suffix: '' },
  { reading: 'falloffStart', id: PALETTE_CONTROL_IDS.falloffStart, scale: 1, digits: 2, suffix: '' },
];

// Recipe readings shown on a select, in the order they are written.
/** @type {Array<import('./palette_recipe_model.js').PaletteChoiceReading|'hueMode'>} */
const RECIPE_SELECT_READINGS = [
  'domain', 'hueMode', 'harmony', 'direction', 'colorPath', 'easing',
];

function renderRecipeSliders() {
  const loopSweep = recipeModel.reading('domain') === 'LOOP'
    && recipeModel.reading('hueMode') === 'SWEEP';
  /** @type {HTMLInputElement} */ (document.getElementById(PALETTE_CONTROL_IDS.sweepTurns)).step = loopSweep ? '1' : '0.5';
  for (const { reading, id, scale, digits, suffix } of RECIPE_SLIDER_DEFINITIONS) {
    const value = Number(recipeModel.reading(reading)) * scale;
    /** @type {HTMLInputElement} */ (document.getElementById(id)).value = String(value);
    /** @type {HTMLElement} */ (document.getElementById(`${id}_value`)).textContent = `${value.toFixed(digits)}${suffix}`;
  }
}

function renderBaseHue() {
  const degrees = recipeModel.baseHueTurns * 360;
  /** @type {HTMLInputElement} */ (document.getElementById(PALETTE_CONTROL_IDS.baseHueDegrees)).value = String(degrees);
  /** @type {HTMLElement} */ (document.getElementById('gen_base_hue_value')).textContent =
    `${Number(degrees.toFixed(1))}°`;
}

function renderRecipeAvailability() {
  const availability = paletteRecipeAvailability(/** @type {import('./palette_controls.js').PaletteRecipe} */ (recipeModel.recipe()));
  /** @type {Array<[string,string,boolean]>} */
  const controls = [
    ['gen_base_hue_field', PALETTE_CONTROL_IDS.baseHueDegrees, availability.baseHue],
    ['gen_hue_mode_field', PALETTE_CONTROL_IDS.hueMode, availability.hueMode],
    ['gen_harmony_field', PALETTE_CONTROL_IDS.harmony, availability.harmony],
    ['gen_spread_field', PALETTE_CONTROL_IDS.spreadDegrees, availability.hueSpread],
    ['gen_sweep_field', PALETTE_CONTROL_IDS.sweepTurns, availability.hueSweep],
    ['gen_torsion_field', PALETTE_CONTROL_IDS.hueTorsion, availability.hueTorsion],
    ['gen_path_field', PALETTE_CONTROL_IDS.colorPath, availability.colorPath],
    ['gen_direction_field', PALETTE_CONTROL_IDS.direction, availability.hueDirection],
    ['gen_falloff_field', PALETTE_CONTROL_IDS.falloffStart, availability.falloffStart],
    ['gen_headroom_field', PALETTE_CONTROL_IDS.headroom, availability.chromaHeadroom],
    ['gen_chroma_minimum_field', PALETTE_CONTROL_IDS.chromaMinimum, availability.chromaEndpoints],
    ['gen_chroma_maximum_field', PALETTE_CONTROL_IDS.chromaMaximum, availability.chromaMaximum],
    ['gen_lightness_minimum_field', PALETTE_CONTROL_IDS.lightnessMinimum, availability.lightnessEndpoints],
    ['gen_lightness_maximum_field', PALETTE_CONTROL_IDS.lightnessMaximum, availability.lightnessMaximum],
  ];

  for (const [fieldId, controlId, enabled] of controls) {
    const field = /** @type {HTMLElement} */ (document.getElementById(fieldId));
    const control = /** @type {HTMLInputElement|HTMLSelectElement} */ (document.getElementById(controlId));
    field.classList.toggle('is-disabled', !enabled);
    field.setAttribute('role', 'group');
    field.setAttribute('aria-disabled', String(!enabled));
    control.disabled = !enabled;
  }
}

/** Writes every generative control from the recipe model. */
function renderRecipeControls() {
  for (const reading of RECIPE_SELECT_READINGS)
    /** @type {HTMLSelectElement} */ (document.getElementById(PALETTE_CONTROL_IDS[reading])).value = String(recipeModel.reading(reading));
  renderRecipeSliders();
  renderBaseHue();
  renderRecipeWindow();
  for (const axisName of /** @type {Array<'lightness'|'chroma'>} */ (Object.keys(PALETTE_AXIS_CONTROLS))) renderAxisControls(axisName);
  renderRecipeAvailability();
}

/** @param {import('./palette_controls.js').PaletteRecipe} recipe */
function loadRecipe(recipe) {
  (/** @type {NonNullable<typeof hueKeyWheel>} */ (hueKeyWheel)).clearStatus();
  recipeModel.loadRecipe(recipe);
  renderRecipeControls();
  scheduleUpdate();
}

/** @param {string} name */
function loadRecipePreset(name) {
  loadRecipe(PALETTE_RECIPE_PRESETS[name]());
}

function buildEffectRecipePresets() {
  const select = /** @type {HTMLSelectElement} */ (document.getElementById('effect_recipe_preset'));
  for (const [index, preset] of effectPalettePresets.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = preset.randomHue
      ? `${preset.name} (varying hue)`
      : preset.name;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    if (select.value === '') return;
    loadRecipe(effectPalettePresets[Number(select.value)].recipe);
    select.value = '';
  });
}

// Drag-to-zoom state
/** @type {ReturnType<typeof createPointerDrag>|null} */
let stripDrag = null;
let isSelectionActive = false; // Tracks if drag is active AND within Y-bounds
let dragStartPosition = 0.0;
let dragEndPosition = 0.0;
/** @type {ReturnType<typeof setTimeout>|null} */
let copyFeedbackTimer = null;
let copyRequestId = 0;
// DOM elements, resolved in init() once the document has loaded.
/** @type {HTMLCanvasElement} */
let waveGraphCanvas;
/** @type {HTMLCanvasElement} */
let colorStripCanvas;
/** @type {CanvasRenderingContext2D|null} */
let waveGraphCtx;
/** @type {CanvasRenderingContext2D|null} */
let colorStripCtx;
/** @type {HTMLElement} */
let resetZoomButton;
/** @type {HTMLElement} */
let paletteRangeHeading;
/** @type {HTMLElement} */
let copyFeedback;
/** @type {HTMLElement} */
let copyFeedbackSwatch;
/** @type {HTMLElement} */
let copyFeedbackStatus;
/** @type {HTMLElement} */
let copyFeedbackHex;

// Owns the strip's offscreen gradient cache; built in init().
/** @type {ReturnType<typeof createColorStripPainter>|null} */
let colorStripPainter = null;

/**
 * The normalized (0-1) X coordinate of a pointer event over the strip.
 */
/** @param {PointerEvent} event */
function getNormalizedX(event) {
  if (!colorStripCanvas) return 0;
  const rect = innerRect(colorStripCanvas);
  const x = event.clientX - rect.left;
  return rect.width > 0 ? Math.max(0, Math.min(1, x / rect.width)) : 0;
}

/**
 * Handles the start of a drag or click on the color strip.
 */
/** @param {PointerEvent} event @returns {boolean|void} */
function handleDragStart(event) {
  if (!colorStripCanvas) return false;

  isSelectionActive = true; // Selection is active on start
  dragStartPosition = getNormalizedX(event);
  dragEndPosition = dragStartPosition;
  colorStripCanvas.style.cursor = 'crosshair';

  drawColorStrip();
}

/**
 * Handles pointer movement during a drag.
 * Cancels selection if the pointer moves above or below the canvas.
 */
/** @param {PointerEvent} event */
function handleDragMove(event) {
  dragEndPosition = getNormalizedX(event);

  if (colorStripCanvas) {
    const rect = innerRect(colorStripCanvas);
    const y = event.clientY;
    isSelectionActive = y >= rect.top && y <= rect.top + rect.height;
  }

  drawColorStrip(isSelectionActive
    ? { start: dragStartPosition, end: dragEndPosition }
    : null);
}

/**
 * Handles the end of a drag (zoom) or a simple click (copy color).
 */
/** @param {PointerEvent} event */
function handleDragEnd(event) {
  if (!colorStripCanvas) return;

  handleDragMove(event);

  const wasSelectionActive = isSelectionActive;

  isSelectionActive = false;
  colorStripCanvas.style.cursor = 'pointer';

  if (!wasSelectionActive) {
    drawColorStrip();
    return;
  }

  const { intent, start, end } = stripDragIntent(
    dragStartPosition, dragEndPosition);

  if (intent === 'copy') {
    drawColorStrip();
    copyPaletteColor(start, event.clientX, event.clientY)
      .catch(reportCopyFailure);
  } else if (activeTab === 'procedural') {
    paletteViewport.zoom(start, end);
    redrawForViewport();
  } else {
    zoomRecipeWindowControls(start, end);
  }
}

function handleDragCancel() {
  if (!colorStripCanvas) return;
  isSelectionActive = false;
  colorStripCanvas.style.cursor = 'pointer';
  drawColorStrip();
}

function updateStripView() {
  if (!colorStripCanvas) return;
  const view = paletteStripView(visiblePhaseRange());
  colorStripCanvas.setAttribute('aria-label', view.ariaLabel);
  if (paletteRangeHeading) paletteRangeHeading.textContent = view.heading;
}

/** @param {number|undefined} clientX @param {number|undefined} clientY */
function feedbackPosition(clientX, clientY) {
  if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
    return { x: clientX, y: clientY };
  }
  const rect = colorStripCanvas.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** @param {number} position @param {number} [clientX] @param {number} [clientY] */
async function copyPaletteColor(position, clientX = undefined, clientY = undefined) {
  if (!palette || !copyFeedback || !copyFeedbackSwatch
      || !copyFeedbackStatus || !copyFeedbackHex) return;

  const phase = activeTab === 'procedural'
    ? paletteViewport.map(position)
    : position;
  const [red, green, blue] = palette.get(phase);
  const hex = linearRgbToHex(red, green, blue);
  const { x, y } = feedbackPosition(clientX, clientY);
  copyFeedbackSwatch.style.backgroundColor = hex;
  copyFeedbackHex.textContent = hex;
  copyFeedbackStatus.textContent = 'Copying';
  copyFeedback.style.left = `${x}px`;
  copyFeedback.style.top = `${y}px`;
  if (copyFeedbackTimer !== null) {
    clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = null;
  }
  copyFeedback.classList.add('is-visible');

  const requestId = ++copyRequestId;
  const copied = await copyToClipboard(hex);
  if (requestId !== copyRequestId) return;
  copyFeedbackStatus.textContent = copied ? 'Copied' : 'Copy failed';
  dismissCopyFeedbackLater();
}

/** Fades the copy feedback out after the message has had time to read. */
function dismissCopyFeedbackLater() {
  if (copyFeedbackTimer !== null) clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = setTimeout(() => {
    copyFeedback.classList.remove('is-visible');
    copyFeedbackTimer = null;
  }, 1300);
}

/**
 * Resolves a copy that threw. The bubble reads 'Copying' from the moment the
 * attempt starts, so an unreported rejection would strand it there.
 * @param {any} error - The rejection.
 * @returns {void}
 */
function reportCopyFailure(error) {
  console.error(error);
  if (!copyFeedback || !copyFeedbackStatus) return;
  copyFeedbackStatus.textContent = 'Copy failed';
  dismissCopyFeedbackLater();
}

function zoomAroundCenter() {
  if (activeTab === 'procedural') {
    paletteViewport.zoom(0.4, 0.6);
    redrawForViewport();
  } else {
    zoomRecipeWindowControls(0.4, 0.6);
  }
}

/** @param {KeyboardEvent} event */
function handleStripKeyDown(event) {
  if ((event.key === 'Enter' || event.key === ' ') && !event.shiftKey) {
    copyPaletteColor(0.5).catch(reportCopyFailure);
  } else if (event.key === 'ArrowLeft' && event.shiftKey) {
    handleResetZoom();
  } else if (event.key === 'ArrowRight' && event.shiftKey) {
    zoomAroundCenter();
  } else {
    return;
  }
  event.preventDefault();
}

function handleResetZoom() {
  if (!zoomed()) return;
  if (activeTab === 'procedural') {
    paletteViewport.reset();
    redrawForViewport();
  } else {
    recipeModel.setWindow(0, 1);
    renderRecipeWindow();
    scheduleUpdate();
  }
}

function syncResetZoomButton() {
  if (resetZoomButton) {
    resetZoomButton.classList.toggle('hidden', !zoomed());
  }
}

/** @param {{start:number,end:number}|null} selectionRange */
function drawColorStrip(selectionRange = null) {
  if (!palette) return;
  const viewport = activeTab === 'procedural' ? paletteViewport.value : FULL_VIEWPORT;
  colorStripPainter?.draw(palette, selectionRange, viewport);
}

/**
 * Plots the wave graph over the strip's phase window by re-parameterizing the
 * coefficients through the procedural viewport. The generative palette carries
 * its window in its own recipe, so it plots as baked.
 */
function drawPaletteWaveGraph() {
  let plotted = palette;
  if (activeTab === 'procedural') {
    const view = proceduralParamsForViewport((/** @type {NonNullable<typeof proceduralSliders>} */ (proceduralSliders)).values(), paletteViewport.value);
    plotted = new ProceduralPalette(
      [view.A_R, view.A_G, view.A_B],
      [view.B_R, view.B_G, view.B_B],
      [view.C_R, view.C_G, view.C_B],
      [view.D_R, view.D_G, view.D_B]);
  }
  if (!plotted) return;
  drawWaveGraph({ canvas: waveGraphCanvas,
    ctx: /** @type {CanvasRenderingContext2D} */ (waveGraphCtx), palette: plotted });
  waveGraphCanvas.setAttribute('aria-label', waveGraphLabel(visiblePhaseRange()));
}

/** Redraws every view of the palette after its viewport moved. */
function redrawForViewport() {
  if (engineHalted) return;
  drawColorStrip();
  drawPaletteWaveGraph();
  if (activeTab === 'generative' && (/** @type {GenerativePalette|null} */ (palette))?.canonicalRecipe)
    (/** @type {NonNullable<typeof hueKeyWheel>} */ (hueKeyWheel)).draw(/** @type {import('./palette_controls.js').PaletteRecipe} */ ((/** @type {GenerativePalette} */ (palette)).canonicalRecipe));
  updateStripView();
  updatePaletteCodeOutput();
  syncResetZoomButton();
}


/**
 * Updates the code output block with the current parameters.
 */
function updatePaletteCodeOutput() {
  const codeOutput = /** @type {HTMLElement} */ (document.getElementById('palette_code_output'));
  if (!codeOutput) return;

  if (activeTab === 'procedural') {
    codeOutput.textContent = proceduralPaletteCpp(
      proceduralParamsForViewport((/** @type {NonNullable<typeof proceduralSliders>} */ (proceduralSliders)).values(), paletteViewport.value));
  } else {
    codeOutput.textContent = generativePaletteCpp(
      (/** @type {GenerativePalette|null} */ (palette))?.canonicalRecipe ?? /** @type {import('./palette_controls.js').PaletteRecipe} */ (recipeModel.recipe()));
  }
}

/**
 * Loads a named palette's coefficients into the procedural controls and
 * redraws in the full palette viewport.
 * @param {{name:string, a:number[], b:number[], c:number[], d:number[]}} entry - The palette to load.
 */
function loadNamedPalette(entry) {
  (/** @type {NonNullable<typeof proceduralSliders>} */ (proceduralSliders)).setAll(proceduralPaletteParams(entry));
  paletteViewport.reset();
  syncResetZoomButton();
  updateStripView();
  updatePalette();
}

/**
 * Populates the named-palette gallery with a clickable gradient swatch per
 * entry in NAMED_PROCEDURAL_PALETTES.
 */
function buildPaletteGallery() {
  const gallery = /** @type {HTMLElement} */ (document.getElementById('palette_gallery'));
  if (!gallery) return;
  NAMED_PROCEDURAL_PALETTES.forEach(entry => {
    const label = prettyPaletteName(entry.name);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'palette-swatch';
    button.title = `Load ${label}`;
    button.setAttribute('aria-label', `Load ${label} palette`);

    const strip = document.createElement('span');
    strip.className = 'palette-swatch-strip';
    strip.style.background = paletteGradientCss(entry);

    const name = document.createElement('span');
    name.className = 'palette-swatch-label';
    name.textContent = label;

    button.append(strip, name);
    button.addEventListener('click', () => loadNamedPalette(entry));
    gallery.appendChild(button);
  });
}

/**
 * Main update function: reads parameters, initializes palette, and redraws visualizations.
 */
function updatePalette() {
  if (engineHalted) return;
  if (activeTab === 'procedural') {
    const parameters = (/** @type {NonNullable<typeof proceduralSliders>} */ (proceduralSliders)).values();
    const A = [parameters.A_R, parameters.A_G, parameters.A_B];
    const B = [parameters.B_R, parameters.B_G, parameters.B_B];
    const C = [parameters.C_R, parameters.C_G, parameters.C_B];
    const D = [parameters.D_R, parameters.D_G, parameters.D_B];
    palette = new ProceduralPalette(A, B, C, D);
  } else {
    try {
      palette = new GenerativePalette(/** @type {import('./palette_controls.js').PaletteRecipe} */ (recipeModel.recipe()));
      const adjusted = paletteAdjustmentSummary(palette.status);
      const status = /** @type {HTMLElement} */ (document.getElementById('gen_status'));
      status.dataset.status = 'valid';
      const message = adjusted ? `Recipe valid — ${adjusted}` : 'Recipe valid';
      if (status.textContent !== message) status.textContent = message;
    } catch (error) {
      if (engineTrapped(error)) return;
      const status = /** @type {HTMLElement} */ (document.getElementById('gen_status'));
      status.dataset.status = 'error';
      status.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
  }

  colorStripPainter?.invalidate();

  drawPaletteWaveGraph();
  if (activeTab === 'generative')
    (/** @type {NonNullable<typeof hueKeyWheel>} */ (hueKeyWheel)).draw(/** @type {import('./palette_controls.js').PaletteRecipe} */ ((/** @type {GenerativePalette} */ (palette)).canonicalRecipe));
  drawColorStrip();
  updateStripView();
  syncResetZoomButton();

  updatePaletteCodeOutput();
}

// Coalesce updatePalette() into one recompute per animation frame.
const scheduleUpdate = createFrameScheduler(updatePalette);
const scheduleViewportRedraw = createFrameScheduler(redrawForViewport);

let engineHalted = false;

/** @param {unknown} error */
function engineTrapped(error) {
  if (engineHalted) return true;
  return standDownIfHalted(error, wasmModule, (message) => {
    engineHalted = true;
    scheduleUpdate.cancel();
    scheduleViewportRedraw.cancel();
    for (const control of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input, select, button, textarea')))
      control.disabled = true;
    setPaletteOps(null);
    paletteOps = null;
    wasmModule = null;
    showFatalError(message);
  });
}

/**
 * Initialize the sliders and the first visualization.
 */
async function init() {
  // Load the engine module first: GenerativePalette bakes its LUT through
  // PaletteOps.
  try {
    const { default: createHolosphereModule } = await import('../../../generated/holosphere_wasm.js');
    const wasm = await createHolosphereModule();
    wasmModule = wasm;
    paletteOps = /** @type {NonNullable<typeof paletteOps>} */ (new wasm.PaletteOps());
    setPaletteOps(paletteOps, wasm);
    effectPalettePresets = /** @type {typeof effectPalettePresets} */ (Array.from(paletteOps.effectPresetsV4()));
  } catch (e) {
    if (wasmModule && engineTrapped(e)) return;
    setPaletteOps(null);
    paletteOps?.delete();
    paletteOps = null;
    wasmModule = null;
    console.error('Failed to load WASM:', e);
    showFatalError('Failed to load the Holosphere WASM engine — the palette '
      + 'tool needs the built holosphere_wasm artifacts. Build the WASM '
      + 'target and reload.');
    return;
  }

  colorStripCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('colorStripCanvas'));
  colorStripCtx = colorStripCanvas ? colorStripCanvas.getContext('2d') : null;
  waveGraphCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('waveGraphCanvas'));
  waveGraphCtx = waveGraphCanvas ? waveGraphCanvas.getContext('2d') : null;
  hueKeyWheelCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('hueKeyWheelCanvas'));
  hueKeyWheelCtx = hueKeyWheelCanvas ? hueKeyWheelCanvas.getContext('2d') : null;
  resetZoomButton = /** @type {HTMLButtonElement} */ (document.getElementById('resetZoomButton'));
  paletteRangeHeading = /** @type {HTMLElement} */ (document.getElementById('palette_range_heading'));
  copyFeedback = /** @type {HTMLElement} */ (document.getElementById('palette_copy_feedback'));
  copyFeedbackSwatch = /** @type {HTMLElement} */ (document.getElementById('palette_copy_swatch'));
  copyFeedbackStatus = /** @type {HTMLElement} */ (document.getElementById('palette_copy_status'));
  copyFeedbackHex = /** @type {HTMLElement} */ (document.getElementById('palette_copy_hex'));

  if (!colorStripCanvas || !waveGraphCanvas || !hueKeyWheelCanvas ||
      !colorStripCtx || !waveGraphCtx || !hueKeyWheelCtx) {
    showFatalError('The palette tool could not acquire its canvases — a '
      + 'canvas element is missing or the browser refused a 2D context. '
      + 'The controls below are inert.');
    return;
  }

  colorStripPainter = createColorStripPainter({
    canvas: colorStripCanvas,
    ctx: colorStripCtx,
  });
  hueKeyWheel = createHueKeyWheel({
    model: recipeModel,
    scheduleUpdate,
    onRecipeChange: renderRecipeControls,
    canvas: hueKeyWheelCanvas,
    group: /** @type {HTMLElement} */ (document.getElementById('hueKeyWheelGroup')),
    status: /** @type {HTMLElement} */ (document.getElementById('hue_key_status')),
    painter: createHueKeyWheelPainter({ canvas: hueKeyWheelCanvas, ctx: hueKeyWheelCtx }),
  });

  // Tab buttons; activation follows focus.
  const tabButtons = Array.from(/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tab-btn[data-tab]')));
  tabButtons.forEach((btn, index) => {
    btn.addEventListener('click', () => switchTab(/** @type {string} */ (btn.dataset.tab)));
    btn.addEventListener('keydown', (event) => {
      const target = tablistKeyTarget(event.key, index, tabButtons.length);
      if (target === null) return;
      event.preventDefault();
      switchTab(/** @type {string} */ (tabButtons[target].dataset.tab));
      tabButtons[target].focus();
    });
  });

  proceduralSliders = mountProceduralSliders({ defaults: DEFAULT_PARAMS, scheduleUpdate });

  buildPaletteGallery();
  buildEffectRecipePresets();

  // Generative palette controls.
  const baseHueSlider = /** @type {HTMLInputElement} */ (document.getElementById(PALETTE_CONTROL_IDS.baseHueDegrees));
  baseHueSlider.addEventListener('keydown', (/** @type {NonNullable<typeof hueKeyWheel>} */ (hueKeyWheel)).onBaseHueKeyDown);
  baseHueSlider.addEventListener('input', handleBaseHueInput);

  for (const reading of RECIPE_SELECT_READINGS) {
    /** @type {HTMLSelectElement} */ (document.getElementById(PALETTE_CONTROL_IDS[reading])).addEventListener('change', (event) => {
      (/** @type {NonNullable<typeof hueKeyWheel>} */ (hueKeyWheel)).clearStatus();
      if (reading === 'hueMode') (/** @type {NonNullable<typeof hueKeyWheel>} */ (hueKeyWheel)).onHueModeChange((/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value);
      else recipeModel.setChoice(reading, (/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value);
      renderRecipeControls();
      scheduleUpdate();
    });
  }

  for (const axisName of /** @type {Array<'lightness'|'chroma'>} */ (Object.keys(PALETTE_AXIS_CONTROLS))) {
    const { curve, minimum, maximum } = axisControlElements(axisName);
    curve.addEventListener('change', (event) => handleAxisCurveChange(axisName, event));
    minimum.addEventListener('input', (event) => handleAxisEndpointInput(axisName, 'minimum', event));
    maximum.addEventListener('input', (event) => handleAxisEndpointInput(axisName, 'maximum', event));
  }

  /** @type {HTMLInputElement} */ (document.getElementById(PALETTE_CONTROL_IDS.offset)).addEventListener('input', (event) => {
    recipeModel.setWindow(Number((/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value), recipeModel.window.span);
    renderRecipeWindow();
    scheduleUpdate();
  });
  /** @type {HTMLInputElement} */ (document.getElementById(PALETTE_CONTROL_IDS.span)).addEventListener('input', (event) => {
    recipeModel.setWindow(recipeModel.window.offset, Number((/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value));
    renderRecipeWindow();
    scheduleUpdate();
  });

  for (const { reading, id, scale } of RECIPE_SLIDER_DEFINITIONS) {
    /** @type {HTMLInputElement} */ (document.getElementById(id)).addEventListener('input', (event) => {
      (/** @type {NonNullable<typeof hueKeyWheel>} */ (hueKeyWheel)).clearStatus();
      recipeModel.setAmount(reading, Number((/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value) / scale);
      renderRecipeControls();
      scheduleUpdate();
    });
  }

  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-recipe-preset]')).forEach((button) => {
    button.addEventListener('click', () => loadRecipePreset(/** @type {string} */ (button.dataset.recipePreset)));
  });

  renderRecipeControls();

  window.addEventListener('resize', scheduleViewportRedraw);


  stripDrag = createPointerDrag({
    element: colorStripCanvas,
    onStart: handleDragStart,
    onMove: handleDragMove,
    onEnd: /** @type {(event: PointerEvent|null) => void} */ (handleDragEnd),
    onCancel: handleDragCancel,
  });
  colorStripCanvas.addEventListener('keydown', handleStripKeyDown);
  updateStripView();

  if (resetZoomButton) {
    resetZoomButton.addEventListener('click', handleResetZoom);
  }

  onPageTeardown(wireCopyBlock({
    source: /** @type {HTMLElement} */ (document.getElementById('palette_code_output')),
    button: /** @type {HTMLButtonElement} */ (document.getElementById('copy_code_button')),
    prompt: /** @type {HTMLElement} */ (document.getElementById('copy_code_prompt')),
  }));
  const teardownExportFlyout = wireFlyout({
    root: /** @type {HTMLElement} */ (document.getElementById('export_flyout')),
    trigger: /** @type {HTMLButtonElement} */ (document.getElementById('export_toggle')),
  });

  switchTab(paletteTabFromSearch(window.location.search), false);

  onPageTeardown(() => {
    scheduleUpdate.cancel();
    scheduleViewportRedraw.cancel();
    copyRequestId += 1;
    if (copyFeedbackTimer !== null) clearTimeout(copyFeedbackTimer);
    (/** @type {NonNullable<typeof proceduralSliders>} */ (proceduralSliders)).dispose();
    teardownExportFlyout();
    baseHueSlider.removeEventListener('keydown', (/** @type {NonNullable<typeof hueKeyWheel>} */ (hueKeyWheel)).onBaseHueKeyDown);
    window.removeEventListener('resize', scheduleViewportRedraw);
    (/** @type {NonNullable<typeof stripDrag>} */ (stripDrag)).remove();
    colorStripCanvas.removeEventListener('keydown', handleStripKeyDown);
    (/** @type {NonNullable<typeof hueKeyWheel>} */ (hueKeyWheel)).dispose();
    setPaletteOps(null);
    if (wasmModule?.HS_MODULE_DEAD !== true)
      paletteOps?.delete();
    paletteOps = null;
    wasmModule = null;
  });
}

bootstrapTool(init, 'palette tool');

/** @param {Event} event */
function handleBaseHueInput(event) {
  recipeModel.setBaseHue(Number((/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value) / 360);
  renderBaseHue();
  scheduleUpdate();
}
