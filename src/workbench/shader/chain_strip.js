// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createChainPalette} from './chain_palette.js';
import {createChainParamRows, BAKED_PARAMETER_REASON} from './chain_param_rows.js';
import { titleCase } from '../../shared/labels.js';
import {
  createChainPresentation, fieldOf, PALETTE_OPERATOR, MODULATION_OPERATOR,
} from './chain_presentation.js';

import { createFrameScheduler } from '../../shared/page_lifecycle.js';
import { createPointerDrag } from '../../shared/pointer_drag.js';

/**
 * The pipeline strip: the document's operator chain in execution order as chips
 * grouped into one band per editable carrier family, with carrier crossings as
 * socket chips on band boundaries. Structural gestures commit through the
 * store's span replacement; the strip is rebuilt whole after every committed
 * edit. Each chip carries its stage's controls inline.
 */

/** @typedef {import('./chain_presentation.js').CatalogOperator} CatalogOperator */
/** @typedef {import('./chain_presentation.js').OperatorCatalog} OperatorCatalog */
/** @typedef {import('./chain_presentation.js').ChainEntry} ChainEntry */
/** @typedef {import('./chain_presentation.js').LegalityEntry} LegalityEntry */
/** @typedef {import('./chain_presentation.js').SequenceEntry} SequenceEntry */
/** @typedef {import('./chain_presentation.js').SpanChoice} SpanChoice */
/** @typedef {import('./chain_document_store.js').ParameterDeclaration} ParameterDeclaration */
/** @typedef {{name: string, min: number, max: number}} ParameterRange */
/** @typedef {import('./chain_presentation.js').BandLayout} BandLayout */

/** @typedef {import('./chain_document_store.js').EditResult} EditResult */
/**
 * The document-store surface the strip drives. Legality queries throw RangeError
 * for invalid indices; mutation methods return EditResult refusals.
 * @typedef {{
 *   chain: () => ChainEntry[],
 *   selectedLabel: () => string|null,
 *   declares: (id: string) => boolean,
 *   setSelectedLabel: (label: string|null) => boolean,
 *   bypassedLabels: () => string[],
 *   setBypassed: (label: string, on: boolean) => EditResult,
 *   legalInsertions: (index: number) => LegalityEntry[],
 *   legalSequences: (start: number, deleteCount: number,
 *     maxLength: number) => SequenceEntry[],
 *   parameterDeclarations: () => ParameterDeclaration[],
 *   document: () => *,
 *   replaceSpan: (start: number, deleteCount: number,
 *     sequence: Array<{label?: string, operator: string}>) => EditResult,
 *   relabel: (oldLabel: string, newLabel: string) => EditResult,
 *   endValueRun: () => void,
 *   setPresetValues: (presetId: string, values: Object<string, *>) => EditResult,
 *   undo: () => boolean, redo: () => boolean,
 *   canUndo: () => boolean, canRedo: () => boolean,
 * }} ChainStore
 */
const BYPASS_UNAVAILABLE = 'Bypass applies to the interpreter only: '
  + 'the compiled build renders the whole chain.';

const MIN_SCROLL_STEP = 160;
const SCROLL_STEP_RATIO = 0.75;
const DRAG_SLOP_PX = 5;
const DRAG_SCROLL_EDGE_PX = 24;

// Pixels one WheelEvent.DOM_DELTA_LINE notch stands for.
const WHEEL_LINE_PX = 16;

/**
 * A socket's function name, by the carrier the crossing produces.
 * @type {Record<string, {name: string, accessibleName: string}>}
 */
const SOCKET_FUNCTIONS = {
  plane: { name: 'Projection', accessibleName: 'Projection' },
  field: { name: 'Source', accessibleName: 'Source function' },
  color: { name: 'Palette', accessibleName: 'Palette' },
};

/** @type {Record<string, string>} */
const SOURCE_GROUP_NAMES = { sphere: 'Spherical sources', plane: 'Planar sources' };

