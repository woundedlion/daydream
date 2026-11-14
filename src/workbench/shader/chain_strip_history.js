// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {BYPASS_UNAVAILABLE} from './chain_strip_context.js';

/**
 * Owns history actions, shortcuts and button state.
 * @param {object} deps
 * @param {import('./chain_row_controls.js').ElementFactory} deps.el
 * @param {import('./chain_document_store.js').ChainStore} deps.store
 * @param {import('./chain_strip_commands.js').StripCommands['undo']} deps.undo
 * @param {import('./chain_strip_commands.js').StripCommands['redo']} deps.redo
 * @param {() => boolean} deps.bypassAvailable
 */
export function createStripHistory({el, store, undo, redo, bypassAvailable}) {
  /** @type {{undo: HTMLButtonElement, redo: HTMLButtonElement}|null} */
  let buttons = null;
  /** @returns {HTMLElement} The history action bar. */
  const render = () => {
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
    buttons = { undo: undoButton, redo: redoButton };
    if (!bypassAvailable()) {
      const note = el('p', 'chain-strip-note');
      note.textContent = BYPASS_UNAVAILABLE;
      actions.appendChild(note);
    }

    return actions;
  };

  /**
   * The container's history shortcut.
   * @param {*} event - A keydown anywhere in the strip.
   * @returns {void}
   */
  const keydown = (event) => {
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
  /** Updates history availability without replacing controls. */
  const sync = () => {
    if (buttons === null) return;
    buttons.undo.disabled = !store.canUndo();
    buttons.redo.disabled = !store.canRedo();
  };
  return {render, keydown, sync};
}
