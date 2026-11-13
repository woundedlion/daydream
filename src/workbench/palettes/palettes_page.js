/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/palettes.html.
 */
import { byId } from '../../shared/dom.js';
import { wireCopyBlock } from '../../shared/clipboard.js';
import { replaceUrl } from '../../shared/url.js';
import { showFatalError, bootstrapTool } from '../../shared/banner.js';
import {
  ProceduralPalette, GenerativePalette,
  proceduralPaletteCpp, proceduralParamsForViewport,
  generativePaletteCpp, setPaletteOps,
  proceduralPaletteParams,
  paletteGradientCss, prettyPaletteName, paletteAdjustmentSummary,
} from './palette_math.js';
import {
  createPaletteViewport,
  axisControlState, PALETTE_AXIS_CONTROLS,
  paletteTabFromSearch, paletteTabUrl, tablistKeyTarget,
  PALETTE_CONTROL_IDS,
  PALETTE_RECIPE_PRESETS, paletteRecipeAvailability,
  waveGraphLabel,
} from './palette_controls.js';
import { PaletteRecipeModel } from './palette_recipe_model.js';
import { mountProceduralSliders } from './procedural_sliders.js';
import { createColorStripPainter, drawWaveGraph } from './palette_canvas.js';
import { createHueKeyWheelPainter } from './palette_wheel.js';
import { createHueKeyWheel } from './hue_key_wheel_controller.js';
import { standDownIfHalted } from '../../shared/engine_halt.js';
import { wireFlyout } from '../../shared/flyout.js';
import { createFrameScheduler, onPageTeardown } from '../../shared/page_lifecycle.js';
import { createStripController } from './strip_controller.js';

let activeTab = 'procedural';

