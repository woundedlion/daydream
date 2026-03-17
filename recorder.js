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
export class VideoRecorder {
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

  /** Returns true if the browser supports canvas recording. */
  static isSupported() {
    return typeof HTMLCanvasElement.prototype.captureStream === 'function'
      && typeof MediaRecorder !== 'undefined';
  }

  get isRecording() {
    return this.mediaRecorder !== null && this.mediaRecorder.state === 'recording';
  }

  /** Start or stop recording. Returns true if now recording. */
  toggle(effectName) {
    if (this.isRecording) {
      this.stop();
      return false;
    } else {
      this.start(effectName);
      return true;
    }
  }

  start(effectName = 'effect') {
    if (this.isRecording) return;

    if (!VideoRecorder.isSupported()) {
      console.error('VideoRecorder: captureStream or MediaRecorder is not supported in this browser.');
      return;
    }

    this._effectName = effectName;
    this.chunks = [];
    this.elapsedSeconds = 0;

    // Determine capture source: offscreen scaled canvas or native
    let captureSource = this.canvas;
    if (this.targetHeight) {
      captureSource = this._ensureOffscreen();
    }

    // Manual frame-request mode: framerate 0 means we control when frames are captured
    this.stream = captureSource.captureStream(0);
    this.track = this.stream.getVideoTracks()[0];

    // Build codec candidate list based on requested format
    const allMimeTypes = {
      mp4:  ['video/mp4;codecs=avc1'],
      webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
    };
    const candidates = this.format === 'mp4'  ? allMimeTypes.mp4
                     : this.format === 'webm' ? allMimeTypes.webm
                     : [...allMimeTypes.mp4, ...allMimeTypes.webm]; // 'auto'
    let mimeType = '';
    for (const mt of candidates) {
      if (MediaRecorder.isTypeSupported(mt)) {
        mimeType = mt;
        break;
      }
    }

    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType,
      videoBitsPerSecond: this.bitrateMbps * 1_000_000,
    });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    this.mediaRecorder.onstop = () => {
      this._download();
      this._cleanup();
    };

    this.mediaRecorder.start();
  }

  stop() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }
  }

  /** Call once per simulation frame to request a video frame. */
  captureFrame() {
    if (!this.isRecording || !this.track || typeof this.track.requestFrame !== 'function') return;

    // If using an offscreen canvas, blit the source canvas scaled to the target resolution
    if (this._offscreen && this._offCtx) {
      this._offCtx.drawImage(this.canvas, 0, 0, this._offscreen.width, this._offscreen.height);
    }

    this.track.requestFrame();
    this.elapsedSeconds += this.frameInterval;
  }

  /** Formatted elapsed time string (MM:SS). */
  get elapsedFormatted() {
    const total = Math.floor(this.elapsedSeconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /** Create or resize the offscreen scaling canvas. */
  _ensureOffscreen() {
    const aspect = this.canvas.width / this.canvas.height;
    const w = Math.round(this.targetHeight * aspect);
    // Ensure even dimensions (codecs require it)
    const evenW = w % 2 === 0 ? w : w + 1;
    const evenH = this.targetHeight % 2 === 0 ? this.targetHeight : this.targetHeight + 1;

    if (!this._offscreen) {
      this._offscreen = document.createElement('canvas');
      this._offCtx = this._offscreen.getContext('2d');
    }
    this._offscreen.width = evenW;
    this._offscreen.height = evenH;
    return this._offscreen;
  }

  /** Determine file extension from the recorded mimeType. */
  _extension() {
    const mime = this.mediaRecorder?.mimeType ?? '';
    if (mime.startsWith('video/mp4')) return 'mp4';
    return 'webm';
  }

  _download() {
    const ext = this._extension();
    const blob = new Blob(this.chunks, { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' });

    const now = new Date();
    const ts = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + '_'
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0');

    const filename = `${this._effectName}_${ts}.${ext}`;

    // Use showSaveFilePicker when available for a proper, deterministic download;
    // fall back to anchor-click with a load-event-based revoke.
    if (typeof showSaveFilePicker === 'function') {
      this._saveWithPicker(blob, filename);
    } else {
      this._saveWithAnchor(blob, filename);
    }
  }

  /** Modern File System Access API — deterministic write, no URL leak. */
  async _saveWithPicker(blob, filename) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'Video',
          accept: { [blob.type]: [`.${this._extension()}`] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (err) {
      // User cancelled the dialog — not an error
      if (err.name !== 'AbortError') console.error('VideoRecorder: save failed', err);
    }
  }

  /** Legacy fallback: anchor-click download with iframe-based revoke. */
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
    iframe.onload = () => {
      URL.revokeObjectURL(url);
      iframe.remove();
    };
    // Safety net: if the iframe never fires load (some browsers), revoke after 60 s.
    setTimeout(() => {
      URL.revokeObjectURL(url);
      iframe.remove();
    }, 60_000);
    document.body.appendChild(iframe);
  }

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
