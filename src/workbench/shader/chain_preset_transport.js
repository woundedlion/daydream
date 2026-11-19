// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {DEFAULT_PRESET_DWELL, neighbouringPresets} from './chain_preset_bank.js';

/** @typedef {import('./chain_preset_bank.js').Bank} Bank */
/** @typedef {import('./chain_preset_bank.js').Edge} Edge */
/** @typedef {{edge: Edge, frame: number, playing: boolean}} Preview */

/**
 * @param {{bank: () => Bank|null, preset: () => string|null, snap: (id: string) => boolean,
 * adopt: (id: string) => void, start: (edge: Edge) => boolean,
 * evaluate: (edge: Edge, frame: number, seek: boolean) => boolean,
 * update: (preview: Preview|null) => void, requestFrame: () => void}} deps
 */
export function createPresetTransport({bank, preset, snap, adopt, start, evaluate, update, requestFrame}) {
  /** @type {Preview|null} */
  let active = null;
  /** @type {Edge|null} */
  let selected = null;
  let showing = false;
  let dwell = 0;
  let seeking = false;

  /** @param {string|null} id @returns {Edge|null} */
  function nextEdge(id) {
    const current = bank();
    if (!current || id === null) return null;
    const pair = neighbouringPresets(current.choreography.generated_order)
      .find((pair) => pair.from === id);
    if (!pair) return null;
    return current.edges.find((edge) => edge.from === pair.from && edge.to === pair.to) ?? null;
  }

  function clear() {
    active = null;
    selected = null;
    showing = false;
    seeking = false;
    dwell = 0;
    update(null);
  }

  /** @param {Edge} edge */
  function begin(edge) {
    if (!start(edge)) {
      clear();
      return false;
    }
    selected = edge;
    active = {edge, frame: 0, playing: true};
    update(active);
    return true;
  }

  /** @param {string} id */
  function setDwell(id) {
    dwell = bank()?.choreography.dwell?.[id] ?? DEFAULT_PRESET_DWELL;
  }

  function tick() {
    if (seeking && active) {
      const {edge, frame} = active;
      seeking = false;
      if (evaluate(edge, frame, true)) update(active);
      else clear();
      return;
    }
    if (active?.playing && active.frame >= active.edge.duration) {
      const {to} = active.edge;
      adopt(to);
      active = null;
      if (showing) {
        setDwell(to);
        update(null);
      } else {
        clear();
        return;
      }
    }
    if (!active && showing && --dwell <= 0) {
      const current = bank();
      const id = preset();
      const edge = nextEdge(id);
      if (edge) {
        if (!begin(edge)) return;
      } else if (current && id !== null) {
        const order = current.choreography.generated_order;
        const next = order[(order.indexOf(id) + 1) % order.length];
        if (next !== id && !snap(next)) {
          clear();
          return;
        }
        setDwell(next);
      }
    }
    if (active?.playing) {
      if (evaluate(active.edge, active.frame + 1, false)) {
        active.frame += 1;
        update(active);
      } else clear();
    }
  }

  return {
    tick,
    clear,
    inProgress: () => active !== null || showing,
    next() {
      const id = preset();
      const edge = nextEdge(id);
      if (!edge || id === null) return;
      clear();
      if (snap(id) && begin(edge)) requestFrame();
    },
    show() {
      const id = preset();
      if (id === null) return;
      clear();
      if (!snap(id)) return;
      showing = true;
      setDwell(id);
      update(null);
      requestFrame();
    },
    /** @param {Edge} edge */
    selectEdge(edge) {
      clear();
      if (!snap(edge.from)) return;
      selected = edge;
      update(null);
    },
    /** @param {number} frame */
    seek(frame) {
      const edge = selected ?? nextEdge(preset());
      if (edge === null) return;
      showing = false;
      active = {edge, frame: Math.min(edge.duration, Math.max(0, frame)), playing: false};
      seeking = true;
      update(active);
      requestFrame();
    },
    stop() {
      const id = preset();
      clear();
      if (id !== null) snap(id);
    },
    view: () => ({active, selected: selected ?? nextEdge(preset()), showing}),
  };
}