/**
 * Builds the pipeline strip into a container and wires its gestures.
 * @param {Object} options - The strip's collaborators.
 * @param {*} options.doc - Document the strip renders into.
 * @param {*} options.container - Element the strip owns.
 * @param {ChainStore} options.store - The chain document store.
 * @param {OperatorCatalog} options.catalog - The operator catalog.
 * @param {(message: string) => void} options.announce - Writes the shared live
 *   status region; refusals report through it, and a committed edit clears it.
 * @param {() => void} options.onApply - Runs after every committed chain edit
 *   (structural replacement, rename, parameter reset), undo/redo and session
 *   bypass toggle.
 * @param {() => string|null} [options.presetId] - The preset the inline stage
 *   controls read and write; null falls back to the document's first.
 * @param {(parameterId: string, value: *) => boolean|void} [options.onEditParameter] -
 *   Takes every inline control edit as the document value the store stores: a
 *   number for a binary32 field, the option id for an enum8 one.
 * @param {() => void} [options.onCommitParameter] - Runs once an inline control
 *   edit completes: a slider release, a chosen option, an entered value.
 * @param {() => boolean} [options.bypassAvailable] - Whether a bypass reaches
 *   what is rendering. False disables the toggles and states why.
 * @param {(parameterId: string) => boolean} [options.parameterLive] - Whether a parameter reaches the active build.
 * @param {() => ParameterRange[]} [options.parameterRanges] - Current scalar and enum-index limits from the preview engine.
 * @returns {Object} The strip.
 */
