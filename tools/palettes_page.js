/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/palettes.html.
 */
// Shared primitives, imported rather than re-implemented inline: the
// clipboard copy (tools/clipboard.js) and the sRGB/linear-RGB transfer
// functions (tools/color.js, which mirrors core/color/color.h's).
import { copyToClipboard, wireCopyBlock } from './clipboard.js';
// Labelled range slider + readout, shared with the other tool pages.
import { createSlider } from './slider.js';
// Fatal-error banner and load bootstrap from the THREE-free banner module
// (not shared.js, which pulls in three.js — a dependency this tool
// otherwise doesn't have).
import { showFatalError, bootstrapTool } from './banner.js';
import { linearRgbToHex } from './color.js';
// Pure palette math (ProceduralPalette/GenerativePalette + helpers and the
// C++ export-string generators) lives in palette_math.js so it can be unit
// tested without a DOM. DOM-coupled wiring stays inline below.
import {
  ProceduralPalette, GenerativePalette,
  proceduralPaletteCpp, proceduralParamsForViewport,
  generativePaletteCpp, setPaletteOps,
  NAMED_PROCEDURAL_PALETTES, proceduralPaletteParams,
  paletteGradientCss, prettyPaletteName,
} from './palette_math.js';
// DOM-free interaction and recipe state live in palette_controls.js; the
// DOM reads and writes around them stay inline.
import {
  createPaletteViewport, axisFromEndpoints,
  axisControlState, PALETTE_AXIS_CONTROLS,
  lockedGroupMove,
  paletteTabFromSearch, paletteTabUrl, tablistKeyTarget,
  defaultPaletteRecipe, paletteRecipeFromControls, PaletteV4,
  PALETTE_CONTROL_IDS, paletteControlReadings, paletteControlsFromRecipe,
  PALETTE_RECIPE_PRESETS, paletteRecipeAvailability,
  clampRecipeWindow, zoomRecipeWindow, paletteStripView, waveGraphLabel,
  stripDragIntent,
  wrapTurns,
  hitTestHueKeyMarker,
  hueKeyState, customHueKeyState, moveCustomHueKey,
} from './palette_controls.js';
// The two canvas painters take their canvas, context and palette as
// arguments, so they live in their own module and are unit tested against a
// context double; the pointer and keyboard wiring around them stays inline.
import { createColorStripPainter, drawWaveGraph } from './palette_canvas.js';
// The hue-key wheel's raster, marker geometry and pointer arithmetic, on the
// same terms.
import {
  createHueKeyWheelPainter, canvasPoint, wheelTurnAt,
  hueKeyNudgeTurns, hueKeyHandoff, HUE_KEY_NAMES, HUE_KEY_GRAB_RADIUS,
} from './palette_wheel.js';
import { wireFlyout } from './flyout.js';
import { createFrameScheduler, onPageTeardown } from './page_lifecycle.js';
import { createPointerDrag } from './pointer_drag.js';

// --- Palette Class and Data Structure ---

// --- Tab Switcher Logic ---
let activeTab = 'procedural';

function switchTab(tabName, updateUrl = true) {
  activeTab = tabName;
  document.querySelector('.palette-shell').dataset.activeTab = tabName;
  // Update buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const selected = btn.dataset.tab === tabName;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    btn.tabIndex = selected ? 0 : -1;
  });
  // Update content
  document.querySelectorAll('.tab-content').forEach(content => {
    const selected = content.id === `tab-content-${tabName}`;
    content.classList.toggle('active', selected);
    content.hidden = !selected;
  });
  // Named Palettes loads procedural coefficients, so it only applies here.
  const palettesPanel = document.getElementById('named_palettes_panel');
  if (palettesPanel) palettesPanel.style.display = (tabName === 'procedural') ? '' : 'none';

  if (updateUrl)
    history.replaceState(history.state, '',
      paletteTabUrl(window.location.href, tabName));

  // Update palette based on visible tab
  updatePalette();
}

// --- State and UI Elements ---

const defaultParams = {
  A_R: 0.500, A_G: 0.500, A_B: 0.500, // Base (0.0 to 1.0)
  B_R: 0.500, B_G: 0.500, B_B: 0.500, // Amplitude (0.0 to 1.0)
  C_R: 1.000, C_G: 1.000, C_B: 1.000, // Frequency (-5.0 to 5.0)
  D_R: 0.000, D_G: 0.330, D_B: 0.670  // Phase (-1.0 to 2.0)
};

let parameters = { ...defaultParams };
let palette;
let paletteOps = null;
let recipeTemplate = defaultPaletteRecipe();
let customHueOffsets = [0, 0.07, 0.14];
let previousHueMode = PaletteV4.hueMode.HARMONY;
let effectPalettePresets = [];
const paletteViewport = createPaletteViewport();

let hueKeyWheelCanvas, hueKeyWheelCtx;
let hueKeyWheelPainter = null;
// Marker positions of the last wheel actually painted. The wheel draws the
// canonical recipe, which clamps and rounds what the controls hold, and a
// recipe that failed to compile leaves the previous wheel on screen — so a
// grab must be tested against what the user can see, not against a state
// recomputed from the controls.
let hueKeyWheelDrawnPoints = [];
let activeHueKey = null;
let hueKeyDrag = null;
let selectedHueKey = 0;
// Off-screen role="slider" proxies, one per hue key. The wheel is a canvas,
// so a key's live position is announced through its own handle's
// aria-valuenow/aria-valuetext, which a screen reader re-reads on change.
let hueKeyHandles = [];

