/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/* Palette strip selection, zoom and color-copy interactions. */

import {copyToClipboard as copyToClipboardDefault} from '../../shared/clipboard.js';
import {linearRgbToHex} from '../../shared/color.js';
import {createPointerDrag, innerRect} from '../../shared/pointer_drag.js';
import {paletteStripView, stripDragIntent} from './palette_controls.js';

/**
 * Binds strip selection, viewport zoom and color-copy feedback.
 * @param {object} options - Strip elements, model and interaction callbacks.
 * @param {HTMLCanvasElement} options.canvas - Interactive color strip.
 * @param {ReturnType<typeof import('./palette_controls.js').createPaletteViewport>} options.viewport - Procedural palette viewport.
 * @param {import('./palette_recipe_model.js').PaletteRecipeModel} options.model - Editable generative palette recipe.
 * @param {() => string} options.getTab - Reads the active palette tab.
 * @param {() => {get: (phase:number) => number[]}|null} options.getPalette - Reads the palette used for color copying.
 * @param {() => {start:number,end:number}} options.visiblePhaseRange - Reads the displayed phase interval.
 * @param {(selection?:{start:number,end:number}|null) => void} options.drawColorStrip - Paints the strip and optional drag selection.
 * @param {() => void} options.redrawForViewport - Redraws after procedural viewport changes.
 * @param {(start:number,end:number) => void} options.zoomRecipeWindowControls - Sets the recipe window to the selected range.
 * @param {() => void} options.renderRecipeWindow - Refreshes the recipe window controls.
 * @param {() => void} options.scheduleUpdate - Schedules a palette preview update.
 * @param {HTMLElement} options.resetZoomButton - Restores the full phase range.
 * @param {HTMLElement} options.paletteRangeHeading - Names the displayed phase interval.
 * @param {{root:HTMLElement,swatch:HTMLElement,status:HTMLElement,hex:HTMLElement}} options.feedback - Color-copy feedback elements.
 * @param {typeof copyToClipboardDefault} [options.copy] - Copies the selected color text.
 * @param {typeof createPointerDrag} [options.createDrag] - Binds pointer selection gestures.
 * @param {{setTimeout:typeof setTimeout, clearTimeout:typeof clearTimeout}} [options.timers] - Schedules and cancels feedback dismissal.
 * @returns {{copyColor: (position: number, x?: number, y?: number) => Promise<void>,
 *   updateView: () => void, syncResetZoom: () => void, dispose: () => void}} Strip controls and cleanup.
 */
export function createStripController({canvas: colorStripCanvas, viewport, model, getTab, getPalette,
  visiblePhaseRange, drawColorStrip, redrawForViewport, zoomRecipeWindowControls, renderRecipeWindow,
  scheduleUpdate, resetZoomButton, paletteRangeHeading, feedback, copy: copyToClipboard = copyToClipboardDefault,
  createDrag = createPointerDrag, timers = globalThis}) {
  const {root:copyFeedback, swatch:copyFeedbackSwatch, status:copyFeedbackStatus, hex:copyFeedbackHex} = feedback;
  let isSelectionActive = false;
  let dragStartPosition = 0;
  let dragEndPosition = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let copyFeedbackTimer = null;
  let copyRequestId = 0;
  const zoomed = () => paletteStripView(visiblePhaseRange()).zoomed;
  /**
   * The normalized (0-1) X coordinate of a pointer event over the strip.
   * @param {PointerEvent} event - Pointer position.
   * @returns {number} The clamped coordinate, or zero when the strip has no width.
   */
  function getNormalizedX(event) {
    const rect = innerRect(colorStripCanvas);
    const x = event.clientX - rect.left;
    return rect.width > 0 ? Math.max(0, Math.min(1, x / rect.width)) : 0;
  }

  /**
   * Handles the start of a drag or click on the color strip.
   * @param {PointerEvent} event
   * @returns {void}
   */
  function handleDragStart(event) {

    isSelectionActive = true;
    dragStartPosition = getNormalizedX(event);
    dragEndPosition = dragStartPosition;
    colorStripCanvas.style.cursor = 'crosshair';

    drawColorStrip();
  }

  /**
   * Handles pointer movement during a drag.
   * Cancels selection if the pointer moves above or below the canvas.
   * @param {PointerEvent} event
   */
  function handleDragMove(event) {
    dragEndPosition = getNormalizedX(event);

    const rect = innerRect(colorStripCanvas);
    const y = event.clientY;
    isSelectionActive = y >= rect.top && y <= rect.top + rect.height;

    drawColorStrip(isSelectionActive
      ? { start: dragStartPosition, end: dragEndPosition }
      : null);
  }

  /**
   * Handles the end of a drag (zoom) or a simple click (copy color).
   * @param {PointerEvent} event
   */
  function handleDragEnd(event) {
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
    } else if (getTab() === 'procedural') {
      viewport.zoom(start, end);
      redrawForViewport();
    } else {
      zoomRecipeWindowControls(start, end);
    }
  }

  function handleDragCancel() {
    isSelectionActive = false;
    colorStripCanvas.style.cursor = 'pointer';
    drawColorStrip();
  }

  function updateStripView() {
    const view = paletteStripView(visiblePhaseRange());
    colorStripCanvas.setAttribute('aria-label', view.ariaLabel);
    paletteRangeHeading.textContent = view.heading;
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
    const palette = getPalette();
    if (!palette) return;

    const phase = getTab() === 'procedural'
      ? viewport.map(position)
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
      timers.clearTimeout(copyFeedbackTimer);
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
    if (copyFeedbackTimer !== null) timers.clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = timers.setTimeout(() => {
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
    copyFeedbackStatus.textContent = 'Copy failed';
    dismissCopyFeedbackLater();
  }

  function zoomAroundCenter() {
    if (getTab() === 'procedural') {
      viewport.zoom(0.4, 0.6);
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
    if (getTab() === 'procedural') {
      viewport.reset();
      redrawForViewport();
    } else {
      model.setWindow(0, 1);
      renderRecipeWindow();
      scheduleUpdate();
    }
  }

  function syncResetZoomButton() {
    const hidden = !zoomed();
    if (hidden && colorStripCanvas.ownerDocument.activeElement === resetZoomButton) colorStripCanvas.focus();
    resetZoomButton.classList.toggle('hidden', hidden);
  }

  const drag = createDrag({element: colorStripCanvas, onStart: handleDragStart,
    onMove: handleDragMove,
    // onCancel owns cancellation; onEnd receives a release event.
    onEnd: /** @type {(event: PointerEvent|null) => void} */ (handleDragEnd),
    onCancel: handleDragCancel});
  colorStripCanvas.addEventListener('keydown', handleStripKeyDown);
  resetZoomButton.addEventListener('click', handleResetZoom);
  updateStripView();
  return {copyColor: copyPaletteColor, updateView: updateStripView, syncResetZoom: syncResetZoomButton,
    dispose() {
      copyRequestId++;
      if (copyFeedbackTimer !== null) timers.clearTimeout(copyFeedbackTimer);
      drag.remove();
      colorStripCanvas.removeEventListener('keydown', handleStripKeyDown);
      resetZoomButton.removeEventListener('click', handleResetZoom);
    }};
}
