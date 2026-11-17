/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { pixelToSpherical } from "./geometry.js";
import { isViewLive } from "./pixel_view.js";
import { FPS } from "./frame_constants.js";
import { LabelPool } from "./label_pool.js";
import {ensurePovSweep, updatePovSweep, sweepFraction,
  resetPovNow, resetPovOnNextFrame, setStrobeColumns} from './driver_pov.js';
import { setupContextLossHandling } from "./driver_context.js";
import { setupKeyboardOrbit, setupViewReset, resetView, cancelViewReset, keydown } from "./driver_input.js";
import { refreshLabels } from "./driver_labels.js";
import { renderMainView, renderPip, renderDisplayViews } from "./driver_views.js";
import { updateStats } from "./driver_capture.js";
import { setupDots } from "./driver_dots.js";
import { MOBILE_BREAKPOINT_PX } from "../shared/layout.js";

/** @typedef {Omit<THREE.InstancedBufferAttribute, 'array'> & {array: Uint16Array|null}} RgbAttribute */
/** @typedef {Omit<THREE.InstancedMesh, 'instanceColor'> & {instanceColor: RgbAttribute|null}} RgbMesh */
/** @typedef {import('../../generated/holosphere_wasm.js').ArenaMetrics} ArenaMetrics */

export { LabelPool } from "./label_pool.js";
export { dotDetailFor, MAX_DOT_SEGMENTS, MIN_DOT_SEGMENTS } from './dot_detail.js';

/**
 * Browser-side simulator: drives the three.js scene that renders the LED
 * sphere as instanced dots, on a fixed-timestep sim clock with on-demand
 * repainting. Holds all rendering config (camera, resolution, axes, PiP) and
 * the pixel color buffer alias.
 */
export class Daydream {
  /** @type {boolean} */
  contextLost = false;
  /** @type {HTMLElement|null} */
  contextLostDetail = null;
  /** @type {HTMLElement|null} */
  contextLostOverlay = null;
  /** @type {(event: Event) => void} */
  onContextLost = () => {};
  /** @type {() => void} */
  onContextRestored = () => {};
  /** @type {() => void} */
  onCanvasFocus = () => {};
  /** @type {() => void} */
  onCanvasBlur = () => {};
  /** @type {(event: KeyboardEvent) => void} */
  onCanvasKeyDown = () => {};
  /** @type {number} */
  viewResetFrame = 0;
  /** @type {HTMLElement|null} */
  resetViewButton = null;
  /** @type {() => void} */
  onResetView = () => {};
  /** @type {() => void} */
  onCancelViewReset = () => {};
  /** @type {{uCameraPos: {value: THREE.Vector3}, uCullThreshold: {value: number}, uColumnFillArc: {value: number}}|null} */
  cullUniforms = null;
  /** @type {THREE.SphereGeometry|null} */
  dotGeometry = null;
  /** @type {THREE.MeshBasicMaterial|null} */
  dotMaterial = null;
  static SCENE_ANTIALIAS = true;
  static SCENE_ALPHA = true;
  static SCENE_BACKGROUND_COLOR = 0x000000;

  static CAMERA_FOV = 20;
  static CAMERA_NEAR = 100;
  static CAMERA_FAR = 1000;
  static CAMERA_X = 0;
  static CAMERA_Y = 0;
  static CAMERA_Z = 220;

  // Keyboard orbit: radians of rotation per arrow press, dolly factor per +/-.
  static KEY_ORBIT_STEP = Math.PI / 36;
  static KEY_ZOOM_STEP = 1.1;
  static VIEW_RESET_MS = 250;

  static SPHERE_RADIUS = 30;
  static COLUMN_FILL_OVERLAP = 1.15;
  // Rescaled by the live camera distance at use.
  static LABEL_VISIBILITY_FRAMING_RATIO = Daydream.SPHERE_RADIUS / Daydream.CAMERA_Z;
  static DEFAULT_H = 20;
  static DEFAULT_W = 96;
  static FPS = FPS;
  // Bounds the post-stall frame backlog (clock consumes one interval per frame).
  static MAX_FRAME_BACKLOG_SECONDS = 0.25;
  static DEFAULT_DOT_SIZE = 2;

