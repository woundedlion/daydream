/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The Recording panel: the folder and its settings, the record toggle, and the
 * duration overlay the frame loop writes.
 */

import { MEMORY_BUFFER_LIMIT_BYTES } from "./recorder.js";
import { createRecordingSettings } from "./recording_settings.js";
import { errorDetail } from "./tools/banner.js";

/**
 * Build the recording controls: the Recording folder and its settings, the
 * record toggle, and the duration overlay the frame loop writes.
 *
 * The recorder is constructed only once the WASM load resolves and the canvas
 * exists, so the controls are wired against one that does not exist yet and
 * attach() hands them the one the load built.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {Document} deps.doc - Document the duration overlay mounts into.
 * @param {{addFolder: (title: string) => *}} deps.gui - The global GUI root the
 *   folder is added under.
 * @param {*} deps.driver - The driver: its frame interval, its axis-label state,
 *   the recorder handle it renders through, and the invalidate that redraws the
 *   PiP a session suppresses.
 * @param {() => ?Object} deps.getRecorder - Reads the live recorder, null until
 *   the module load resolves.
 * @param {() => string} deps.getEffect - Names the effect a session records.
 * @param {(message: string) => void} deps.showNotice - Owner-tagged sink for the
 *   session and fault reports.
 * @returns {{attach: (recorder: Object) => void, tick: () => void,
 *   removeOverlay: () => void}} The post-load hookup, the per-frame duration
 *   readout, and the overlay release the page teardown runs.
 */
export function createRecordingControls({
  doc,
  gui,
  driver,
  getRecorder,
  getEffect,
  showNotice,
}) {
  const REC_RESOLUTIONS = { 'Native': null, '720p': 720, '1080p': 1080 };
  const REC_FORMATS = { 'Auto': 'auto', 'MP4': 'mp4', 'WebM': 'webm' };
  const recordingSettings = createRecordingSettings({ getRecorder, warn: showNotice });
  const recSettings = recordingSettings.settings;
  recordingSettings.define('recQuality', 16, 'bitrate',
    (recorder, v) => { recorder.bitrateMbps = v; });
  recordingSettings.define('recResolution', 'Native', 'resolution',
    (recorder, v) => { recorder.targetHeight = REC_RESOLUTIONS[v]; });
  recordingSettings.define('recFormat', 'Auto', 'format',
    (recorder, v) => { recorder.format = REC_FORMATS[v]; });

  const durationEl = doc.createElement('div');
  durationEl.className = 'rec-duration';
  durationEl.style.display = 'none';
  doc.getElementById('canvas-container')?.appendChild(durationEl);

  let durationSecond = null;

  // Whether the UI is currently showing a session. A failure hook runs after the
  // recorder has already cleaned up, so its own state cannot tell a failed start
  // from a stopped session; this can.
  let recordingShown = false;

  let startNotice = '';

  /**
   * Reflects the session state in the canvas styling, duration readout, and record
   * button label.
   * @param {boolean} isRecording - Whether a recording session is now active.
   * @returns {void}
   */
  const showRecording = (isRecording) => {
    driver.heldCaptures = 0;
    durationSecond = null;
    recordingShown = isRecording;
    const canvasEl = doc.getElementById('canvas-container');
    if (isRecording) {
      canvasEl?.classList.add('recording');
      durationEl.style.display = '';
      recordCtrl.name('\u25a0 Stop');
    } else {
      canvasEl?.classList.remove('recording');
      durationEl.style.display = 'none';
      recordCtrl.name('\u25cf Record');
    }
    driver.invalidate();
  };

  const recordState = { record: () => {
    if (!getRecorder()) {
      console.warn('Recording is unavailable until the rendering engine finishes loading.');
      return;
    }
    const wasRecording = recordingShown;
    const isRecording = getRecorder().toggle(getEffect());
    // A start that never began a session has already reported why through onError;
    // there was no session to stop, and the same owner tag would overwrite it.
    if (!wasRecording && !isRecording) return;
    // The canvas tint, the duration readout, and the button label are all visual;
    // the notice region is what carries the state change to assistive tech.
    const axisWarning = isRecording && driver.labelAxes
      ? ' Axis labels are page overlays, not canvas pixels; the recording will not carry them.'
      : '';
    const memoryNotice = isRecording && typeof globalThis.showSaveFilePicker !== 'function'
      ? ` This browser saves up to ${MEMORY_BUFFER_LIMIT_BYTES / 1_000_000} MB per recording`
        + ` (about ${Math.floor(MEMORY_BUFFER_LIMIT_BYTES * 8 / (recSettings.recQuality * 1_000_000))} seconds at this quality).`
      : '';
    startNotice = `${isRecording ? 'Recording started.' : 'Recording stopped.'}`
      + `${axisWarning}${memoryNotice}`;
    showNotice(startNotice);
    showRecording(isRecording);
  }};

  const recFolder = gui.addFolder('Recording');
  recFolder.close();
  recFolder.addSession(recSettings, 'recQuality', 1, 20, 1).name('Rec Quality (Mbps)');
  recFolder.addSession(recSettings, 'recResolution', Object.keys(REC_RESOLUTIONS)).name('Rec Resolution');
  recFolder.addSession(recSettings, 'recFormat', Object.keys(REC_FORMATS)).name('Rec Format');
  const recordCtrl = recFolder.add(recordState, 'record').name('\u25cf Record');
  recordCtrl.disable();

  return {
    /**
     * Hand the controls the recorder the module load built: push the settings
     * that accumulated while none existed, wire the fallback and fault hooks,
     * point the driver at it, and offer the Record button.
     * @param {Object} recorder - The freshly constructed VideoRecorder.
     * @returns {void}
     */
    attach(recorder) {
      recorder.frameInterval = driver.frameInterval;
      recordingSettings.replay();
      recorder.onFormatFallback = (extension) => {
        const label = Object.keys(REC_FORMATS)
          .find(key => REC_FORMATS[key] === extension) ?? extension.toUpperCase();
        const filenameNote = typeof globalThis.showSaveFilePicker === 'function'
          ? ` If the saved filename ends in .video, rename it to .${extension}.` : '';
        showNotice(`${startNotice} ${recSettings.recFormat} is unsupported in this`
          + ` browser; recording as ${label}.${filenameNote}`);
      };
      // A fault ends the session on its own; drop the recording UI so the button
      // doesn't keep offering to stop a session that is already gone, and report
      // the reason through the same notice the record toggle writes.
      recorder.onError = (err) => {
        const detail = errorDetail(err);
        showNotice(recordingShown
          ? `Recording stopped: ${detail}`
          : `Recording failed to start: ${detail}`);
        showRecording(false);
      };
      recorder.onSaveError = (err, filename) => {
        showNotice(`Recording save failed for ${filename}: ${errorDetail(err)}`);
      };
      driver.recorder = recorder;
      recordCtrl.enable();
    },
    /**
     * Advance the duration readout, which changes once a second rather than
     * once a frame.
     * @returns {void}
     */
    tick() {
      const recorder = getRecorder();
      if (!recorder?.isRecording) return;
      const elapsedSecond = Math.floor(recorder.elapsedSeconds);
      if (elapsedSecond !== durationSecond) {
        durationSecond = elapsedSecond;
        durationEl.textContent = recorder.elapsedFormatted;
      }
    },
    /** Drop the duration overlay the controls mounted. @returns {void} */
    removeOverlay() { durationEl.remove(); },
  };
}
