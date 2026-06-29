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
// Chunk-delivery interval for MediaRecorder.start(); bounds encoder buffering.
const RECORDER_TIMESLICE_MS = 1000;

export function selectMimeType(
  format,
  isTypeSupported = (mt) => MediaRecorder.isTypeSupported(mt)) {
  const allMimeTypes = {
    mp4:  ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'],
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
    this.effectName = 'effect';
    this.frameInterval = frameInterval;
    this.elapsedSeconds = 0;
    // bitrateMbps, format, and targetHeight are latched at start().
    this.bitrateMbps = 16;
    this.format = 'auto';
    this.targetHeight = null;
    this.offscreen = null;
    this.offCtx = null;
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

    this.effectName = effectName;
    this.elapsedSeconds = 0;

    const captureSource = this.targetHeight
      ? this.ensureOffscreen()
      : this.ensurePinnedOffscreen();

    if (!this.offCtx) {
      console.error('VideoRecorder: failed to acquire a 2D drawing context for the capture canvas; recording aborted.');
      return;
    }

    // framerate 0: manual frame-request mode, frames are captured on
    // requestFrame(). Browsers without requestFrame would record an empty video
    // in that mode, so fall back to a timed captureStream at the frame rate.
    let stream = captureSource.captureStream(0);
    let track = stream.getVideoTracks()[0];
    if (typeof track?.requestFrame !== 'function') {
      stream.getTracks().forEach(t => t.stop());
      const fps = Math.max(1, Math.round(1 / this.frameInterval));
      stream = captureSource.captureStream(fps);
      track = stream.getVideoTracks()[0];
    }

    const mimeType = selectMimeType(this.format);

    // Omit the mimeType key entirely when empty: some engines throw on an empty one.
    const options = { videoBitsPerSecond: this.bitrateMbps * 1_000_000 };
    if (mimeType) options.mimeType = mimeType;
    let recorder;
    try {
      recorder = new MediaRecorder(stream, options);
    } catch (err) {
      // Construction can throw on unsupported options; stop the live capture
      // tracks so the stream doesn't leak.
      stream.getTracks().forEach(t => t.stop());
      console.error('VideoRecorder: MediaRecorder construction failed.', err);
      return;
    }

    // ondataavailable/onstop fire after a fast stop→start may have installed a new
    // session, so the closures bind the per-session chunks/stream/recorder/sink
    // rather than read this.*.
    const chunks = [];
    const sink = this.openSink(recorder, effectName, chunks);

    this.mediaRecorder = recorder;
    this.stream = stream;
    this.track = track;
    this.chunks = chunks;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) sink.write(e.data);
    };

    recorder.onstop = () => {
      sink.finish();
      stream.getTracks().forEach(t => t.stop());
      // Only clean up if a rapid stop→start hasn't already replaced this session.
      if (this.mediaRecorder === recorder) this.cleanup();
    };

    // Timeslice so ondataavailable delivers chunks incrementally; without it the
    // encoder buffers the whole recording in memory until stop().
    recorder.start(RECORDER_TIMESLICE_MS);
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

    // Skip the blit at a transient 0x0 source (mid-resize): drawImage from a
    // zero-sized source throws. The offscreen keeps its prior good frame.
    if (this.offscreen && this.offCtx &&
        this.canvas.width > 0 && this.canvas.height > 0) {
      // Letterbox/pillarbox the source into the pinned offscreen.
      const offW = this.offscreen.width, offH = this.offscreen.height;
      const srcAspect = this.canvas.width / this.canvas.height;
      const offAspect = offW / offH;
      let destW, destH;
      if (srcAspect > offAspect) {
        destW = offW;
        destH = Math.round(offW / srcAspect);
      } else {
        destH = offH;
        destW = Math.round(offH * srcAspect);
      }
      const destX = Math.round((offW - destW) / 2);
      const destY = Math.round((offH - destH) / 2);
      this.offCtx.clearRect(0, 0, offW, offH);
      this.offCtx.drawImage(this.canvas, destX, destY, destW, destH);
    }

    // Timed-fallback tracks have no requestFrame; the stream samples on its own.
    if (typeof this.track.requestFrame === 'function') this.track.requestFrame();
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
   * (required by video codecs). Like ensurePinnedOffscreen, it sizes only on
   * creation and never tracks a later source resize: the captured track's frame
   * size must stay fixed for the whole session, so a resized source scales into
   * this fixed buffer (captureFrame) rather than changing the track size.
   * @returns {HTMLCanvasElement} The offscreen canvas pinned to the target height.
   */
  ensureOffscreen() {
    if (!this.offscreen) {
      // Clamp a non-finite aspect (0 → Infinity, 0/0 → NaN) from a zero-size source.
      const rawAspect = this.canvas.width / this.canvas.height;
      const aspect = Number.isFinite(rawAspect) && rawAspect > 0 ? rawAspect : 1;
      const w = Math.round(this.targetHeight * aspect);
      const evenW = w % 2 === 0 ? w : w + 1;
      const evenH = this.targetHeight % 2 === 0 ? this.targetHeight : this.targetHeight + 1;
      this.offscreen = document.createElement('canvas');
      this.offCtx = this.offscreen.getContext('2d');
      // A null 2d context must not latch the canvas; drop it so a later start()
      // retries creation rather than reusing a context-less buffer forever.
      if (!this.offCtx) {
        this.offscreen = null;
        return null;
      }
      this.offscreen.width = evenW;
      this.offscreen.height = evenH;
    }
    return this.offscreen;
  }

  /**
   * Creates the native-resolution offscreen capture canvas, pinned to the source
   * canvas's dimensions at the moment of call (start of recording), rounded up to
   * even values (codecs require it). Like ensureOffscreen this sizes once and
   * never tracks a later source resize, but at the native source size rather than
   * a scaled target height: the buffer keeps its start dimensions for the whole
   * session so the captured track's frame size stays fixed, and captureFrame
   * scales a resized source into it instead of changing the track size.
   * @returns {HTMLCanvasElement} The offscreen canvas pinned to the start-time source size.
   */
  ensurePinnedOffscreen() {
    if (!this.offscreen) {
      const srcW = this.canvas.width > 0 ? this.canvas.width : 1;
      const srcH = this.canvas.height > 0 ? this.canvas.height : 1;
      this.offscreen = document.createElement('canvas');
      this.offCtx = this.offscreen.getContext('2d');
      // A null 2d context must not latch the canvas; drop it so a later start()
      // retries creation rather than reusing a context-less buffer forever.
      if (!this.offCtx) {
        this.offscreen = null;
        return null;
      }
      this.offscreen.width = srcW % 2 === 0 ? srcW : srcW + 1;
      this.offscreen.height = srcH % 2 === 0 ? srcH : srcH + 1;
    }
    return this.offscreen;
  }

  /**
   * Builds the per-session data sink. With the File System Access API present,
   * streams each chunk straight to a user-chosen file as it arrives so a long
   * recording never buffers the whole video in RAM; otherwise it accumulates
   * chunks for a single blob download at stop. The save dialog is raised here
   * (under start()'s user gesture) so its transient activation is preserved.
   * @param {MediaRecorder} recorder - Session recorder, queried for its container type.
   * @param {string} effectName - Base name for the suggested file.
   * @param {Blob[]} chunks - Per-session buffer; the fallback path fills it, the
   *   streaming path leaves it empty (each chunk is released after its disk write).
   * @returns {{write: (data: Blob) => void, finish: () => void}} The session sink.
   */
  openSink(recorder, effectName, chunks) {
    if (typeof globalThis.showSaveFilePicker !== 'function') {
      return {
        write: (data) => { chunks.push(data); },
        finish: () => { this.download(recorder, chunks, effectName); },
      };
    }

    const ext = this.extension(recorder);
    const filename = this.timestampedName(effectName, ext);

    let writable = null;
    let failed = false;
    const opened = globalThis.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: 'Video', accept: { [this.mimeForExt(ext)]: [`.${ext}`] } }],
    })
      .then((handle) => handle.createWritable())
      .then((w) => { writable = w; })
      .catch((err) => {
        failed = true;
        if (err?.name !== 'AbortError')
          console.warn('VideoRecorder: streaming save unavailable, buffering in memory', err);
      });

    // One serialized chain; each link awaits the picker, so chunks that arrive
    // before the file opens are written in order once it does. A chunk that
    // cannot stream (picker cancelled/unavailable) falls back to the blob buffer.
    let chain = Promise.resolve();
    return {
      write: (data) => {
        chain = chain.then(async () => {
          await opened;
          if (failed || !writable) { chunks.push(data); return; }
          try {
            await writable.write(data);
          } catch (err) {
            // A mid-stream write rejection (disk full, handle revoked) would leave
            // the chain rejected and drop every later chunk; fall back to the
            // in-memory buffer so finish() can still download what remains.
            console.warn('VideoRecorder: streaming write failed, buffering in memory', err);
            failed = true;
            chunks.push(data);
          }
        });
      },
      finish: () => {
        chain
          .then(async () => {
            await opened;
            if (failed || !writable) { this.download(recorder, chunks, effectName); return; }
            await writable.close();
          })
          .catch((err) => {
            console.warn('VideoRecorder: streaming save failed', err);
            if (chunks.length) this.download(recorder, chunks, effectName);
          });
      },
    };
  }

  /**
   * Determines the output file extension from the recorder's MIME type, so the
   * filename matches the real container the browser chose.
   * @param {MediaRecorder} [recorder] - Recorder whose mimeType is inspected;
   *   defaults to the active recorder.
   * @returns {string} The container extension (e.g. 'mp4', 'webm', 'mkv'),
   *   falling back to 'webm' for an empty/unknown type.
   */
  extension(recorder = this.mediaRecorder) {
    const mime = recorder?.mimeType ?? '';
    const subtype = mime.split(';')[0].split('/')[1] ?? '';
    const EXT = { mp4: 'mp4', webm: 'webm', 'x-matroska': 'mkv', ogg: 'ogv' };
    return EXT[subtype] ?? (subtype || 'webm');
  }

  /**
   * Canonical container MIME type for a file extension, used for both the blob
   * type and the save picker's accept filter so the two never disagree.
   * @param {string} ext - File extension without dot.
   * @returns {string} The matching MIME type, defaulting to 'video/webm'.
   */
  mimeForExt(ext) {
    const MIME = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg' };
    return MIME[ext] ?? 'video/webm';
  }

  /**
   * Builds the download file name from the effect name, a local-time timestamp,
   * and the container extension.
   * @param {string} effectName - Base name for the file.
   * @param {string} ext - Container extension without the dot.
   * @returns {string} A name of the form `effect_YYYYMMDD_HHMMSS.ext`.
   */
  timestampedName(effectName, ext) {
    const now = new Date();
    const ts = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + '_'
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0');
    return `${effectName}_${ts}.${ext}`;
  }

  /**
   * Buffered fallback save: assembles captured chunks into a blob and downloads
   * it under a timestamped name via an anchor click. Used when the File System
   * Access API is unavailable; the streaming sink handles the file otherwise.
   * @param {MediaRecorder} [recorder] - Recorder used to derive the extension;
   *   defaults to the active recorder.
   * @param {Blob[]} [chunks] - Captured data chunks; defaults to the active chunks.
   * @param {string} [effectName] - Base name for the file; defaults to the stored name.
   * @returns {void}
   */
  download(recorder = this.mediaRecorder, chunks = this.chunks, effectName = this.effectName) {
    const ext = this.extension(recorder);
    const blob = new Blob(chunks, { type: this.mimeForExt(ext) });
    this.saveWithAnchor(blob, this.timestampedName(effectName, ext));
  }

  /**
   * Legacy save path: triggers an anchor-click download and revokes the object
   * URL on a short timeout once the click has handed the blob to the browser's
   * download manager.
   * @param {Blob} blob - The recorded video data to download.
   * @param {string} filename - File name applied to the download anchor.
   * @returns {void}
   */
  saveWithAnchor(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // The click consumes the blob synchronously; the URL only needs to outlive it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Releases the active session's recorder, stream tracks, and offscreen canvas.
   * @returns {void}
   */
  cleanup() {
    this.mediaRecorder = null;
    this.chunks = [];
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.track = null;
    if (this.offscreen) {
      this.offscreen.width = 0;
      this.offscreen.height = 0;
      this.offscreen = null;
      this.offCtx = null;
    }
  }

  /**
   * Stop any active recording and release the stream tracks and offscreen canvas.
   * Idempotent; call on teardown so a mid-recording discard does not leak the
   * captured stream/track (onstop, which normally cleans up, cannot flush on a
   * synchronous page discard).
   * @returns {void}
   */
  dispose() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }
    this.cleanup();
  }
}