const enumIndex = (group, value) => PaletteV4[group][value];
const fullViewport = Object.freeze({ start: 0, end: 1 });

function customBaseTurns() {
  return Number(document.getElementById('gen_seed_slider').value) / 360;
}

function setCustomBaseTurns(turns) {
  const degrees = wrapTurns(turns) * 360;
  document.getElementById('gen_seed_slider').value = degrees;
  document.getElementById('gen_seed_value').textContent =
    `${Number(degrees.toFixed(1))}°`;
}

/**
 * Switch the controls into CUSTOM hue mode, authoring the three keys the
 * handoff starts from.
 * @param {Object} sourceRecipe - The recipe the keys are resampled from.
 * @returns {boolean} False when the resample dropped the key the user was
 *   acting on — a four-key harmony resamples to three, and clamping the
 *   grab or the selection onto a neighbour would silently move a different
 *   key.
 */
function activateCustomHue(sourceRecipe) {
  const state = customHueKeyState(sourceRecipe);
  customHueOffsets = state.offsets;
  const handoff = hueKeyHandoff(
    customHueOffsets.length, selectedHueKey, activeHueKey);
  selectedHueKey = handoff.selectedKey;
  activeHueKey = handoff.activeKey;
  setCustomBaseTurns(state.baseTurns);
  document.getElementById('gen_hue_mode').value = 'CUSTOM';
  previousHueMode = PaletteV4.hueMode.CUSTOM;
  syncRecipeControlAvailability();
  return handoff.kept;
}

function currentHueKeyState(recipe) {
  if (recipe.hue.mode === PaletteV4.hueMode.CUSTOM) {
    return { baseTurns: customBaseTurns(), offsets: [...customHueOffsets] };
  }
  return hueKeyState(recipe);
}

function drawHueKeyWheel(recipe) {
  if (!hueKeyWheelPainter) return;
  const { points, degrees } = hueKeyWheelPainter.draw({
    lightness: recipe.lightness.center,
    state: currentHueKeyState(recipe),
    activeKey: activeHueKey,
    selectedKey: selectedHueKey,
  });
  hueKeyWheelDrawnPoints = points;
  selectedHueKey = Math.min(selectedHueKey, points.length - 1);
  syncHueKeyHandles(degrees);
}

/**
 * Build one off-screen slider handle per hue key and attach them to the
 * wheel's group. Focusing a handle selects its key, so focus and the
 * highlighted marker stay the same thing; the draw hides the handles the
 * current key count does not reach.
 * @param {HTMLElement} group - The wheel's role="group" wrapper.
 * @returns {void}
 */
function mountHueKeyHandles(group) {
  hueKeyHandles = HUE_KEY_NAMES.map((name, index) => {
    const handle = document.createElement('span');
    handle.className = 'visually-hidden';
    handle.tabIndex = 0;
    handle.hidden = true;
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', `Hue key ${name}`);
    handle.setAttribute('aria-valuemin', '0');
    handle.setAttribute('aria-valuemax', '360');
    handle.setAttribute('aria-keyshortcuts',
      'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight');
    handle.addEventListener('focus', () => {
      selectedHueKey = index;
      scheduleUpdate();
    });
    handle.addEventListener('keydown', (event) => handleHueKeyNudge(event, index));
    group.appendChild(handle);
    return handle;
  });
}

/**
 * Republish each key's hue on its slider handle, and take the handles a
 * shorter key set no longer has out of the tab order and the accessibility
 * tree. Focus is handed to the last surviving handle before its own is
 * hidden, so a resample never drops focus to the document body.
 * @param {number[]} degrees - Every drawn key's hue, in whole degrees.
 * @returns {void}
 */
function syncHueKeyHandles(degrees) {
  hueKeyHandles.forEach((handle, index) => {
    if (index < degrees.length) {
      handle.hidden = false;
      handle.setAttribute('aria-valuenow', String(degrees[index]));
      handle.setAttribute('aria-valuetext', `${degrees[index]} degrees`);
      return;
    }
    if (handle === document.activeElement && degrees.length > 0)
      hueKeyHandles[degrees.length - 1].focus();
    handle.hidden = true;
  });
}

function wheelPointerPosition(event) {
  return canvasPoint(event.clientX, event.clientY,
    hueKeyWheelCanvas.getBoundingClientRect(),
    hueKeyWheelCanvas.width, hueKeyWheelCanvas.height);
}

function updateHueKeyFromPointer(event) {
  if (activeHueKey === null) return;
  const position = wheelPointerPosition(event);
  const pointerTurn = wheelTurnAt(position.x, position.y,
    hueKeyWheelCanvas.width, hueKeyWheelCanvas.height);
  customHueOffsets = moveCustomHueKey(
    customBaseTurns(), customHueOffsets, activeHueKey, pointerTurn);
  scheduleUpdate();
}

function handleHueWheelPointerDown(event) {
  const position = wheelPointerPosition(event);
  activeHueKey = hitTestHueKeyMarker(position.x, position.y,
    hueKeyWheelDrawnPoints, HUE_KEY_GRAB_RADIUS);
  if (activeHueKey === null) return false;
  selectedHueKey = activeHueKey;
  hueKeyWheelCanvas.style.cursor = 'grabbing';
  scheduleUpdate();
}