/** @param {string} tabName */
function switchTab(tabName, updateUrl = true) {
  activeTab = tabName;
  byId('export_code_kind', HTMLElement).textContent = tabName === 'procedural'
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
  const palettesPanel = byId('named_palettes_panel', HTMLElement);
  palettesPanel.style.display = (tabName === 'procedural') ? '' : 'none';

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
/** @type {Array<{name:string, a:number[], b:number[], c:number[], d:number[]}>} */
let namedPalettes = [];
const paletteViewport = createPaletteViewport();

/** @type {HTMLCanvasElement} */
let hueKeyWheelCanvas;
/** @type {CanvasRenderingContext2D|null} */
let hueKeyWheelCtx;
/** @type {ReturnType<typeof createHueKeyWheel>|null} */
let hueKeyWheel = null;

const FULL_VIEWPORT = Object.freeze({ start: 0, end: 1 });

function renderRecipeWindow() {
  const offsetSlider = byId(PALETTE_CONTROL_IDS.offset, HTMLInputElement);
  const spanSlider = byId(PALETTE_CONTROL_IDS.span, HTMLInputElement);
  const { offset, span } = recipeModel.window;
  spanSlider.value = String(span);
  offsetSlider.max = String(1 - span);
  offsetSlider.value = String(offset);
  const offsetText = offset.toFixed(3);
  const spanText = span.toFixed(3);
  offsetSlider.setAttribute('aria-valuetext', offsetText);
  spanSlider.setAttribute('aria-valuetext', spanText);
  byId('gen_offset_value', HTMLElement).textContent = offsetText;
  byId('gen_span_value', HTMLElement).textContent = spanText;
}

function visiblePhaseRange() {
  if (activeTab === 'procedural') return paletteViewport.value;
  const { offset, span } = (/** @type {GenerativePalette|null} */ (palette))?.canonicalRecipe?.input ?? recipeModel.window;
  return { start: offset, end: offset + span };
}

/** @param {'lightness'|'chroma'} axisName */
function axisControlElements(axisName) {
  const { minimum, maximum, curve, label, shortLabel } = PALETTE_AXIS_CONTROLS[axisName];
  return {
    label, shortLabel,
    curve: byId(curve, HTMLSelectElement),
    minimum: byId(minimum, HTMLInputElement),
    maximum: byId(maximum, HTMLInputElement),
    minimumLabel: byId(`${minimum}_label`, HTMLElement),
    maximumLabel: byId(`${maximum}_label`, HTMLElement),
    minimumValue: byId(`${minimum}_value`, HTMLElement),
    maximumValue: byId(`${maximum}_value`, HTMLElement),
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
  byId(PALETTE_CONTROL_IDS.sweepTurns, HTMLInputElement).step = loopSweep ? '1' : '0.5';
  for (const { reading, id, scale, digits, suffix } of RECIPE_SLIDER_DEFINITIONS) {
    const value = Number(recipeModel.reading(reading)) * scale;
    const input = byId(id, HTMLInputElement);
    const text = `${value.toFixed(digits)}${suffix}`;
    input.value = String(value);
    input.setAttribute('aria-valuetext', text);
    byId(`${id}_value`, HTMLElement).textContent = text;
  }
}

function renderBaseHue() {
  const degrees = recipeModel.baseHueTurns * 360;
  const input = byId(PALETTE_CONTROL_IDS.baseHueDegrees, HTMLInputElement);
  const text = `${Number(degrees.toFixed(1)) % 360}°`;
  input.value = String(degrees);
  input.setAttribute('aria-valuetext', text);
  byId('gen_base_hue_value', HTMLElement).textContent = text;
}

function renderRecipeAvailability() {
  const availability = paletteRecipeAvailability(recipeModel.recipe());
  hueKeyWheel?.setEnabled(availability.hueKeys);
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
    const field = byId(fieldId, HTMLElement);
    const control = byId(controlId, HTMLElement).tagName === 'SELECT'
      ? byId(controlId, HTMLSelectElement) : byId(controlId, HTMLInputElement);
    field.classList.toggle('is-disabled', !enabled);
    field.setAttribute('role', 'group');
    field.setAttribute('aria-disabled', String(!enabled));
    control.disabled = !enabled;
  }
}

/** Writes every generative control from the recipe model. */
function renderRecipeControls() {
  for (const reading of RECIPE_SELECT_READINGS)
    byId(PALETTE_CONTROL_IDS[reading], HTMLSelectElement).value = String(recipeModel.reading(reading));
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
  const select = byId('effect_recipe_preset', HTMLSelectElement);
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
  });
  select.addEventListener('blur', () => { select.value = ''; });
  select.addEventListener('pointerdown', () => { select.value = ''; });
}

/** @type {ReturnType<typeof createStripController>|null} */
let stripController = null;
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
    plotted = ProceduralPalette.fromParams(view);
  }
  if (!plotted) return;
  drawWaveGraph({ canvas: waveGraphCanvas,
    ctx: /** @type {CanvasRenderingContext2D} */ (waveGraphCtx), palette: plotted,
    ...(activeTab === 'generative' ? {range: {min: -0.05, max: 1.05}} : {}) });
  waveGraphCanvas.setAttribute('aria-label', waveGraphLabel(visiblePhaseRange()));
}

/** Redraws every view of the palette after its viewport moved. */
function redrawForViewport() {
  if (engineHalted) return;
  drawColorStrip();
  drawPaletteWaveGraph();
  if (activeTab === 'generative' && (/** @type {GenerativePalette|null} */ (palette))?.canonicalRecipe)
    (/** @type {NonNullable<typeof hueKeyWheel>} */ (hueKeyWheel)).draw(/** @type {import('./palette_controls.js').PaletteRecipe} */ ((/** @type {GenerativePalette} */ (palette)).canonicalRecipe));
  stripController?.updateView();
  updatePaletteCodeOutput();
  stripController?.syncResetZoom();
}

/**
 * Updates the code output block with the current parameters.
 */
function updatePaletteCodeOutput() {
  const codeOutput = byId('palette_code_output', HTMLElement);

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
  stripController?.syncResetZoom();
  stripController?.updateView();
  updatePalette();
}

