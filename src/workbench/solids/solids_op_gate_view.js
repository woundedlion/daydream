/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {{showGateMsg: (text: string, options?: {persist?: boolean}) => void,
 * setOpBlocked: (btn: HTMLElement, reason: string|null) => void,
 * openOpGate: (reason: string) => void, refreshOpGating: () => Promise<void>}} SolidsOpGateView */

/** Creates operation availability feedback.
 * @param {import('./solids_state.js').SolidsPage} page - Shared page state.
 * @param {import('./solids_state.js').SolidsActions} actions - Page collaborators.
 * @param {Partial<{document: Document, clearTimeout: typeof clearTimeout, setTimeout: typeof setTimeout}>} [dependencies] - DOM and timers.
 * @returns {SolidsOpGateView} Gate rendering actions.
 */
export function createSolidsOpGateView(page, actions, dependencies = {}) {
  const env = { document: globalThis.document, clearTimeout, setTimeout, ...dependencies };
  /** Shows validation status. @param {string} text @param {{persist?: boolean}} [options] @returns {void} */
  function showGateMsg(text, { persist = true } = {}) {
    const el = env.document.getElementById('opGateMsg');
    if (!el) return;
    el.innerText = text;
    env.clearTimeout(/** @type {number|undefined} */ (page.view.gateMsgTimer));
    page.view.gateMsgTimer = persist ? null : env.setTimeout(() => { el.innerText = ''; }, 3000);
  }

  /** Updates one add-op button's availability. @param {HTMLElement} btn @param {string|null} reason @returns {void} */
  function setOpBlocked(btn, reason) {
    btn.dataset.authoredDescription ??= btn.getAttribute('aria-describedby') ?? '';
    if (reason) {
      btn.setAttribute('aria-disabled', 'true');
      btn.title = reason;
      btn.setAttribute('aria-describedby', [btn.dataset.authoredDescription, 'opBlockedReason'].filter(Boolean).join(' '));
    } else {
      btn.removeAttribute('aria-disabled');
      if (btn.dataset.authoredDescription) btn.setAttribute('aria-describedby', btn.dataset.authoredDescription);
      else btn.removeAttribute('aria-describedby');
      btn.removeAttribute('title');
    }
  }

  /**
   * Re-enables every add-op button: a gate that stopped probing fails open.
   * @param {string} reason - Why the sweep stopped, shown to the user.
   * @returns {void}
   */
  function openOpGate(reason) {
    if (!page.engine.wasmModule) return;
    for (const btn of env.document.querySelectorAll('#addOpGrid [data-op]')) {
      actions.setOpBlocked(/** @type {HTMLElement} */ (btn), null);
    }
    actions.showGateMsg(`op availability is no longer checked: ${reason}`);
  }

  /** Refreshes button availability against the current chain. @returns {Promise<void>} */
  async function refreshOpGating() {
    const buttons = [.../** @type {NodeListOf<HTMLElement>} */ (env.document.querySelectorAll('#addOpGrid [data-op]'))];
    const opGate = /** @type {NonNullable<import('./solids_state.js').SolidsPage['engine']['opGate']>} */ (page.engine.opGate);
    const probe = await opGate.refresh(page.doc.base, page.doc.ops,
      buttons.map((btn) => /** @type {string} */ (btn.dataset.op)), page.mesh.currentMeshIsCurrent ? page.mesh.currentMesh : null);
    if (!probe || !page.engine.wasmModule) return;

    if (probe.abandoned) {
      actions.openOpGate('the validator module will not start');
      return;
    }

    for (const btn of buttons) {
      const blocked = probe.blocked.has(/** @type {string} */ (btn.dataset.op));
      // An incomplete pass is a lower bound; unnamed ops keep their last state.
      if (!blocked && !probe.complete) continue;
      actions.setOpBlocked(btn, blocked ? (/** @type {HTMLElement} */ (env.document.getElementById('opBlockedReason'))).textContent : null);
    }
  }
  return { showGateMsg, setOpBlocked, openOpGate, refreshOpGating };
}
