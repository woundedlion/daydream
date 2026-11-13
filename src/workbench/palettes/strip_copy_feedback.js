/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {copyToClipboard as copyToClipboardDefault} from '../../shared/clipboard.js';
import {linearRgbToHex} from '../../shared/color.js';

/** Creates palette color copying and transient feedback.
 * @param {Pick<Parameters<typeof import('./strip_controller.js').createStripController>[0],
 * 'canvas'|'viewport'|'getTab'|'getPalette'|'feedback'|'copy'|'timers'>} deps
 * @returns {{copyPaletteColor: (position: number, clientX?: number, clientY?: number) => Promise<void>,
 * reportCopyFailure: (error: any) => void, disposeCopy: () => void}} Copy actions and cleanup. */
export function createStripCopyFeedback({canvas: colorStripCanvas, viewport, getTab, getPalette,
  feedback, copy: copyToClipboard = copyToClipboardDefault, timers = globalThis}) {
  const {root:copyFeedback, swatch:copyFeedbackSwatch, status:copyFeedbackStatus, hex:copyFeedbackHex} = feedback;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let copyFeedbackTimer = null;
  let copyRequestId = 0;
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

  /** Reports a rejected copy and dismisses its feedback.
   * @param {any} error - The rejection.
   * @returns {void}
   */
  function reportCopyFailure(error) {
    console.error(error);
    copyFeedbackStatus.textContent = 'Copy failed';
    dismissCopyFeedbackLater();
  }
  return {copyPaletteColor, reportCopyFailure, disposeCopy() {
    copyRequestId++;
    if (copyFeedbackTimer !== null) timers.clearTimeout(copyFeedbackTimer);
  }};
}
