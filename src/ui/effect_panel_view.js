/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {{property: string, domElement: HTMLElement, $select?: HTMLSelectElement, $input?: HTMLInputElement, $button?: HTMLButtonElement}} PanelController */
/** @typedef {{domElement: HTMLElement, closed: boolean, open: (open?: boolean) => void, close: () => void}} PanelFolder */
/** @typedef {{gui: PanelFolder, controllerByName?: Map<string, PanelController>, pause: {controller?: PanelController|null}, actionControllers?: PanelController[], stageFolders?: Map<string, PanelFolder>}} PanelRecord */

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
 * @param {PanelController|undefined} controller - A controller from an effect record.
 * @returns {HTMLElement|null} The element that takes focus, or null.
 */
export function focusWidget(controller) {
  return controller?.$select ?? controller?.$input
    ?? controller?.$button ?? null;
}

/**
 * Panel mounting and view state across synchronous rebuilds.
 * @param {{focusedElement: () => *, guiContainer: *, isMobile: () => boolean}} dependencies
 */
export function createEffectPanelView({ focusedElement, guiContainer, isMobile }) {
  /** @type {boolean|undefined} */
  let mountClosedOverride;
  /** @param {PanelFolder|undefined} gui @returns {HTMLElement|null} */
  function scrollElement(gui) {
    return gui?.domElement?.querySelector?.('.lil-children') ?? null;
  }

  /**
   * Every controller a rebuilt panel can hand keyboard focus back to, keyed by
   * the property it binds.
   * @param {PanelRecord|null} fx - An effect record, or null.
   * @returns {Array<[string, PanelController]>} Property/controller pairs.
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
   * Which control holds keyboard focus.

   * @param {PanelRecord|null} fx - The effect record about to be replaced.
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
   * @param {PanelRecord|null} fx - The effect record about to be replaced.
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
   * @param {PanelRecord|null} fx - The record now published.
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
        focusWidget(controller)?.focus?.({ preventScroll: true });
        break;
      }
    }
    // Last, so a host that ignores preventScroll is still overridden.
    if (scroller) scroller.scrollTop = captured.scrollTop;
  }

  /**
   * Mount one effect record in the current GUI container.
   * @param {PanelRecord|null} fx - Record to mount.
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
    /** @param {boolean} closed @param {() => void} apply */
    rebuild(closed, apply) {
      mountClosedOverride = closed;
      try { apply(); } finally { mountClosedOverride = undefined; }
    },
  };
}
