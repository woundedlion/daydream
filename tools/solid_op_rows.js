/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * DOM construction for one row of the solids tool's op chain
 * (tools/solids.html), unit-testable without a browser.
 *
 * An op's name and parameter values survive a localStorage round-trip, so every
 * row is assembled node-by-node — createElement plus textContent/setAttribute,
 * never innerHTML — and carries no inline event-handler attribute; the callers'
 * handlers are wired with addEventListener here.
 */

import { unsweepableReason } from './solid_codegen.js';

/** @typedef {import('./solid_codegen.js').OpParamDef} OpParamDef */

/**
 * @typedef {{op: string, params: Object<string, number>}} ChainOpRow
 */

/**
 * The row's handlers.
 * @typedef {object} OpRowHandlers
 * @property {(grip: HTMLElement, row: HTMLElement) => void} wireDrag - Attaches the reorder drag to the row's grip.
 * @property {(from: number, to: number) => void} move - Moves the op one slot.
 * @property {(index: number) => void} remove - Drops the op.
 * @property {(index: number, key: string, value: string) => void} setParam - Writes one parameter.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// Six-dot drag grip.
const DRAG_HANDLE_PATH =
  'M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 '
  + '2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 '
  + '0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 '
  + '2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z';

/**
 * Builds the drag grip.
 * @param {Document} doc - Document the nodes are created in.
 * @returns {HTMLElement} The grip element.
 */
function buildDragHandle(doc) {
  const handle = doc.createElement('div');
  handle.className = 'drag-handle';
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', DRAG_HANDLE_PATH);
  svg.appendChild(path);
  handle.appendChild(svg);
  return handle;
}

/**
 * Builds a labelled button.
 * @param {Document} doc - Document the nodes are created in.
 * @param {string} className - Class attribute value.
 * @param {string} text - Visible label.
 * @param {string} ariaLabel - Accessible name.
 * @returns {HTMLButtonElement} The button element.
 */
function buildButton(doc, className, text, ariaLabel) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = className;
  button.setAttribute('aria-label', ariaLabel);
  button.textContent = text;
  return button;
}

/**
 * Formats a parameter value for its number box, at the precision its step grid
 * can reach: whole for an integer-stepped parameter (whose C++ argument is a
 * count or a whole degree), two decimals otherwise.
 * @param {number|string} value - The value to display.
 * @param {{step: number}} [def] - The parameter's OP_DEFS range.
 * @returns {string} The formatted value, or 'NaN' for a non-numeric one.
 */
export function formatParamValue(value, def) {
  return Number(value).toFixed(Number.isInteger(def?.step) ? 0 : 2);
}

/**
 * Builds one parameter row: name, slider, number box and unit suffix.
 * @param {Document} doc - Document the nodes are created in.
 * @param {string} key - Parameter name, as declared in OP_DEFS.
 * @param {OpParamDef} def - The parameter's range.
 * @param {number} value - Current value.
 * @param {string} controlId - Unique id prefix for the row's controls.
 * @param {string} opName - Op the parameter belongs to, used in both inputs' accessible names.
 * @returns {{row: HTMLElement, range: HTMLInputElement, number: HTMLInputElement}} The row and its two inputs.
 */
function buildParamRow(doc, key, def, value, controlId, opName) {
  const row = doc.createElement('div');
  row.className = 'op-param flex items-center text-[0.6rem] space-x-1';
  row.dataset.key = key;

  const name = doc.createElement('label');
  name.className = 'w-12 text-slate-400 capitalize truncate';
  name.htmlFor = `${controlId}-range`;
  name.textContent = key;

  const range = doc.createElement('input');
  range.type = 'range';
  range.id = `${controlId}-range`;
  // The visible label is the bare key, which repeats across the chain; the
  // aria-label overrides it so each op's slider is named by its own op.
  range.setAttribute('aria-label', `${opName} ${key}`);
  range.className = 'flex-1 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer min-w-0';
  range.min = String(def.min);
  range.max = String(def.max);
  range.step = String(def.step);
  range.value = String(value);

  const number = doc.createElement('input');
  number.type = 'number';
  number.setAttribute('aria-label', `${opName} ${key} value`);
  // At 0.6rem on the row's --slate-800, slate-300/400 are the lightest pair that
  // keeps the value ahead of its unit and both over the 4.5:1 WCAG AA floor.
  number.className = 'w-12 bg-transparent text-right font-mono text-slate-300 focus:outline-none focus:text-white [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none';
  number.min = String(def.min);
  number.max = String(def.max);
  number.step = String(def.step);
  number.value = formatParamValue(value, def);

  const unit = doc.createElement('span');
  unit.className = 'text-[0.5rem] text-slate-400 ml-0.5';
  unit.setAttribute('aria-hidden', 'true');
  unit.textContent = key === 'angle' ? 'deg' : '';

  row.append(name, range, number, unit);
  return { row, range, number };
}