function handleHueWheelPointerMove(event) {
  const recipe = readPaletteRecipe();
  if (recipe.hue.mode !== PaletteV4.hueMode.CUSTOM
      && !activateCustomHue(recipe)) {
    hueKeyDrag.stop();
    return;
  }
  updateHueKeyFromPointer(event);
}

function handleHueWheelPointerHover(event) {
  const position = wheelPointerPosition(event);
  const marker = hitTestHueKeyMarker(position.x, position.y,
    hueKeyWheelDrawnPoints, HUE_KEY_GRAB_RADIUS);
  hueKeyWheelCanvas.style.cursor = marker === null ? 'default' : 'grab';
}

function handleHueWheelPointerEnd() {
  activeHueKey = null;
  hueKeyWheelCanvas.style.cursor = 'default';
  scheduleUpdate();
}

/**
 * Nudge one hue key from its own slider handle.
 * @param {KeyboardEvent} event - The handle's keydown.
 * @param {number} keyIndex - Which key the handle stands for.
 * @returns {void}
 */
function handleHueKeyNudge(event, keyIndex) {
  const delta = hueKeyNudgeTurns(event.key, event.shiftKey);
  if (delta === null) return;
  selectedHueKey = keyIndex;

  const recipe = readPaletteRecipe();
  if (recipe.hue.mode !== PaletteV4.hueMode.CUSTOM
      && !activateCustomHue(recipe)) {
    // The resample dropped the selected key; redraw on the clamped
    // selection rather than nudging the neighbour it landed on.
    scheduleUpdate();
    event.preventDefault();
    return;
  }
  const base = customBaseTurns();
  const current = base + customHueOffsets[selectedHueKey];
  customHueOffsets = moveCustomHueKey(
    base, customHueOffsets, selectedHueKey, wrapTurns(current + delta));
  scheduleUpdate();
  event.preventDefault();
}

function recipeWindow() {
  return {
    offset: Number(document.getElementById('gen_phase').value),
    span: Number(document.getElementById('gen_width').value),
  };
}

function syncRecipeWindowControls() {
  const phase = document.getElementById('gen_phase');
  const width = document.getElementById('gen_width');
  const { offset, span } = clampRecipeWindow(
    Number(phase.value), Number(width.value));
  width.value = span;
  phase.max = String(1 - span);
  phase.value = offset;
  document.getElementById('gen_phase_value').textContent = offset.toFixed(3);
  document.getElementById('gen_width_value').textContent = span.toFixed(3);
}

function setRecipeWindow(offset, span) {
  const width = document.getElementById('gen_width');
  const phase = document.getElementById('gen_phase');
  width.value = span;
  phase.max = String(1 - Number(width.value));
  phase.value = offset;
  syncRecipeWindowControls();
}

function zoomRecipeWindowControls(startPosition, endPosition) {
  const { offset, span } = zoomRecipeWindow(
    recipeWindow(), startPosition, endPosition);
  setRecipeWindow(offset, span);
  scheduleUpdate();
}

function visiblePhaseRange() {
  if (activeTab === 'procedural') return paletteViewport.value;
  const { offset, span } = palette?.canonicalRecipe?.input ?? recipeWindow();
  return { start: offset, end: offset + span };
}

function zoomed() {
  return paletteStripView(visiblePhaseRange()).zoomed;
}

function axisControlElements(axisName) {
  const { prefix, curve, label, shortLabel } = PALETTE_AXIS_CONTROLS[axisName];
  return {
    label, shortLabel,
    curve: document.getElementById(curve),
    minimum: document.getElementById(`${prefix}_minimum`),
    maximum: document.getElementById(`${prefix}_maximum`),
    minimumLabel: document.getElementById(`${prefix}_minimum_label`),
    maximumLabel: document.getElementById(`${prefix}_maximum_label`),
    minimumValue: document.getElementById(`${prefix}_minimum_value`),
    maximumValue: document.getElementById(`${prefix}_maximum_value`),
  };
}

function readAxisEndpoints(axisName) {
  const { minimum, maximum } = axisControlElements(axisName);
  return { minimum: Number(minimum.value), maximum: Number(maximum.value) };
}

