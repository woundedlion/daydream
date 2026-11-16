// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {titleCase} from '../../shared/labels.js';
import {BAKED_PARAMETER_REASON} from './chain_param_rows.js';
import {fieldOf, PALETTE_OPERATOR, MODULATION_OPERATOR} from './chain_presentation.js';
import {BYPASS_UNAVAILABLE} from './chain_strip_context.js';

/** @typedef {import('./chain_presentation.js').ChainEntry} ChainEntry */
/** @typedef {import('./chain_presentation.js').BandLayout} BandLayout */

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

/** @param {ReturnType<typeof import('./chain_presentation.js').createChainPresentation>} presentation @param {ChainEntry} entry @param {boolean} bypassed @returns {string} Accessible chip name. */
export const chipLabel = (presentation, entry, bypassed) => {
  const op = presentation.opOf(entry);
  return `${op.name} · ${entry.label}`
    + (op.input !== op.output ? `, ${op.input} to ${op.output}` : '')
    + (bypassed ? ', bypassed' : '');
};

/**
 * Creates chips and band insertion controls.
 * @param {object} deps
 * @param {import('./chain_strip_context.js').StripContext} deps.context
 * @param {import('./chain_row_controls.js').ElementFactory} deps.el
 * @param {ReturnType<typeof import('./chain_presentation.js').createChainPresentation>} deps.presentation
 * @param {ReturnType<typeof import('./chain_param_rows.js').createChainParamRows>} deps.parameterRows
 * @param {ReturnType<typeof import('./chain_palette.js').createChainPalette>} deps.paletteController
 * @param {ReturnType<typeof import('./chain_chip_drag.js').createChipDrag>} deps.wireChipDrag
 * @param {ReturnType<typeof import('./chain_selection.js').createChainSelection>} deps.select
 * @param {(index: number) => void} deps.focusChip
 * @param {import('./chain_strip_commands.js').StripCommands['report']} deps.report
 * @param {import('./chain_strip_context.js').StripContext['commit']} deps.commit
 * @param {import('./chain_strip_commands.js').StripCommands['moveChip']} deps.moveChip
 * @param {import('./chain_strip_commands.js').StripCommands['removeChip']} deps.removeChip
 * @param {import('./chain_strip_commands.js').StripCommands['toggleStage']} deps.toggleStage
 * @param {import('./chain_strip_commands.js').StripCommands['resetParameters']} deps.resetParameters
 */
export function createChipElements({
  context, el, presentation, parameterRows, paletteController, wireChipDrag,
  select, focusChip, report, commit, moveChip, removeChip, toggleStage, resetParameters,
}) {
  const {store, view, bypassAvailable, parameterLive} = context;
  const {pinnedLabels} = view;
  const {opOf, appendGap, choiceEntries, choiceKey, socketChoices, sharesBand} = presentation;
  const {open: openPalette, close: closePalette} = paletteController;
  /**
   * @param {KeyboardEvent} event - A chip's keydown.
   * @param {number} index - The chip's chain index.
   * @param {ChainEntry} entry - The chain entry.
   * @param {boolean} crossing - Whether the operator crosses carriers.
   * @param {HTMLElement} chip - The chip element.
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

  /**
   * @param {number} index - The entry's chain index.
   * @param {ChainEntry} entry - The chain entry.
   * @param {Object} pass - Render-pass state.
   * @param {boolean} pass.crossing - Whether the operator crosses carriers.
   * @param {string|null} pass.selected - The selected label.
   * @param {Set<string>} pass.bypassed - The bypassed labels.
   * @param {string|null} pass.tabLabel - The roving-tabindex label.
   * @returns {HTMLElement} The chip element.
   */
  const buildChip = (index, entry, {
    crossing, selected, bypassed, tabLabel,
  }) => {
    const op = opOf(entry);
    const isSelected = selected === entry.label;
    const isBypassed = bypassed.has(entry.label);
    const declared = view.declarations.filter(
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
    chip.setAttribute('aria-label', chipLabel(presentation, entry, isBypassed));
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
   * @returns {HTMLButtonElement|null} The band's insertion affordance, when a stage fits.
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

  return {buildChip, chipKeydown, bandAddButton};
}
