/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {formatNumericValue, numericSliderPosition, numericSliderValue, nudgeStep}
  from './chain_presentation.js';

/** @typedef {import('./chain_document_store.js').ParameterDeclaration} ParameterDeclaration */
/** @typedef {<K extends keyof HTMLElementTagNameMap>(tag: K, classes: string) => HTMLElementTagNameMap[K]} ElementFactory */

/**
 * @param {object} deps
 * @param {ElementFactory} deps.el
 * @param {(declaration: ParameterDeclaration) => HTMLSelectElement|HTMLInputElement} deps.enumControl
 * @param {(declaration: ParameterDeclaration, readout: HTMLInputElement) => HTMLInputElement} deps.sliderControl
 * @param {() => Record<string, number|string>} deps.getValues
 * @param {(id: string, value: number|string) => void} deps.editParameter
 * @param {import('./chain_document_store.js').ChainStore} deps.store
 * @param {() => void} deps.commitParameter
 */
export function createParameterRowControls({el, enumControl, sliderControl, getValues,
  editParameter, store, commitParameter}) {
  /** @param {HTMLElement} row @param {ParameterDeclaration} declaration @param {string} name */
  function appendEnumControl(row, declaration, name) {
    const control = enumControl(declaration);
    control.setAttribute('aria-label', name);
    row.appendChild(control);
  }

  /** @param {HTMLElement} row @param {ParameterDeclaration} declaration @param {string} name */
  function appendNumericControl(row, declaration, name) {
    const readout = el('input', 'chain-param-value');
    readout.type = 'number';
    readout.value = formatNumericValue(/** @type {number} */ (getValues()[declaration.id]));
    const slider = sliderControl(declaration, readout);
    slider.setAttribute('aria-label', name);
    readout.min = String(declaration.domain?.minimum);
    readout.max = String(declaration.domain?.maximum);
    // Any step grid would report a stored binary32 as stepMismatch.
    readout.step = 'any';
    readout.setAttribute('aria-label', `${name} value`);
    /** @param {string} raw - The entered text. @returns {void} */
    const enterValue = (raw) => {
      // Unparseable number-input content reads as '', which Number() makes 0.
      const trimmed = raw.trim();
      const typed = trimmed === '' ? Number.NaN : Number(trimmed);
      const current = Number(getValues()[declaration.id]);
      const value = Number.isFinite(typed)
        ? Math.min(Number(readout.max), Math.max(Number(readout.min), typed))
        : current;
      readout.value = formatNumericValue(value);
      if (value === current) return;
      slider.value = String(numericSliderPosition(declaration, value));
      editParameter(declaration.id, value);
    };
    readout.addEventListener('change', (event) => {
      enterValue(String((/** @type {HTMLInputElement} */ (event.target)).value ?? ''));
      store.endValueRun();
      commitParameter();
    });
    readout.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      const direction = event.key === 'ArrowUp' ? 1
        : event.key === 'ArrowDown' ? -1 : 0;
      if (direction === 0) return;
      event.preventDefault();
      const shown = readout.value.trim() === '' ? NaN : Number(readout.value);
      const from = Number.isFinite(shown) ? shown : Number(getValues()[declaration.id]);
      enterValue(String(numericSliderValue(declaration,
        numericSliderPosition(declaration, from) + direction * nudgeStep(declaration))));
      store.endValueRun();
      commitParameter();
    });
    row.appendChild(slider);
    row.appendChild(readout);
  }

  /** @param {HTMLElement} row @param {ParameterDeclaration} declaration @param {string} name */
  return function appendParameterControl(row, declaration, name) {
    if (declaration.storage === 'enum8') appendEnumControl(row, declaration, name);
    else appendNumericControl(row, declaration, name);
  };
}