function syncAxisEndpointControls(axisName) {
  const {
    label, shortLabel, curve, minimum, maximum, minimumLabel, maximumLabel,
    minimumValue, maximumValue,
  } = axisControlElements(axisName);
  const state = axisControlState({
    curve: curve.value, minimum: minimum.value, maximum: maximum.value,
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
  minimumValue.textContent = state.minimumText;
  maximumValue.textContent = state.maximumText;
}

function setAxisEndpoints(axisName, endpoints) {
  const { minimum, maximum } = axisControlElements(axisName);
  minimum.min = maximum.min = '0';
  minimum.max = maximum.max = '1';
  minimum.value = endpoints.minimum;
  maximum.value = endpoints.maximum;
  syncAxisEndpointControls(axisName);
}

function handleAxisEndpointInput(axisName, event) {
  const { curve } = axisControlElements(axisName);
  if (curve.value === 'CONSTANT') {
    setAxisEndpoints(axisName,
      { minimum: event.target.value, maximum: event.target.value });
  } else {
    syncAxisEndpointControls(axisName);
  }
  syncRecipeControlAvailability();
  scheduleUpdate();
}

function handleAxisCurveChange(axisName) {
  const { curve } = axisControlElements(axisName);
  if (curve.value === 'CONSTANT') {
    const { minimum, maximum } = readAxisEndpoints(axisName);
    const { center } = axisFromEndpoints(minimum, maximum);
    setAxisEndpoints(axisName, { minimum: center, maximum: center });
  } else {
    syncAxisEndpointControls(axisName);
  }
  syncRecipeControlAvailability();
  scheduleUpdate();
}

// Recipe fields read straight off a slider: its element, how many decimals
// the mirror label shows, and the unit it is labelled in.
const recipeSliderDefinitions = [
  { id: 'gen_spread', digits: 1, suffix: '°' },
  { id: 'gen_sweep', digits: 1, suffix: '' },
  { id: 'gen_torsion', digits: 1, suffix: '' },
  { id: 'gen_headroom', digits: 2, suffix: '' },
  { id: 'gen_falloff', digits: 2, suffix: '' },
];

function recipeSliderValue(id) {
  return Number(document.getElementById(id).value);
}

function syncRecipeSliderLabels() {
  for (const { id, digits, suffix } of recipeSliderDefinitions) {
    document.getElementById(`${id}_value`).textContent =
      `${recipeSliderValue(id).toFixed(digits)}${suffix}`;
  }
}

const controlValue = (id) => document.getElementById(id)?.value;

function readPaletteRecipe() {
  return paletteRecipeFromControls(recipeTemplate,
    paletteControlReadings(controlValue, customHueOffsets));
}

function syncRecipeControlAvailability() {
  const recipe = readPaletteRecipe();
  const availability = paletteRecipeAvailability(recipe);
  const controls = [
    ['gen_seed_field', 'gen_seed_slider', availability.baseHue],
    ['gen_hue_mode_field', 'gen_hue_mode', availability.hueMode],
    ['gen_harmony_field', 'gen_harmony', availability.harmony],
    ['gen_spread_field', 'gen_spread', availability.hueSpread],
    ['gen_sweep_field', 'gen_sweep', availability.hueSweep],
    ['gen_torsion_field', 'gen_torsion', availability.hueTorsion],
    ['gen_path_field', 'gen_path', availability.colorPath],
    ['gen_direction_field', 'gen_direction', availability.hueDirection],
    ['gen_falloff_field', 'gen_falloff', availability.falloffStart],
    ['gen_headroom_field', 'gen_headroom', availability.chromaHeadroom],
    ['gen_chroma_minimum_field', 'gen_chroma_minimum', availability.chromaEndpoints],
    ['gen_chroma_maximum_field', 'gen_chroma_maximum', availability.chromaMaximum],
    ['gen_lightness_minimum_field', 'gen_lightness_minimum', availability.lightnessEndpoints],
    ['gen_lightness_maximum_field', 'gen_lightness_maximum', availability.lightnessMaximum],
  ];

  for (const [fieldId, controlId, enabled] of controls) {
    const field = document.getElementById(fieldId);
    const control = document.getElementById(controlId);
    field.classList.toggle('is-disabled', !enabled);
    field.setAttribute('aria-disabled', String(!enabled));
    control.disabled = !enabled;
  }
}

function loadRecipe(recipe) {
  recipeTemplate = structuredClone(recipe);
  const controls = paletteControlsFromRecipe(recipe);
  const write = (name, value) => {
    document.getElementById(PALETTE_CONTROL_IDS[name]).value = value;
  };
  write('domain', controls.domain);
  write('hueMode', controls.hueMode);
  write('harmony', controls.harmony);
  write('direction', controls.direction);
  write('colorPath', controls.colorPath);
  write('lightnessCurve', controls.lightnessCurve);
  write('chromaCurve', controls.chromaCurve);
  write('easing', controls.easing);
  write('spreadDegrees', controls.spreadTurns * 360);
  write('sweepTurns', controls.sweepTurns);
  write('hueTorsion', controls.hueTorsion);
  write('headroom', controls.headroom);
  write('falloffStart', controls.falloffStart);
  syncRecipeSliderLabels();
  customHueOffsets = controls.customHueOffsets;
  previousHueMode = recipe.hue.mode;
  setCustomBaseTurns(controls.baseTurns);
  setRecipeWindow(controls.window.offset, controls.window.span);
  setAxisEndpoints('lightness', controls.lightness);
  setAxisEndpoints('chroma', controls.chroma);
  syncRecipeControlAvailability();
  scheduleUpdate();
}

function loadRecipePreset(name) {
  loadRecipe(PALETTE_RECIPE_PRESETS[name]());
}

function buildEffectRecipePresets() {
  const select = document.getElementById('effect_recipe_preset');
  for (const [index, preset] of effectPalettePresets.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = preset.randomHue
      ? `${preset.name} (random hue)`
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
let stripDrag = null;
let isSelectionActive = false; // Tracks if drag is active AND within Y-bounds
let dragStartPosition = 0.0;
let dragEndPosition = 0.0;
let copyFeedbackTimer = null;
let copyRequestId = 0;
let lockedDragStartValues = {}; // For locked slider relative movement

// Slider handles by param, so a value computed elsewhere (a locked group
// drag, a zoom) can drive the control it belongs to.
const sliderHandles = {};

// DOM Elements
// Declared inside init() after the window load handler.
// to ensure elements exist.
let colorStripCanvas, colorStripCtx, waveGraphCanvas, waveGraphCtx,
  resetZoomButton, paletteRangeHeading, copyFeedback, copyFeedbackSwatch,
  copyFeedbackStatus, copyFeedbackHex;

// Owns the strip's offscreen gradient cache; built in init() once the canvas
// and its context resolve. Invalidated on every palette change
// (updatePalette); a size change is detected by the painter itself.
let colorStripPainter = null;

// Spoken names for the coefficient groups and the RGB channels. The visible
// slider labels are single letters repeated across all four groups, so each
// control's accessible name is built from its group and channel instead —
// "Offset red" rather than a fourth control called "R". The group names match
// the <h3> each group's role="group" is labelled by.
const GROUP_NAMES = {
  A: 'Offset', B: 'Amplitude', C: 'Frequency', D: 'Phase',
};
const CHANNEL_NAMES = { R: 'red', G: 'green', B: 'blue' };

/**
 * The accessible name for one procedural slider.
 * @param {{param: string, group: string}} def - A sliderDefinitions entry; its param is `<group>_<channel>`.
 * @returns {string} The group and channel name, e.g. "Offset red".
 */
function sliderAriaLabel(def) {
  return `${GROUP_NAMES[def.group]} ${CHANNEL_NAMES[def.param.split('_')[1]]}`;
}

// Each entry carries a 'group' property.
const sliderDefinitions = [
  // A (Base): Range [0, 1]
  { param: 'A_R', container: 'A_R_container', label: 'R', color: 'red-500', thumb: 'r-thumb', min: 0, max: 1, step: 0.001, scale: 1000, group: 'A' },
  { param: 'A_G', container: 'A_G_container', label: 'G', color: 'green-500', thumb: 'g-thumb', min: 0, max: 1, step: 0.001, scale: 1000, group: 'A' },
  { param: 'A_B', container: 'A_B_container', label: 'B', color: 'blue-500', thumb: 'b-thumb', min: 0, max: 1, step: 0.001, scale: 1000, group: 'A' },
  // B (Amplitude): Range [0, 1]
  { param: 'B_R', container: 'B_R_container', label: 'R', color: 'red-500', thumb: 'r-thumb', min: 0, max: 1, step: 0.001, scale: 1000, group: 'B' },
  { param: 'B_G', container: 'B_G_container', label: 'G', color: 'green-500', thumb: 'g-thumb', min: 0, max: 1, step: 0.001, scale: 1000, group: 'B' },
  { param: 'B_B', container: 'B_B_container', label: 'B', color: 'blue-500', thumb: 'b-thumb', min: 0, max: 1, step: 0.001, scale: 1000, group: 'B' },
  // C (Frequency): Range [-5, 5] — engine palettes run the cosine backwards
  // with negative frequencies.
  { param: 'C_R', container: 'C_R_container', label: 'R', color: 'red-500', thumb: 'r-thumb', min: -5, max: 5, step: 0.001, scale: 1000, group: 'C' },
  { param: 'C_G', container: 'C_G_container', label: 'G', color: 'green-500', thumb: 'g-thumb', min: -5, max: 5, step: 0.001, scale: 1000, group: 'C' },
  { param: 'C_B', container: 'C_B_container', label: 'B', color: 'blue-500', thumb: 'b-thumb', min: -5, max: 5, step: 0.001, scale: 1000, group: 'C' },
  // D (Phase): Range [-1, 2] — a full period either side of [0, 1], so an
  // engine phase past 1 (or a zoom-derived negative one) stays representable.
  { param: 'D_R', container: 'D_R_container', label: 'R', color: 'red-500', thumb: 'r-thumb', min: -1, max: 2, step: 0.001, scale: 1000, group: 'D' },
  { param: 'D_G', container: 'D_G_container', label: 'G', color: 'green-500', thumb: 'g-thumb', min: -1, max: 2, step: 0.001, scale: 1000, group: 'D' },
  { param: 'D_B', container: 'D_B_container', label: 'B', color: 'blue-500', thumb: 'b-thumb', min: -1, max: 2, step: 0.001, scale: 1000, group: 'D' }
];

// --- Helper Functions ---

// --- UI and Event Functions ---

/**
 * Creates the HTML structure for a single parameter slider.
 */
function mountSlider(def) {
  const handles = createSlider(def.container, {
    id: def.param,
    label: def.label,
    min: def.min,
    max: def.max,
    step: def.step,
    value: parameters[def.param],
    scale: def.scale,
    decimals: 3,
    ariaLabel: sliderAriaLabel(def),
    labelSuffix: '',
    labelClass: `w-4 h-4 text-center font-bold text-${def.color}`,
    sliderClass: def.thumb,
    valueClass: 'slider-label w-16 text-right',
  }, (rawValue) => {
    const lockCheckbox = document.getElementById(`lock_${def.group}`);
    const isLocked = lockCheckbox ? lockCheckbox.checked : false;

    if (isLocked && Object.keys(lockedDragStartValues).length > 0) {
      // --- LOCKED RELATIVE MOVEMENT ---
      const startRawValue = lockedDragStartValues[def.param];
      if (startRawValue === undefined) {
        handles.setValue(parameters[def.param]);
        return;
      }

      // Read the group's raw bounds off the live sliders, cap the shared
      // delta so no channel leaves its range (lockedGroupMove), then write
      // the results back to state and the readouts.
      const group = sliderDefinitions.filter(groupDef => groupDef.group === def.group);
      const members = [];
      for (const groupDef of group) {
        const groupSlider = document.getElementById(`${groupDef.param}_slider`);
        if (!groupSlider) continue;
        members.push({
          param: groupDef.param,
          start: lockedDragStartValues[groupDef.param],
          min: parseFloat(groupSlider.min),
          max: parseFloat(groupSlider.max),
        });
      }
      const { values } = lockedGroupMove(rawValue - startRawValue, members);

      for (const groupDef of group) {
        const finalRawValue = values[groupDef.param];
        if (finalRawValue === undefined) continue;

        const finalNewValue = finalRawValue / groupDef.scale;
        parameters[groupDef.param] = finalNewValue;
        sliderHandles[groupDef.param].setValue(finalNewValue);
      }

    } else {
      // --- UNLOCKED MOVEMENT --- (the factory already wrote the readout)
      parameters[def.param] = rawValue / def.scale;
    }

    scheduleUpdate();
  });

  sliderHandles[def.param] = handles;
  const { slider } = handles;

  // Seed the per-group start values a locked relative drag works from. Must
  // fire on mouse, touch, and keyboard input: touch drags and arrow-key
  // presses emit `input` with no preceding `mousedown`, so without a seed the
  // locked branch above sees an empty map and the Lock checkbox silently does
  // nothing.
  const seedLockedDrag = () => {
    const lockCheckbox = document.getElementById(`lock_${def.group}`);
    const isLocked = lockCheckbox ? lockCheckbox.checked : false;

    if (isLocked) {
      lockedDragStartValues = {}; // Clear previous drag values
      sliderDefinitions.forEach(groupDef => {
        if (groupDef.group === def.group) {
          const groupSlider = document.getElementById(`${groupDef.param}_slider`);
          if (groupSlider) { // Safety check
            lockedDragStartValues[groupDef.param] = parseFloat(groupSlider.value);
          }
        }
      });
    }
  };
  slider.addEventListener('mousedown', seedLockedDrag);
  slider.addEventListener('touchstart', seedLockedDrag, { passive: true });
  slider.addEventListener('keydown', seedLockedDrag);

  // Clear locked values on mouseup
  slider.addEventListener('mouseup', () => {
    lockedDragStartValues = {};
  });
  slider.addEventListener('touchend', () => {
    lockedDragStartValues = {};
  });
}

/**
     * Updates all slider positions and value spans from the 'parameters' object.
     * Used after zooming or resetting zoom.
     */
function updateAllSliders() {
  sliderDefinitions.forEach(def => {
    sliderHandles[def.param].setValue(parameters[def.param]);
  });
}

/**
     * Helper function to get the normalized (0-1) X coordinate from a pointer event.
     */
function getNormalizedX(event) {
  if (!colorStripCanvas) return 0; // Safety check
  const rect = colorStripCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  return rect.width > 0 ? Math.max(0, Math.min(1, x / rect.width)) : 0;
}

/**
     * Handles the start of a drag or click on the color strip.
     */
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
function handleDragMove(event) {
  dragEndPosition = getNormalizedX(event);

  // Check if the pointer is outside the canvas's Y-bounds to deactivate selection
  if (colorStripCanvas) { // Safety check
    const rect = colorStripCanvas.getBoundingClientRect();
    const y = event.clientY;

    if (y < rect.top || y > rect.bottom) {
      // Pointer is above or below the canvas, deactivate selection
      isSelectionActive = false;
    } else {
      // Pointer is back inside, reactivate selection
      isSelectionActive = true;
    }
  }

  drawColorStrip(isSelectionActive
    ? { start: dragStartPosition, end: dragEndPosition }
    : null);
}

/**
     * Handles the end of a drag (zoom) or a simple click (set phase).
     */
function handleDragEnd(event) {
  if (!colorStripCanvas) return;

  handleDragMove(event);

  const wasSelectionActive = isSelectionActive; // Store state before reset

  isSelectionActive = false; // Reset selection state
  colorStripCanvas.style.cursor = 'pointer';

  // If the pointer was released outside Y-bounds, do nothing.
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

function feedbackPosition(clientX, clientY) {
  if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
    return { x: clientX, y: clientY };
  }
  const rect = colorStripCanvas.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

async function copyPaletteColor(position, clientX, clientY) {
  if (!palette || !copyFeedback || !copyFeedbackSwatch
      || !copyFeedbackStatus || !copyFeedbackHex) return;

  const phase = activeTab === 'procedural'
    ? paletteViewport.map(position)
    : position;
  const hex = linearRgbToHex(...palette.get(phase));
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
    setRecipeWindow(0, 1);
    scheduleUpdate();
  }
}

function syncResetZoomButton() {
  if (resetZoomButton) {
    resetZoomButton.classList.toggle('hidden', !zoomed());
  }
}

function drawColorStrip(selectionRange = null) {
  const viewport = activeTab === 'procedural' ? paletteViewport.value : fullViewport;
  colorStripPainter?.draw(palette, selectionRange, viewport);
}

/**
 * Plots the wave graph over the phase window the strip and the C++ export
 * show, by re-parameterizing the coefficients through the procedural
 * viewport exactly as the export does. The generative palette carries its
 * window in its own recipe, so it plots as baked.
 */
function drawPaletteWaveGraph() {
  let plotted = palette;
  if (activeTab === 'procedural') {
    const view = proceduralParamsForViewport(parameters, paletteViewport.value);
    plotted = new ProceduralPalette(
      [view.A_R, view.A_G, view.A_B],
      [view.B_R, view.B_G, view.B_B],
      [view.C_R, view.C_G, view.C_B],
      [view.D_R, view.D_G, view.D_B]);
  }
  drawWaveGraph({ canvas: waveGraphCanvas, ctx: waveGraphCtx, palette: plotted });
  waveGraphCanvas.setAttribute('aria-label', waveGraphLabel(visiblePhaseRange()));
}

/** Redraws every view of the palette after its viewport moved. */
function redrawForViewport() {
  drawColorStrip();
  drawPaletteWaveGraph();
  updateStripView();
  updatePaletteCodeOutput();
  syncResetZoomButton();
}


/**
     * Updates the code output block with the current parameters.
     */
function updatePaletteCodeOutput() {
  const codeOutput = document.getElementById('palette_code_output');
  if (!codeOutput) return;

  if (activeTab === 'procedural') {
    // The C++ export string is generated by the pure proceduralPaletteCpp
    // (palette_math.js) so its exact format is regression-tested; this
    // function only reads the current parameters and writes the result.
    codeOutput.textContent = proceduralPaletteCpp(
      proceduralParamsForViewport(parameters, paletteViewport.value));
  } else {
    codeOutput.textContent = generativePaletteCpp(
      palette?.canonicalRecipe ?? readPaletteRecipe());
  }
}

/**
 * Loads a named palette's coefficients into the procedural controls and
 * redraws in the full palette viewport.
 * @param {{name:string, a:number[], b:number[], c:number[], d:number[]}} entry - The palette to load.
 */
function loadNamedPalette(entry) {
  parameters = { ...proceduralPaletteParams(entry) };
  paletteViewport.reset();
  syncResetZoomButton();
  updateStripView();
  updateAllSliders();
  updatePalette();
}

/**
 * Populates the named-palette gallery with a clickable gradient swatch per
 * entry in NAMED_PROCEDURAL_PALETTES.
 */
function buildPaletteGallery() {
  const gallery = document.getElementById('palette_gallery');
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
  if (activeTab === 'procedural') {
    const A = [parameters.A_R, parameters.A_G, parameters.A_B];
    const B = [parameters.B_R, parameters.B_G, parameters.B_B];
    const C = [parameters.C_R, parameters.C_G, parameters.C_B];
    const D = [parameters.D_R, parameters.D_G, parameters.D_B];
    palette = new ProceduralPalette(A, B, C, D);
  } else {
    try {
      palette = new GenerativePalette(readPaletteRecipe());
      document.getElementById('gen_status').textContent = 'Recipe valid';
    } catch (error) {
      document.getElementById('gen_status').textContent = error.message;
      return;
    }
  }

  // The gradient changed — force the cached color strip to rebuild.
  colorStripPainter?.invalidate();

  drawPaletteWaveGraph();
  if (activeTab === 'generative')
    drawHueKeyWheel(palette.canonicalRecipe);
  drawColorStrip();
  updateStripView();
  syncResetZoomButton();

  // Update the code output
  updatePaletteCodeOutput();
}

// Coalesce updatePalette() into one recompute per animation frame: without
// this, every slider pointer tick re-bakes the generative palette's
// 256-entry LUT and redraws the wave graph (three channels reconstructed per
// canvas column) on the main thread.
const scheduleUpdate = createFrameScheduler(updatePalette);

/**
     * Initialize the sliders and the first visualization.
     */
async function init() {
  // Load the engine module first so GenerativePalette can bake its LUT with
  // the exact C++ color math (PaletteOps). The generative tab can't render
  // without it, so fail loudly rather than silently fall back.
  try {
    const { default: createHolosphereModule } = await import('../holosphere_wasm.js');
    const wasm = await createHolosphereModule();
    paletteOps = new wasm.PaletteOps();
    setPaletteOps(paletteOps);
    effectPalettePresets = Array.from(paletteOps.effectPresetsV4());
  } catch (e) {
    setPaletteOps(null);
    paletteOps?.delete();
    paletteOps = null;
    console.error('Failed to load WASM:', e);
    showFatalError('Failed to load the Holosphere WASM engine — the palette '
      + 'tool needs the built holosphere_wasm artifacts. Build the WASM '
      + 'target and reload.');
    return;
  }

  // Assign DOM elements inside init, after DOM load.
  colorStripCanvas = document.getElementById('colorStripCanvas');
  colorStripCtx = colorStripCanvas ? colorStripCanvas.getContext('2d') : null;
  waveGraphCanvas = document.getElementById('waveGraphCanvas');
  waveGraphCtx = waveGraphCanvas ? waveGraphCanvas.getContext('2d') : null;
  hueKeyWheelCanvas = document.getElementById('hueKeyWheelCanvas');
  hueKeyWheelCtx = hueKeyWheelCanvas ? hueKeyWheelCanvas.getContext('2d') : null;
  resetZoomButton = document.getElementById('resetZoomButton');
  paletteRangeHeading = document.getElementById('palette_range_heading');
  copyFeedback = document.getElementById('palette_copy_feedback');
  copyFeedbackSwatch = document.getElementById('palette_copy_swatch');
  copyFeedbackStatus = document.getElementById('palette_copy_status');
  copyFeedbackHex = document.getElementById('palette_copy_hex');

  // Safety check for critical elements
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
  hueKeyWheelPainter = createHueKeyWheelPainter({
    canvas: hueKeyWheelCanvas,
    ctx: hueKeyWheelCtx,
  });

  // 0. Tab buttons. Wired here via listeners rather than inline onclick
  // attributes, which a `<script type="module">` (module scope, not global)
  // cannot reach. The roving tabindex switchTab maintains leaves arrow keys
  // as the only way into the unselected tab, so activation follows focus.
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn[data-tab]'));
  tabButtons.forEach((btn, index) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    btn.addEventListener('keydown', (event) => {
      const target = tablistKeyTarget(event.key, index, tabButtons.length);
      if (target === null) return;
      event.preventDefault();
      switchTab(tabButtons[target].dataset.tab);
      tabButtons[target].focus();
    });
  });

  // 1. Initialize all 12 R/G/B sliders
  sliderDefinitions.forEach(mountSlider);

  // 1.5 Build the named-palette swatch gallery
  buildPaletteGallery();
  buildEffectRecipePresets();

  // 2. Initialize Generative Palette UI Controls
  const genSeedSlider = document.getElementById('gen_seed_slider');
  const genSeedValue = document.getElementById('gen_seed_value');
  if (genSeedSlider && genSeedValue) {
    genSeedSlider.addEventListener('input', () => {
      genSeedValue.textContent = `${Number(Number(genSeedSlider.value).toFixed(1))}°`;
      scheduleUpdate();
    });
  }

  const dropdowns = [
    'gen_hue_mode', 'gen_harmony', 'gen_shape', 'gen_path', 'gen_direction',
    'gen_easing',
  ];
  dropdowns.forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener('change', () => {
      if (id === 'gen_hue_mode') {
        const nextMode = enumIndex('hueMode', el.value);
        if (nextMode === PaletteV4.hueMode.CUSTOM &&
            previousHueMode !== PaletteV4.hueMode.CUSTOM) {
          const sourceRecipe = readPaletteRecipe();
          sourceRecipe.hue.mode = previousHueMode;
          sourceRecipe.hue.baseTurns = customBaseTurns();
          sourceRecipe.hue.sweepTurns = 1;
          activateCustomHue(sourceRecipe);
        } else {
          previousHueMode = nextMode;
        }
      }
      if (id === 'gen_harmony' && el.value === 'COMPLEMENTARY')
        document.getElementById('gen_path').value = 'OKLAB_CARTESIAN';
      syncRecipeControlAvailability();
      scheduleUpdate();
    });
  });

  for (const axisName of Object.keys(PALETTE_AXIS_CONTROLS)) {
    const { curve, minimum, maximum } = axisControlElements(axisName);
    curve.addEventListener('change', () => handleAxisCurveChange(axisName));
    minimum.addEventListener('input', (event) => handleAxisEndpointInput(axisName, event));
    maximum.addEventListener('input', (event) => handleAxisEndpointInput(axisName, event));
    syncAxisEndpointControls(axisName);
  }

  for (const id of ['gen_phase', 'gen_width']) {
    document.getElementById(id).addEventListener('input', () => {
      syncRecipeWindowControls();
      scheduleUpdate();
    });
  }
  syncRecipeWindowControls();

  for (const { id } of recipeSliderDefinitions) {
    document.getElementById(id).addEventListener('input', () => {
      syncRecipeSliderLabels();
      scheduleUpdate();
    });
  }
  syncRecipeSliderLabels();

  document.querySelectorAll('[data-recipe-preset]').forEach((button) => {
    button.addEventListener('click', () => loadRecipePreset(button.dataset.recipePreset));
  });

  syncRecipeControlAvailability();

  window.addEventListener('resize', scheduleUpdate);

  hueKeyDrag = createPointerDrag({
    element: hueKeyWheelCanvas,
    onStart: handleHueWheelPointerDown,
    onMove: handleHueWheelPointerMove,
    onHover: handleHueWheelPointerHover,
    onEnd: handleHueWheelPointerEnd,
  });
  mountHueKeyHandles(document.getElementById('hueKeyWheelGroup'));

  // 3. Add drag-and-drop listeners
  stripDrag = createPointerDrag({
    element: colorStripCanvas,
    onStart: handleDragStart,
    onMove: handleDragMove,
    onEnd: handleDragEnd,
    onCancel: handleDragCancel,
  });
  colorStripCanvas.addEventListener('keydown', handleStripKeyDown); // keyboard parity (a11y)
  updateStripView();

  // 5. Add listener for the reset zoom button
  if (resetZoomButton) {
    resetZoomButton.addEventListener('click', handleResetZoom);
  }

  // 6. Add listener for the copy code button
  wireCopyBlock({
    source: document.getElementById('palette_code_output'),
    button: document.getElementById('copy_code_button'),
    prompt: document.getElementById('copy_code_prompt'),
  });
  const teardownExportFlyout = wireFlyout({
    root: document.getElementById('export_flyout'),
    trigger: document.getElementById('export_toggle'),
  });

  switchTab(paletteTabFromSearch(window.location.search), false);

  onPageTeardown(() => {
    setPaletteOps(null);
    paletteOps?.delete();
    paletteOps = null;
    teardownExportFlyout();
    scheduleUpdate.cancel();
    window.removeEventListener('resize', scheduleUpdate);
    copyRequestId += 1;
    if (copyFeedbackTimer !== null) clearTimeout(copyFeedbackTimer);
    stripDrag.remove();
    colorStripCanvas.removeEventListener('keydown', handleStripKeyDown);
    hueKeyDrag.remove();
    for (const handle of hueKeyHandles) handle.remove();
    hueKeyHandles = [];
  });
}

bootstrapTool(init, 'palette tool');
