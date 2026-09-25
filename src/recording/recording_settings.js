/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The recording settings the GUI binds to, each holding its own value until the
 * recorder the module load builds exists to take it.
 */

/**
 * Build the recording settings the GUI binds to, over a recorder that does not
 * exist yet.
 *
 * The recorder is constructed only once the module load resolves and the canvas
 * exists, but the GUI mounts at module scope — so each setting holds its own
 * value behind an accessor, pushes it at every write, and replay() carries
 * whatever accumulated (deep-linked or default) into the recorder the load
 * builds. The recorder latches these at start(), so a write during a session is
 * reported rather than silently deferred to the next one.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {() => ?{isRecording: boolean}} deps.getRecorder - Reads the live
 *   recorder, null until the module load resolves.
 * @param {(message: string) => void} [deps.warn] - Sink for the mid-recording
 *   notice.
 * @returns {{settings: Object, define: (prop: string, initial: *, label: string,
 *   push: (recorder: Object, value: *) => void) => void, replay: () => void}}
 *   The GUI-bound settings object, the per-setting definer, and the post-load
 *   replay.
 */
export function createRecordingSettings({
  getRecorder,
  warn = (message) => console.warn(message),
}) {
  /** @type {Object} */
  const settings = {};
  /** @type {Array<() => void>} */
  const replays = [];
  return {
    settings,
    define(prop, initial, label, push) {
      let value = initial;
      Object.defineProperty(settings, prop, {
        enumerable: true,
        get: () => value,
        set(v) {
          value = v;
          const recorder = getRecorder();
          if (recorder) push(recorder, v);
          if (recorder?.isRecording) {
            warn(`Recording: ${label} change applies to the next recording `
              + '(the current one is already running).');
          }
        },
      });
      // Unguarded: replay() runs immediately after the recorder is constructed,
      // and a null-tolerant replay would drop every setting in silence.
      replays.push(() => push(/** @type {Object} */ (getRecorder()), value));
    },
    replay() {
      for (const push of replays) push();
    },
  };
}