export function createChainStrip({
  doc, container, store, catalog, announce, onApply,
  presetId = () => null, onEditParameter = () => {}, onCommitParameter = () => {},
  bypassAvailable = () => true, parameterLive = () => true,
  parameterRanges = () => [],
}) {
  const presentation = createChainPresentation({
    catalog, chain: store.chain, legalSequences: store.legalSequences,
  });
  const {opOf, bandLayout, appendGap, choiceEntries, choiceKey, socketChoices, sharesBand} = presentation;

  /** @type {string|null} Roving-tabindex position, by instance label. */
  let focusedLabel = null;
  /** @type {{undo: *, redo: *}|null} The current render's history buttons. */
  let history = null;
  /** @type {ParameterDeclaration[]} The current render's declarations. */
  let declarations = [];
  /** @type {Object<string, *>} The values the inline controls show. */
  let values = {};
  /** @type {Set<string>} */
  const pinnedLabels = new Set();
  /** @type {Array<{remove: () => void}>} */
  const drags = [];

  /**
   * @param {string} tag - Element tag.
   * @param {string} classes - Class attribute.
   * @returns {*} The created element.
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
   * @returns {*|null} The first match.
   */
  const elementBy = (selector, attribute, value) => {
    for (const node of container.querySelectorAll(selector)) {
      if (node.dataset[attribute] === value) return node;
    }
    return null;
  };

  /** @param {string} label @returns {*|null} The chip carrying the instance. */
  const chipByLabel = (label) => elementBy('.chain-chip', 'label', label);

  /** @param {number} index @returns {*|null} The chip at that chain index. */
  const chipAt = (index) => elementBy('.chain-chip', 'index', String(index));

  /** @param {ChainEntry} entry @param {boolean} bypassed @returns {string} Accessible chip name. */
  const chipLabel = (entry, bypassed) => {
    const op = opOf(entry);
    return `${op.name} · ${entry.label}`
      + (op.input !== op.output ? `, ${op.input} to ${op.output}` : '')
      + (bypassed ? ', bypassed' : '');
  };

  /**
   * Surfaces a store refusal in the shared live region.
   * @param {EditResult} result - The refused edit.
   * @returns {false} Always false, for tail-calling.
   */
  const report = (result) => {
    if (result.ok === false) {
      announce(result.diagnostics[0]?.message ?? 'the edit was refused');
    }
    return false;
  };

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

  /**
   * Toggles a chip's pin and selection and re-renders.
   * @param {string} label - The instance label.
   * @returns {void}
   */
  const select = (label) => {
    const open = !pinnedLabels.has(label);
    const selected = open ? label : store.selectedLabel() === label ? null : store.selectedLabel();
    if (!store.setSelectedLabel(selected)) return;
    if (selected !== null) focusedLabel = selected;
    if (open) pinnedLabels.add(label);
    else pinnedLabels.delete(label);
    render({ focusLabel: label });
  };

  /**
   * Moves the chip at one chain index to a gap, as the m-for-m span replacement
   * that keeps every label (and so every parameter value).
   * @param {number} index - The chip's chain index.
   * @param {number} gap - Target gap, 0..chain length.
   * @returns {boolean} Whether the move committed.
   */
  const moveChip = (index, gap) => {
    const chain = store.chain();
    if (gap < 0 || gap > chain.length) return false;
    if (gap === index || gap === index + 1) return true;
    const entry = chain[index];
    const result = gap < index
      ? store.replaceSpan(gap, index - gap + 1, [entry, ...chain.slice(gap, index)])
      : store.replaceSpan(index, gap - index, [...chain.slice(index + 1, gap), entry]);
    if (!result.ok) return report(result);
    return commit(entry.label);
  };

  /**
   * @param {*} chip - The movable chip.
   * @param {*} header - Its drag surface.
   * @param {number} index - The chip's chain index.
   * @param {string|null} name - The stage name shown while dragging.
   * @returns {() => boolean} Whether a completed drag consumes the next click.
   */
  const wireChipDrag = (chip, header, index, name) => {
    let originX = 0;
    let originY = 0;
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let suppressClick = false;
    /** @type {PointerEvent|null} */
    let lastPointer = null;
    /** @type {*|null} */
    let preview = null;
    /** @type {*|null} */
    let marker = null;

    const clearMarker = () => {
      marker?.classList.remove('chain-chip--drop-before', 'chain-chip--drop-after');
      marker = null;
    };
    const clear = () => {
      scrollFrame.cancel();
      lastPointer = null;
      clearMarker();
      preview?.remove();
      preview = null;
      dragging = false;
      chip.classList.remove('chain-chip--dragging');
    };
    const dropGap = (/** @type {PointerEvent} */ event) => {
      clearMarker();
      const band = chip.parentNode;
      const bounds = band.getBoundingClientRect();
      const viewport = container.querySelector('.chain-strip-viewport').getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < Math.max(bounds.top, viewport.top)
          || event.clientY > Math.min(bounds.bottom, viewport.bottom)) return null;
      const siblings = [...band.querySelectorAll('.chain-chip')];
      const before = siblings.find((other) => {
        const rect = other.getBoundingClientRect();
        return event.clientY < rect.top + rect.height / 2;
      });
      const target = before ?? siblings[siblings.length - 1];
      const gap = Number(target.dataset.index) + (before ? 0 : 1);
      if (gap === index || gap === index + 1) return null;
      marker = target;
      marker.classList.add(before ? 'chain-chip--drop-before' : 'chain-chip--drop-after');
      return gap;
    };
    const scrollViewport = (/** @type {PointerEvent} */ event) => {
      const viewport = container.querySelector('.chain-strip-viewport');
      const bounds = viewport.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right) return false;
      const direction = event.clientY < bounds.top + DRAG_SCROLL_EDGE_PX ? -1
        : event.clientY > bounds.bottom - DRAG_SCROLL_EDGE_PX ? 1 : 0;
      const before = viewport.scrollTop;
      viewport.scrollTop = Math.max(0, Math.min(
        viewport.scrollHeight - viewport.clientHeight,
        before + direction * DRAG_SCROLL_EDGE_PX));
      return viewport.scrollTop !== before;
    };
    const scrollFrame = createFrameScheduler(() => {
      if (lastPointer === null || !scrollViewport(lastPointer)) return;
      dropGap(lastPointer);
      scrollFrame();
    });
    const drag = createPointerDrag({
      element: header,
      onStart(event) {
        suppressClick = false;
        const target = /** @type {Element} */ (event.target);
        if (target.closest('button, input, select, textarea, label, a')) return false;
        originX = event.clientX;
        originY = event.clientY;
        const rect = header.getBoundingClientRect();
        offsetX = originX - rect.left;
        offsetY = originY - rect.top;
        return true;
      },
      onMove(event) {
        if (!dragging) {
          if (Math.hypot(event.clientX - originX, event.clientY - originY) < DRAG_SLOP_PX) return;
          dragging = true;
          suppressClick = true;
          focusChip(index);
          chip.classList.add('chain-chip--dragging');
          preview = el('div', 'chain-drag-preview');
          preview.setAttribute('aria-hidden', 'true');
          preview.textContent = name;
          preview.style.width = `${header.getBoundingClientRect().width}px`;
          doc.body.appendChild(preview);
        }
        preview.style.left = `${event.clientX - offsetX}px`;
        preview.style.top = `${event.clientY - offsetY}px`;
        lastPointer = event;
        if (scrollViewport(event)) scrollFrame();
        dropGap(event);
      },
      onEnd(event) {
        if (!dragging) return;
        const gap = event === null ? null : dropGap(event);
        clear();
        if (gap !== null) moveChip(index, gap);
      },
      onCancel: clear,
    });
    const cancelKeydown = (/** @type {*} */ event) => {
      if (event.key !== 'Escape' || !dragging) return;
      event.preventDefault();
      drag.stop();
    };
    chip.addEventListener('keydown', cancelKeydown);
    drags.push({ remove() {
      chip.removeEventListener('keydown', cancelKeydown);
      drag.remove();
    } });
    return () => {
      const consumed = suppressClick;
      suppressClick = false;
      return consumed;
    };
  };

  /**
   * Removes one endomorphism, the empty span replacement legality makes
   * automatic. Focus lands on whatever fills the vacated position.
   * @param {number} index - The chip's chain index.
   * @returns {boolean} Whether the removal committed.
   */
  const removeChip = (index) => {
    const result = store.replaceSpan(index, 1, []);
    if (!result.ok) return report(result);
    const after = store.chain();
    return commit(after[index]?.label ?? after[index - 1]?.label ?? null);
  };

  /**
   * Toggles a modulation's authored enabled state or another stage's session bypass.
   * @param {string} label - The instance label.
   * @param {string|null} [focusControl] - Header control to retain after a pointer toggle.
   * @returns {void}
   */
  const toggleStage = (label, focusControl = null) => {
    if (store.chain().find((entry) => entry.label === label)?.operator === MODULATION_OPERATOR) {
      const id = `${label}.modulation-enabled`;
      if (!parameterLive(id)) {
        announce(BAKED_PARAMETER_REASON);
        return;
      }
      parameterRows.editParameter(id, values[id] === 'disabled' ? 'enabled' : 'disabled');
      store.endValueRun();
      parameterRows.commitParameter();
      return;
    }
    if (!bypassAvailable()) {
      announce(BYPASS_UNAVAILABLE);
      return;
    }
    const on = !store.bypassedLabels().includes(label);
    const result = store.setBypassed(label, on);
    if (!result.ok) {
      report(result);
      return;
    }
    commit(label, focusControl);
  };

  /** @param {string|null} [focusAction] */
  const undo = (focusAction = null) => {
    if (!store.undo()) return false;
    return commit(focusedLabel, null, focusAction);
  };

  /** @param {string} label - The instance whose editable parameters reset. */
  const resetParameters = (label) => {
    parameterRows.flushParameterEdit();
    const defaults = Object.fromEntries(declarations
      .filter((parameter) => parameter.id.startsWith(`${label}.`) && store.declares(parameter.id) && parameterLive(parameter.id))
      .map((parameter) => [parameter.id, parameter.default]));
    if (Object.keys(defaults).length === 0
        || Object.entries(defaults).every(([id, value]) => values[id] === value)) return;
    const targetPreset = presetId() ?? store.document().preset_bank.presets[0]?.preset_id;
    if (!targetPreset) return;
    store.endValueRun();
    const result = store.setPresetValues(targetPreset, defaults);
    store.endValueRun();
    if (!result.ok) {
      report(result);
      return;
    }
    commit(label, '.chain-chip-reset');
    parameterRows.commitParameter();
  };

  /** @param {string|null} [focusAction] */
  const redo = (focusAction = null) => {
    if (!store.redo()) return false;
    return commit(focusedLabel, null, focusAction);
  };

  const paletteController = createChainPalette({
    doc, el, store, presentation, commit, report, announce, pinnedLabels,
  });
  const {open: openPalette, close: closePalette, pointerDown} = paletteController;

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
    focusedLabel = chip.dataset.label ?? null;
    chip.focus();
  };

  /**
   * @param {*} event - A chip's keydown.
   * @param {number} index - The chip's chain index.
   * @param {ChainEntry} entry - The chain entry.
   * @param {boolean} crossing - Whether the operator crosses carriers.
   * @param {*} chip - The chip element.
   * @returns {void}
   */
  const chipKeydown = (event, index, entry, crossing, chip) => {
    const inside = event.target !== chip;
    if (inside) return;
    const key = event.key;
    if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(key)) {
      event.preventDefault();
      const forward = key === 'ArrowDown' || key === 'ArrowRight';
      if (!event.altKey) {
        focusChip(forward ? index + 1 : index - 1);
        return;
      }
      // A crossing has no reorder, and a band edge has no neighbour to swap with.
      if (crossing || !sharesBand(index, forward ? 1 : -1)) return;
      moveChip(index, forward ? index + 2 : index - 1);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      select(entry.label);
      return;
    }
    if ((key === 'b' || key === 'B')
      && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!crossing) toggleStage(entry.label);
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      if (crossing) openPalette({ kind: 'replace', index, anchor: chip });
      else removeChip(index);
      return;
    }
    if (key === 'Insert') {
      event.preventDefault();
      openPalette({ kind: 'insert', index: index + 1, anchor: chip });
    }
  };

  const parameterRows = createChainParamRows({
    el, container, store, catalog, opOf, chipByLabel, chipLabel, parameterLive, parameterRanges,
    onEditParameter, onCommitParameter, render: () => render(), commit, report, pinnedLabels,
  });

  /**
   * @param {number} index - The entry's chain index.
   * @param {ChainEntry} entry - The chain entry.
   * @param {Object} view - Render-pass state.
   * @param {boolean} view.crossing - Whether the operator crosses carriers.
   * @param {string|null} view.selected - The selected label.
   * @param {Set<string>} view.bypassed - The bypassed labels.
   * @param {string|null} view.tabLabel - The roving-tabindex label.
   * @returns {*} The chip element.
   */
  const chipElement = (index, entry, {
    crossing, selected, bypassed, tabLabel,
  }) => {
    const op = opOf(entry);
    const isSelected = selected === entry.label;
    const isBypassed = bypassed.has(entry.label);
    const declared = declarations.filter(
      (declaration) => declaration.id.startsWith(`${entry.label}.`));
    const expanded = pinnedLabels.has(entry.label);
    const chip = el('div', 'chain-chip'
      + (crossing ? ' chain-chip--socket' : ' chain-chip--stage')
      + (expanded ? ' chain-chip--expanded' : '')
      + (isBypassed ? ' chain-chip--bypassed' : ''));
    chip.dataset.label = entry.label;
    chip.dataset.index = String(index);
    // Not role=option: an option's children are presentational to assistive technology.
    chip.setAttribute('role', 'group');
    if (isSelected) chip.setAttribute('aria-current', 'true');
    chip.setAttribute('tabindex', tabLabel === entry.label ? '0' : '-1');
    chip.setAttribute('aria-keyshortcuts',
      crossing ? 'ArrowUp ArrowDown ArrowLeft ArrowRight Enter Space Delete Backspace Insert'
        : 'ArrowUp ArrowDown Alt+ArrowUp Alt+ArrowDown ArrowLeft ArrowRight Alt+ArrowLeft Alt+ArrowRight Enter Space b Delete Backspace Insert');
    chip.setAttribute('aria-label', chipLabel(entry, isBypassed));
    const header = el('div', 'chain-chip-header');

    if (crossing) {
      const functionLabel = el('label', 'chain-chip-function-label');
      const socketFunction = SOCKET_FUNCTIONS[op.output] ?? {
        name: titleCase(op.output),
        accessibleName: `${titleCase(op.output)} function`,
      };
      functionLabel.textContent = `${socketFunction.name}: `;
      const paletteType = entry.operator === PALETTE_OPERATOR
        ? declared.find((parameter) => fieldOf(parameter.id) === 'palette-type') : undefined;
      const replacement = paletteType ? parameterRows.enumControl(paletteType) : el('select', 'chain-chip-replace');
      if (paletteType) {
        replacement.classList.remove('chain-param-control');
        replacement.classList.add('chain-chip-replace', 'chain-palette-type');
        replacement.dataset.parameter = paletteType.id;
      }
      replacement.setAttribute('tabindex', '0');
      replacement.setAttribute('aria-label', socketFunction.accessibleName);
      const choices = new Map(socketChoices(index).map(
        (choice) => [choiceKey(choice.operators), choice]));
      const sourceGroups = new Map();
      for (const [key, choice] of paletteType ? [] : choices) {
        const option = el('option', 'chain-chip-replace-option');
        option.value = key;
        option.textContent = choice.operators.map((candidate) => candidate.name)
          .join(' → ');
        option.selected = key === entry.operator;
        const source = choice.operators.at(-1);
        const groupName = op.output === 'field'
          ? SOURCE_GROUP_NAMES[source?.input ?? ''] : undefined;
        let parent = replacement;
        if (groupName) {
          if (!sourceGroups.has(groupName)) {
            const group = el('optgroup', '');
            group.label = groupName;
            sourceGroups.set(groupName, group);
            replacement.appendChild(group);
          }
          parent = sourceGroups.get(groupName);
        }
        parent.appendChild(option);
      }
      replacement.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
      });
      replacement.addEventListener('change', (/** @type {*} */ event) => {
        event.stopPropagation();
        if (paletteType) return;
        const choice = choices.get(event.target.value);
        if (choice === undefined) return;
        const result = store.replaceSpan(choice.start, choice.deleteCount,
          choiceEntries(choice));
        if (!result.ok) {
          event.target.value = entry.operator;
          report(result);
          return;
        }
        commit(store.chain()[choice.start]?.label ?? null, '.chain-chip-replace');
      });
      functionLabel.appendChild(replacement);
      header.appendChild(functionLabel);
    } else {
      const name = el('span', 'chain-chip-name');
      name.textContent = op.name;
      header.appendChild(name);
      const toggle = el('button', 'chain-chip-bypass');
      const modulation = entry.operator === MODULATION_OPERATOR;
      const bypassable = modulation ? parameterLive(`${entry.label}.modulation-enabled`) : bypassAvailable();
      if (modulation) {
        toggle.classList.add('chain-modulation-enabled');
        toggle.dataset.label = entry.label;
      }
      toggle.type = 'button';
      toggle.setAttribute('tabindex', '0');
      toggle.disabled = !bypassable;
      toggle.setAttribute('aria-pressed', String(isBypassed));
      toggle.setAttribute('aria-label', `Bypass ${op.name} · ${entry.label}`);
      toggle.setAttribute('title', bypassable ? 'Bypass'
        : modulation ? BAKED_PARAMETER_REASON : BYPASS_UNAVAILABLE);
      toggle.textContent = '◉';
      toggle.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
        toggleStage(entry.label, '.chain-chip-bypass');
      });
      header.appendChild(toggle);
    }

    const reset = el('button', 'chain-chip-reset');
    reset.type = 'button';
    reset.disabled = !declared.some((parameter) => parameterLive(parameter.id));
    reset.setAttribute('aria-label', `Reset ${op.name} · ${entry.label} parameters to defaults`);
    reset.setAttribute('title', reset.disabled ? 'No editable parameters' : 'Reset parameters to defaults');
    const resetIcon = el('span', 'chain-chip-reset-icon');
    resetIcon.setAttribute('aria-hidden', 'true');
    reset.appendChild(resetIcon);
    reset.addEventListener('click', (/** @type {*} */ event) => {
      event.stopPropagation();
      resetParameters(entry.label);
    });
    header.appendChild(reset);

    const pin = el('button', 'chain-chip-pin');
    pin.type = 'button';
    const pinIcon = el('span', 'chain-chip-pin-icon');
    pinIcon.setAttribute('aria-hidden', 'true');
    pin.appendChild(pinIcon);
    const syncPin = () => {
      const pinned = pinnedLabels.has(entry.label);
      pin.setAttribute('aria-pressed', String(pinned));
      pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${op.name} · ${entry.label}`);
      pin.setAttribute('title', pinned ? 'Unpin panel' : 'Pin panel');
    };
    syncPin();
    pin.addEventListener('click', (/** @type {*} */ event) => {
      event.stopPropagation();
      if (!pinnedLabels.delete(entry.label)) pinnedLabels.add(entry.label);
      syncPin();
      chip.classList.toggle('chain-chip--expanded', pinnedLabels.has(entry.label));
      parameterRows.syncParameterRows();
    });
    header.appendChild(pin);
    if (!crossing) {
      const remove = el('button', 'chain-chip-remove');
      remove.type = 'button';
      remove.setAttribute('tabindex', '0');
      remove.setAttribute('aria-label', `Remove ${op.name} · ${entry.label}`);
      remove.setAttribute('title', 'Delete');
      remove.textContent = '×';
      remove.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
        removeChip(index);
      });
      header.appendChild(remove);
    }
    chip.appendChild(header);
    chip.appendChild(parameterRows.paramsElement(entry, declared));

    const movable = !crossing && (sharesBand(index, -1) || sharesBand(index, 1));
    header.classList.toggle('chain-chip-header--draggable', movable);
    const consumeDragClick = movable ? wireChipDrag(chip, header, index, op.name) : () => false;
    chip.addEventListener('click', (/** @type {*} */ event) => {
      const clickedHeader = event.target === chip
        || event.target?.closest?.('.chain-chip-header') === header;
      if (clickedHeader && consumeDragClick()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (clickedHeader) select(entry.label);
    });
    chip.addEventListener('keydown', (/** @type {*} */ event) => {
      chipKeydown(event, index, entry, crossing, chip);
    });
    return chip;
  };

  /**
   * @param {BandLayout} band - The band the button belongs to.
   * @returns {*|null} The band's insertion affordance, when a stage fits.
   */
  const bandAddButton = (band) => {
    const title = titleCase(band.carrier);
    const gap = appendGap(band);
    if (gap === null) return null;
    const choices = store.legalInsertions(gap).filter((entry) => entry.legal);
    if (choices.length === 0) return null;
    const add = el('button', 'chain-band-add');
    add.type = 'button';
    add.setAttribute('aria-label', `Add a ${title} stage`);
    add.textContent = '+';
    if (choices.length === 1) {
      add.addEventListener('click', () => {
        const result = store.replaceSpan(gap, 0, [{operator: choices[0].operator.id}]);
        if (!result.ok) { report(result); return; }
        const label = store.chain()[gap].label;
        store.setSelectedLabel(label);
        pinnedLabels.add(label);
        commit(label);
      });
      return add;
    }
    add.setAttribute('aria-haspopup', 'listbox');
    add.setAttribute('aria-expanded', 'false');
    /** @type {boolean|null} */
    let openOnPointerDown = null;
    add.addEventListener('pointerdown', () => { openOnPointerDown = paletteController.anchor() === add; });
    add.addEventListener('click', () => {
      const wasOpen = openOnPointerDown ?? (paletteController.anchor() === add);
      openOnPointerDown = null;
      if (wasOpen) closePalette();
      else openPalette({ kind: 'insert', index: gap, anchor: add });
    });
    return add;
  };

  /** @param {*} viewport @param {number} direction */
  const scrollPipeline = (viewport, direction) => {
    const distance = Math.max(MIN_SCROLL_STEP,
      Number(viewport.clientHeight ?? 0) * SCROLL_STEP_RATIO);
    viewport.scrollTop = Math.max(0,
      Number(viewport.scrollTop ?? 0) + direction * distance);
  };

  /** @param {*} viewport @param {number} direction @returns {*} */
  const scrollButton = (viewport, direction) => {
    const button = el('button', 'chain-scroll-button');
    button.type = 'button';
    button.setAttribute('aria-label', direction < 0
      ? 'Scroll shader chain up' : 'Scroll shader chain down');
    const icon = el('span', direction < 0
      ? 'chain-scroll-icon chain-scroll-icon--up' : 'chain-scroll-icon');
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    button.addEventListener('click', () => scrollPipeline(viewport, direction));
    return button;
  };

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
    declarations = store.parameterDeclarations();
    const presets = snapshot.preset_bank.presets;
    const preset = presets.find(
      (/** @type {*} */ candidate) => candidate.preset_id === presetId()) ?? presets[0];
    values = Object.fromEntries(declarations.map((parameter) =>
      [parameter.id, parameter.default]));
    Object.assign(values, preset?.values);
    parameterRows.reset(declarations, values);

    const chain = store.chain();
    const selected = store.selectedLabel();
    const bypassed = new Set(store.bypassedLabels());
    const labels = chain.map((entry) => entry.label);
    for (const label of pinnedLabels) {
      if (!labels.includes(label)) pinnedLabels.delete(label);
    }
    const tabLabel = focusLabel !== null && labels.includes(focusLabel) ? focusLabel
      : focusedLabel !== null && labels.includes(focusedLabel) ? focusedLabel
      : selected ?? labels[0] ?? null;

    const actions = el('div', 'chain-strip-actions');
    const undoButton = el('button', 'chain-undo');
    undoButton.type = 'button';
    undoButton.textContent = 'Undo';
    undoButton.disabled = !store.canUndo();
    undoButton.addEventListener('click', () => undo('.chain-undo'));
    const redoButton = el('button', 'chain-redo');
    redoButton.type = 'button';
    redoButton.textContent = 'Redo';
    redoButton.disabled = !store.canRedo();
    redoButton.addEventListener('click', () => redo('.chain-redo'));
    actions.appendChild(undoButton);
    actions.appendChild(redoButton);
    history = { undo: undoButton, redo: redoButton };
    if (!bypassAvailable()) {
      const note = el('p', 'chain-strip-note');
      note.textContent = BYPASS_UNAVAILABLE;
      actions.appendChild(note);
    }

    const strip = el('div', 'chain-strip');
    const view = { selected, bypassed, tabLabel };
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
        element.appendChild(chipElement(chip, chain[chip],
          { crossing: false, ...view }));
      }
      const add = bandAddButton(band);
      if (add !== null) element.appendChild(add);
      strip.appendChild(element);
      if (band.socket !== null) {
        strip.appendChild(chipElement(band.socket, chain[band.socket],
          { crossing: true, ...view }));
      }
    }

    const viewport = el('div', 'chain-strip-viewport');
    viewport.setAttribute('tabindex', '0');
    viewport.setAttribute('role', 'group');
    viewport.setAttribute('aria-label', 'Scrollable shader chain');
    viewport.appendChild(strip);
    viewport.addEventListener('wheel', (/** @type {*} */ event) => {
      if (event.target?.closest?.('.chain-palette')) return;
      const delta = event.deltaY;
      if (delta === 0) return;
      const height = Number(viewport.clientHeight ?? 0);
      const overflow = Number(viewport.scrollHeight ?? 0) - height;
      if (overflow <= 0) return;
      closePalette();
      // deltaMode counts pixels, lines or pages.
      const scale = event.deltaMode === 1 ? WHEEL_LINE_PX
        : event.deltaMode === 2 ? Math.max(MIN_SCROLL_STEP, height) : 1;
      viewport.scrollTop = Math.min(overflow,
        Math.max(0, Number(viewport.scrollTop ?? 0) + delta * scale));
      event.preventDefault();
    }, { passive: false });
    viewport.addEventListener('keydown', (/** @type {*} */ event) => {
      if (event.target !== viewport
        || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      scrollPipeline(viewport, event.key === 'ArrowUp' ? -1 : 1);
    });

    container.replaceChildren(actions, scrollButton(viewport, -1), viewport,
      scrollButton(viewport, 1));
    // Preserve the scroll offset across rebuilds.
    if (scrolled > 0) viewport.scrollTop = scrolled;
    parameterRows.syncParameterRows();

    const action = focusAction === null ? null : actions.querySelector(focusAction);
    if (action && !action.disabled) {
      action.focus();
      return;
    }
    const target = focusLabel !== null ? chipByLabel(focusLabel) : null;
    if (target) {
      focusedLabel = focusLabel;
      if (focusControl !== null) {
        const control = target.querySelector(focusControl);
        (control ?? target).focus();
      } else {
        target.focus();
      }
    } else if (hadFocus || focusLabel !== null) {
      const fallback = tabLabel !== null ? chipByLabel(tabLabel) : null;
      if (fallback) {
        focusedLabel = tabLabel;
        fallback.focus();
      }
    }
  };

  /**
   * The container's history shortcut.
   * @param {*} event - A keydown anywhere in the strip.
   * @returns {void}
   */
  const historyKeydown = (event) => {
    const target = event.target;
    if (target?.isContentEditable ||
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName)) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      redo();
    }
  };
  // Bound after the first render: a throwing render returns no destroy().
  render();
  container.addEventListener('keydown', historyKeydown);
  doc.addEventListener('pointerdown', pointerDown, true);
  const view = doc.defaultView;
  view?.addEventListener('resize', closePalette);

  return {
    render,
    syncParameterRows: parameterRows.syncParameterRows,

    syncParameterValues: parameterRows.syncParameterValues,

    /**
     * Repaints the Undo/Redo buttons without a rebuild, which would replace the
     * control under a dragging pointer.
     * @returns {void}
     */
    syncHistory() {
      if (history === null) return;
      history.undo.disabled = !store.canUndo();
      history.redo.disabled = !store.canRedo();
    },

    flushParameterEdit: parameterRows.flushParameterEdit,

    /**
     * Detaches the strip's listeners and empties its container.
     * @returns {void}
     */
    destroy() {
      parameterRows.destroy();
      container.removeEventListener('keydown', historyKeydown);
      doc.removeEventListener('pointerdown', pointerDown, true);
      view?.removeEventListener('resize', closePalette);
      for (const drag of drags) drag.remove();
      drags.length = 0;
      container.replaceChildren();
    },
  };
}
