/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The key one of the panel's own controls is remembered under across a rebuild,
 * outside the namespace the engine parameter names occupy.
 * @param {string} property - The control's bound property name.
 * @returns {string} The namespaced key.
 */
function panelControlKey(property) {
  return `panel.${property}`;
}

/**
 * The focusable widget a lil-gui controller built: a dropdown's select, an
 * input, or a button, whichever its control kind owns.
 * @param {Object|undefined} controller - A controller from an effect record.
 * @returns {Object|null} The element that takes focus, or null.
 */
export function focusWidget(controller) {
  return controller?.$select ?? controller?.$input
    ?? controller?.$button ?? null;
}

/** Panel mounting and view state across synchronous rebuilds. */
export function createEffectPanelView({ focusedElement, guiContainer, isMobile }) {
  let mountClosedOverride;
  /** Return the element that owns a GUI panel's vertical scroll offset. */
  function scrollElement(gui) {
    return gui?.domElement?.querySelector?.('.lil-children') ?? null;
  }

  /**
   * Every controller a rebuilt panel can hand keyboard focus back to, keyed by
   * the property it binds: the parameters, the pause toggle, the preset
   * selector, then the action row's buttons.
   * @param {Object|null} fx - An effect record, or null.
   * @returns {Array<[string, Object]>} Property/controller pairs.
   */
  function panelControllers(fx) {
    if (!fx) return [];
    const pairs = [...(fx.controllerByName ?? [])];
    if (fx.pause.controller) pairs.push([panelControlKey('pause'), fx.pause.controller]);
    for (const controller of fx.actionControllers ?? []) {
      pairs.push([panelControlKey(controller.property), controller]);
    }
    return pairs;
  }

  /**
   * Which control holds keyboard focus. Discarding the focused control drops
   * focus to <body>, so a rebuild that renames nothing can still cost a full
   * document re-traverse to get back to the panel.
   * @param {Object|null} fx - The effect record about to be replaced.
   * @returns {string|null} The bound property, or null when focus is elsewhere.
   */
  function focusedControlProperty(fx) {
    const focused = focusedElement() ?? null;
    if (focused === null) return null;
    for (const [property, controller] of panelControllers(fx)) {
      if (controller.domElement?.contains(focused) === true) return property;
    }
    return null;
  }

  /**
   * Capture the panel's scroll offset, focused control, and per-stage folder
   * collapse state ahead of a rebuild.
   * @param {Object|null} fx - The effect record about to be replaced.
   * @returns {{scrollTop: number, property: string|null, closed: boolean,
   *   stagesClosed: Map<string, boolean>}} The captured state.
   */
  function capturePanelFocus(fx) {
    const stagesClosed = new Map();
    for (const [stage, folder] of fx?.stageFolders ?? []) {
      stagesClosed.set(stage, Boolean(folder.closed));
    }
    return {
      scrollTop: scrollElement(fx?.gui)?.scrollTop ?? 0,
      property: focusedControlProperty(fx),
      closed: Boolean(fx?.gui?.closed),
      stagesClosed,
    };
  }

  /**
   * Re-seat a captured scroll offset and keyboard focus on the record that
   * replaced the captured one. A detached element cannot hold focus, so the
   * replacement must already be mounted.
   * @param {Object|null} fx - The record now published.
   * @param {{scrollTop: number, property: string|null, closed: boolean,
   *   stagesClosed: Map<string, boolean>}} captured - The state
   *   capturePanelFocus() returned. A stage the replacement does not carry is
   *   dropped; one it gained opens.
   * @returns {void}
   */
  function restorePanelFocus(fx, captured) {
    fx?.gui?.open?.(!captured.closed);
    for (const [stage, folder] of fx?.stageFolders ?? []) {
      const closed = captured.stagesClosed?.get(stage);
      if (closed !== undefined) folder.open?.(!closed);
    }
    const scroller = scrollElement(fx?.gui);
    if (captured.property !== null) {
      for (const [property, controller] of panelControllers(fx)) {
        if (property !== captured.property) continue;
        // A rebuilt panel's control heights differ, so the default
        // scroll-into-view would land the panel somewhere else.
        focusWidget(controller)?.focus?.({ preventScroll: true });
        break;
      }
    }
    // Last, so a host that ignores preventScroll is still overridden.
    if (scroller) scroller.scrollTop = captured.scrollTop;
  }

  /**
   * Mount one effect record in the current GUI container.
   * @param {Object} fx - Record to mount.
   * @param {boolean} [closed] - Initial panel state; defaults to a pending
   *   rebuild state or the mobile layout default.
   * @returns {void}
   */
  function mountEffect(fx, closed = mountClosedOverride ?? isMobile()) {
    if (!fx?.gui) return;
    if (closed) fx.gui.close();
    else fx.gui.open();
    const container = guiContainer();
    if (!container) return;
    const dom = fx.gui.domElement;
    dom.classList.add('effect-gui');
    container.appendChild(dom);
  }

  return {
    capture: capturePanelFocus,
    restore: restorePanelFocus,
    mount: mountEffect,
    rebuild(closed, apply) {
      mountClosedOverride = closed;
      try { apply(); } finally { mountClosedOverride = undefined; }
    },
  };
}
