/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The Pole LOD control's binding, which holds the near-pole decimation setting
 * until the engine the module load builds exists to take it.
 */

/**
 * Bind the Pole LOD control to an engine that does not exist yet.
 *
 * DeepLinkGUI replays a URL-hydrated control's onChange at registration, during
 * module evaluation, while the engine is still null — so the value's only
 * durable home is this state, and replay() is what carries it (deep-linked or
 * default) into the engine the module load builds.
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
  // Near-pole azimuthal shading decimation. 1.0 is the physically-neutral
  // setting: one shade per run of columns sharing an LED footprint. Higher
  // trades fidelity for render time; 0 disables.
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
