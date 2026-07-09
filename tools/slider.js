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

  // `!(a < b)` rather than `a >= b` so NaN bounds are rejected too.
  if (!(min < max)) {
    throw new Error(`createSlider(${id}): min (${min}) must be < max (${max})`);
  }
  if (!(step > 0)) {
    throw new Error(`createSlider(${id}): step (${step}) must be > 0`);
  }
  if (!(scale > 0)) {
    throw new Error(`createSlider(${id}): scale (${scale}) must be > 0`);
  }
  // Scaled units are integer, so a small fractional step can round to 0 (e.g.
  // step 0.4, scale 1); require >= 1 so the control stays movable.
  const sliderStep = Math.round(step * scale);
  if (sliderStep < 1) {
    throw new Error(`createSlider(${id}): step (${step}) * scale (${scale}) rounds to `
      + `${sliderStep} in scaled units; must be >= 1 (increase step or scale)`);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`createSlider(${id}): value (${value}) must be a finite number`);
  }

  const sliderId = `${id}_slider`;
  const valueSpanId = `${id}_value`;
  const clampedValue = Math.min(max, Math.max(min, value));

  container.replaceChildren();

  const labelSpan = document.createElement('span');
  labelSpan.className = labelClass;
  labelSpan.textContent = `${label}:`;

  const roundedValue = Math.round(clampedValue * scale);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = sliderId;
  slider.min = String(Math.round(min * scale));
  slider.max = String(Math.round(max * scale));
  slider.step = String(sliderStep);
  slider.value = String(roundedValue);
  slider.className = sliderClass;

  const valueSpan = document.createElement('span');
  valueSpan.id = valueSpanId;
  valueSpan.className = valueClass;
  valueSpan.textContent = (roundedValue / scale).toFixed(decimals);

  container.append(labelSpan, slider, valueSpan);

  if (onInput) {
    slider.addEventListener('input', () => {
      const raw = parseFloat(slider.value);
      // Set the readout before onInput so a caller can overwrite it with a
      // custom (e.g. snapped) value.
      valueSpan.textContent = (raw / scale).toFixed(decimals);
      onInput(raw);
    });
  }

  return { slider, valueSpan };
}