  static X_AXIS = new THREE.Vector3(1, 0, 0);
  static Y_AXIS = new THREE.Vector3(0, 1, 0);
  static Z_AXIS = new THREE.Vector3(0, 0, 1);
  static NEG_X_AXIS = new THREE.Vector3(-1, 0, 0);
  static NEG_Y_AXIS = new THREE.Vector3(0, -1, 0);
  static NEG_Z_AXIS = new THREE.Vector3(0, 0, -1);

  /** Floating labels drawn at the axis poles while labelAxes is on. */
  static AXIS_LABELS = [
    { position: Daydream.X_AXIS, content: "X" },
    { position: Daydream.Y_AXIS, content: "Y" },
    { position: Daydream.Z_AXIS, content: "Z" },
    { position: Daydream.NEG_X_AXIS, content: "-X" },
    { position: Daydream.NEG_Y_AXIS, content: "-Y" },
    { position: Daydream.NEG_Z_AXIS, content: "-Z" },
  ];

  /**
   * Build the renderer, cameras, controls, scene, and axis lines, and wire up
   * resize/camera-change observers. Leaves the sim paused-capable and ready for
   * render() to be driven from an animation loop once a resolution is applied.
   * @param {Object} [dependencies] - Page seams, the same set start() threads
   *   through the rest of the app; a driver reads no globals of its own.
   * @param {Document} [dependencies.doc] - Document the canvas and overlays live in.
   * @param {Window & typeof globalThis} [dependencies.win] - Window the pixel
   *   ratio, the reload, the resize observer and the frame timer are read off.
   * @param {Navigator} [dependencies.nav] - Navigator carrying the webdriver flag.
   * @param {boolean} [dependencies.pipOnRight] - Anchor the PiP at the bottom right.
   * @param {Pick<import('../ui/global_stats_view.js').GlobalStatsView, 'update'|'clear'>|null} [dependencies.statsView] - Optional frame metrics view.
   */
  constructor({
    doc = globalThis.document,
    win = /** @type {Window & typeof globalThis} */ (globalThis),
    nav = globalThis.navigator,
    statsView = null,
    pipOnRight = false,
  } = {}) {
    THREE.ColorManagement.enabled = true;

    this.doc = doc;
    this.win = win;
    this.nav = nav;
    this.pipOnRight = pipOnRight;

    this.W = Daydream.DEFAULT_W;
    this.H = Daydream.DEFAULT_H;
    this.DISPLAY_NORTH_PHI = 0;
    this.DISPLAY_SOUTH_PHI = Math.PI;
    this.DOT_SIZE = Daydream.DEFAULT_DOT_SIZE;
    // Null until precomputeMatrices allocates a zeroed RGB16 placeholder;
    // the engine host then supplies the WASM view.
    /** @type {Uint16Array|null} */
    this.pixels = null;
    // Composed instance matrices per grid, keyed by resolution and latitude endpoints.
    /** @type {Map<string, Float32Array>} */
    this.matrixCache = new Map();

    const canvas = /** @type {HTMLCanvasElement|null} */ (this.doc.querySelector('#canvas'));
    const canvasParent = canvas?.parentElement;
    if (!canvas || !canvasParent) {
      throw new Error(canvas
        ? "Daydream: #canvas has no parent element to mount the renderer into"
        : "Daydream: #canvas element not found in the document");
    }

    this.canvas = canvas;
    this.canvasParent = canvasParent;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: Daydream.SCENE_ANTIALIAS,
      alpha: Daydream.SCENE_ALPHA,
    });

    // Cap at CSS resolution.
    this.renderer.setPixelRatio(Math.min(this.win.devicePixelRatio, 1));

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.setupContextLossHandling();

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = "labelLayer";
    this.canvasParent.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      Daydream.CAMERA_FOV,
      initialAspect(this.canvas),
      Daydream.CAMERA_NEAR,
      Daydream.CAMERA_FAR
    );

    this.pipCamera = this.camera.clone();

    // Before OrbitControls: its constructor snapshots the camera position as
    // position0, the pose reset() restores.
    this.camera.position.set(
      Daydream.CAMERA_X,
      Daydream.CAMERA_Y,
      Daydream.CAMERA_Z
    );

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.updateOrbitLimits();

    // On-demand rendering: a camera 'change' marks the frame dirty so an idle
    // scene does no GPU work. Starts dirty so the first frame always paints.
    this.needsRender = true;
    this.controls.addEventListener('change', () => { this.needsRender = true; });

    this.setupKeyboardOrbit();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(Daydream.SCENE_BACKGROUND_COLOR);
    this.paused = false;
    this.stepFrames = 0;
    // Injected video capture sink; null disables capture. Must expose
    // captureFrame(), abort(message), and an isRecording flag (which also
    // suppresses the PiP corner).
    /** @type {import('../recording/recorder.js').VideoRecorder|null} */
    this.recorder = null;
    // Captures owed by advanced ticks whose repaint a detached view held.
    this.heldCaptures = 0;

    this.clock = new THREE.Timer();
    this.clock.connect(this.doc);
    this.frameInterval = 1 / Daydream.FPS; // seconds per simulation frame
    this.timeAccumulator = 0;
    this.povFidelity = false;
    this.povResponseScale = 1;
    this.showSweepBoundary = false;
    /** @type {import('./pov_sweep.js').PovSweep|null} */
    this.povSweep = null;
    this.povResetPending = false;

    this.labelPool = new LabelPool(this.scene, Daydream.SPHERE_RADIUS, this.doc);

    // Built by updateResolution(); null means nothing to draw.
    /** @type {RgbMesh|null} */
    this.dotMesh = null;

    this.axisMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff
    });

    const axisLine = (/** @type {THREE.Vector3} */ axis) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        axis.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS * 0.95),
        axis.clone().multiplyScalar(Daydream.SPHERE_RADIUS * 0.95),
      ]);
      const line = new THREE.Line(geometry, this.axisMaterial);
      line.visible = false;
      this.scene.add(line);
      return line;
    };
    this.xAxis = axisLine(Daydream.X_AXIS);
    this.yAxis = axisLine(Daydream.Y_AXIS);
    this.zAxis = axisLine(Daydream.Z_AXIS);

    this.mainViewport = { x: 0, y: 0, width: 0, height: 0 };
    this.pipViewport = { x: 0, y: 0, width: 0, height: 0 };
    this.compactViewport = false;
    this.fittedDistance = 0;
    this.setCanvasSize();
    this.setupViewReset();

    this.resizeObserver = new this.win.ResizeObserver(() => {
      this.setCanvasSize();
    });
    this.resizeObserver.observe(this.canvasParent);

    this.labelAxes = false;
    this.cullBackSphere = true;
    this.showPip = true;
    this.noBlackColumns = false;

    this.statsView = statsView;
  }

  /** Bind canvas context-loss and restore handling. */
  setupContextLossHandling() {
    setupContextLossHandling(this);
  }

  /** Bind keyboard orbit controls. */
  setupKeyboardOrbit() {
    setupKeyboardOrbit(this, Daydream);
  }

  /** Bind the viewport reset button, double-click, and interruption listeners. */
  setupViewReset() {
    setupViewReset(this);
  }

  /** Return to the default orientation and center while preserving zoom. */
  resetView() {
    resetView(this, Daydream);
  }

  /** Cancel an in-flight return to the default orientation. */
  cancelViewReset() {
    cancelViewReset(this);
  }

  /** Handle playback and preset keys.
   * @param {KeyboardEvent} e - Key event.
   * @param {(delta: number) => boolean} [movePreset] - Preset selector. */
  keydown(e, movePreset = () => false) {
    keydown(this, e, movePreset);
  }

  /**
   * Fit renderer, label layer, and both cameras to the container size. Sizes the
   * square PiP viewport to 30% of the smaller dimension, marks the viewport
   * compact at or below MOBILE_BREAKPOINT_PX (using window width for a right
   * PiP), and
   * re-fits the camera distance while it still equals the previous fit, so the
   * sphere fills ~85% of the view. User zoom is preserved.
   */
  setCanvasSize() {
    const container = this.canvasParent;
    const width = container.clientWidth;
    const height = container.clientHeight;
    // Skip a 0×0 container: aspect = 0/0 = NaN would poison the projection matrix.
    // The ResizeObserver re-invokes once laid out.
    if (width <= 0 || height <= 0) return;
    this.compactViewport = (this.pipOnRight ? this.win.innerWidth : width) <= MOBILE_BREAKPOINT_PX;
    this.mainViewport.x = 0;
    this.mainViewport.y = 0;
    this.mainViewport.width = width;
    this.mainViewport.height = height;

    const pipSize = Math.floor(Math.min(width, height) * PIP_FRACTION);
    this.pipViewport.x = this.pipOnRight ? width - pipSize : 0;
    this.pipViewport.y = 0;
    this.pipViewport.width = pipSize;
    this.pipViewport.height = pipSize;

    this.pipCamera.aspect = 1.0;
    this.pipCamera.updateProjectionMatrix();

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // Preserve user zoom; refit only while the radius equals the previous fit.
    const orbitOffset = this.camera.position.clone().sub(this.controls.target);
    const orbitRadius = orbitOffset.length();
    if (
      this.fittedDistance === 0 ||
      Math.abs(orbitRadius - this.fittedDistance) < 1e-3 * this.fittedDistance
    ) {
      this.fittedDistance = fitDistance(
        this.camera.aspect,
        this.controls.minDistance,
        this.controls.maxDistance
      );
      orbitOffset.setLength(this.fittedDistance);
      this.camera.position.copy(this.controls.target).add(orbitOffset);
    }

    this.renderer.setPixelRatio(Math.min(this.win.devicePixelRatio, 1));
    this.renderer.setSize(width, height);
    this.labelRenderer.setSize(width, height);

    this.needsRender = true;
  }

  /** Queues one simulation step and requests a repaint. */
  stepOnce() {
    this.stepFrames = Math.max(1, this.stepFrames);
    this.invalidate();
  }

  /**
   * Request a repaint on the next animation frame. Required after any visible
   * scene change that neither advances the simulation nor moves the camera.
   */
  invalidate() {
    this.needsRender = true;
  }

  /**
   * Animation-loop body, called once per animation frame with the active render
   * adapter. Advances the fixed-timestep simulation if an interval has accrued,
   * updates controls, and repaints the main view, labels, and PiP — but only
   * when the sim stepped, the camera moved, or invalidate() was called. Hands
   * this.recorder each newly completed frame the adapter reports capture-ready.
   * @param {{drawFrame: () => void, sync?: (advanced: boolean) => void,
   *   getArenaMetrics?: () => ArenaMetrics|null, captureReady?: (advanced: boolean) => boolean,
   *   refreshPixelView?: () => void, retainsDisplay?: () => boolean}} adapter - Per-frame render adapter:
   *   drawFrame() paints the pixel buffer,
   *   sync(advanced) reconciles the effect panel and is told whether the sim
   *   stepped this frame, getArenaMetrics() feeds the stats
   *   overlay, captureReady() gates the recorder, and retainsDisplay() preserves
   *   the displayed frame until its replacement is ready. Optional methods default
   *   to permissive when absent.
   */
  render(adapter) {
    if (this.contextLost) return;

    ensurePovSweep(this);

    // A pending single-step must fire immediately, even while paused and before
    // the fixed-timestep clock has accrued a full interval; the frame clock still
    // advances once per frame either way.
    const previousSweepTime = this.timeAccumulator;
    const clockReady = this.advanceFrameClock();
    const advanced =
      (clockReady || this.stepFrames !== 0) && this.stepSimulation(adapter);
    const captureReady = typeof adapter?.captureReady === 'function'
      ? adapter.captureReady(advanced) : advanced;
    const panelDue = updatePovSweep(this, advanced, captureReady, previousSweepTime, adapter);
    if (panelDue) adapter?.sync?.(advanced);

    // Services live pointer interaction; emits 'change' (→ needsRender).
    this.controls.update();

    if (!advanced && !this.needsRender) return;
    this.needsRender = false;

    const captureDue = this.recorder?.isRecording === true && captureReady;

    // Three throws if an attribute's array byteLength differs from the size it gave
    // the GPU buffer, and a mid-frame heap growth detaches the aliased instanceColor
    // array (byteLength 0). needsUpdate only ever bumps version, so a flagged upload
    // cannot be cancelled — refresh the alias before retrying the repaint.
    if (this.dotMesh?.instanceColor && !isViewLive(this.dotMesh.instanceColor.array)) {
      adapter?.refreshPixelView?.();
      // The tick advanced and cannot be un-run, and the track is locked one frame
      // per tick. Capturing here would blit a canvas this task never painted (the
      // compositor already cleared it), so carry the frame to the next repaint.
      if (captureDue) this.heldCaptures++;
      this.needsRender = true;
      return;
    }

    const colorAttribute = this.dotMesh?.instanceColor;
    const sourcePixels = colorAttribute?.array;
    if (this.povSweep && colorAttribute) {
      const fraction = sweepFraction(this.timeAccumulator, this.frameInterval);
      const pixels = this.povSweep.visualPixels(fraction, this.povResponseScale);
      colorAttribute.array = this.povSweep.displayPixels(this.showSweepBoundary, pixels);
      colorAttribute.needsUpdate = true;
    }
    try {
      renderDisplayViews(this, captureDue);
    } finally {
      if (this.povSweep && colorAttribute)
        colorAttribute.array = /** @type {Uint16Array|null} */ (sourcePixels);
    }
  }

  /**
   * Fixed-timestep gate. Accumulates real elapsed time (clamped to avoid a
   * spiral-of-death after a stall) and consumes one frame interval only when
   * enough has accrued to advance a frame. Backlog beyond the clamp is dropped,
   * not replayed: at most one frame advances per call. POV fidelity drops overdue
   * whole intervals and retains the current sweep phase.
   * @returns {boolean} True when a frame interval was consumed and the sim should advance.
   */
  advanceFrameClock() {
    this.clock.update();
    const delta = this.clock.getDelta();
    // Drain getDelta each frame but don't accrue while paused, so unpause neither
    // stalls on an emptied accumulator nor replays the paused span as backlog.
    if (this.paused) return false;
    this.timeAccumulator += delta;
    if (this.povFidelity) {
      if (this.timeAccumulator < this.frameInterval) return false;
      this.timeAccumulator %= this.frameInterval;
      return true;
    }
    if (this.timeAccumulator > Daydream.MAX_FRAME_BACKLOG_SECONDS)
      this.timeAccumulator = Daydream.MAX_FRAME_BACKLOG_SECONDS;
    if (this.timeAccumulator < this.frameInterval) return false;
    this.timeAccumulator -= this.frameInterval;
    return true;
  }

  /**
   * Advance the simulation one frame when running or single-stepping: clear the
   * pixel buffer, draw the effect, refresh stats.
   * @param {{drawFrame: () => void, retainsDisplay?: () => boolean, getArenaMetrics?: () => ArenaMetrics|null}} adapter - Render adapter whose drawFrame() paints the pixel buffer.
   * @returns {boolean} Whether the simulation actually advanced (false while paused without a queued step), so the caller can gate the recorder on the same decision.
   */
  stepSimulation(adapter) {
    const advanced = !this.paused || this.stepFrames !== 0;
    if (!advanced) return false;

    if (this.stepFrames !== 0) this.stepFrames--;

    // A WASM-detached Uint16Array is still truthy but fill() on it throws; the
    // next drawFrame heals the view.
    if (isViewLive(this.pixels) && !adapter?.retainsDisplay?.())
      this.pixels.fill(0);

    const start = this.win.performance.now();
    if (adapter) {
      adapter.drawFrame();
    }
    const duration = this.win.performance.now() - start;

    this.updateStats(duration, adapter);

    // drawFrame() and updateStats() both call into WASM after the view heal, so a
    // heap growth can detach the array instanceColor aliases.
    const instanceColor = this.dotMesh?.instanceColor;
    if (instanceColor && isViewLive(instanceColor.array))
      instanceColor.needsUpdate = true;

    return true;
  }

  /** Replace POV history with the current displayed pixels. */
  resetPovNow() {
    resetPovNow(this);
  }

  /** Replace POV history when the next complete effect frame is displayed. */
  resetPovOnNextFrame() {
    resetPovOnNextFrame(this);
  }

  /** Refresh axis labels. */
  refreshLabels() {
    refreshLabels(this, Daydream);
  }

  /**
   * Push the current camera position / cull mode into the backface-cull shader
   * uniforms.
   */
  updateCullUniforms() {
    if (this.cullUniforms) {
      this.cullUniforms.uCameraPos.value.copy(this.camera.position);
      this.cullUniforms.uCullThreshold.value = this.cullBackSphere
        ? -this.DOT_SIZE / Daydream.SPHERE_RADIUS
        : -2.0;
      this.cullUniforms.uColumnFillArc.value = this.noBlackColumns
        ? Daydream.COLUMN_FILL_OVERLAP * Math.PI * Daydream.SPHERE_RADIUS / this.W
        : 0;
    }
  }

  /**
   * Apply an effect's default column layout; the view control may override it.
   * @param {boolean} strobe - true to strobe columns, false to persist/smear.
   */
  setStrobeColumns(strobe) {
    setStrobeColumns(this, strobe);
  }

  /** Render the main sphere viewport. */
  renderMainView() {
    renderMainView(this);
  }

  /** Render the picture-in-picture viewport. */
  renderPip() {
    renderPip(this);
  }

  /** Dispose the dot mesh after detaching its WASM-aliased instanceColor array. */
  releaseDotMesh() {
    if (!this.dotMesh) return;
    this.scene.remove(this.dotMesh);
    this.dotMesh.geometry?.dispose();
    // instanceColor.array may alias WASM memory.
    if (this.dotMesh.instanceColor) this.dotMesh.instanceColor.array = null;
    this.dotMesh.dispose();
    this.dotMesh = null;
  }

  /** Build the pixel dot mesh. */
  setupDots() {
    setupDots(this);
  }

  /**
   * Compute each dot's instance matrix: map its pixel (x,y) to a point on the
   * sphere and orient the dot to face outward from the center. Also allocates
   * zeroed instanceColor placeholder, replaced by the view from the engine host.
   *
   * Placements are cached by grid dimensions and LED-center latitude endpoints.
   * @param {boolean} [resetColors=true] - Allocate colors for a new pixel grid.
   */
  precomputeMatrices(resetColors = true) {
    const mesh = /** @type {RgbMesh} */ (this.dotMesh);
    const count = this.W * this.H;
    const key = `${this.W}x${this.H}x${this.DISPLAY_NORTH_PHI}x${this.DISPLAY_SOUTH_PHI}`;
    let matrices = this.matrixCache.get(key);

    if (!matrices) {
      const dummy = new THREE.Object3D();
      const composed = new Float32Array(count * 16);
      const vector = new THREE.Vector3();
      const sph = new THREE.Spherical(); // reused scratch out-param

      for (let i = 0; i < count; i++) {
        const x = i % this.W;
        const y = Math.floor(i / this.W);

        vector.setFromSpherical(pixelToSpherical(x, y, this, sph));
        vector.multiplyScalar(Daydream.SPHERE_RADIUS);

        dummy.position.set(0, 0, 0);
        dummy.lookAt(vector);
        dummy.position.copy(vector);
        dummy.updateMatrix();

        dummy.matrix.toArray(composed, i * 16);
      }
      this.matrixCache.set(key, composed);
      matrices = composed;
    }
    mesh.instanceMatrix.array.set(matrices);

    if (resetColors) {
      const needed = mesh.count * 3;
      mesh.instanceColor = /** @type {RgbAttribute} */ (new THREE.InstancedBufferAttribute(
        new Uint16Array(needed), 3, true
      ));
      mesh.instanceColor.setUsage(THREE.StreamDrawUsage);
      this.pixels = mesh.instanceColor.array;
      if (isViewLive(this.pixels)) this.pixels.fill(0);
      mesh.instanceColor.needsUpdate = true;
    }

    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Apply LED-center latitudes and discard placements from the previous profile.
   * @param {{DISPLAY_NORTH_PHI:number, DISPLAY_SOUTH_PHI:number}} geometry
   * @returns {void}
   */
  setDisplayGeometry(geometry) {
    if (this.DISPLAY_NORTH_PHI === geometry.DISPLAY_NORTH_PHI
        && this.DISPLAY_SOUTH_PHI === geometry.DISPLAY_SOUTH_PHI) return;
    Object.assign(this, geometry);
    this.matrixCache.clear();
    if (this.dotMesh) this.precomputeMatrices(false);
    this.invalidate();
  }

  /** Update the stats overlay.
   * @param {number} duration - Frame draw time in milliseconds.
   * @param {{getArenaMetrics?: () => ArenaMetrics|null}} adapter - Render adapter. */
  updateStats(duration, adapter) {
    return updateStats(this, duration, adapter);
  }

  /** Updates the zoom bounds to keep dot caps inside the clipping planes. */
  updateOrbitLimits() {
    const extent = Daydream.SPHERE_RADIUS + this.DOT_SIZE + 0.01;
    this.controls.minDistance = Daydream.CAMERA_NEAR + extent;
    this.controls.maxDistance = Daydream.CAMERA_FAR - extent;
    this.controls.update();
  }

  /**
   * Change the sphere's pixel grid to `w`x`h` with the given dot size, then
   * rebuild the dot mesh and its instance matrices/color buffer.
   * @param {number} w - New grid width in pixels.
   * @param {number} h - New grid height in pixels.
   * @param {number} dotSize - New dot radius in scene units.
   */
  updateResolution(w, h, dotSize) {
    this.W = w;
    this.H = h;
    this.DOT_SIZE = dotSize;
    this.updateOrbitLimits();

    this.setupDots();

    this.precomputeMatrices();

    // The rebuilt color buffer is zeroed; without a repaint the pre-resize image
    // stays on screen while paused.
    this.invalidate();
  }

  /**
   * Drive `frame` once per animation frame, until dispose() stops the loop.
   * @param {() => void} frame - Per-frame callback.
   * @returns {void}
   */
  startFrameLoop(frame) {
    this.renderer.setAnimationLoop(frame);
  }

  /**
   * Release everything this instance owns and undo what it put on the page: the
   * animation loop, the ResizeObserver, the simulation timer, the context-loss
   * and canvas-keyboard listeners, the WebGL program/geometry/material
   * resources and drawing context, the OrbitControls, and the label and
   * context-lost layers. A fresh instance requires a new canvas: this method
   * loses the old context.
   */
  dispose() {
    // Stop the rAF callback first so it never fires into the nulled dotMesh /
    // disposed renderer on a real page discard.
    const renderer = this.renderer;
    renderer?.setAnimationLoop(null);
    // Three re-arms rAF after an in-progress callback returns.
    if (renderer) queueMicrotask(() => renderer.setAnimationLoop(null));
    this.statsView?.clear();
    this.resizeObserver?.disconnect();
    this.clock?.dispose();

    if (this.onContextLost) {
      this.canvas.removeEventListener(
        "webglcontextlost", this.onContextLost, false);
      this.canvas.removeEventListener(
        "webglcontextrestored", /** @type {EventListener} */ (this.onContextRestored), false);
    }
    this.contextLostOverlay?.remove();

    if (this.onResetView) {
      this.cancelViewReset();
      this.resetViewButton?.removeEventListener('click', this.onResetView);
      this.canvas.removeEventListener('dblclick', this.onResetView);
    }
    if (this.onCancelViewReset) {
      this.canvas.removeEventListener('keydown', this.onCancelViewReset);
      this.controls.removeEventListener('start', this.onCancelViewReset);
    }

    if (this.onCanvasKeyDown) {
      this.canvas.removeEventListener("keydown", this.onCanvasKeyDown);
      this.canvas.removeEventListener("focus", /** @type {EventListener} */ (this.onCanvasFocus));
      this.canvas.removeEventListener("blur", /** @type {EventListener} */ (this.onCanvasBlur));
      // The canvas outlives the driver.
      this.canvas.classList.remove("keyboard-focus");
    }

    this.releaseDotMesh();
    this.pixels = null;
    this.povSweep = null;
    // Injected sink; not disposed here.
    this.recorder = null;
    this.matrixCache.clear();
    this.dotMaterial?.dispose();
    this.dotMaterial = null;

    for (const axis of [this.xAxis, this.yAxis, this.zAxis]) {
      if (!axis) continue;
      this.scene.remove(axis);
      axis.geometry?.dispose();
    }
    this.axisMaterial?.dispose();

    this.controls?.dispose();
    this.labelRenderer?.domElement?.remove();
    this.renderer?.dispose();
    // dispose() frees the GPU objects but keeps the drawing context, which the
    // browser caps at ~16 per page; only a context loss hands it back.
    this.renderer?.forceContextLoss();
  }
}

