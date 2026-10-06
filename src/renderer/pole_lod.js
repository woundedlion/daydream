/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** The Pole LOD control's binding. */

/**
 * Bind the Pole LOD control to an engine that does not exist yet.
 *
 * DeepLinkGUI replays URL-hydrated controls during app startup, before the
 * engine loads. replay() applies the stored value after the engine loads.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {() => ?{setPoleLod: (v: number) => void}} deps.getEngine - Reads the
 *   main engine, null until the module load resolves.
 * @param {() => void} deps.onChange - Invalidates the scene after a change.
 * @returns {{state: {poleLod: number}, apply: (v: number) => void,
 *   replay: () => void}} The GUI-bound state object, the control's onChange
 *   sink, and the post-load replay.
 */
export function createPoleLodBinding({ getEngine, onChange }) {
  // Near-pole azimuthal shading decimation: runs of aggressiveness / sin(phi)
  // columns share one shade; 0 disables.
  const state = { poleLod: 0 };
  return {
    state,
    apply(value) {
      state.poleLod = value;
      getEngine()?.setPoleLod(value);
      onChange();
    },
    replay() {
      getEngine()?.setPoleLod(state.poleLod);
    },
  };
}
