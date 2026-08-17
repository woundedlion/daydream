/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { onPageTeardown } from './page_lifecycle.js';

const TITLE_SELECTOR = '#gui-container .lil-gui > .lil-title';

/**
 * Finds a Shader control folder by its displayed title.
 * @param {ParentNode} root - Document or element containing the GUI.
 * @param {string} name - Exact folder title.
 * @returns {HTMLElement|null} Matching folder element.
 */
export function findWorkbenchFolder(root, name) {
  const titles = /** @type {HTMLElement[]} */ (
    [...root.querySelectorAll(TITLE_SELECTOR)]
  );
  return folderFromTitles(titles, name);
}

/**
 * Picks a folder out of an already-collected title list, so a caller resolving
 * several names pays one DOM sweep rather than one per name.
 * @param {HTMLElement[]} titles - Every GUI folder title, in document order.
 * @param {string} name - Exact folder title.
 * @returns {HTMLElement|null} Matching folder element.
 */
function folderFromTitles(titles, name) {
  const title = titles
    .filter((candidate) => candidate.textContent?.trim() === name)
    .at(-1);
  return title?.parentElement ?? null;
}

/**
 * Opens and reveals a Shader control folder.
 * @param {ParentNode} root - Document or element containing the GUI.
 * @param {string} name - Exact folder title.
 * @returns {boolean} Whether the folder was found.
 */
export function revealWorkbenchFolder(root, name) {
  const folder = findWorkbenchFolder(root, name);
  if (!folder) return false;
  const title = /** @type {HTMLButtonElement|null} */ (
    folder.querySelector(':scope > .lil-title')
  );
  if (title?.getAttribute('aria-expanded') === 'false') title.click();
  folder.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}

/**
 * Connects the stage navigator to the live Shader GUI.
 *
 * The observer watches the GUI mount and disconnects the moment every stage
 * folder has appeared: the GUI is built once, so past that point each structural
 * change would cost a sweep for a result that can no longer change.
 * @param {Document} doc - Workbench document.
 * @returns {MutationObserver|null} Observer watching the mount, or null when the
 *   nav is absent or every folder was already there.
 */
export function wireShaderWorkbenchNav(doc) {
  const nav = doc.getElementById('shader-workbench-nav');
  const gui = doc.getElementById('gui-container');
  if (!nav || !gui) return null;
  const buttons = /** @type {HTMLButtonElement[]} */ (
    [...nav.querySelectorAll('[data-workbench-folder]')]
  );
  // One sweep per call, shared across the buttons; a per-button lookup would
  // re-walk the whole GUI subtree once per stage on every mutation.
  const sync = () => {
    const titles = /** @type {HTMLElement[]} */ ([...doc.querySelectorAll(TITLE_SELECTOR)]);
    for (const button of buttons) {
      const name = button.dataset.workbenchFolder;
      button.disabled = !name || !folderFromTitles(titles, name);
    }
    return buttons.every((button) => !button.disabled);
  };
  for (const button of buttons) {
    button.disabled = true;
    button.addEventListener('click', () => {
      const name = button.dataset.workbenchFolder;
      if (!name || !revealWorkbenchFolder(doc, name)) return;
      for (const candidate of buttons) candidate.removeAttribute('aria-current');
      button.setAttribute('aria-current', 'true');
    });
  }
  if (sync()) return null;
  const observer = new MutationObserver(() => {
    if (sync()) observer.disconnect();
  });
  observer.observe(gui, { childList: true, subtree: true });
  onPageTeardown(() => observer.disconnect());
  return observer;
}

if (typeof document !== 'undefined') wireShaderWorkbenchNav(document);