/**
 * Camera aspect for a canvas the page has not laid out yet.
 *
 * Both dimensions must be positive: width/0 yields a truthy Infinity that slips
 * past a `|| 1` guard and poisons the projection matrix.
 * @param {{width: number, height: number}} canvas - The render canvas.
 * @returns {number} width/height, or 1 while either dimension is still 0.
 */
export const initialAspect = (canvas) =>
  canvas.width > 0 && canvas.height > 0 ? canvas.width / canvas.height : 1;

/** Fraction of the smaller viewport dimension the square PiP spans. */
export const PIP_FRACTION = 0.3;

/** Fraction of the smaller view dimension the fitted sphere fills. */
export const SPHERE_FIT_COVERAGE = 0.85;

/**
 * Orbit radius at which the sphere fills `SPHERE_FIT_COVERAGE` of the smaller
 * view dimension, clamped into the orbit-control range.
 * @param {number} aspect - Viewport aspect ratio (width / height).
 * @param {number} minDistance - Closest orbit radius the controls allow.
 * @param {number} maxDistance - Farthest orbit radius the controls allow.
 * @returns {number} Clamped camera distance from the sphere center.
 */
export const fitDistance = (aspect, minDistance, maxDistance) => {
  const diameter = Daydream.SPHERE_RADIUS * 2;
  const fovRad = THREE.MathUtils.degToRad(Daydream.CAMERA_FOV / 2);
  const distForHeight = diameter / (2 * Math.tan(fovRad) * SPHERE_FIT_COVERAGE);
  const distForWidth = distForHeight / aspect;
  return THREE.MathUtils.clamp(
    Math.max(distForHeight, distForWidth), minDistance, maxDistance);
};