/**
 * Writes a row's morph-sweep marker for the op's current parameters. A slider
 * can cross the band without the row being rebuilt, so the caller re-runs this
 * after a parameter write.
 * @param {HTMLElement} el - The row buildOpRow returned.
 * @param {ChainOpRow} op - The op's current state.
 * @returns {void}
 */
export function syncSweepWarning(el, op) {
  const flag = /** @type {HTMLElement?} */ (el.querySelector('.op-unsweepable'));
  if (!flag) return;
  const reason = unsweepableReason(op);
  flag.textContent = reason ? '⚠' : '';
  flag.setAttribute('aria-label', reason ?? '');
  flag.setAttribute('title', reason ?? '');
  flag.hidden = !reason;
}

/**
 * Builds one op-chain row, wired to the caller's handlers.
 * @param {ChainOpRow} op - The op this row shows.
 * @param {number} index - The op's position in the chain.
 * @param {Object} opts - Row context.
 * @param {{params: Object<string, OpParamDef>}} opts.opDef - The op's OP_DEFS entry.
 * @param {number} opts.count - Length of the chain, which disables the last row's down button.
 * @param {OpRowHandlers} opts.on - The row's handlers.
 * @param {Document} [opts.doc] - Document the nodes are created in.
 * @returns {HTMLElement} The row element, unattached.
 */
export function buildOpRow(op, index, { opDef, count, on, doc = document }) {
  const el = doc.createElement('div');
  el.className = 'op-item flex-col items-stretch text-xs text-indigo-300';

  const header = doc.createElement('div');
  header.className = 'flex justify-between items-center w-full';

  const headerLeft = doc.createElement('div');
  headerLeft.className = 'flex items-center';

  const handle = buildDragHandle(doc);
  const upButton = buildButton(doc, 'move-op-btn move-op-up', '↑', `Move ${op.op} up`);
  upButton.disabled = index === 0;
  const downButton = buildButton(doc, 'move-op-btn move-op-down', '↓', `Move ${op.op} down`);
  downButton.disabled = index === count - 1;

  const label = doc.createElement('span');
  label.className = 'font-bold';
  label.textContent = `${index + 1}. ${String(op.op).toUpperCase()}`;

  const sweep = doc.createElement('span');
  sweep.className = 'op-unsweepable text-amber-400';
  sweep.setAttribute('role', 'img');
  headerLeft.append(handle, upButton, downButton, label, sweep);

  const removeButton = buildButton(doc, 'remove-op-btn text-slate-500 hover:text-white',
    '×', `Remove ${op.op} at position ${index + 1}`);
  header.append(headerLeft, removeButton);
  el.appendChild(header);

  const paramKeys = opDef.params ? Object.keys(opDef.params) : [];
  if (paramKeys.length > 0) {
    const controls = doc.createElement('div');
    controls.className = 'mt-1 space-y-1';
    for (const key of paramKeys) {
      const { row, range, number } = buildParamRow(
        doc, key, opDef.params[key], op.params[key], `op-${index}-${key}`, op.op);
      controls.appendChild(row);

      const readValue = (/** @type {Event} */ e) =>
        /** @type {HTMLInputElement} */ (e.target).value;
      range.addEventListener('input', (e) => on.setParam(index, key, readValue(e)));
      number.addEventListener('change', (e) => on.setParam(index, key, readValue(e)));
    }
    el.appendChild(controls);
  }

  on.wireDrag(handle, el);
  upButton.addEventListener('click', () => on.move(index, index - 1));
  downButton.addEventListener('click', () => on.move(index, index + 1));
  removeButton.addEventListener('click', () => on.remove(index));

  syncSweepWarning(el, op);
  return el;
}
