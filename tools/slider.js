/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Build a labelled range slider with a live value readout.
 *
 * The factory owns only the markup and the input wiring; tool-specific
 * behaviour (state updates, re-rendering, value snapping) lives in the
 * `onInput` callback, which receives the raw (scaled) slider value.
 *
 * Slider values are stored in "raw" integer space (display * scale) so that
 * `<input type=range>` can use whole-number steps; the initial readout shows
 * the display value.
 *
 * @param {string} containerId - ID of the element to fill with the slider
 * @param {object} cfg
 * @param {string} cfg.id - Base id; produces `${id}_slider` and `${id}_value`
 * @param {string} cfg.label - Text shown before the slider
 * @param {number} cfg.min - Minimum (display space)
 * @param {number} cfg.max - Maximum (display space)
 * @param {number} cfg.step - Step (display space)
 * @param {number} cfg.value - Initial value (display space)
 * @param {number} [cfg.scale=1] - Display-to-raw multiplier
 * @param {number} [cfg.decimals=2] - Decimals for the readout
 * @param {string} [cfg.labelClass] - Classes for the label span
 * @param {string} [cfg.sliderClass] - Classes for the input
 * @param {string} [cfg.valueClass] - Classes for the readout span
 * @param {Function} onInput - Called with the raw slider value on each input
 * @returns {{ slider: HTMLInputElement, valueSpan: HTMLElement } | null}
 */
export function createSlider(containerId, cfg, onInput) {
  const container = document.getElementById(containerId);
  if (!container) return null;

  const {
    id,
    label,
    min,
    max,
    step,
    value,
    scale = 1,
    decimals = 2,
    labelClass = 'w-20 text-center font-bold text-white text-lg',
    sliderClass = 'flex-grow',
    valueClass = 'slider-label w-24 text-right',
  } = cfg;

  const sliderId = `${id}_slider`;
  const valueSpanId = `${id}_value`;

  container.innerHTML = `
    <span class="${labelClass}">${label}:</span>
    <input type="range" id="${sliderId}"
      min="${Math.round(min * scale)}"
      max="${Math.round(max * scale)}"
      step="${Math.round(step * scale)}"
      value="${Math.round(value * scale)}"
      class="${sliderClass}">
    <span id="${valueSpanId}" class="${valueClass}">${value.toFixed(decimals)}</span>
  `;

  const slider = document.getElementById(sliderId);
  const valueSpan = document.getElementById(valueSpanId);

  if (onInput) {
    slider.addEventListener('input', () => onInput(parseFloat(slider.value)));
  }

  return { slider, valueSpan };
}
