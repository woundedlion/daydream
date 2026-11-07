// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { titleCase } from '../../shared/labels.js';
import { createFrameScheduler } from '../../shared/page_lifecycle.js';
import {
  deactivatedParameterIds, formatNumericValue, nudgeStep,
  numericSliderPosition, numericSliderValue, fieldOf,
  COLOR_PARAMETER_GROUPS, MODULATION_PARAMETER_GROUPS, COLOR_PARAMETER_NAMES,
  POTENTIAL_OPERATOR, POTENTIAL_PARAMETER_GROUPS,
  colorParameterHidden, modulationParameterHidden, modulationValueLimits,
  PALETTE_OPERATOR, MODULATION_OPERATOR,
} from './chain_presentation.js';

/** @typedef {import('./chain_document_store.js').ParameterDeclaration} ParameterDeclaration */
/** @typedef {import('./chain_presentation.js').ChainEntry} ChainEntry */
/** @typedef {{name: string, min: number, max: number}} ParameterRange */

export const BAKED_PARAMETER_REASON = 'This parameter is baked into the compiled build';

/**
 * Owns inline parameter rows and their pending edits across strip renders.
 * @param {{el: (tag: string, classes: string) => *, container: *,
 *   store: import('./chain_strip.js').ChainStore,
 *   catalog: import('./chain_presentation.js').OperatorCatalog,
 *   opOf: (entry: ChainEntry) => import('./chain_document_store.js').CatalogOperator,
 *   chipByLabel: (label: string) => *,
 *   chipLabel: (entry: ChainEntry, bypassed: boolean) => string,
 *   parameterLive: (id: string) => boolean,
 *   parameterRanges: () => ParameterRange[],
 *   onEditParameter: (id: string, value: *) => boolean|void,
 *   onCommitParameter: () => void,
 *   render: () => void,
 *   commit: (label: string|null) => boolean,
 *   report: (result: *) => boolean,
 *   pinnedLabels: Set<string>}} deps
 */
