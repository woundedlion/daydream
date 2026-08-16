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
 * @param {Document} doc - Workbench document.
 * @returns {MutationObserver|null} Observer used while the GUI mounts.
 */
export function wireShaderWorkbenchNav(doc) {
  const nav = doc.getElementById('shader-workbench-nav');
  const gui = doc.getElementById('gui-container');
  if (!nav || !gui) return null;
  const buttons = /** @type {HTMLButtonElement[]} */ (
    [...nav.querySelectorAll('[data-workbench-folder]')]
  );
  const sync = () => {
    for (const button of buttons) {
      const name = button.dataset.workbenchFolder;
      button.disabled = !name || !findWorkbenchFolder(doc, name);
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
  return observer;
}

if (typeof document !== 'undefined') wireShaderWorkbenchNav(document);
