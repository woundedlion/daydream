// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createChainPalette} from './chain_palette.js';
import {createChainParamRows} from './chain_param_rows.js';
import { titleCase } from '../../shared/labels.js';
import {
  createChainPresentation, labelOf,
} from './chain_presentation.js';

import {createChipDrag} from './chain_chip_drag.js';
import {createChainViewport} from './chain_viewport.js';
import {createChainSelection} from './chain_selection.js';
import {createStripViewState} from './chain_strip_context.js';
import {createStripCommands} from './chain_strip_commands.js';
import {createChipElements, chipLabel} from './chain_chip_element.js';
import {createStripHistory} from './chain_strip_history.js';

/**
 * The pipeline strip: the document's operator chain in execution order as chips
 * grouped into one band per editable carrier family, with carrier crossings as
 * socket chips on band boundaries. Structural gestures commit through the
 * store's span replacement; the strip is rebuilt whole after every committed
 * edit. Each chip carries its stage's controls inline.
 */

/** @typedef {import('./chain_presentation.js').OperatorCatalog} OperatorCatalog */
/** @typedef {{name: string, min: number, max: number}} ParameterRange */
/** @typedef {import('./chain_document_store.js').ChainStore} ChainStore */
/** @typedef {import('./chain_strip_context.js').RenderOptions} RenderOptions */
/**
 * @typedef {Object} ChainStrip
 * @property {(options?: RenderOptions) => void} render
 * @property {ReturnType<typeof createChainParamRows>['syncParameterRows']} syncParameterRows
 * @property {ReturnType<typeof createChainParamRows>['syncParameterValues']} syncParameterValues
 * @property {ReturnType<typeof createChainParamRows>['showTransitionValues']} showTransitionValues
 * @property {(parameterId: string) => void} focusParameter
 * @property {() => void} syncHistory
 * @property {ReturnType<typeof createChainParamRows>['flushParameterEdit']} flushParameterEdit
 * @property {() => void} destroy
 */

/**
 * Builds the pipeline strip into a container and wires its gestures.
 * @param {Object} options - The strip's collaborators.
 * @param {Document} options.doc - Document the strip renders into.
 * @param {HTMLElement} options.container - Element the strip owns.
 * @param {ChainStore} options.store - The chain document store.
 * @param {OperatorCatalog} options.catalog - The operator catalog.
 * @param {(message: string) => void} options.announce - Writes the shared live
 *   status region; refusals report through it, and a committed edit clears it.
 * @param {() => void} options.onApply - Runs after every committed chain edit
 *   (structural replacement, rename, parameter reset), undo/redo and session
 *   bypass toggle.
 * @param {() => string|null} [options.presetId] - The preset the inline stage
 *   controls read and write; null falls back to the document's first.
 * @param {(parameterId: string, value: number|string) => boolean|void} [options.onEditParameter] -
 *   Takes every inline control edit as the document value the store stores: a
 *   number for a binary32 field, the option id for an enum8 one.
 * @param {() => void} [options.onCommitParameter] - Runs once an inline control
 *   edit completes: a slider release, a chosen option, an entered value.
 * @param {() => boolean} [options.bypassAvailable] - Whether a bypass reaches
 *   what is rendering. False disables the toggles and states why.
 * @param {(parameterId: string) => boolean} [options.parameterLive] - Whether a parameter reaches the active build.
 * @param {() => ParameterRange[]} [options.parameterRanges] - Current scalar and enum-index limits from the preview engine.
 * @param {import('./chain_param_rows.js').PresetRowEditor} [options.presetEditor]
 * @returns {ChainStrip} The strip.
 */
