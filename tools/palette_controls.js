/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * DOM-free control state for the palette tool page (tools/palettes.html): the
 * drag-to-zoom history the Reset Zoom button reflects, and the delta capping a
 * locked R/G/B slider group moves under. The page keeps the DOM reads and
 * writes around these.
 */

/**
 * The procedural coefficients a zoom rewrites, and therefore the ones the
 * history snapshots. The A (base) and B (amplitude) triples are untouched by a
 * zoom, so restoring them would discard unrelated edits.
 */
export const ZOOMED_PARAMS = ['C_R', 'C_G', 'C_B', 'D_R', 'D_G', 'D_B'];

/**
 * Builds the zoom history: at most one pre-zoom snapshot of the frequency/phase
 * coefficients, held from the first zoom until it is restored or invalidated.
 *
 * Successive zooms compose, so only the FIRST pre-zoom state is kept — a reset
 * always returns to where the user started rather than one zoom back. Any edit
 * that redefines the frequency/phase baseline (a manual C/D slider move, loading
 * a named palette) invalidates the snapshot instead.
 *
 * @returns {{zoomed: boolean, capture: function(Object): void, restore: function(): ?Object, clear: function(): void}} The history handle; `zoomed` reports whether a snapshot is held.
 */
export function createZoomHistory() {
  /** @type {?Object} */
  let saved = null;

  return {
    get zoomed() {
      return saved !== null;
    },

    /**
     * Snapshots the frequency/phase coefficients, unless one is already held.
     * @param {Object} parameters - The current 12-coefficient parameter set.
     * @returns {void}
     */
    capture(parameters) {
      if (saved !== null) return;
      saved = {};
      for (const key of ZOOMED_PARAMS) saved[key] = parameters[key];
    },

    /**
     * Takes the snapshot back and drops it.
     * @returns {?Object} The pre-zoom frequency/phase coefficients, or null when none is held.
     */
    restore() {
      const snapshot = saved;
      saved = null;
      return snapshot;
    },

    /**
     * Drops the snapshot without restoring it.
     * @returns {void}
     */
    clear() {
      saved = null;
    },
  };
}

/**
 * Caps the shared delta a locked R/G/B group moves by so no member leaves its
 * own range, and reports each member's resulting value.
 *
 * All three channels move rigidly, so the group can only travel as far as its
 * most constrained member: the first channel to hit a bound stops the whole
 * group instead of clipping alone and breaking the lock.
 *
 * @param {number} rawDelta - Delta the dragged slider asks for, in raw (scaled integer) units.
 * @param {Array<{param: string, start: number, min: number, max: number}>} members - The group's sliders, with their drag-start values and raw bounds. A member whose start value is not finite is ignored (the page could not read it).
 * @returns {{delta: number, values: Object<string, number>}} The capped delta and the raw value each member lands on.
 */
export function lockedGroupMove(rawDelta, members) {
  const moving = members.filter((m) => Number.isFinite(m.start));

  let delta = rawDelta;
  for (const m of moving) {
    // Bounds are tested against the REQUESTED delta, so an earlier member's cap
    // cannot mask a later member's violation.
    if (m.start + rawDelta < m.min) delta = Math.max(delta, m.min - m.start);
    if (m.start + rawDelta > m.max) delta = Math.min(delta, m.max - m.start);
  }

  const values = {};
  for (const m of moving) values[m.param] = m.start + delta;
  return { delta, values };
}
