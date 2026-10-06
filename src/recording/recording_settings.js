/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Recording settings the GUI binds to before the recorder exists. */

/**
 * Build the recording settings the GUI binds to, over a recorder that does not
 * exist yet.
 *
 * Each setting holds its own value behind an accessor and pushes it on write;
 * replay() pushes the accumulated values into the newly built recorder. The
 * recorder latches settings at start(), so a write mid-recording warns.
 *
 * @template {{isRecording: boolean}} T
 * @param {Object} deps - Injected app collaborators.
 * @param {() => T|null} deps.getRecorder - Reads the live
 *   recorder, null until the module load resolves.
 * @param {(message: string) => void} [deps.warn] - Sink for the mid-recording
 *   notice.
 * @returns {{settings: Record<string, any>, define: (prop: string, initial: *, label: string,
 *   push: (recorder: T, value: *) => void) => void, replay: () => void}}
 *   The GUI-bound settings object, the per-setting definer, and the post-load
 *   replay.
 */
export function createRecordingSettings({
  getRecorder,
  warn = (message) => console.warn(message),
}) {
  /** @type {Record<string, any>} */
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
      // Unguarded: replay() requires a constructed recorder.
      replays.push(() => push(/** @type {T} */ (getRecorder()), value));
    },
    replay() {
      for (const push of replays) push();
    },
  };
}
