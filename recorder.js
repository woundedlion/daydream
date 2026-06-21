/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Records the WebGL canvas to a video using MediaRecorder.
 * Uses captureStream(0) (manual frame-request mode) so frames are locked
 * to simulation ticks rather than wall-clock time.
 *
 * Codec priority: MP4/H.264 > WebM/VP9 > WebM/VP8.
 *
 * When a target resolution is set, an offscreen canvas is used to scale the
 * source canvas image before capture — the source renderer is never resized.
 */

/**
 * Pick the best-supported MIME type for the requested output format. Codec
 * priority: MP4/H.264 > WebM/VP9 > WebM/VP8. Returns '' if nothing in the
 * candidate list is supported (MediaRecorder then falls back to its default).
 * The support probe is injected so this stays pure and unit-testable.
 * @param {'auto'|'mp4'|'webm'} format - Requested output container/codec family.
 * @param {(mimeType: string) => boolean} isTypeSupported - Probe returning whether
 *   a MIME type is supported by MediaRecorder; injected to keep this function pure.
 * @returns {string} The best-supported MIME type, or '' if none of the candidates match.
 */
export function selectMimeType(
  format,
  isTypeSupported = (mt) => MediaRecorder.isTypeSupported(mt)) {
  const allMimeTypes = {
    mp4:  ['video/mp4;codecs=avc1'],
    webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
  };
  const candidates = format === 'mp4'  ? allMimeTypes.mp4
                   : format === 'webm' ? allMimeTypes.webm
                   : [...allMimeTypes.mp4, ...allMimeTypes.webm]; // 'auto'
  for (const mt of candidates) {
    if (isTypeSupported(mt)) return mt;
  }
  return '';
}

export class VideoRecorder {
  /**
   * Constructs a recorder bound to a source canvas.
   * @param {HTMLCanvasElement} canvas - Source canvas to record.
   * @param {number} frameInterval - Seconds of video added per captured frame;
   *   drives the elapsed-time counter (default 1/16 s = 16 fps).
   */
  constructor(canvas, frameInterval = 1 / 16) {
    this.canvas = canvas;
    this.mediaRecorder = null;
    this.chunks = [];
    this.stream = null;
    this.track = null;
    this._effectName = 'effect';
    this.frameInterval = frameInterval;
    this.elapsedSeconds = 0;
    this.bitrateMbps = 16;
    // Output format: 'auto' (prefer mp4, fall back to webm), 'mp4', or 'webm'
    this.format = 'auto';
    // Resolution override: target height in pixels (null = native)
    // Width is computed from the source canvas aspect ratio.
    this.targetHeight = null;
    // Offscreen scaling canvas (created on demand, destroyed on cleanup)
    this._offscreen = null;
    this._offCtx = null;
  }

  /**
   * Reports whether the browser supports canvas recording.
   * @returns {boolean} True if both captureStream and MediaRecorder are available.
   */
  static isSupported() {
    return typeof HTMLCanvasElement.prototype.captureStream === 'function'
      && typeof MediaRecorder !== 'undefined';
  }

  /**
   * Whether a recording session is actively capturing.
   * @returns {boolean} True while the MediaRecorder is in the 'recording' state.
   */
  get isRecording() {
    return this.mediaRecorder !== null && this.mediaRecorder.state === 'recording';
  }

  /**
   * Starts recording if idle, or stops it if active.
   * @param {string} effectName - Base name used for the downloaded file when starting.
   * @returns {boolean} True if a recording session is now active.
   */
  toggle(effectName) {
    if (this.isRecording) {
      this.stop();
      return false;
    } else {
      this.start(effectName);
      // start() can refuse (unsupported browser, etc.); report the real state
      // so the caller's button does not latch into a phantom recording mode.
      return this.isRecording;
    }
  }

