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

// Chunk-delivery interval for MediaRecorder.start(); bounds encoder buffering.
const RECORDER_TIMESLICE_MS = 1000;

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
    this.frameInterval = frameInterval;
    this.elapsedSeconds = 0;
    // bitrateMbps, format, and targetHeight are latched at start().
    this.bitrateMbps = 16;
    this.format = 'auto';
    this.targetHeight = null;
    this.offscreen = null;
    this.offCtx = null;
    // Host hook fired whenever a session ends without the host asking for it: a
    // failure to start, an encoder fault, or a cancelled Save dialog. The reason is
    // passed so the UI can report it, and the UI drops its recording state; the
    // record button's label is set on click and would otherwise keep reading "Stop"
    // over a dead session.
    this.onError = null;
    // Host hook fired when an explicit format falls back to the browser's
    // default container. Receives the actual file extension.
    this.onFormatFallback = null;
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
   * Reports a failure that ends a session before it produces video: logs it and
   * notifies the host hook, so an abort is not console-only.
   * @param {string} message - Failure description, logged with the class prefix.
   * @param {*} [cause] - Underlying error, when the failure came from a throw.
   * @returns {void}
   */
  reportFailure(message, cause) {
    if (cause === undefined) console.error(`VideoRecorder: ${message}`);
    else console.error(`VideoRecorder: ${message}`, cause);
    this.onError?.(cause instanceof Error ? cause : new Error(message));
  }

  /**
   * Begins a recording session. No-op if already recording or unsupported.
   * @param {string} effectName - Base name used for the downloaded file.
   * @returns {void}
   */
  start(effectName = 'effect') {
    if (this.isRecording) return;

    if (!VideoRecorder.isSupported()) {
      this.reportFailure('captureStream or MediaRecorder is not supported in this browser.');
      return;
    }

    this.elapsedSeconds = 0;

    // Each session pins its capture size at start. Drop an offscreen left by a
    // prior session whose async onstop cleanup has not run yet, so a resolution
    // change between stop and start re-sizes instead of encoding at stale dims.
    if (this.offscreen) {
      this.offscreen.width = 0;
      this.offscreen.height = 0;
      this.offscreen = null;
      this.offCtx = null;
    }

    const captureSource = this.ensureOffscreen();

    if (!this.offCtx) {
      this.cleanup();
      this.reportFailure('failed to acquire a 2D drawing context for the capture canvas; recording aborted.');
      return;
    }

    // framerate 0: manual frame-request mode, frames are captured on
    // requestFrame(). Browsers without requestFrame would record an empty video
    // in that mode, so fall back to a timed captureStream at the frame rate.
    let stream, track;
    try {
      stream = captureSource.captureStream(0);
      track = stream.getVideoTracks()[0];
      if (typeof track?.requestFrame !== 'function') {
        stream.getTracks().forEach(t => t.stop());
        const fps = Math.max(1, Math.round(1 / this.frameInterval));
        stream = captureSource.captureStream(fps);
        track = stream.getVideoTracks()[0];
      }
    } catch (err) {
      if (stream) stream.getTracks().forEach(t => t.stop());
      this.cleanup();
      this.reportFailure('captureStream failed; recording aborted.', err);
      return;
    }

    // No video track means captureFrame would silently no-op the whole session
    // (it guards on !this.track); surface it instead of recording nothing.
    if (!track) {
      stream.getTracks().forEach(t => t.stop());
      this.cleanup();
      this.reportFailure('capture stream produced no video track; recording aborted.');
      return;
    }

    const mimeType = selectMimeType(this.format);

    // An explicitly-chosen container with no supported codec means we fall back
    // to the browser default below; warn so the format choice isn't silently ignored.
    if (!mimeType && this.format !== 'auto') {
      console.warn(`VideoRecorder: requested format "${this.format}" is unsupported; using the browser default.`);
    }

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
      this.cleanup();
      this.reportFailure('MediaRecorder construction failed.', err);
      return;
    }
    if (!mimeType && this.format !== 'auto') {
      this.onFormatFallback?.(this.extension(recorder));
    }

    // ondataavailable/onstop/onerror fire after a fast stop→start may have installed
    // a new session, so the closures bind the per-session chunks/stream/recorder/sink
    // rather than read this.*.
    const chunks = [];
    let sink = null;
    let ended = false;

    // Finalizes the output and releases the capture tracks; runs once per session
    // whether it ended normally or on an encoder fault.
    const endSession = () => {
      if (ended) return;
      ended = true;
      sink?.finish();
      stream.getTracks().forEach(t => t.stop());
      // Only clean up if a rapid stop→start hasn't already replaced this session.
      if (this.mediaRecorder === recorder) this.cleanup();
    };

    this.mediaRecorder = recorder;
    this.stream = stream;
    this.track = track;
    // Alias of the live session buffer; the recorder never reads it back, it exists
    // so the active buffer is observable from outside.
    this.chunks = chunks;

    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      // sink is assigned below, after start(); a chunk arriving before that goes
      // to the fallback buffer, which every sink's finish() drains.
      if (sink) sink.write(e.data);
      else chunks.push(e.data);
    };

    recorder.onstop = endSession;

    // A fatal encoder fault ends the session without a guaranteed stop event, so
    // finalize here rather than leaving a dead recorder installed.
    recorder.onerror = (e) => {
      const live = this.mediaRecorder === recorder;
      const cause = e?.error ?? e;
      const error = cause instanceof Error
        ? cause
        : new Error('recording failed; the saved file may be truncated or incomplete.');
      recorder.ondataavailable = null;
      if (recorder.state !== 'inactive') recorder.stop();
      endSession();
      console.error('VideoRecorder: recording failed; the saved file may be truncated or incomplete.',
        cause);
      if (live) this.onError?.(error);
    };

    // Timeslice so ondataavailable delivers chunks incrementally; without it the
    // encoder buffers the whole recording in memory until stop().
    try {
      recorder.start(RECORDER_TIMESLICE_MS);
    } catch (err) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      this.cleanup();
      this.reportFailure('MediaRecorder start failed.', err);
      return;
    }

    try {
      sink = this.openSink(recorder, effectName, chunks);
      const pending = chunks.splice(0);
      for (const chunk of pending) sink.write(chunk);
    } catch (err) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      recorder.stop();
      this.cleanup();
      this.reportFailure('output setup failed.', err);
    }
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
   * Ends an active session on an external fault (e.g. a lost WebGL context, after
   * which the source canvas produces no more frames): the onstop handler still
   * flushes the partial file, and the host hook fires so the UI drops its
   * recording state instead of offering to stop a session that is frozen.
   * @param {string} message - Failure description, logged and sent to the host hook.
   * @returns {void}
   */
  abort(message) {
    if (!this.isRecording) return;
    this.stop();
    this.reportFailure(message);
  }

  /**
   * Requests a single video frame; call once per simulation frame, from the same
   * task that rendered it — the source is a WebGL canvas without
   * preserveDrawingBuffer, so a blit after compositing reads transparent black.
   * When an offscreen scaling canvas is in use, blits the source canvas into it
   * (scaled to the target resolution) before requesting the frame, and advances
   * the elapsed-time counter by one frame interval.
   * @returns {void}
   */
  captureFrame() {
    if (!this.isRecording || !this.track) return;
    this.blitToOffscreen();
    // Timed-fallback tracks have no requestFrame; the stream samples on its own.
    if (typeof this.track.requestFrame === 'function') this.track.requestFrame();
    this.elapsedSeconds += this.frameInterval;
  }

  /**
   * Letterbox/pillarbox-blits the source canvas into the pinned offscreen. No-op
   * at a transient 0x0 source (mid-resize): drawImage from a zero-sized source
   * throws, so the offscreen keeps its prior good frame.
   * @returns {void}
   */
  blitToOffscreen() {
    if (!this.offscreen || !this.offCtx ||
        this.canvas.width <= 0 || this.canvas.height <= 0) return;
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

  /**
   * Elapsed recording time as a formatted string. Counts captured frames
   * (frameInterval each), so it tracks the manual requestFrame path exactly; on
   * the timed-fallback path (a track without requestFrame, which encodes on the
   * wall clock) it can drift from the encoded file's real duration.
   * @returns {string} The elapsed time in M:SS form (seconds zero-padded).
   */
  get elapsedFormatted() {
    const total = Math.floor(this.elapsedSeconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Creates the offscreen capture canvas, at the target height and the source
   * canvas's start-time aspect ratio when a targetHeight is set, otherwise at the
   * source's start-time native size; both dimensions round up to even values
   * (required by video codecs). It sizes only on creation and never tracks a later
   * source resize: the captured track's frame size must stay fixed for the whole
   * session, so a resized source scales into this fixed buffer (captureFrame)
   * rather than changing the track size.
   * @returns {HTMLCanvasElement} The offscreen canvas pinned to its start-time size.
   */
  ensureOffscreen() {
    if (!this.offscreen) {
      let w, h;
      if (this.targetHeight) {
        // Clamp a non-finite aspect (0 → Infinity, 0/0 → NaN) from a zero-size source.
        const rawAspect = this.canvas.width / this.canvas.height;
        const aspect = Number.isFinite(rawAspect) && rawAspect > 0 ? rawAspect : 1;
        w = Math.round(this.targetHeight * aspect);
        h = this.targetHeight;
      } else {
        w = this.canvas.width > 0 ? this.canvas.width : 1;
        h = this.canvas.height > 0 ? this.canvas.height : 1;
      }
      this.offscreen = document.createElement('canvas');
      this.offCtx = this.offscreen.getContext('2d');
      // A null 2d context must not latch the canvas; drop it so a later start()
      // retries creation rather than reusing a context-less buffer forever.
      if (!this.offCtx) {
        this.offscreen = null;
        return null;
      }
      this.offscreen.width = w % 2 === 0 ? w : w + 1;
      this.offscreen.height = h % 2 === 0 ? h : h + 1;
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
   * @returns {{write: (data: Blob) => void, finish: () => (void|Promise<void>)}} The
   *   session sink. The streaming variant's finish() returns the promise that
   *   settles once the file is flushed and closed; callers may ignore it.
   */
  openSink(recorder, effectName, chunks) {
    if (typeof globalThis.showSaveFilePicker !== 'function') {
      return {
        write: (data) => { chunks.push(data); },
        finish: () => { if (chunks.length) this.download(recorder, chunks, effectName); },
      };
    }

    const ext = this.extension(recorder);
    const filename = this.timestampedName(effectName, ext);

    let handle = null;
    let writable = null;
    let failed = false;
    let aborted = false;
    const opened = globalThis.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: 'Video', accept: { [this.mimeForExt(ext)]: [`.${ext}`] } }],
    })
      .then((h) => { handle = h; })
      .catch((err) => {
        if (err?.name === 'AbortError') {
          aborted = true;
          // Cancelling the Save dialog ends the session; without this the recorder
          // keeps capturing frames that finish() will only discard. Guard against a
          // superseding session: only stop if this recorder is still the live one.
          // The host hook fires too, or the UI stays latched on a dead session and
          // the next click starts a second recording instead of stopping this one.
          if (this.mediaRecorder === recorder) {
            this.stop();
            this.onError?.(err);
          }
        } else {
          console.warn('VideoRecorder: streaming save unavailable, buffering in memory', err);
        }
      });

    // One serialized chain; each link awaits the picker, so chunks that arrive
    // before the file opens are written in order once it does. The writable is
    // created on the first chunk, not at pick time, so a session that streams no
    // data never truncates the user's chosen file. A chunk that cannot stream
    // (picker cancelled/unavailable) falls back to the blob buffer.
    let chain = Promise.resolve();
    return {
      write: (data) => {
        chain = chain.then(async () => {
          await opened;
          // Save dialog cancelled: finish() discards the buffer, so drop chunks
          // instead of hoarding a whole recording that will be thrown away.
          if (aborted) return;
          // No file handle (picker unavailable, or createWritable failed):
          // buffer every chunk for the blob-download fallback.
          if (!handle) { chunks.push(data); return; }
          // A prior write errored the writable; stop feeding it.
          if (failed) return;
          if (!writable) {
            try {
              writable = await handle.createWritable();
            } catch (err) {
              console.warn('VideoRecorder: streaming save unavailable, buffering in memory', err);
              handle = null;
              chunks.push(data);
              return;
            }
          }
          try {
            await writable.write(data);
          } catch (err) {
            console.warn('VideoRecorder: streaming write failed', err);
            failed = true;
          }
        });
      },
      finish: () => {
        return chain
          .then(async () => {
            await opened;
            // User cancelled the Save dialog: honor Cancel and discard the
            // buffered chunks instead of writing to the default Downloads folder.
            if (aborted) return;
            // No writable opened — the picker was unavailable (chunks buffered)
            // or the session streamed no data (the chosen file was never
            // truncated). Download the buffer if there is one.
            if (!writable) {
              if (chunks.length) this.download(recorder, chunks, effectName);
              else console.warn('VideoRecorder: session produced no data; nothing to download');
              return;
            }
            // Mid-stream write failed: only the on-disk prefix is contiguous.
            // Flush it and report truncation rather than downloading the
            // post-failure tail as if it were a complete video.
            if (failed) {
              try { await writable.close(); } catch { /* writable already errored */ }
              console.error('VideoRecorder: streaming write failed mid-session; the saved file is truncated to the data written before the failure.');
              return;
            }
            // Streaming succeeded; a close() failure can still leave the file
            // unflushed/truncated, so report it rather than claiming success.
            try {
              await writable.close();
            } catch (err) {
              console.error('VideoRecorder: finalizing the streamed file failed; it may be truncated or incomplete.', err);
            }
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
   * @param {MediaRecorder} recorder - Recorder used to derive the extension.
   * @param {Blob[]} chunks - Captured data chunks.
   * @param {string} effectName - Base name for the file.
   * @returns {void}
   */
  download(recorder, chunks, effectName) {
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
    this.stop();
    this.cleanup();
  }
}
