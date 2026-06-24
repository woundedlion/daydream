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
 * Capture always goes through an offscreen canvas so the recorded track's frame
 * size stays fixed for the whole session: when a target resolution is set the
 * offscreen scales to it; at native resolution the offscreen is pinned to the
 * source's start-time size. Either way the source renderer is never resized, and
 * a mid-recording resolution change cannot change the encoded track dimensions.
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
    // bitrateMbps, format, and targetHeight are latched at start(): assigning any
    // mid-recording has no effect until the next start().
    this.bitrateMbps = 16;
    // 'auto' (prefer mp4, fall back to webm), 'mp4', or 'webm'.
    this.format = 'auto';
    // Resolution override: target height in pixels (null = native); width follows
    // the source canvas aspect.
    this.targetHeight = null;
    this._offscreen = null;
    this._offCtx = null;
    // Latch so captureFrame() warns at most once when the browser lacks
    // track.requestFrame.
    this._warnedNoRequestFrame = false;
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
      // start() can refuse (unsupported browser); report the real state so the
      // caller's button doesn't latch into a phantom recording mode.
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

    // Both paths capture through an offscreen canvas so the track's frame
    // dimensions stay fixed for the session: a captureStream bound to the source
    // would change track size on a mid-recording resize, which most H.264/VP9
    // encoders reject or corrupt. Scaled path pins the target height; native path
    // pins the source's start dimensions.
    const captureSource = this.targetHeight
      ? this._ensureOffscreen()
      : this._ensurePinnedOffscreen();

    // A null 2D context (getContext('2d') can fail under memory pressure or a lost
    // context) would otherwise start the recorder and produce a permanently blank
    // file with no diagnostic. Abort the session loudly instead.
    if (!this._offCtx) {
      console.error('VideoRecorder: failed to acquire a 2D drawing context for the capture canvas; recording aborted.');
      return;
    }

    // framerate 0: manual frame-request mode, we control when frames are captured.
    const stream = captureSource.captureStream(0);
    const track = stream.getVideoTracks()[0];

    const mimeType = selectMimeType(this.format);

    // Omit the mimeType key when no candidate is supported (selectMimeType returns
    // ''): some engines throw on an empty mimeType, whereas omitting it takes the
    // UA-default codec path.
    const options = { videoBitsPerSecond: this.bitrateMbps * 1_000_000 };
    if (mimeType) options.mimeType = mimeType;
    const recorder = new MediaRecorder(stream, options);

    // Session-local capture state. stop() flips state synchronously but
    // ondataavailable/onstop fire later, so a fast stop→start can install a new
    // session on this.* before the old handlers run. Binding chunks/stream/
    // recorder/effectName in the closures (not reading this.* at fire time) keeps
    // a stale handler from touching the new session's state.
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
      // Clear shared instance state only if this is still the active session: a
      // rapid stop→start may have replaced it, and that session must survive.
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
      // Without requestFrame recording is a silent no-op; warn once (not per
      // frame) so the broken recording is visible without spamming the console.
      if (!this._warnedNoRequestFrame) {
        console.warn('Recorder: track.requestFrame is unavailable; recorded frames will not advance in this browser.');
        this._warnedNoRequestFrame = true;
      }
      return;
    }

    // Blit the source into the offscreen buffer (dimensions pinned at start()), so
    // a mid-recording resize scales into the fixed buffer rather than resizing the
    // track (most H.264/VP9 encoders reject a mid-stream size change).
    // Skip the blit at a transient 0x0 source (mid-resize): drawImage from a
    // zero-sized source throws or injects a blank/wrong-aspect frame. The offscreen
    // keeps its prior contents, so requestFrame() re-emits the last good frame.
    if (this._offscreen && this._offCtx &&
        this.canvas.width > 0 && this.canvas.height > 0) {
      // Letterbox/pillarbox the source into the pinned offscreen so a resize that
      // changes the source aspect preserves geometry instead of stretching. A
      // matching aspect fills the destination rect exactly.
      const offW = this._offscreen.width, offH = this._offscreen.height;
      const srcAspect = this.canvas.width / this.canvas.height;
      const offAspect = offW / offH;
      let destW, destH;
      if (srcAspect > offAspect) {
        // Source is wider: fit to width, pillarbox/letterbox vertically.
        destW = offW;
        destH = Math.round(offW / srcAspect);
      } else {
        // Source is taller (or equal): fit to height, bars horizontally.
        destH = offH;
        destW = Math.round(offH * srcAspect);
      }
      const destX = Math.round((offW - destW) / 2);
      const destY = Math.round((offH - destH) / 2);
      // Clear first so the bars left by a shrunken dest rect are clean black.
      this._offCtx.clearRect(0, 0, offW, offH);
      this._offCtx.drawImage(this.canvas, destX, destY, destW, destH);
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
   * Creates the offscreen scaling canvas at the target height and the source
   * canvas's start-time aspect ratio, rounding both dimensions up to even values
   * (required by video codecs). Like _ensurePinnedOffscreen, it sizes only on
   * creation and never tracks a later source resize: the captured track's frame
   * size must stay fixed for the whole session, so a resized source scales into
   * this fixed buffer (captureFrame) rather than changing the track size.
   * @returns {HTMLCanvasElement} The offscreen canvas pinned to the target height.
   */
  _ensureOffscreen() {
    // Size only on creation, never resize — that pin keeps the track frame size
    // constant. _cleanup nulls it, so each session pins to its own start aspect.
    if (!this._offscreen) {
      // Clamp the aspect: an early/zero-size source layout makes it non-finite
      // (0 → Infinity, 0/0 → NaN), which would poison the canvas dimensions.
      const rawAspect = this.canvas.width / this.canvas.height;
      const aspect = Number.isFinite(rawAspect) && rawAspect > 0 ? rawAspect : 1;
      const w = Math.round(this.targetHeight * aspect);
      // Even dimensions (codecs require it).
      const evenW = w % 2 === 0 ? w : w + 1;
      const evenH = this.targetHeight % 2 === 0 ? this.targetHeight : this.targetHeight + 1;
      this._offscreen = document.createElement('canvas');
      this._offCtx = this._offscreen.getContext('2d');
      this._offscreen.width = evenW;
      this._offscreen.height = evenH;
    }
    return this._offscreen;
  }

  /**
   * Creates the native-resolution offscreen capture canvas, pinned to the source
   * canvas's dimensions at the moment of call (start of recording), rounded up to
   * even values (codecs require it). Like _ensureOffscreen this sizes once and
   * never tracks a later source resize, but at the native source size rather than
   * a scaled target height: the buffer keeps its start dimensions for the whole
   * session so the captured track's frame size stays fixed, and captureFrame
   * scales a resized source into it instead of changing the track size.
   * @returns {HTMLCanvasElement} The offscreen canvas pinned to the start-time source size.
   */
  _ensurePinnedOffscreen() {
    // Size only on creation, never resize: that is what "pinned" means. _cleanup
    // nulls it, so each session pins to its own start-time source size. Floor at
    // 1 so a zero/early source layout still yields a valid even dimension.
    if (!this._offscreen) {
      const srcW = this.canvas.width > 0 ? this.canvas.width : 1;
      const srcH = this.canvas.height > 0 ? this.canvas.height : 1;
      this._offscreen = document.createElement('canvas');
      this._offCtx = this._offscreen.getContext('2d');
      this._offscreen.width = srcW % 2 === 0 ? srcW : srcW + 1;
      this._offscreen.height = srcH % 2 === 0 ? srcH : srcH + 1;
    }
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

    // Reference showSaveFilePicker off `window`, not as a bare global, so a
    // missing API reads as `undefined` instead of a ReferenceError.
    if (typeof window.showSaveFilePicker === 'function') {
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
      const handle = await window.showSaveFilePicker({
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
      // Any other failure (expired activation → SecurityError, disk/write error)
      // would silently lose the recording; fall back to the anchor download.
      console.warn('VideoRecorder: picker save failed, falling back to anchor download', err);
      this._saveWithAnchor(blob, filename);
    }
  }

  /**
   * Legacy save path: triggers an anchor-click download and revokes the object
   * URL on a short timeout once the click has handed the blob to the browser's
   * download manager.
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

    // The click hands the blob to the download manager synchronously, so the URL
    // only needs to outlive the click. Revoke on a short timeout rather than an
    // <iframe> load event: an iframe pointed at a video blob can start inline
    // playback or never fire load, and can re-trigger the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    if (this._offscreen) {
      this._offscreen.width = 0;
      this._offscreen.height = 0;
      this._offscreen = null;
      this._offCtx = null;
    }
  }
}
