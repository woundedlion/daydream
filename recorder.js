/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Records the WebGL canvas to a WebM video using MediaRecorder.
 * Uses captureStream(0) (manual frame-request mode) so frames are locked
 * to simulation ticks rather than wall-clock time.
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
    // Resolution override: target height in pixels (null = native)
    // Width is computed from the source canvas aspect ratio.
    this.targetHeight = null;
    // Offscreen scaling canvas (created on demand)
    this._offscreen = null;
    this._offCtx = null;
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

    this._effectName = effectName;
    this.chunks = [];
    this.elapsedSeconds = 0;

    // Determine capture source: offscreen scaled canvas or native
    let captureSource = this.canvas;
    if (this.targetHeight) {
      // Compute width preserving source aspect ratio
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
      captureSource = this._offscreen;
    }

    // Manual frame-request mode: framerate 0 means we control when frames are captured
    this.stream = captureSource.captureStream(0);
    this.track = this.stream.getVideoTracks()[0];

    // Pick best available codec
    const mimeTypes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    let mimeType = '';
    for (const mt of mimeTypes) {
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

  _download() {
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    const now = new Date();
    const ts = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + '_'
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0');

    a.href = url;
    a.download = `${this._effectName}_${ts}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Revoke after a short delay to ensure download starts
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  _cleanup() {
    this.mediaRecorder = null;
    this.chunks = [];
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.track = null;
  }
}