  /**
   * Begins a recording session. No-op if already recording or unsupported.
   * @param {string} effectName - Base name used for the downloaded file.
   * @returns {void}
   */
  start(effectName = 'effect') {
    if (this.isRecording) return;

    if (!VideoRecorder.isSupported()) {
      console.error('VideoRecorder: captureStream or MediaRecorder is not supported in this browser.');
      return;
    }

    this._effectName = effectName;
    this.elapsedSeconds = 0;

    // Determine capture source: offscreen scaled canvas or native
    let captureSource = this.canvas;
    if (this.targetHeight) {
      captureSource = this._ensureOffscreen();
    }

    // Manual frame-request mode: framerate 0 means we control when frames are captured
    const stream = captureSource.captureStream(0);
    const track = stream.getVideoTracks()[0];

    // Pick the best-supported codec for the requested format.
    const mimeType = selectMimeType(this.format);

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: this.bitrateMbps * 1_000_000,
    });

    // Session-local capture state. MediaRecorder.stop() flips state to
    // 'inactive' synchronously, but ondataavailable/onstop fire asynchronously
    // later. A fast stop→start can therefore install a brand-new session on
    // this.* before the old recorder's handlers run. Binding chunks/stream/
    // recorder/effectName in the closures (instead of reading this.* at fire
    // time) keeps a stale session from downloading the new session's chunks or
    // tearing down its stream — the old handlers only ever touch their own.
    const chunks = [];

    this.mediaRecorder = recorder;
    this.stream = stream;
    this.track = track;
    this.chunks = chunks;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      this._download(recorder, chunks, effectName);
      // This session owns `stream`, so stop its tracks unconditionally.
      stream.getTracks().forEach(t => t.stop());
      // Only clear the shared instance state (and offscreen canvas) if this is
      // still the active session; a rapid stop→start may have already replaced
      // it, and that newer session must survive this stale teardown.
      if (this.mediaRecorder === recorder) this._cleanup();
    };

    recorder.start();
  }

  /**
   * Stops the active session; download and cleanup happen in the onstop handler.
   * @returns {void}
   */
  stop() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }
  }

  /**
   * Requests a single video frame; call once per simulation frame. When an
   * offscreen scaling canvas is in use, blits the source canvas into it (scaled
   * to the target resolution) before requesting the frame, and advances the
   * elapsed-time counter by one frame interval.
   * @returns {void}
   */
  captureFrame() {
    if (!this.isRecording || !this.track) return;
    if (typeof this.track.requestFrame !== 'function') {
      // Recording is silently a no-op without requestFrame (browser lacks the
      // captureStream frame-request API). Warn once rather than per frame so the
      // broken recording is visible without spamming the console.
      if (!this._warnedNoRequestFrame) {
        console.warn('Recorder: track.requestFrame is unavailable; recorded frames will not advance in this browser.');
        this._warnedNoRequestFrame = true;
      }
      return;
    }

    // If using an offscreen canvas, blit the source canvas scaled to the target
    // resolution. Re-sync the offscreen dimensions first: if the source canvas
    // was resized mid-recording (window/resolution change), its aspect ratio
    // has changed and the offscreen would otherwise scale into stale, wrong-
    // aspect dimensions. _ensureOffscreen only reassigns on an actual change, so
    // this is a no-op on the steady-state path.
    if (this._offscreen && this._offCtx) {
      this._ensureOffscreen();
      this._offCtx.drawImage(this.canvas, 0, 0, this._offscreen.width, this._offscreen.height);
    }

    this.track.requestFrame();
    this.elapsedSeconds += this.frameInterval;
  }

  /**
   * Elapsed recording time as a formatted string.
   * @returns {string} The elapsed time in M:SS form (seconds zero-padded).
   */
  get elapsedFormatted() {
    const total = Math.floor(this.elapsedSeconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Creates or resizes the offscreen scaling canvas to match the target height
   * and the source canvas aspect ratio, rounding both dimensions up to even
   * values (required by video codecs).
   * @returns {HTMLCanvasElement} The offscreen canvas sized for the target resolution.
   */
  _ensureOffscreen() {
    // Clamp the aspect: an early or zero-size source layout makes
    // width/height non-finite (height 0 → Infinity, 0/0 → NaN), which would
    // propagate to NaN canvas dimensions. Fall back to a square in that case.
    const rawAspect = this.canvas.width / this.canvas.height;
    const aspect = Number.isFinite(rawAspect) && rawAspect > 0 ? rawAspect : 1;
    const w = Math.round(this.targetHeight * aspect);
    // Ensure even dimensions (codecs require it)
    const evenW = w % 2 === 0 ? w : w + 1;
    const evenH = this.targetHeight % 2 === 0 ? this.targetHeight : this.targetHeight + 1;

    if (!this._offscreen) {
      this._offscreen = document.createElement('canvas');
      this._offCtx = this._offscreen.getContext('2d');
    }
    // Reassign only on change — writing canvas.width/height clears the bitmap,
    // so doing it every captureFrame would needlessly blank the offscreen.
    if (this._offscreen.width !== evenW) this._offscreen.width = evenW;
    if (this._offscreen.height !== evenH) this._offscreen.height = evenH;
    return this._offscreen;
  }

  /**
   * Determines the output file extension from the recorder's MIME type.
   * @param {MediaRecorder} [recorder] - Recorder whose mimeType is inspected;
   *   defaults to the active recorder.
   * @returns {string} 'mp4' for MP4 output, otherwise 'webm'.
   */
  _extension(recorder = this.mediaRecorder) {
    const mime = recorder?.mimeType ?? '';
    if (mime.startsWith('video/mp4')) return 'mp4';
    return 'webm';
  }

  /**
   * Assembles captured chunks into a blob and saves it under a timestamped name.
   * Uses showSaveFilePicker when available, falling back to an anchor download.
   * @param {MediaRecorder} [recorder] - Recorder used to derive the extension;
   *   defaults to the active recorder.
   * @param {Blob[]} [chunks] - Captured data chunks; defaults to the active chunks.
   * @param {string} [effectName] - Base name for the file; defaults to the stored name.
   * @returns {void}
   */
  _download(recorder = this.mediaRecorder, chunks = this.chunks, effectName = this._effectName) {
    const ext = this._extension(recorder);
    const blob = new Blob(chunks, { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' });

    const now = new Date();
    const ts = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + '_'
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0');

    const filename = `${effectName}_${ts}.${ext}`;

    // Use showSaveFilePicker when available for a proper, deterministic download;
    // fall back to anchor-click with a load-event-based revoke.
    if (typeof showSaveFilePicker === 'function') {
      this._saveWithPicker(blob, filename, ext);
    } else {
      this._saveWithAnchor(blob, filename);
    }
  }

  /**
   * Saves the blob via the File System Access API for a deterministic write with
   * no object-URL leak. Silently returns if the user cancels; on any other
   * failure, falls back to the anchor download so the recording is not lost.
   * @param {Blob} blob - The recorded video data to write.
   * @param {string} filename - Suggested file name for the save dialog.
   * @param {string} [ext] - File extension without dot; defaults to the recorder's extension.
   * @returns {Promise<void>} Resolves once the file is written or the fallback completes.
   */
  async _saveWithPicker(blob, filename, ext = this._extension()) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'Video',
          accept: { [blob.type]: [`.${ext}`] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (err) {
      // User cancelled the dialog — not an error; nothing to save.
      if (err.name === 'AbortError') return;
      // Any other failure (expired user activation -> SecurityError, disk/write
      // error, etc.) would otherwise silently lose the recording. Fall back to the
      // anchor download so the artifact still reaches the user.
      console.warn('VideoRecorder: picker save failed, falling back to anchor download', err);
      this._saveWithAnchor(blob, filename);
    }
  }

  /**
   * Legacy save path: triggers an anchor-click download and revokes the object
   * URL once an offscreen iframe load confirms the browser consumed it, with a
   * 60 s timeout safety net for browsers that never fire the load event.
   * @param {Blob} blob - The recorded video data to download.
   * @param {string} filename - File name applied to the download anchor.
   * @returns {void}
   */
  _saveWithAnchor(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Revoke after the browser has consumed the blob URL.  An <iframe> load
    // event fires once the download has been handed to the OS save dialog,
    // giving us a reliable signal instead of an arbitrary timeout.
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = url;
    // Safety net: if the iframe never fires load (some browsers), revoke after 60 s.
    const safetyTimeout = setTimeout(() => {
      URL.revokeObjectURL(url);
      iframe.remove();
    }, 60_000);
    iframe.onload = () => {
      // Cancel the safety net on an early load so it doesn't fire a redundant
      // (double) revoke/remove 60 s later.
      clearTimeout(safetyTimeout);
      URL.revokeObjectURL(url);
      iframe.remove();
    };
    document.body.appendChild(iframe);
  }

  /**
   * Releases the active session's recorder, stream tracks, and offscreen canvas.
   * @returns {void}
   */
  _cleanup() {
    this.mediaRecorder = null;
    this.chunks = [];
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.track = null;
    // Tear down offscreen canvas to free memory
    if (this._offscreen) {
      this._offscreen.width = 0;
      this._offscreen.height = 0;
      this._offscreen = null;
      this._offCtx = null;
    }
  }
}
