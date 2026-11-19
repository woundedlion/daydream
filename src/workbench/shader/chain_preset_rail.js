// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {titleCase} from '../../shared/labels.js';
import {FPS} from '../../renderer/frame_constants.js';
import {neighbouringPresets, DEFAULT_PRESET_DWELL} from './chain_preset_bank.js';
import {presetSourceKind} from './chain_planar_source.js';

/** @typedef {import('./chain_document_store.js').ChainStore} ChainStore */
/** @typedef {import('./chain_document_store.js').EditResult} EditResult */
/** @typedef {import('./chain_preset_bank.js').Edge} Edge */
/** @typedef {ReturnType<typeof import('./chain_preset_transport.js').createPresetTransport>} Transport */
/** @typedef {{code?: string, message: string, parameter_id?: string, preset_id?: string, from?: string, to?: string}} PromotionIssue */

/**
 * @param {{doc: Document, mount: HTMLElement, store: () => ChainStore|null, preset: () => string|null,
 * choose: (id: string) => void, edit: (result: EditResult, id?: string) => void, transport: Transport,
 * catalog: () => *, diagnostics: () => PromotionIssue[], jump: (issue: PromotionIssue) => void}} options
 */
export function createPresetRail({doc, mount, store, preset, choose, edit, transport, catalog,
  diagnostics, jump}) {
  /** @type {HTMLButtonElement|null} */
  let nextButton = null;
  /** @type {HTMLButtonElement|null} */
  let showButton = null;
  /** @type {HTMLButtonElement|null} */
  let stopButton = null;
  /** @type {HTMLInputElement|null} */
  let scrubber = null;
  /** @type {HTMLOutputElement|null} */
  let progress = null;
  /** @type {string|null} */
  let openEdge = null;
  /** @type {string|null} */
  let dragged = null;

  /** @param {string} text @param {() => void} action @param {string} [label] */
  function button(text, action, label = text) {
    const control = doc.createElement('button');
    control.type = 'button';
    control.textContent = text;
    control.setAttribute('aria-label', label);
    control.addEventListener('click', action);
    return control;
  }

  /** @param {number} value @param {string} label @param {(value: number) => void} change */
  function frameCount(value, label, change) {
    const input = doc.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.value = String(value);
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      if (input.value === '' || !input.checkValidity()) {
        input.value = String(value);
        return;
      }
      change(input.valueAsNumber);
    });
    return input;
  }

  /** @param {string} label @param {string} value @param {string[]} choices @param {(value: string) => void} change */
  function selector(label, value, choices, change) {
    const input = doc.createElement('select');
    input.setAttribute('aria-label', label);
    for (const choice of choices) {
      const option = doc.createElement('option');
      option.value = choice;
      option.textContent = choice === 'EASE_IN_OUT_SIN' ? 'Ease in-out sine' : titleCase(choice.toLowerCase());
      input.appendChild(option);
    }
    input.value = value;
    input.addEventListener('change', () => change(input.value));
    return input;
  }

  /** @param {string} label @param {HTMLElement} control */
  function labelled(label, control) {
    const element = doc.createElement('label');
    element.append(label, control);
    return element;
  }

  function sync() {
    const {active, selected, showing} = transport.view();
    if (!scrubber || !progress || !nextButton || !stopButton || !showButton) return;
    const frame = active?.frame ?? 0;
    const total = selected?.duration ?? 0;
    scrubber.max = String(total);
    scrubber.value = String(frame);
    scrubber.disabled = total === 0;
    progress.textContent = total === 0 ? '' : Math.round(frame * 100 / total) + '%';
    nextButton.disabled = total === 0;
    stopButton.disabled = !active && !showing;
    showButton.setAttribute('aria-pressed', String(showing));
  }

  function render() {
    const current = store();
    const active = preset();
    if (!current || active === null) {
      mount.replaceChildren();
      return;
    }
    const bank = current.presetBankView();
    const order = bank.choreography.generated_order;
    const edges = neighbouringPresets(order);
    const issues = diagnostics();
    const operators = catalog()?.operators ?? [];
    const document = current.document();
    const source = current.chainView().find((entry) =>
      operators.some((/** @type {*} */ operator) => operator.id === entry.operator && operator.output === 'field'));
    const definition = operators.find((/** @type {*} */ operator) => operator.id === source?.operator);
    /** @param {string} id */
    const sourceName = (id) => {
      const values = current.presetValuesView(id);
      const kind = source && values ? presetSourceKind(source.operator, source.label, values, definition) : null;
      return kind ? titleCase(kind) : definition?.name ?? '';
    };

    const toolbar = doc.createElement('div');
    toolbar.className = 'shader-preset-transport';
    const prior = order[(order.indexOf(active) + order.length - 1) % order.length];
    const previous = button('Previous', () => choose(prior));
    previous.disabled = order.length < 2;
    nextButton = button('Next', transport.next);
    showButton = button('Show', () => transport.view().showing ? transport.stop() : transport.show());
    stopButton = button('Stop', transport.stop);
    scrubber = doc.createElement('input');
    scrubber.type = 'range';
    scrubber.min = '0';
    scrubber.step = '1';
    scrubber.setAttribute('aria-label', 'Transition frame');
    scrubber.addEventListener('input', () => transport.seek(scrubber?.valueAsNumber ?? 0));
    progress = doc.createElement('output');
    progress.setAttribute('aria-label', 'Transition progress');
    toolbar.append(previous, nextButton, showButton, stopButton, scrubber, progress);

    const dwell = bank.choreography.dwell;
    const frames = dwell?.[active] ?? DEFAULT_PRESET_DWELL;
    const timing = doc.createElement('div');
    timing.className = 'shader-preset-timing';
    timing.id = 'shader-preset-dwell';
    timing.tabIndex = -1;
    const dwellInput = frameCount(frames, 'Dwell frames',
      (value) => edit(current.setPresetDwell(active, value)));
    const seconds = doc.createElement('span');
    seconds.textContent = (frames / FPS).toFixed(2).replace(/\.?0+$/, '') + ' s';
    timing.append(labelled('Dwell frames', dwellInput), seconds);

    const track = doc.createElement('div');
    track.className = 'shader-preset-track';
    track.setAttribute('role', 'group');
    track.setAttribute('aria-label', 'Preset order');

    for (const [index, id] of order.entries()) {
      const preset = bank.presets.find((candidate) => candidate.preset_id === id);
      const name = preset?.display_name ?? id;
      const tile = doc.createElement('div');
      tile.className = 'shader-preset-tile';
      tile.dataset.preset = id;
      tile.draggable = true;
      tile.addEventListener('dragstart', (event) => {
        dragged = id;
        event.dataTransfer?.setData('text/plain', id);
      });
      tile.addEventListener('dragend', () => { dragged = null; });
      tile.addEventListener('dragover', (event) => { if (dragged !== null) event.preventDefault(); });
      tile.addEventListener('drop', (event) => {
        event.preventDefault();
        if (dragged !== null && dragged !== id) edit(current.movePreset(dragged, index));
        dragged = null;
      });
      const select = button(name, () => choose(id));
      select.setAttribute('aria-pressed', String(id === active));
      select.addEventListener('keydown', (event) => {
        if (!event.altKey) return;
        const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if (offset && order[index + offset] !== undefined) {
          event.preventDefault();
          edit(current.movePreset(id, index + offset));
        }
      });
      const source = doc.createElement('span');
      source.textContent = sourceName(id);
      const actions = doc.createElement('details');
      const label = doc.createElement('summary');
      label.textContent = 'Edit';
      label.setAttribute('aria-label', 'Edit ' + name);
      const rename = doc.createElement('input');
      rename.value = name;
      rename.setAttribute('aria-label', 'Preset name');
      rename.addEventListener('change', () => edit(current.renamePreset(id, rename.value)));
      const duplicate = button('Duplicate', () => {
        const result = current.duplicatePreset(id);
        edit(result, result.ok ? result.presetId : undefined);
      });
      const remove = button('Delete', () => edit(current.deletePreset(id), id === active ? (order[index + 1] ?? order[index - 1]) : active));
      remove.disabled = order.length === 1;
      const earlier = button('Move left', () => edit(current.movePreset(id, index - 1)));
      earlier.disabled = index === 0;
      const later = button('Move right', () => edit(current.movePreset(id, index + 1)));
      later.disabled = index === order.length - 1;
      actions.append(label, rename, duplicate, earlier, later, remove);
      tile.append(select, source, actions);
      track.appendChild(tile);

      const pair = edges.find((edge) => edge.from === id);
      if (!pair) continue;
      const edge = bank.edges.find((edge) => edge.from === id && edge.to === pair.to);
      const details = doc.createElement('details');
      details.className = 'shader-preset-edge';
      details.dataset.from = id;
      details.dataset.to = pair.to;
      const summary = doc.createElement('summary');
      const toSource = sourceName(pair.to);
      summary.textContent = (edge ? (edge.duration / FPS).toFixed(2).replace(/\.?0+$/, '') + ' s' : 'Add edge')
        + (source.textContent && toSource && source.textContent !== toSource
          ? ' · morph ' + source.textContent + ' → ' + toSource : ' →');
      details.open = openEdge === id;
      details.addEventListener('toggle', () => {
        if (details.open) openEdge = id;
        else if (openEdge === id) openEdge = null;
      });
      details.appendChild(summary);
      if (edge) {
        const refusal = issues.find((issue) => issue.from === edge.from && issue.to === edge.to);
        if (refusal) {
          summary.title = refusal.message;
          if (refusal.code === 'INCOMPATIBLE_SOURCE_LATTICE') summary.textContent += ' ? Incompatible lattice';
        }
        /** @param {Partial<Edge>} settings */
        const save = (settings) => edit(current.setPresetEdge(edge.from, edge.to, settings));
        const settings = doc.createElement('div');
        settings.className = 'shader-preset-edge-settings';
        const easing = selector('Easing', edge.easing, ['EASE_IN_OUT_SIN', 'LINEAR'], (easing) => save({easing}));
        const more = doc.createElement('details');
        const moreLabel = doc.createElement('summary');
        moreLabel.textContent = 'More';
        more.append(moreLabel, labelled('Path', selector('Path policy', edge.path_policy,
          document.descriptor.path_policies.map((/** @type {*} */ policy) => policy.id), (path_policy) => save({path_policy}))));
        settings.append(button('Preview edge', () => transport.selectEdge(edge)),
          labelled('Duration frames', frameCount(edge.duration, 'Transition duration frames', (duration) => save({duration}))),
          labelled('Easing', easing), more);
        details.appendChild(settings);
      } else {
        details.appendChild(button('Add edge', () => edit(current.setPresetEdge(id, pair.to, {}))));
      }
      track.appendChild(details);
    }
    track.appendChild(button('+', () => {
      const result = current.addPreset(active);
      edit(result, result.ok ? result.presetId : undefined);
    }, 'Add preset'));

    const report = doc.createElement('details');
    const summary = doc.createElement('summary');
    const extras = bank.edges.filter((edge) => !edges.some((pair) => pair.from === edge.from && pair.to === edge.to));
    summary.textContent = issues.length || extras.length ? 'Promotion issues' : 'Promotable';
    report.appendChild(summary);
    for (const issue of issues) {
      report.appendChild(button(issue.message, () => jump(issue)));
    }
    for (const edge of extras) {
      const control = button('Off-rail edge ' + edge.from + ' → ' + edge.to, () => transport.selectEdge(edge));
      control.dataset.offrail = 'true';
      control.dataset.from = edge.from;
      control.dataset.to = edge.to;
      report.appendChild(control);
    }
    mount.replaceChildren(toolbar, timing, track, report);
    sync();
  }

  return {render, sync};
}