export function createChainParamRows({
  el, container, store, catalog, opOf, chipByLabel, chipLabel, parameterLive, parameterRanges,
  onEditParameter, onCommitParameter, render, commit, report, pinnedLabels,
}) {
  /** @type {ParameterDeclaration[]} */
  let declarations = [];
  /** @type {Record<string, *>} */
  let values = {};
  /** @type {Map<string, *>} */
  const rows = new Map();
  /** @type {Map<string, Map<number, boolean>>} */
  const potentialSectionChoices = new Map();

  /**
   * @param {string} parameterId - The read-only parameter.
   * @returns {string} The id its reason node is published under, for the row's
   *   controls to describe themselves by.
   */
  const reasonId = (parameterId) => `chain-param-off-${encodeURIComponent(parameterId)}`;

  /**
   * Points a row's controls at its reason node, or takes the reference back.
   * @param {*} row - The parameter row.
   * @param {string|null} id - The reason node's id, or null to clear.
   * @returns {void}
   */
  const describeControls = (row, id) => {
    for (const selector of ['.chain-param-control', '.chain-param-value']) {
      const control = row.querySelector(selector);
      if (control === null) continue;
      if (id === null) control.removeAttribute('aria-describedby');
      else control.setAttribute('aria-describedby', id);
    }
  };

  /** @type {Map<string, ParameterRange>} */
  let admittedRanges = new Map();
  /**
   * Updates admitted ranges, topology visibility and read-only diagnostics.
   * @param {boolean} [refreshRanges] - Recompute limits after committed edits.
   */
  const syncParameterRows = (refreshRanges = true) => {
    const chain = store.chain();
    if (refreshRanges)
      admittedRanges = new Map(parameterRanges().map((range) => [range.name, range]));
    const ranges = admittedRanges;
    const off = deactivatedParameterIds(declarations, values, chain, catalog);
    for (const control of container.querySelectorAll('.chain-modulation-enabled')) {
      const id = `${control.dataset.label}.modulation-enabled`;
      const disabled = values[id] === 'disabled';
      control.setAttribute('aria-pressed', String(disabled));
      control.setAttribute('title', parameterLive(id) ? 'Bypass' : BAKED_PARAMETER_REASON);
      control.disabled = !parameterLive(id);
      const entry = chain.find(entry => entry.label === control.dataset.label);
      if (entry) {
        const chip = chipByLabel(entry.label);
        chip?.classList.toggle('chain-chip--bypassed', disabled);
        chip?.setAttribute('aria-label', chipLabel(entry, disabled));
      }
    }
    for (const control of container.querySelectorAll('.chain-palette-type')) {
      const id = control.dataset.parameter;
      control.value = values[id];
      control.disabled = !parameterLive(id);
    }
    for (const [id, row] of rows) {
      const label = id.slice(0, id.indexOf('.'));
      const operator = chain.find((entry) => entry.label === label)?.operator;
      const color = operator === PALETTE_OPERATOR;
      const modulation = operator === MODULATION_OPERATOR;
      const field = fieldOf(id);
      const declaration = declarations.find((parameter) => parameter.id === id);
      if (declaration?.storage === 'enum8') {
        const select = row.querySelector('select');
        const range = ranges.get(id);
        const bounded = range && Number.isFinite(range.min) && Number.isFinite(range.max);
        for (const option of select?.options ?? []) {
          const index = declaration.domain?.values?.indexOf(option.value) ?? -1;
          option.disabled = Boolean(bounded
            && (index < Math.fround(range.min) || index > Math.fround(range.max)));
        }
      }
      if (declaration?.storage === 'binary32') {
        const domain = declaration.domain;
        let minimum = Number(domain?.minimum);
        let maximum = Number(domain?.maximum);
        const range = ranges.get(id);
        if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
          minimum = Math.max(minimum, range.min);
          maximum = Math.min(maximum, range.max);
        }
        const limits = modulation && modulationValueLimits(field, (field) => values[`${label}.${field}`]);
        if (limits) {
          minimum = Math.max(minimum, limits.min);
          maximum = Math.min(maximum, limits.max);
        }
        for (const control of row.querySelectorAll('input')) {
          const slider = control.type === 'range';
          control.min = String(slider ? numericSliderPosition(declaration, minimum) : minimum);
          control.max = String(slider ? numericSliderPosition(declaration, maximum) : maximum);
        }
      }
      row.hidden = off.has(id)
        || (color && colorParameterHidden(field, (field) => values[`${label}.${field}`]))
        || (modulation && modulationParameterHidden(field, (field) => values[`${label}.${field}`]));
      const shown = row.querySelector('.chain-param-note');
      const live = parameterLive(id);
      for (const control of row.querySelectorAll('input, select')) control.disabled = !live;
      if (!row.hidden && !live) {
        row.dataset.deactivated = 'true';
        if (shown !== null) { shown.textContent = BAKED_PARAMETER_REASON; continue; }
        const note = el('span', 'chain-param-note');
        note.setAttribute('id', reasonId(id));
        note.textContent = BAKED_PARAMETER_REASON;
        row.appendChild(note);
        describeControls(row, reasonId(id));
      } else {
        delete row.dataset.deactivated;
        if (shown === null) continue;
        row.removeChild(shown);
        describeControls(row, null);
      }
    }
    for (const group of container.querySelectorAll('.chain-param-group')) {
      group.hidden = [...group.querySelectorAll('.chain-param')].every((row) => row.hidden);
    }
  };

  const commitParameter = () => {
    onCommitParameter();
    syncParameterRows();
  };

  /**
   * Takes one inline control edit: the document write is the caller's, and the
   * strip keeps the value it now shows so a topology edit re-dims what the new
   * selection hides.
   * @param {string} parameterId - The edited parameter.
   * @param {*} value - The document value.
   * @returns {boolean}
   */
  const editParameter = (parameterId, value) => {
    if (!parameterLive(parameterId)) return false;
    const control = rows.get(parameterId)?.querySelector('.chain-param-control');
    if (control?.tagName === 'SELECT'
        && [...control.options].some((option) => option.value === value && option.disabled)) {
      control.value = String(values[parameterId]);
      return false;
    }
    if (typeof value === 'number') {
      if (control?.type === 'range') {
        const declaration = declarations.find((parameter) => parameter.id === parameterId);
        const minimum = numericSliderValue(declaration, Number(control.min));
        const maximum = numericSliderValue(declaration, Number(control.max));
        value = Math.min(maximum, Math.max(minimum, value));
        control.value = String(numericSliderPosition(declaration, value));
        control.setAttribute('aria-valuetext', formatNumericValue(value));
        rows.get(parameterId).querySelector('.chain-param-value').value = formatNumericValue(value);
      }
    }
    if (onEditParameter(parameterId, value) === false) {
      scheduleSliderEdit.cancel();
      pendingSliderEdit = null;
      store.endValueRun();
      render();
      return false;
    }
    values[parameterId] = value;
    syncParameterRows(false);
    return true;
  };
  /** @type {{parameterId: string, value: number}|null} */
  let pendingSliderEdit = null;
  const scheduleSliderEdit = createFrameScheduler(() => {
    const edit = pendingSliderEdit;
    pendingSliderEdit = null;
    if (edit !== null) editParameter(edit.parameterId, edit.value);
  });
  const commitSliderEdit = () => {
    scheduleSliderEdit.cancel();
    const edit = pendingSliderEdit;
    pendingSliderEdit = null;
    if (edit !== null) editParameter(edit.parameterId, edit.value);
  };

  /**
   * @param {ParameterDeclaration} declaration - An enum8 declaration.
   * @returns {*} The control for its domain values.
   */
  const enumControl = (declaration) => {
    if (fieldOf(declaration.id) === 'random-center'
      && declaration.domain?.values?.join(',') === 'off,on') {
      const toggle = el('input', 'chain-param-control');
      toggle.type = 'checkbox';
      toggle.checked = values[declaration.id] === 'on';
      toggle.addEventListener('change', () => {
        const accepted = editParameter(declaration.id, toggle.checked ? 'on' : 'off');
        toggle.checked = values[declaration.id] === 'on';
        if (accepted) {
          store.endValueRun();
          commitParameter();
        }
      });
      return toggle;
    }
    const select = el('select', 'chain-param-control');
    for (const value of declaration.domain?.values ?? []) {
      const option = el('option', 'chain-param-option');
      option.value = value;
      option.textContent = titleCase(value);
      option.selected = value === values[declaration.id];
      select.appendChild(option);
    }
    select.addEventListener('change', (/** @type {*} */ event) => {
      if (!editParameter(declaration.id, event.target.value)) return;
      store.endValueRun();
      commitParameter();
    });
    return select;
  };

  /**
   * @param {ParameterDeclaration} declaration - A binary32 declaration.
   * @param {*} readout - The row's value readout, repainted as the slider moves.
   * @returns {*} The slider over its domain.
   */
  const sliderControl = (declaration, readout) => {
    const slider = el('input', 'chain-param-control');
    const minimum = Number(declaration.domain?.minimum);
    const maximum = Number(declaration.domain?.maximum);
    slider.type = 'range';
    slider.min = String(numericSliderPosition(declaration, minimum));
    slider.max = String(numericSliderPosition(declaration, maximum));
    // Any step grid would re-snap the authored value on first touch.
    slider.step = 'any';
    slider.value = String(numericSliderPosition(declaration, values[declaration.id]));
    slider.setAttribute('aria-valuetext', formatNumericValue(values[declaration.id]));
    slider.addEventListener('input', (/** @type {*} */ event) => {
      const position = Math.min(Number(slider.max), Math.max(Number(slider.min), Number(event.target.value)));
      const value = numericSliderValue(declaration, position);
      slider.value = String(position);
      slider.setAttribute('aria-valuetext', formatNumericValue(value));
      readout.value = formatNumericValue(value);
      pendingSliderEdit = { parameterId: declaration.id, value };
      scheduleSliderEdit();
    });
    slider.addEventListener('change', () => {
      commitSliderEdit();
      store.endValueRun();
      commitParameter();
    });
    return slider;
  };

  /**
   * The instance label as an editable field. A rename is a document edit
   * through the store; a refusal restores the field.
   * @param {ChainEntry} entry - The chain entry.
   * @returns {*} The rename row.
   */
  const renameRow = (entry) => {
    const row = el('div', 'chain-chip-rename-row');
    const label = el('span', 'chain-param-name');
    label.textContent = 'Name';
    row.appendChild(label);
    const field = el('input', 'chain-chip-rename');
    field.type = 'text';
    field.value = entry.label;
    field.setAttribute('aria-label', `${opOf(entry).name} · ${entry.label} name`);
    field.addEventListener('change', (/** @type {*} */ event) => {
      const next = String(event.target.value ?? '').trim();
      if (next === entry.label) return;
      const result = store.relabel(entry.label, next);
      if (!result.ok) {
        field.value = entry.label;
        report(result);
        return;
      }
      if (pinnedLabels.delete(entry.label)) pinnedLabels.add(next);
      const sections = potentialSectionChoices.get(entry.label);
      if (sections) potentialSectionChoices.set(next, sections);
      potentialSectionChoices.delete(entry.label);
      commit(next);
    });
    row.appendChild(field);
    return row;
  };

  /**
   * The chip's own controls, one row per parameter the store reports
   * for the instance (authored declarations plus undeclared catalog fields),
   * labeled by the field segment alone: the chip already names the instance.
   * @param {ChainEntry} entry - The chain entry.
   * @param {ParameterDeclaration[]} declared - The instance's parameters.
   * @returns {*} The parameter region.
   */
  const paramsElement = (entry, declared) => {
    const palette = entry.operator === PALETTE_OPERATOR;
    const modulation = entry.operator === MODULATION_OPERATOR;
    const potential = entry.operator === POTENTIAL_OPERATOR;
    const color = palette || modulation;
    const grouped = color || potential;
    const parameterGroups = potential ? POTENTIAL_PARAMETER_GROUPS
      : modulation ? MODULATION_PARAMETER_GROUPS : COLOR_PARAMETER_GROUPS;
    const region = el('div', 'chain-chip-params');
    region.dataset.label = entry.label;
    region.setAttribute('role', 'group');
    region.setAttribute('aria-label', `${opOf(entry).name} · ${entry.label} parameters`);
    if (!color) region.appendChild(renameRow(entry));
    if (declared.length === 0) {
      const note = el('p', 'chain-strip-note');
      note.textContent = 'No adjustable parameters';
      region.appendChild(note);
    }
    /** @type {Map<string, *>} */
    const groups = new Map();
    const ordered = grouped ? parameterGroups.flatMap((group) => group.fields.flatMap(
      (field) => declared.filter((parameter) => fieldOf(parameter.id) === field))) : declared;
    for (const declaration of [...ordered, ...declared.filter((parameter) => !ordered.includes(parameter))]) {
      const field = fieldOf(declaration.id);
      if (modulation && field === 'modulation-enabled') continue;
      if (palette && field === 'palette-type') continue;
      const localField = potential ? field.replace(/^term-[1-4]-/, '') : field;
      const name = color ? COLOR_PARAMETER_NAMES[field]
        ?? titleCase(field.replace(/^(interference|grid)-(.+)-b(?=-|$)/, '$1-$2')
          .replace(/^(sine|interference|grid)-/, ''))
        : potential && localField === 'l' ? 'Degree'
          : potential && localField === 'm' ? 'Order' : titleCase(localField);
      let parent = region;
      if (grouped) {
        const definition = parameterGroups.find((group) => group.fields.includes(field));
        const groupName = definition?.name ?? 'Other';
        if (!groups.has(groupName)) {
          const group = el('div', 'chain-param-group');
          group.setAttribute('role', 'group');
          group.setAttribute('aria-label', groupName);
          const term = potential ? definition?.term : undefined;
          const heading = el(term === undefined ? 'div' : 'button',
            'chain-param-group-title' + (term === undefined ? '' : ' chain-param-group-toggle'));
          heading.textContent = groupName;
          group.appendChild(heading);
          let content = group;
          if (term !== undefined) {
            content = el('div', 'chain-param-group-fields');
            const contentId = `chain-potential-${encodeURIComponent(entry.label)}-term-${term}`;
            content.setAttribute('id', contentId);
            content.hidden = !(potentialSectionChoices.get(entry.label)?.get(term)
              ?? (term === 1 || Number(values[`${entry.label}.term-${term}-amplitude`] ?? 0) !== 0));
            heading.type = 'button';
            heading.setAttribute('aria-label', groupName);
            heading.setAttribute('aria-controls', contentId);
            heading.setAttribute('aria-expanded', String(!content.hidden));
            const chevron = el('span', 'chain-param-group-chevron');
            chevron.setAttribute('aria-hidden', 'true');
            chevron.textContent = '\u25b8';
            heading.appendChild(chevron);
            heading.addEventListener('click', () => {
              const open = content.hidden;
              content.hidden = !open;
              heading.setAttribute('aria-expanded', String(open));
              if (!potentialSectionChoices.has(entry.label))
                potentialSectionChoices.set(entry.label, new Map());
              potentialSectionChoices.get(entry.label)?.set(term, open);
            });
            group.appendChild(content);
          }
          region.appendChild(group);
          groups.set(groupName, content);
        }
        parent = groups.get(groupName);
      }
      const row = el('div', 'chain-param');
      row.dataset.parameter = declaration.id;
      const label = el('span', 'chain-param-name');
      label.textContent = name;
      if (color && field === 'pattern-scale')
        label.setAttribute('title', 'Higher values produce finer noise; lower values produce broader patches.');
      if (color && field === 'pattern-speed')
        label.setAttribute('title', 'Animation rate. Zero freezes the noise; negative values reverse it.');
      row.appendChild(label);
      if (declaration.storage === 'enum8') {
        const control = enumControl(declaration);
        control.setAttribute('aria-label', name);
        row.appendChild(control);
      } else {
        const readout = el('input', 'chain-param-value');
        readout.type = 'number';
        readout.value = formatNumericValue(values[declaration.id]);
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
          const current = Number(values[declaration.id]);
          const value = Number.isFinite(typed)
            ? Math.min(Number(readout.max), Math.max(Number(readout.min), typed))
            : current;
          readout.value = formatNumericValue(value);
          if (value === current) return;
          slider.value = String(numericSliderPosition(declaration, value));
          editParameter(declaration.id, value);
        };
        readout.addEventListener('change', (/** @type {*} */ event) => {
          enterValue(String(event.target.value ?? ''));
          store.endValueRun();
          commitParameter();
        });
        readout.addEventListener('keydown', (/** @type {*} */ event) => {
          const direction = event.key === 'ArrowUp' ? 1
            : event.key === 'ArrowDown' ? -1 : 0;
          if (direction === 0) return;
          event.preventDefault();
          const shown = readout.value.trim() === '' ? NaN : Number(readout.value);
          const from = Number.isFinite(shown) ? shown : Number(values[declaration.id]);
          enterValue(String(numericSliderValue(declaration,
            numericSliderPosition(declaration, from) + direction * nudgeStep(declaration))));
          store.endValueRun();
          commitParameter();
        });
        row.appendChild(slider);
        row.appendChild(readout);
      }
      rows.set(declaration.id, row);
      parent.appendChild(row);
    }
    if (color) region.appendChild(renameRow(entry));
    return region;
  };


  return {
    paramsElement,
    enumControl,
    syncParameterRows,
    editParameter,
    commitParameter,
    flushParameterEdit: commitSliderEdit,
    /** @param {ParameterDeclaration[]} nextDeclarations @param {Record<string, *>} nextValues */
    reset(nextDeclarations, nextValues) {
      rows.clear();
      declarations = nextDeclarations;
      values = nextValues;
      const labels = new Set(store.chain().map((entry) => entry.label));
      for (const label of potentialSectionChoices.keys()) {
        if (!labels.has(label)) potentialSectionChoices.delete(label);
      }
    },
    /** @param {Record<string, *>} updates - Committed parameter values. */
    syncParameterValues(updates) {
      for (const [id, value] of Object.entries(updates)) {
        values[id] = value;
        const row = rows.get(id);
        if (!row) continue;
        const control = row.querySelector('.chain-param-control');
        if (control.type === 'checkbox') control.checked = value === 'on';
        else if (control.type === 'range') {
          const declaration = declarations.find((parameter) => parameter.id === id);
          control.value = String(numericSliderPosition(declaration, Number(value)));
          control.setAttribute('aria-valuetext', formatNumericValue(value));
        } else control.value = String(value);
        const readout = row.querySelector('.chain-param-value');
        if (readout) readout.value = formatNumericValue(value);
      }
      syncParameterRows();
    },

    destroy() {
      scheduleSliderEdit.cancel();
      pendingSliderEdit = null;
    },
  };
}