/**
 * Populates the named-palette gallery with a clickable gradient swatch per
 * named procedural palette the engine exports.
 */
function buildPaletteGallery() {
  const gallery = byId('palette_gallery', HTMLElement);
  namedPalettes.forEach(entry => {
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
    palette = ProceduralPalette.fromParams(parameters);
  } else {
    try {
      palette = new GenerativePalette(/** @type {import('./palette_controls.js').PaletteRecipe} */ (recipeModel.recipe()));
      const adjusted = paletteAdjustmentSummary(palette.status);
      const status = byId('gen_status', HTMLElement);
      status.dataset.status = 'valid';
      const message = adjusted ? `Recipe valid — ${adjusted}` : 'Recipe valid';
      if (status.textContent !== message) status.textContent = message;
    } catch (error) {
      if (engineTrapped(error)) return;
      const status = byId('gen_status', HTMLElement);
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
  stripController?.updateView();
  stripController?.syncResetZoom();

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
    hueKeyWheel?.dispose();
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

/** Loads the engine-backed palette operations. */
async function initializePaletteEngine() {
  // Load the engine module first: GenerativePalette bakes its LUT through
  // PaletteOps.
  try {
    const { default: createHolosphereModule } = await import('../../../generated/holosphere_wasm.js');
    const wasm = await createHolosphereModule();
    wasmModule = wasm;
    paletteOps = /** @type {NonNullable<typeof paletteOps>} */ (new wasm.PaletteOps());
    setPaletteOps(paletteOps, wasm);
    effectPalettePresets = /** @type {typeof effectPalettePresets} */ (Array.from(paletteOps.effectPresetsV4()));
    namedPalettes = Array.from(wasm.named_procedural_palettes());
  } catch (e) {
    if (wasmModule && engineTrapped(e)) return false;
    setPaletteOps(null);
    paletteOps?.delete();
    paletteOps = null;
    wasmModule = null;
    console.error('Failed to load WASM:', e);
    showFatalError('Failed to load the Holosphere WASM engine — the palette '
      + 'tool needs the built holosphere_wasm artifacts. Build the WASM '
      + 'target and reload.');
    return false;
  }

  return true;
}

function initializePaletteCanvases() {
  colorStripCanvas = byId('colorStripCanvas', HTMLCanvasElement);
  colorStripCtx = colorStripCanvas.getContext('2d');
  waveGraphCanvas = byId('waveGraphCanvas', HTMLCanvasElement);
  waveGraphCtx = waveGraphCanvas.getContext('2d');
  hueKeyWheelCanvas = byId('hueKeyWheelCanvas', HTMLCanvasElement);
  hueKeyWheelCtx = hueKeyWheelCanvas.getContext('2d');
  resetZoomButton = byId('resetZoomButton', HTMLButtonElement);
  paletteRangeHeading = byId('palette_range_heading', HTMLElement);
  copyFeedback = byId('palette_copy_feedback', HTMLElement);
  copyFeedbackSwatch = byId('palette_copy_swatch', HTMLElement);
  copyFeedbackStatus = byId('palette_copy_status', HTMLElement);
  copyFeedbackHex = byId('palette_copy_hex', HTMLElement);

  if (!colorStripCtx || !waveGraphCtx || !hueKeyWheelCtx) {
    showFatalError('The palette tool could not acquire its canvases — a '
      + 'canvas element is missing or the browser refused a 2D context. '
      + 'The controls below are inert.');
    return false;
  }

  return {colorStripCtx, hueKeyWheelCtx};
}

function mountPaletteTabs() {
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

}

/** @param {NonNullable<typeof hueKeyWheel>} wheel */
function mountRecipeInputs(wheel) {
  const baseHueSlider = byId(PALETTE_CONTROL_IDS.baseHueDegrees, HTMLInputElement);
  baseHueSlider.addEventListener('keydown', wheel.onBaseHueKeyDown);
  baseHueSlider.addEventListener('input', handleBaseHueInput);

  for (const reading of RECIPE_SELECT_READINGS) {
    byId(PALETTE_CONTROL_IDS[reading], HTMLSelectElement).addEventListener('change', (event) => {
      wheel.clearStatus();
      if (reading === 'hueMode') wheel.onHueModeChange((/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value);
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

  byId(PALETTE_CONTROL_IDS.offset, HTMLInputElement).addEventListener('input', (event) => {
    recipeModel.setWindow(Number((/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value), recipeModel.window.span);
    renderRecipeWindow();
    scheduleUpdate();
  });
  byId(PALETTE_CONTROL_IDS.span, HTMLInputElement).addEventListener('input', (event) => {
    recipeModel.setWindow(recipeModel.window.offset, Number((/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value));
    renderRecipeWindow();
    scheduleUpdate();
  });

  for (const { reading, id, scale } of RECIPE_SLIDER_DEFINITIONS) {
    byId(id, HTMLInputElement).addEventListener('input', (event) => {
      wheel.clearStatus();
      recipeModel.setAmount(reading, Number((/** @type {HTMLInputElement|HTMLSelectElement} */ (event.target)).value) / scale);
      renderRecipeControls();
      scheduleUpdate();
    });
  }

  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-recipe-preset]')).forEach((button) => {
    button.addEventListener('click', () => loadRecipePreset(/** @type {string} */ (button.dataset.recipePreset)));
  });

  return baseHueSlider;
}

async function init() {
  if (!await initializePaletteEngine()) return;

  const contexts = initializePaletteCanvases();
  if (!contexts) return;

  colorStripPainter = createColorStripPainter({
    canvas: colorStripCanvas,
    ctx: contexts.colorStripCtx,
  });
  const wheel = createHueKeyWheel({
    model: recipeModel,
    scheduleUpdate,
    onRecipeChange: renderRecipeControls,
    canvas: hueKeyWheelCanvas,
    group: byId('hueKeyWheelGroup', HTMLElement),
    status: byId('hue_key_status', HTMLElement),
    painter: createHueKeyWheelPainter({ canvas: hueKeyWheelCanvas, ctx: contexts.hueKeyWheelCtx }),
  });

  hueKeyWheel = wheel;

  mountPaletteTabs();

  const sliders = mountProceduralSliders({ defaults: DEFAULT_PARAMS, scheduleUpdate });
  proceduralSliders = sliders;

  buildPaletteGallery();
  buildEffectRecipePresets();

  const baseHueSlider = mountRecipeInputs(wheel);

  renderRecipeControls();

  window.addEventListener('resize', scheduleViewportRedraw);

  stripController = createStripController({canvas: colorStripCanvas, viewport: paletteViewport,
    model: recipeModel, getTab: () => activeTab, getPalette: () => palette, visiblePhaseRange,
    drawColorStrip, redrawForViewport, renderRecipeWindow, scheduleUpdate,
    resetZoomButton, paletteRangeHeading,
    feedback: {root: copyFeedback, swatch: copyFeedbackSwatch, status: copyFeedbackStatus, hex: copyFeedbackHex}});

  onPageTeardown(wireCopyBlock({
    source: byId('palette_code_output', HTMLElement),
    button: byId('copy_code_button', HTMLButtonElement),
    prompt: byId('copy_code_prompt', HTMLElement),
  }));
  const teardownExportFlyout = wireFlyout({
    root: byId('export_flyout', HTMLElement),
    trigger: byId('export_toggle', HTMLButtonElement),
  });

  switchTab(paletteTabFromSearch(window.location.search), false);

  onPageTeardown(() => {
    scheduleUpdate.cancel();
    scheduleViewportRedraw.cancel();
    sliders.dispose();
    teardownExportFlyout();
    baseHueSlider.removeEventListener('keydown', wheel.onBaseHueKeyDown);
    window.removeEventListener('resize', scheduleViewportRedraw);
    stripController?.dispose();
    wheel.dispose();
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
