// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The parameter dock: the selected stage instance's controls beside the canvas,
 * and the collapse toggle that trades the dock's width back to the render. The
 * controls themselves belong to the effect GUI, narrowed to the selected
 * instance by the parameter filter; what lives here is the dock's own collapsed
 * state and the union-schema predicate that filter dims fields with.
 */

/**
 * The parameter names the current topology selections deactivate: an
 * `edge-width` field is read by the engine only while its instance's
 * `coverage-mode` or `envelope` enum sits on `edge-fade`. Deactivation changes
 * what the engine reads, never what the document carries, so the GUI dims these
 * controls rather than dropping them.
 * @param {Array<{name: string, value?: *, requestedValue?: *, options?: string[]}>} definitions
 *   - Engine parameter definitions (enum values are option indices).
 * @returns {Set<string>} The deactivated parameter names.
 */
export function deactivatedParamNames(definitions) {
  /** @type {Map<string, string>} */
  const gates = new Map();
  for (const definition of definitions) {
    if (!definition.options) continue;
    const dot = definition.name.indexOf('.');
    if (dot < 0) continue;
    const field = definition.name.slice(dot + 1);
    if (field !== 'coverage-mode' && field !== 'envelope') continue;
    const index = definition.requestedValue ?? definition.value;
    const option = typeof index === 'number' ? definition.options[index] : undefined;
    if (option !== undefined) gates.set(definition.name.slice(0, dot), option);
  }
  const deactivated = new Set();
  for (const definition of definitions) {
    const dot = definition.name.indexOf('.');
    if (dot < 0 || definition.name.slice(dot + 1) !== 'edge-width') continue;
    const gate = gates.get(definition.name.slice(0, dot));
    if (gate !== undefined && gate !== 'edge-fade') deactivated.add(definition.name);
  }
  return deactivated;
}

/**
 * Wires the collapsible parameter dock. The dock is docked beside the canvas
 * rather than over it, so tuning a slider never hides the render it is being
 * judged against; collapsing it hands the width back.
 * @param {Object} options - The dock's collaborators.
 * @param {*} options.doc - Document the dock lives in.
 * @param {*} options.container - The dock element, which carries the state as
 *   `data-collapsed` for the stylesheet.
 * @param {*} options.toggle - Button that flips it, inside the dock.
 * @returns {Object} The dock.
 */
export function createParameterDock({ doc, container, toggle }) {
  let collapsed = false;

  /**
   * @param {boolean} on - Whether the dock is collapsed.
   * @returns {void}
   */
  const setCollapsed = (on) => {
    collapsed = on;
    container.dataset.collapsed = String(on);
    toggle.setAttribute('aria-expanded', String(!on));
    // A collapsed dock is not reachable, so focus inside it would be stranded.
    const active = doc.activeElement ?? null;
    if (on && active !== null && active !== toggle && container.contains(active)) {
      toggle.focus();
    }
  };

  const flip = () => setCollapsed(!collapsed);
  toggle.addEventListener('click', flip);
  setCollapsed(false);

  return {
    setCollapsed,

    /** @returns {boolean} Whether the dock is collapsed. */
    collapsed: () => collapsed,

    /** Detaches the toggle's listener. */
    destroy() {
      toggle.removeEventListener('click', flip);
    },
  };
}
