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
 * @param {string} [cfg.ariaLabel] - Accessible name for the input, for pages whose visible label is too short to identify the control on its own (a grid of sliders labelled only R/G/B). Overrides the visible label as the accessible name; omit it where the visible label already names the control.
 * @param {string} [cfg.labelSuffix=':'] - Text appended to the label
 * @param {string} [cfg.labelClass] - Classes for the label span
 * @param {string} [cfg.sliderClass] - Classes for the input
 * @param {string} [cfg.valueClass] - Classes for the readout span
 * @param {Function} onInput - Called with the raw slider value on each input
 * @returns {{ slider: HTMLInputElement, valueSpan: HTMLElement, setValue: (display: number) => number, setReadout: (display: number) => void }}
 */
export function createSlider(containerId, cfg, onInput) {
  const container = document.getElementById(containerId);
  if (!container)
    throw new Error(`createSlider: container #${containerId} not found`);

  const {
    id,
    label,
    min,
    max,
    step,
    value,
    scale = 1,
    decimals = 2,
    ariaLabel = '',
    labelSuffix = ':',
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
  const scaledMin = Math.round(min * scale);
  const scaledMax = Math.round(max * scale);

  /**
   * Puts a display value onto the scaled grid the input actually accepts:
   * `min + k*step`, clamped to the range. `<input type=range>` re-snaps
   * anything off that grid, so a value merely rounded to scaled units would
   * leave the thumb somewhere the readout does not name whenever
   * `step * scale > 1`.
   * @param {number} display - The value in display space.
   * @returns {number} The value in scaled units, on the grid and in range.
   */
  const toScaled = (display) => {
    const clamped = Math.min(max, Math.max(min, display));
    const steps = Math.round((clamped * scale - scaledMin) / sliderStep);
    const snapped = scaledMin + steps * sliderStep;
    // The top of the range need not land on the grid; the last step below it is
    // then the highest value the control holds.
    const inRange = snapped > scaledMax ? snapped - sliderStep : snapped;
    return Math.max(scaledMin, inRange);
  };

  container.replaceChildren();

  const labelElement = document.createElement('label');
  labelElement.htmlFor = sliderId;
  labelElement.className = labelClass;
  labelElement.textContent = `${label}${labelSuffix}`;

  const roundedValue = toScaled(value);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = sliderId;
  slider.min = String(scaledMin);
  slider.max = String(scaledMax);
  slider.step = String(sliderStep);
  slider.value = String(roundedValue);
  slider.className = sliderClass;
  if (ariaLabel) slider.setAttribute('aria-label', ariaLabel);
  // The input's value is the scaled integer; announce the display value instead.
  slider.setAttribute('aria-valuetext', (roundedValue / scale).toFixed(decimals));

  const valueSpan = document.createElement('span');
  valueSpan.id = valueSpanId;
  valueSpan.className = valueClass;
  valueSpan.textContent = (roundedValue / scale).toFixed(decimals);

  container.append(labelElement, slider, valueSpan);

  if (onInput) {
    slider.addEventListener('input', () => {
      const raw = parseFloat(slider.value);
      // Set the readout before onInput so a caller can overwrite it with a
      // custom (e.g. snapped) value.
      const display = (raw / scale).toFixed(decimals);
      valueSpan.textContent = display;
      slider.setAttribute('aria-valuetext', display);
      onInput(raw);
    });
  }

  /**
   * Writes the readout and `aria-valuetext` together, leaving the thumb where it
   * is. For a value the step grid cannot represent: the thumb takes the nearest
   * grid point, the readout names the value actually in effect.
   * @param {number} display - The value in display space.
   * @returns {void}
   */
  const setReadout = (display) => {
    const text = display.toFixed(decimals);
    valueSpan.textContent = text;
    slider.setAttribute('aria-valuetext', text);
  };

  /**
   * Drives the control from code: thumb, readout, and `aria-valuetext` all move
   * together, so a page that computes a value elsewhere cannot leave one of the
   * three behind. Fires no `input` event — the caller owns its own state.
   * @param {number} display - The value in display space; clamped to [min, max].
   * @returns {number} The value now shown, clamped and snapped to the step grid.
   */
  const setValue = (display) => {
    const scaled = toScaled(display);
    const shown = scaled / scale;
    slider.value = String(scaled);
    setReadout(shown);
    return shown;
  };

  return { slider, valueSpan, setValue, setReadout };
}