export function createChainStrip({
  doc, container, store, catalog, announce, onApply,
  presetId = () => null, onEditParameter = () => {}, onCommitParameter = () => {},
  bypassAvailable = () => true, parameterLive = () => true,
  parameterRanges = () => [], presetEditor,
}) {
  const presentation = createChainPresentation({
    catalog, chain: store.chain, legalSequences: store.legalSequences,
  });
  const {opOf, bandLayout} = presentation;

  const viewState = createStripViewState();
  const {pinnedLabels, drags} = viewState;

  /**
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag - Element tag.
   * @param {string} classes - Class attribute.
   * @returns {HTMLElementTagNameMap[K]} The created element.
   */
  const el = (tag, classes) => {
    const node = doc.createElement(tag);
    node.className = classes;
    return node;
  };

  /**
   * @param {string} selector - Element class selector.
   * @param {string} attribute - Dataset key to match.
   * @param {string} value - Value to match.
   * @returns {HTMLElement|null} The first match.
   */
  const elementBy = (selector, attribute, value) => {
    for (const node of /** @type {NodeListOf<HTMLElement>} */ (container.querySelectorAll(selector))) {
      if (node.dataset[attribute] === value) return node;
    }
    return null;
  };

  /** @param {string} label @returns {HTMLElement|null} The chip carrying the instance. */
  const chipByLabel = (label) => elementBy('.chain-chip', 'label', label);

  /** @param {number} index @returns {HTMLElement|null} The chip at that chain index. */
  const chipAt = (index) => elementBy('.chain-chip', 'index', String(index));

  /**
   * Rebuilds the strip after a committed edit, restores focus, and re-applies
   * the program through the caller.
   * @param {string|null} focusLabel - Chip to hand keyboard focus back to.
   * @param {string|null} [focusControl] - Selector of the chip control to
   *   focus instead of the chip itself.
   * @param {string|null} [focusAction] - Enabled history button to focus.
   * @returns {true} Always true, for tail-calling.
   */
  const commit = (focusLabel, focusControl = null, focusAction = null) => {
    announce('');
    render({ focusLabel, focusControl, focusAction });
    onApply();
    return true;
  };

  /** @type {import('./chain_strip_context.js').StripContext} */
  const context = {
    store, view: viewState, announce, bypassAvailable, parameterLive, presetId, commit,
    get parameterRows() { return parameterRows; },
  };
  const {report, moveChip, removeChip, toggleStage, undo, redo, resetParameters}
    = createStripCommands(context);
  const history = createStripHistory({el, store, undo, redo, bypassAvailable});

  const select = createChainSelection({
    store, pinnedLabels, setFocusedLabel: (label) => { viewState.focusedLabel = label; },
    render: (options) => render(options),
  });

  const wireChipDrag = createChipDrag({
    doc, container, el, focusChip: (index) => focusChip(index), moveChip, drags,
  });

  const paletteController = createChainPalette({
    doc, el, store, presentation, commit, report, announce, pinnedLabels,
  });
  const {close: closePalette, pointerDown} = paletteController;

  /**
   * Moves keyboard focus to the chip at a chain index, updating the roving
   * tabindex.
   * @param {number} index - Target chain index.
   * @returns {void}
   */
  const focusChip = (index) => {
    const chip = chipAt(index);
    if (!chip) return;
    for (const other of container.querySelectorAll('.chain-chip')) {
      other.setAttribute('tabindex', other === chip ? '0' : '-1');
    }
    viewState.focusedLabel = chip.dataset.label ?? null;
    chip.focus();
  };

  const parameterRows = createChainParamRows({
    el, container, store, catalog, opOf, chipByLabel, chipLabel: (entry, bypassed) => chipLabel(presentation, entry, bypassed), parameterLive, parameterRanges,
    onEditParameter, onCommitParameter, presetEditor, render: () => render(), commit, report, pinnedLabels,
  });

  const {buildChip, bandAddButton} = createChipElements({
    context, el, presentation, parameterRows, paletteController, wireChipDrag,
    select, focusChip, report, commit, moveChip, removeChip, toggleStage, resetParameters,
  });

  const {scrollButton, wireViewport} = createChainViewport(el);

  /**
   * Rebuilds the whole strip from the store. Keyboard focus is restored to the
   * named chip (or the chip control matching `focusControl`), or to the
   * roving-tabindex chip when the strip held focus before the rebuild.
   * @param {{focusLabel?: string|null, focusControl?: string|null, focusAction?: string|null}} [options]
   * @returns {void}
   */
  const render = ({ focusLabel = null, focusControl = null, focusAction = null } = {}) => {
    const active = doc.activeElement ?? null;
    const hadFocus = active !== null && container.contains(active);
    const scrolled = Number(
      container.querySelector('.chain-strip-viewport')?.scrollTop ?? 0);
    paletteController.forget();
    for (const drag of drags) drag.remove();
    drags.length = 0;
    const layout = bandLayout();

    const snapshot = store.document();
    viewState.declarations = store.parameterDeclarations();
    const presets = snapshot.preset_bank.presets;
    const preset = presets.find(
      (/** @type {*} */ candidate) => candidate.preset_id === presetId()) ?? presets[0];
    viewState.values = Object.fromEntries(viewState.declarations.map((parameter) =>
      [parameter.id, parameter.default]));
    Object.assign(viewState.values, preset?.values);
    parameterRows.reset(viewState.declarations, viewState.values);

    const chain = store.chain();
    const selected = store.selectedLabel();
    const bypassed = new Set(store.bypassedLabels());
    const labels = chain.map((entry) => entry.label);
    for (const label of pinnedLabels) {
      if (!labels.includes(label)) pinnedLabels.delete(label);
    }
    const tabLabel = focusLabel !== null && labels.includes(focusLabel) ? focusLabel
      : viewState.focusedLabel !== null && labels.includes(viewState.focusedLabel) ? viewState.focusedLabel
      : selected ?? labels[0] ?? null;

    const actions = history.render();

    const strip = el('div', 'chain-strip');
    const pass = { selected, bypassed, tabLabel };
    for (const band of layout) {
      const title = titleCase(band.carrier);
      const element = el('div', 'chain-band');
      element.setAttribute('role', 'group');
      element.setAttribute('aria-label', `${title} stages`);
      element.dataset.carrier = band.carrier;
      const heading = el('div', 'chain-band-title');
      heading.setAttribute('aria-hidden', 'true');
      heading.textContent = title;
      element.appendChild(heading);
      for (const chip of band.chips) {
        element.appendChild(buildChip(chip, chain[chip],
          { crossing: false, ...pass }));
      }
      const add = bandAddButton(band);
      if (add !== null) element.appendChild(add);
      strip.appendChild(element);
      if (band.socket !== null) {
        strip.appendChild(buildChip(band.socket, chain[band.socket],
          { crossing: true, ...pass }));
      }
    }

    const viewport = el('div', 'chain-strip-viewport');
    viewport.setAttribute('tabindex', '0');
    viewport.setAttribute('role', 'group');
    viewport.setAttribute('aria-label', 'Scrollable shader chain');
    viewport.appendChild(strip);
    wireViewport(viewport, closePalette);

    container.replaceChildren(actions, scrollButton(viewport, -1), viewport,
      scrollButton(viewport, 1));
    // Preserve the scroll offset across rebuilds.
    if (scrolled > 0) viewport.scrollTop = scrolled;
    parameterRows.syncParameterRows();

    const action = focusAction === null ? null
      : /** @type {HTMLButtonElement|null} */ (actions.querySelector(focusAction));
    if (action && !action.disabled) {
      action.focus();
      return;
    }
    const target = focusLabel !== null ? chipByLabel(focusLabel) : null;
    if (target) {
      viewState.focusedLabel = focusLabel;
      if (focusControl !== null) {
        const control = /** @type {HTMLElement|null} */ (target.querySelector(focusControl));
        (control ?? target).focus();
      } else {
        target.focus();
      }
    } else if (hadFocus || focusLabel !== null) {
      const fallback = tabLabel !== null ? chipByLabel(tabLabel) : null;
      if (fallback) {
        viewState.focusedLabel = tabLabel;
        fallback.focus();
      }
    }
  };

  // Bound after the first render: a throwing render returns no destroy().
  render();
  container.addEventListener('keydown', history.keydown);
  doc.addEventListener('pointerdown', pointerDown, true);
  const win = doc.defaultView;
  win?.addEventListener('resize', closePalette);

  return {
    render,
    syncParameterRows: parameterRows.syncParameterRows,

    syncParameterValues: parameterRows.syncParameterValues,
    showTransitionValues: parameterRows.showTransitionValues,

    focusParameter(parameterId) {
      const label = labelOf(parameterId);
      if (!pinnedLabels.has(label)) select(label);
      const chip = chipByLabel(label);
      const row = [...(chip?.querySelectorAll('.chain-param') ?? [])]
        .find((entry) => entry.getAttribute('data-parameter') === parameterId);
      const control = /** @type {HTMLElement|null|undefined} */ (
        row?.querySelector('.chain-param-control') ?? chip?.querySelector('.chain-chip-replace') ?? chip);
      control?.scrollIntoView({block: 'nearest'});
      control?.focus();
    },

    syncHistory: history.sync,

    flushParameterEdit: parameterRows.flushParameterEdit,

    /**
     * Detaches the strip's listeners and empties its container.
     * @returns {void}
     */
    destroy() {
      parameterRows.destroy();
      container.removeEventListener('keydown', history.keydown);
      doc.removeEventListener('pointerdown', pointerDown, true);
      win?.removeEventListener('resize', closePalette);
      for (const drag of drags) drag.remove();
      drags.length = 0;
      container.replaceChildren();
    },
  };
}
