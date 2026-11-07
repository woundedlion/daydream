/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {{title?: unknown, thumb?: unknown, stats?: unknown, desc?: unknown}} SavedCardItem */
/** @template T
 * @typedef {{restore: (item: T) => void, remove: (index: number) => void,
 * copy: (index: number, kind: string, button: HTMLButtonElement) => void,
 * explain: (message: string) => void}} SavedCardHandlers */

/**
 * Builds one saved-solid card with text-only metadata and injected actions.
 * @template {SavedCardItem} T
 * @param {T} item - Persisted card metadata.
 * @param {number} index - Position in the saved list.
 * @param {Object} options
 * @param {number} options.count - Number of saved cards.
 * @param {string|null} options.funcName - Exported function name, when available.
 * @param {string} options.clashMessage - Collision explanation, or empty text.
 * @param {boolean} options.canRestore - Whether the engine is available.
 * @param {SavedCardHandlers<T>} options.on - Card actions.
 * @param {Document} [options.doc] - Document creating the card nodes.
 * @returns {HTMLDivElement} The card.
 */
export function buildSavedCard(item, index, {
  count, funcName, clashMessage, canRestore, on, doc = document,
}) {
  const el = doc.createElement('div');
  el.className = 'saved-item relative pr-6';
  const cardName = `${funcName ?? item.title} (card ${count - index})`;
  if (clashMessage) {
    el.classList.add('name-clash');
    el.title = clashMessage;
    const warning = doc.createElement('button');
    warning.type = 'button';
    warning.className = 'saved-clash-btn text-amber-400';
    warning.textContent = '!';
    warning.setAttribute('aria-label', clashMessage);
    warning.addEventListener('click', () => on.explain(clashMessage));
    el.appendChild(warning);
  }
  const deleteButton = doc.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'action-btn del-btn absolute top-2 right-2 flex items-center justify-center w-5 h-5 text-sm';
  deleteButton.textContent = '×';

  const restoreButton = doc.createElement('button');
  restoreButton.type = 'button';
  restoreButton.className = 'saved-restore';
  restoreButton.disabled = !canRestore;
  const image = doc.createElement('img');
  if (typeof item.thumb === 'string' && item.thumb.startsWith('data:image/')) image.src = item.thumb;
  image.alt = '';
  const summary = doc.createElement('span');
  summary.className = 'flex justify-between items-start mt-1';
  const title = doc.createElement('span');
  title.className = 'title capitalize';
  title.textContent = String(item.title ?? '');
  const stats = doc.createElement('span');
  stats.className = 'saved-stats text-[0.55rem] font-mono';
  stats.textContent = String(item.stats ?? '');
  summary.append(title, stats);
  const details = doc.createElement('span');
  details.className = 'details block uppercase';
  details.textContent = String(item.desc ?? '');
  restoreButton.append(image, summary, details);

  const actions = doc.createElement('div');
  actions.className = 'saved-actions';
  const actionStack = doc.createElement('div');
  actionStack.className = 'flex flex-col gap-1 w-full';
  for (const [label, kind, ariaLabel] of [
    ['Recipe', 'recipe_cpp', 'Copy recipe C++'],
    ['Registry', 'registry', 'Copy registry C++'],
  ]) {
    const row = doc.createElement('div');
    row.className = 'flex gap-1 justify-end';
    const rowLabel = doc.createElement('span');
    rowLabel.className = 'saved-row-label text-[0.5rem] uppercase font-bold self-center mr-1';
    rowLabel.textContent = label;
    const copyButton = doc.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'action-btn';
    copyButton.dataset.copy = kind;
    copyButton.setAttribute('aria-label', `${ariaLabel} for ${cardName}`);
    copyButton.textContent = 'C++';
    copyButton.addEventListener('click', () => on.copy(index, kind, copyButton));
    row.append(rowLabel, copyButton);
    actionStack.appendChild(row);
  }
  actions.appendChild(actionStack);
  el.append(deleteButton, restoreButton, actions);

  restoreButton.addEventListener('click', () => on.restore(item));
  deleteButton.setAttribute('aria-label', `Delete ${cardName}`);
  deleteButton.addEventListener('click', () => {
    on.remove(index);
  });
  return el;
}
