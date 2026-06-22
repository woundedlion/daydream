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

  // Assert the numeric contract rather than silently building an inert control:
  // a non-positive scale (the raw step rounds to 0) or step, or min >= max, all
  // produce a slider the user cannot move and no diagnostic. These are author
  // config errors, so fail loudly. The `!(a < b)` form also rejects NaN.
  if (!(min < max)) {
    throw new Error(`createSlider(${id}): min (${min}) must be < max (${max})`);
  }
  if (!(step > 0)) {
    throw new Error(`createSlider(${id}): step (${step}) must be > 0`);
  }
  if (!(scale > 0)) {
    throw new Error(`createSlider(${id}): scale (${scale}) must be > 0`);
  }

  const sliderId = `${id}_slider`;
  const valueSpanId = `${id}_value`;

  // Build via createElement/textContent rather than interpolating into
  // innerHTML, matching the textContent-only discipline used elsewhere in
  // tools/: a label/value/class that ever became data-driven could otherwise
  // inject markup (latent XSS).
  container.replaceChildren();

  const labelSpan = document.createElement('span');
  labelSpan.className = labelClass;
  labelSpan.textContent = `${label}:`;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = sliderId;
  slider.min = String(Math.round(min * scale));
  slider.max = String(Math.round(max * scale));
  slider.step = String(Math.round(step * scale));
  slider.value = String(Math.round(value * scale));
  slider.className = sliderClass;

  const valueSpan = document.createElement('span');
  valueSpan.id = valueSpanId;
  valueSpan.className = valueClass;
  valueSpan.textContent = value.toFixed(decimals);

  container.append(labelSpan, slider, valueSpan);

  if (onInput) {
    slider.addEventListener('input', () => onInput(parseFloat(slider.value)));
  }

  return { slider, valueSpan };
}
