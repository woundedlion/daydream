/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { pixelToSpherical } from "./geometry.js";
import { isViewLive } from "./pixel_view.js";
import { FPS } from "./frame_constants.js";
import { GlobalStatsView } from "./global_stats_view.js";

/**
 * Reuses CSS2DObject label sprites across frames so axis/effect labels can be
 * rebuilt every frame without churning the DOM. acquire() hands out pooled
 * objects in order; cleanup() hides any left over from the previous frame.
 */
export class LabelPool {
  /**
   * @param {THREE.Scene} scene - Scene that pooled label objects are added to and removed from.
   * @param {number} radius - Sphere radius that unit label directions are scaled to.
   * @param {Document} [doc] - Document label elements are created in; defaults to the global `document`.
   */
  constructor(scene, radius, doc = globalThis.document) {
    this.scene = scene;
    this.radius = radius;
    this.doc = doc;
    this.pool = [];
    this.activeCount = 0;
  }

  /**
   * Mark all pooled labels free for reuse this frame (without hiding them yet).
   */
  reset() {
    this.activeCount = 0;
  }

  /**
   * Place the next pooled label at `position` (a unit direction, scaled to the
   * sphere surface) showing `content`, growing the pool if exhausted.
   * @param {THREE.Vector3} position - Unit direction, scaled to the sphere surface for placement.
   * @param {string} content - Plain-text label content (set via textContent so it cannot inject markup).
   */
  acquire(position, content) {
    let labelObj;

    if (this.activeCount < this.pool.length) {
      labelObj = this.pool[this.activeCount];
    } else {
      const div = this.doc.createElement("div");
      div.className = "label";
      labelObj = new CSS2DObject(div);
      labelObj.center.set(0, 0);
      this.pool.push(labelObj);
    }

    if (labelObj.parent !== this.scene) {
      this.scene.add(labelObj);
    }

    labelObj.position.copy(position).multiplyScalar(this.radius);
    labelObj.visible = true;

    if (labelObj.element.textContent !== content) {
      labelObj.element.textContent = content;
    }

    this.activeCount++;
  }

  /**
   * Remove from the scene any pooled labels not acquired this frame, so stale
   * labels from a busier previous frame disappear.
   */
  cleanup() {
    for (let i = this.activeCount; i < this.pool.length; i++) {
      const obj = this.pool[i];
      if (obj.parent === this.scene) {
        this.scene.remove(obj);
      }
    }
  }
}



/** Canvas-container width (px) at and below which rendering uses its compact layout.
 *  CSS rearranges the surrounding page independently based on viewport width. */
export const MOBILE_BREAKPOINT_PX = 900;

/**
 * Browser-side simulator: drives the three.js scene that renders the LED
 * sphere as instanced dots, on a fixed-timestep sim clock with on-demand
 * repainting. Holds all rendering config (camera, resolution, axes, PiP) and
 * the shared pixel color buffer effects draw into.
 */
export class Daydream {
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

  static SPHERE_RADIUS = 30;
  // The use site rescales this by the live camera distance so the visible label
  // set doesn't drift with orbit distance.
  static LABEL_VISIBILITY_FRAMING_RATIO = Daydream.SPHERE_RADIUS / Daydream.CAMERA_Z;
  static DEFAULT_H = 20;
  static DEFAULT_W = 96;
  // Virtual-row padding over logical H (core/platform.h). Sim = 0 (full sphere);
  // device = 3 (south-pole clip). See pixelToSpherical.
  static H_OFFSET = 0;
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
   * @param {Window|typeof globalThis} [dependencies.win] - Window the pixel
   *   ratio, the reload, the resize observer and the frame timer are read off.
   * @param {Navigator} [dependencies.nav] - Navigator carrying the webdriver flag.
   */
  constructor({
    doc = globalThis.document,
    win = globalThis,
    nav = globalThis.navigator,
  } = {}) {
    THREE.ColorManagement.enabled = true;

    this.doc = doc;
    this.win = win;
    this.nav = nav;

    // Pixel grid, virtual-row padding, and dot radius. H_OFFSET is mirrored from
    // the class default so `this` satisfies pixelToSpherical's dims contract.
    this.W = Daydream.DEFAULT_W;
    this.H = Daydream.DEFAULT_H;
    this.H_OFFSET = Daydream.H_OFFSET;
    this.DOT_SIZE = Daydream.DEFAULT_DOT_SIZE;
    // Shared RGB16 color buffer effects draw into; allocated by precomputeMatrices().
    this.pixels = null;
    // Composed instance matrices per grid, keyed `WxHxH_OFFSET`. Entries come
    // from the resolution-preset table, so the map holds a couple of grids.
    /** @type {Map<string, Float32Array>} */
    this.matrixCache = new Map();

    this.canvas = this.doc.querySelector("#canvas");

    this.canvasParent = this.canvas?.parentElement;
    if (!this.canvasParent) {
      throw new Error(this.canvas
        ? "Daydream: #canvas has no parent element to mount the renderer into"
        : "Daydream: #canvas element not found in the document");
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: Daydream.SCENE_ANTIALIAS,
      alpha: Daydream.SCENE_ALPHA,
    });

    // Cap at CSS resolution: the sphere is coarse LED dots, so rendering above
    // 1x device-pixel-ratio only costs fill rate without adding visible detail.
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
    // Keep the sphere between the near and far planes: closest zoom leaves the
    // front surface outside CAMERA_NEAR, farthest keeps the back inside CAMERA_FAR.
    this.controls.minDistance = Daydream.CAMERA_NEAR + Daydream.SPHERE_RADIUS;
    this.controls.maxDistance = Daydream.CAMERA_FAR - Daydream.SPHERE_RADIUS;

    // On-demand rendering: a camera 'change' marks the frame dirty so an idle
    // scene does no GPU work. Starts dirty so the first frame always paints.
    this.needsRender = true;
    this.controls.addEventListener('change', () => { this.needsRender = true; });

    this.setupKeyboardOrbit();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(Daydream.SCENE_BACKGROUND_COLOR);
    this.paused = false;
    this.stepFrames = 0;
    // Video capture sink, injected by the app while recording is armed and
    // nulled when it is torn down; null disables capture entirely. Must expose
    // captureFrame(), abort(message), and an isRecording flag (which also
    // suppresses the PiP corner).
    this.recorder = null;
    // Captures owed by advanced ticks whose repaint a detached view held.
    this.heldCaptures = 0;

    this.clock = new THREE.Timer();
    this.clock.connect(this.doc);
    this.frameInterval = 1 / Daydream.FPS; // seconds per simulation frame
    this.timeAccumulator = 0;

    this.labelPool = new LabelPool(this.scene, Daydream.SPHERE_RADIUS, this.doc);

    // Built by the first updateResolution(), which the app runs before its first
    // paint; every reader of the mesh treats null as "nothing to draw".
    /** @type {THREE.InstancedMesh|null} */
    this.dotMesh = null;

    this.axisMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff
    });

    // Diametric axis lines at 0.95 of the sphere radius, hidden until toggled on.
    let xAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.X_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS).multiplyScalar(0.95),
      Daydream.X_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS).multiplyScalar(0.95)
    ]);
    this.xAxis = new THREE.Line(xAxisGeometry, this.axisMaterial);
    this.xAxis.visible = false;

    let yAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.Y_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS).multiplyScalar(0.95),
      Daydream.Y_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS).multiplyScalar(0.95)
    ]);
    this.yAxis = new THREE.Line(yAxisGeometry, this.axisMaterial);
    this.yAxis.visible = false;

    let zAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.Z_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS).multiplyScalar(0.95),
      Daydream.Z_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS).multiplyScalar(0.95)
    ]);
    this.zAxis = new THREE.Line(zAxisGeometry, this.axisMaterial);
    this.zAxis.visible = false;


    this.scene.add(this.xAxis);
    this.scene.add(this.yAxis);
    this.scene.add(this.zAxis);

    this.mainViewport = { x: 0, y: 0, width: 0, height: 0 };
    this.pipViewport = { x: 0, y: 0, width: 0, height: 0 };
    this.isMobile = false;
    this.fittedDistance = 0;
    this.setCanvasSize();

    this.resizeObserver = new this.win.ResizeObserver(() => {
      this.setCanvasSize();
    });
    this.resizeObserver.observe(this.canvasParent);

    this.labelAxes = false;
    this.cullBackSphere = true;
    this.showPip = true;
    // Persist column gap-fill overlap (see updateCullUniforms): 1.0 = pills meet
    // exactly; higher closes any hairline seam at the cost of longer terminal caps.
    this.columnFillOverlap = 1.15;

    // Round dots until an effect binds and sets its mode (see updateCullUniforms).
    this.strobeColumns = true;

    this.statsView = new GlobalStatsView(this.doc);
  }

  /**
   * Wire WebGL context-loss / -restore handling on the canvas: on loss, flag
   * contextLost (render() then stops issuing GL calls), end any recording, and
   * show a reload prompt.
   */
  setupContextLossHandling() {
    this.contextLost = false;

    const overlay = this.doc.createElement("div");
    overlay.className = "loading-overlay error context-lost-overlay";
    overlay.setAttribute("role", "alert");
    overlay.tabIndex = -1;
    overlay.style.display = "none";
    // Same element vocabulary as the bootstrap load-failure overlay, which
    // shares these classes.
    const title = this.doc.createElement("span");
    title.className = "load-error-title";
    title.textContent = "GPU context lost";
    this.contextLostDetail = this.doc.createElement("span");
    this.contextLostDetail.className = "load-error-detail";
    const reload = this.doc.createElement("button");
    reload.type = "button";
    reload.className = "context-lost-reload";
    reload.textContent = "Reload";
    reload.addEventListener("click", () => this.win.location.reload());
    overlay.append(title, this.contextLostDetail, reload);
    this.canvasParent.appendChild(overlay);
    this.contextLostOverlay = overlay;

    this.onContextLost = (e) => {
      e.preventDefault(); // signal intent to handle a restore
      this.contextLost = true;
      const reason = e.statusMessage || "no reason reported";
      console.error(`[daydream] WebGL context lost: ${reason}`);
      this.contextLostDetail.textContent =
        `${reason}. The GPU process was likely reset — reload to recover.`;
      overlay.style.display = "flex";
      overlay.focus({ preventScroll: true });
      // The canvas feeds no more frames into the capture stream, so end any
      // session rather than leaving it silently frozen.
      this.recorder?.abort(`WebGL context lost (${reason}); recording stopped.`);
    };

    this.onContextRestored = () => {
      this.contextLost = false;
      console.warn("[daydream] WebGL context restored");
      overlay.style.display = "none";
      // Repaint so instanceColor/instanceMatrix re-upload even while paused.
      this.needsRender = true;
    };

    this.canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    this.canvas.addEventListener(
      "webglcontextrestored", this.onContextRestored, false);
  }

  /**
   * Give the canvas a keyboard route to the orbit controls, which OrbitControls
   * itself exposes only to pointer input: arrow keys rotate about the orbit
   * target, +/- dolly in and out.
   */
  setupKeyboardOrbit() {
    const offset = new THREE.Vector3();
    const spherical = new THREE.Spherical();

    // :focus-visible promotes a pointer-focused element the moment any key is
    // pressed, so a global shortcut (space) would ring the whole viewport.
    // Latch the arrival modality instead: keyboard focus rings and orbits,
    // pointer focus does neither, keeping the global arrow-key frame step.
    this.onCanvasFocus = () => {
      this.canvas.classList.toggle(
        "keyboard-focus", this.canvas.matches(":focus-visible"));
    };
    this.onCanvasBlur = () => {
      this.canvas.classList.remove("keyboard-focus");
    };

    this.onCanvasKeyDown = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (!this.canvas.classList.contains("keyboard-focus")) return;

      let dTheta = 0;
      let dPhi = 0;
      let dolly = 1;
      switch (e.key) {
        case "ArrowLeft": dTheta = -Daydream.KEY_ORBIT_STEP; break;
        case "ArrowRight": dTheta = Daydream.KEY_ORBIT_STEP; break;
        case "ArrowUp": dPhi = -Daydream.KEY_ORBIT_STEP; break;
        case "ArrowDown": dPhi = Daydream.KEY_ORBIT_STEP; break;
        case "+": case "=": dolly = 1 / Daydream.KEY_ZOOM_STEP; break;
        case "-": case "_": dolly = Daydream.KEY_ZOOM_STEP; break;
        default: return;
      }

      offset.copy(this.camera.position).sub(this.controls.target);
      spherical.setFromVector3(offset);
      spherical.theta += dTheta;
      spherical.phi = THREE.MathUtils.clamp(
        spherical.phi + dPhi,
        this.controls.minPolarAngle,
        this.controls.maxPolarAngle
      );
      spherical.radius = THREE.MathUtils.clamp(
        spherical.radius * dolly,
        this.controls.minDistance,
        this.controls.maxDistance
      );
      spherical.makeSafe(); // keeps phi off the poles, where the orbit basis degenerates
      this.camera.position
        .copy(this.controls.target)
        .add(offset.setFromSpherical(spherical));
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      this.needsRender = true;

      e.preventDefault();
      // Else the window handler also reads ArrowRight as a paused frame step.
      e.stopPropagation();
    };

    this.canvas.addEventListener("keydown", this.onCanvasKeyDown);
    this.canvas.addEventListener("focus", this.onCanvasFocus);
    this.canvas.addEventListener("blur", this.onCanvasBlur);
  }

  /**
   * Keyboard handler: space toggles pause; right-arrow single-steps while
   * paused; left/right select presets while running.
   * @param {KeyboardEvent} e - The keydown event driving playback or presets.
   * @param {(delta: number) => boolean} [movePreset] - Selects an adjacent preset.
   */
  keydown(e, movePreset = () => false) {
    // An Alt/Ctrl/Meta chord is the browser's or the OS's — Ctrl+Space and
    // Cmd+Space among them — so no playback shortcut claims one.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === ' ') {
      this.paused = !this.paused;
      if (!this.paused) this.stepFrames = 0;
      e.preventDefault(); // else Space also scrolls the page on the mobile layout
    } else if (this.paused && e.key === "ArrowRight") {
      this.stepFrames++;
      e.preventDefault();
    } else if (!this.paused && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const delta = e.key === "ArrowLeft" ? -1 : 1;
      if (movePreset(delta)) e.preventDefault();
    }
  }

  /**
   * Fit renderer, label layer, and both cameras to the container size. Switches
   * to mobile layout at MOBILE_BREAKPOINT_PX, sizes the square PiP viewport to 30% of
   * the smaller dimension, and re-fits the camera distance so the sphere fills
   * ~85% of the view.
   */
  setCanvasSize() {
    const container = this.canvasParent;
    const width = container.clientWidth;
    const height = container.clientHeight;
    // Skip a 0×0 container: aspect = 0/0 = NaN would poison the projection matrix.
    // The ResizeObserver re-invokes once laid out.
    if (width <= 0 || height <= 0) return;
    this.isMobile = width <= MOBILE_BREAKPOINT_PX;
    this.mainViewport.x = 0;
    this.mainViewport.y = 0;
    this.mainViewport.width = width;
    this.mainViewport.height = height;

    const pipSize = Math.floor(Math.min(width, height) * 0.3);
    this.pipViewport.x = width - pipSize;
    this.pipViewport.y = 0;
    this.pipViewport.width = pipSize;
    this.pipViewport.height = pipSize;

    this.pipCamera.aspect = 1.0;
    this.pipCamera.updateProjectionMatrix();

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // Fit the orbit radius to the sphere while the radius still sits at the
    // last fitted value; once the user zooms away from it, later resizes
    // (DPR change, sidebar toggle, devtools) preserve their zoom. Rotation
    // leaves the radius unchanged, so it doesn't block re-fitting.
    // setLength rescales only the orbit radius, leaving azimuth/polar intact.
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

    // Re-apply on resize so moving to a different-DPR monitor refreshes the ratio.
    this.renderer.setPixelRatio(Math.min(this.win.devicePixelRatio, 1));
    this.renderer.setSize(width, height);
    this.labelRenderer.setSize(width, height);

    this.needsRender = true;
  }

  /**
   * Request a repaint on the next animation frame. For on-demand rendering:
   * callers that mutate the visible scene without advancing the simulation or
   * moving the camera (e.g. toggling axes/back-face culling, changing
   * resolution) must call this, otherwise the change won't show until the next
   * sim tick — or never, while paused.
   */
  invalidate() {
    this.needsRender = true;
  }

  /**
   * Animation-loop body, called once per animation frame with the active render
   * adapter. Advances the fixed-timestep simulation if an interval has accrued,
   * updates controls, and repaints the main view, labels, and PiP — but only
   * when the sim stepped, the camera moved, or invalidate() was called. Hands
   * this.recorder one frame per advanced tick the adapter reports capture-ready.
   * @param {{drawFrame: () => void, sync?: (advanced: boolean) => void,
   *   getArenaMetrics?: () => ?Object, captureReady?: () => boolean}} adapter - Per-frame render adapter (see
   *   createRenderAdapter): drawFrame() paints the pixel buffer,
   *   sync(advanced) reconciles the effect panel and is told whether the sim
   *   stepped this frame, getArenaMetrics() feeds the stats
   *   overlay, and captureReady() gates the recorder. Optional methods default
   *   to permissive when absent.
   */
  render(adapter) {
    if (this.contextLost) return;

    // A pending single-step must fire immediately, even while paused and before
    // the fixed-timestep clock has accrued a full interval; the frame clock still
    // advances once per frame either way.
    const clockReady = this.advanceFrameClock();
    const advanced =
      (clockReady || this.stepFrames !== 0) && this.stepSimulation(adapter);
    adapter?.sync?.(advanced);

    // Services live pointer interaction; emits 'change' (→ needsRender).
    this.controls.update();

    if (!advanced && !this.needsRender) return;
    this.needsRender = false;

    // Capture only when the sim advanced. In segmented mode the composite lands a
    // frame late, so captureReady() gates out the leading cleared black frames.
    const captureDue = this.recorder?.isRecording === true && advanced &&
      (typeof adapter?.captureReady !== 'function' || adapter.captureReady());

    // Three throws if an attribute's array byteLength differs from the size it gave
    // the GPU buffer, and a mid-frame heap growth detaches the aliased instanceColor
    // array (byteLength 0). needsUpdate only ever bumps version, so a flagged upload
    // cannot be cancelled — hold the repaint until the next drawFrame re-points it.
    if (this.dotMesh?.instanceColor && !isViewLive(this.dotMesh.instanceColor.array)) {
      // The tick advanced and cannot be un-run, and the track is locked one frame
      // per tick. Capturing here would blit a canvas this task never painted (the
      // compositor already cleared it), so carry the frame to the next repaint.
      if (captureDue) this.heldCaptures++;
      this.needsRender = true;
      return;
    }

    this.xAxis.visible = this.labelAxes;
    this.yAxis.visible = this.labelAxes;
    this.zAxis.visible = this.labelAxes;

    this.updateCullUniforms();

    this.renderer.setScissorTest(true);
    this.renderMainView();

    // One requestFrame per repaint: several in a single task carry one timestamp,
    // so the stream cannot emit them as separate video frames while the elapsed
    // counter charges for each. A backlog drains one per repaint instead.
    const owed = this.recorder ? (captureDue ? 1 : 0) + this.heldCaptures : 0;
    this.heldCaptures = owed > 0 ? owed - 1 : 0;
    if (owed > 0) this.recorder.captureFrame();
    if (this.heldCaptures > 0) this.needsRender = true;

    this.refreshLabels();
    if (this.labelPool.activeCount > 0) {
      this.labelRenderer.render(this.scene, this.camera);
    }

    this.renderPip();
    this.renderer.setScissorTest(false);
  }

  /**
   * Fixed-timestep gate. Accumulates real elapsed time (clamped to avoid a
   * spiral-of-death after a stall) and consumes one frame interval only when
   * enough has accrued to advance a frame. Backlog beyond the clamp is dropped,
   * not replayed: at most one frame advances per call.
   * @returns {boolean} True when a frame interval was consumed and the sim should advance.
   */
  advanceFrameClock() {
    this.clock.update();
    const delta = this.clock.getDelta();
    // Drain getDelta each frame but don't accrue while paused, so unpause neither
    // stalls on an emptied accumulator nor replays the paused span as backlog.
    if (this.paused) return false;
    this.timeAccumulator += delta;
    if (this.timeAccumulator > Daydream.MAX_FRAME_BACKLOG_SECONDS)
      this.timeAccumulator = Daydream.MAX_FRAME_BACKLOG_SECONDS;
    if (this.timeAccumulator < this.frameInterval) return false;
    this.timeAccumulator -= this.frameInterval;
    return true;
  }

  /**
   * Advance the simulation one frame when running or single-stepping: clear the
   * pixel buffer, draw the effect, refresh stats.
   * @param {{drawFrame: () => void}} adapter - Render adapter whose drawFrame() paints the pixel buffer.
   * @returns {boolean} Whether the simulation actually advanced (false while paused), so the caller can gate the recorder on the same decision.
   */
  stepSimulation(adapter) {
    const advanced = !this.paused || this.stepFrames !== 0;
    if (!advanced) return false;

    if (this.stepFrames !== 0) this.stepFrames--;

    // A WASM-detached Uint16Array is still truthy but fill() on it throws, so skip
    // it (isViewLive checks byteLength); the next drawFrame heals the view. On the
    // rare heap-growth (detach) frame the buffer is not cleared, so an additive/
    // persist effect may blend one stale frame; it self-heals the next frame.
    if (isViewLive(this.pixels))
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

  /**
   * Rebuild the floating axis labels, acquiring pooled sprites only for those on
   * the camera-facing hemisphere.
   */
  refreshLabels() {
    this.labelPool.reset();

    if (this.labelAxes) {
      // position is a unit direction, so position·cameraPos == |cameraPos|·cos(angle);
      // scaling the cutoff by the live distance keeps the visible set zoom-independent.
      const facingThreshold =
        Daydream.LABEL_VISIBILITY_FRAMING_RATIO * this.camera.position.length();
      for (const label of Daydream.AXIS_LABELS) {
        if (label.position.dot(this.camera.position) > facingThreshold) {
          this.labelPool.acquire(label.position, label.content);
        }
      }
    }

    this.labelPool.cleanup();
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
      // Persist effects pass the equator half-arc (PI*R/W) so the shader fills the
      // inter-column gaps; strobe and the pre-effect default pass 0 (round dots).
      this.cullUniforms.uColumnFillArc.value = this.strobeColumns === false
        ? this.columnFillOverlap * Math.PI * Daydream.SPHERE_RADIUS / this.W
        : 0;
    }
  }

  /**
   * Set POV column-strobe mode: true = discrete dots, false = gap-filled band
   * (applied via uColumnFillArc in updateCullUniforms()).
   * @param {boolean} strobe - true to strobe columns, false to persist/smear.
   */
  setStrobeColumns(strobe) {
    this.strobeColumns = strobe;
    this.invalidate();
  }

  /**
   * Render the main sphere view into its viewport. Assumes the scissor test is
   * already enabled by the caller.
   */
  renderMainView() {
    this.renderer.setViewport(
      this.mainViewport.x,
      this.mainViewport.y,
      this.mainViewport.width,
      this.mainViewport.height
    );
    this.renderer.setScissor(
      this.mainViewport.x,
      this.mainViewport.y,
      this.mainViewport.width,
      this.mainViewport.height
    );

    // render() clears the scissored viewport itself: a THREE.Color scene
    // background forces a clear to that color before the pass.
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Render the picture-in-picture corner view. Skipped while the showPip toggle
   * is off, on mobile, under headless automation (Playwright/Puppeteer/Selenium
   * set navigator.webdriver), and while recording, so clean screenshots/videos
   * aren't obscured by the PiP corner.
   * @details A second full pass over the instanced mesh (no LOD, frustum culling
   *   off), so on a large grid the toggle roughly halves the per-frame draw cost.
   */
  renderPip() {
    if (!this.showPip || this.isMobile || this.nav.webdriver ||
        this.recorder?.isRecording) return;

    this.renderer.setViewport(
      this.pipViewport.x,
      this.pipViewport.y,
      this.pipViewport.width,
      this.pipViewport.height
    );
    this.renderer.setScissor(
      this.pipViewport.x,
      this.pipViewport.y,
      this.pipViewport.width,
      this.pipViewport.height
    );
    this.pipCamera.position.copy(this.camera.position);
    this.pipCamera.quaternion.copy(this.camera.quaternion);
    this.renderer.render(this.scene, this.pipCamera);
  }

  /**
   * (Re)build the InstancedMesh of dots, one instance per pixel (W*H). Disposes
   * any previous mesh, lazily builds the dot material (whose injected shader
   * hides black pixels and back-face-culls the far hemisphere), and picks a
   * sphere tessellation that drops as pixel count rises to cap geometry cost.
   */
  setupDots() {
    if (this.dotMesh) {
      this.scene.remove(this.dotMesh);
      this.dotMesh.geometry.dispose();
      // instanceColor.array may alias WASM memory; detach before dispose() so
      // Three.js can't read/re-upload a buffer the engine is about to free.
      if (this.dotMesh.instanceColor) this.dotMesh.instanceColor.array = null;
      this.dotMesh.dispose();
    }

    if (!this.dotMaterial) {
      this.dotMaterial = new THREE.MeshBasicMaterial({
        side: THREE.FrontSide,
        blending: THREE.CustomBlending,
        blendEquation: THREE.MaxEquation,
        depthWrite: false
      });

      // Backface-cull + column gap-fill uniforms, updated per frame in
      // updateCullUniforms().
      this.cullUniforms = {
        uCameraPos: { value: new THREE.Vector3(0, 0, 1) },
        uCullThreshold: { value: -0.06 },
        uColumnFillArc: { value: 0 }
      };

      this.dotMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.uCameraPos = this.cullUniforms.uCameraPos;
        shader.uniforms.uCullThreshold = this.cullUniforms.uCullThreshold;
        shader.uniforms.uColumnFillArc = this.cullUniforms.uColumnFillArc;

        shader.vertexShader = 'uniform vec3 uCameraPos;\nuniform float uCullThreshold;\nuniform float uColumnFillArc;\n' + shader.vertexShader;

        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `
          #include <begin_vertex>
          #if defined(USE_INSTANCING_COLOR)
             // Hide black pixels
             if (dot(instanceColor, instanceColor) < 1e-10) {
                 transformed *= 0.0;
             }
             vec3 instPos = (instanceMatrix[3]).xyz;
             // Column gap-fill (persist effects, uColumnFillArc > 0): extend each
             // dot east-west into a PILL whose STRAIGHT (full-radius) middle
             // reaches the column-cell boundary, so a run of lit columns tiles
             // flush — flat seams, no scalloping — and only the run's terminal
             // caps stay rounded. The dot's local +x is the longitude (sweep)
             // tangent after the per-instance lookAt. We TRANSLATE the two
             // x-halves apart by ext (not scale — scaling a sphere yields an
             // oval): the bridge between them becomes a full-radius cylinder and
             // the original rounded caps ride OUT past the cell boundary into the
             // neighbour cell. Where the neighbour is lit, its own straight body
             // buries this cap (flat join); where the neighbour is dark (culled
             // to nothing) the cap shows as the rounded terminal. ext = the cell
             // half-arc = uColumnFillArc * sinPhi; sinPhi (latitude
             // foreshortening from instPos) shrinks the cell toward the poles.
             // Strobe effects pass uColumnFillArc == 0 -> round dots.
             float sinPhi = length(instPos.xz) / max(length(instPos), 1e-6);
             float ext = uColumnFillArc * sinPhi;
             transformed.x += sign(transformed.x) * ext;
             // Backface cull: dot of instance position with camera direction
             float facing = dot(normalize(instPos), normalize(uCameraPos));
             if (facing < uCullThreshold) {
                 transformed *= 0.0;
             }
          #endif
          `
        );
      };
    }

    const totalPixels = this.W * this.H;
    const detail = dotDetailFor(totalPixels);

    this.dotGeometry = new THREE.SphereGeometry(
      this.DOT_SIZE,
      detail,
      detail,
      0,
      Math.PI
    );

    this.dotMesh = new THREE.InstancedMesh(
      this.dotGeometry,
      this.dotMaterial,
      totalPixels
    );

    this.dotMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.dotMesh.count = totalPixels;
    this.dotMesh.frustumCulled = false;
    this.scene.add(this.dotMesh);
  }

  /**
   * Compute each dot's instance matrix: map its pixel (x,y) to a point on the
   * sphere and orient the dot to face outward from the center. Also allocates
   * the shared instanceColor buffer (exposed as this.pixels) that effects write
   * pixel colors into.
   *
   * The matrices are a function of the grid alone, so they are composed once per
   * grid and replayed afterwards: this runs synchronously inside the resolution
   * handler over W*H instances, and toggling back to a preset would otherwise
   * redo every spherical conversion, lookAt and compose to reach the same
   * matrices.
   */
  precomputeMatrices() {
    const count = this.W * this.H;
    const key = `${this.W}x${this.H}x${this.H_OFFSET}`;
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
    // The cache holds the instanceMatrix layout itself, so the upload is one
    // typed-array copy; round-tripping each matrix through an Object3D would
    // read and write the same 16 floats an element at a time.
    this.dotMesh.instanceMatrix.array.set(matrices);

    const needed = this.dotMesh.count * 3;
    if (!this.dotMesh.instanceColor) {
      this.dotMesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Uint16Array(needed), 3, true
      );
      this.dotMesh.instanceColor.setUsage(THREE.StreamDrawUsage);
    }
    // A fresh JS-owned buffer, not WASM memory; the next refreshPixelView()
    // re-fetches the WASM view and re-points all three aliases.
    this.pixels = this.dotMesh.instanceColor.array;
    this.pixels.fill(0);

    this.dotMesh.instanceMatrix.needsUpdate = true;
    this.dotMesh.instanceColor.needsUpdate = true;
  }

  /**
   * Hand one frame's measurements to the stats overlay.
   * @param {number} duration - Frame draw time in milliseconds.
   * @param {{getArenaMetrics?: () => ?Object}} adapter - Render adapter; its getArenaMetrics() supplies arena usage when present.
   */
  updateStats(duration, adapter) {
    this.statsView.update(duration, adapter?.getArenaMetrics?.() ?? null);
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

    this.setupDots();

    this.precomputeMatrices();

    // The rebuilt color buffer is zeroed; without a repaint the pre-resize image
    // stays on screen while paused.
    this.invalidate();
  }

  /**
   * Release everything this instance owns and undo what it put on the page: the
   * animation loop, the ResizeObserver, the simulation timer, the context-loss
   * and canvas-keyboard listeners, the WebGL program/geometry/material
   * resources and drawing context, the OrbitControls, and the label and
   * context-lost layers. Call before discarding a Daydream (e.g. on SPA
   * navigation away) so it leaves behind no live observer firing into a dead
   * scene and no leaked GPU material, geometry, or context. A fresh instance
   * requires a new canvas because this method deliberately loses the old context.
   */
  dispose() {
    // Stop the rAF callback first so it never fires into the nulled dotMesh /
    // disposed renderer on a real page discard.
    this.renderer?.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    this.clock?.dispose();

    if (this.onContextLost) {
      this.canvas.removeEventListener(
        "webglcontextlost", this.onContextLost, false);
      this.canvas.removeEventListener(
        "webglcontextrestored", this.onContextRestored, false);
    }
    this.contextLostOverlay?.remove();

    if (this.onCanvasKeyDown) {
      this.canvas.removeEventListener("keydown", this.onCanvasKeyDown);
      this.canvas.removeEventListener("focus", this.onCanvasFocus);
      this.canvas.removeEventListener("blur", this.onCanvasBlur);
      // The canvas outlives the driver; a stale latch would orbit a fresh
      // instance on arrow keys the page had not routed to it.
      this.canvas.classList.remove("keyboard-focus");
    }

    if (this.dotMesh) {
      this.scene.remove(this.dotMesh);
      this.dotMesh.geometry?.dispose();
      // Detach the possibly WASM-aliased instanceColor buffer before dispose()
      // (see setupDots()).
      if (this.dotMesh.instanceColor) this.dotMesh.instanceColor.array = null;
      this.dotMesh.dispose();
      this.dotMesh = null;
    }
    this.pixels = null;
    // Injected sink the engine host disposes on the same teardown; holding it
    // here would leave the render path a disposed recorder to capture through.
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

/** Per-dot sphere LOD: segment count decays exponentially as pixel count rises
 *  so the triangle budget stays bounded.
 * @param {number} totalPixels - Instance count of the dot mesh (W*H).
 * @returns {number} Sphere width/height segment count, floored at 3.
 */
export const dotDetailFor = (totalPixels) => {
  const MAX_DOT_SEGMENTS = 30;
  const LOD_DECAY_PIXELS = 30000;
  const MIN_DOT_SEGMENTS = 3;
  return Math.max(
    MIN_DOT_SEGMENTS,
    Math.round(MAX_DOT_SEGMENTS * Math.exp(-totalPixels / LOD_DECAY_PIXELS)));
};

/**
 * Orbit radius at which the sphere fills ~85% of the smaller view dimension,
 * clamped into the orbit-control range.
 * @param {number} aspect - Viewport aspect ratio (width / height).
 * @param {number} minDistance - Closest orbit radius the controls allow.
 * @param {number} maxDistance - Farthest orbit radius the controls allow.
 * @returns {number} Clamped camera distance from the sphere center.
 */
export const fitDistance = (aspect, minDistance, maxDistance) => {
  const diameter = Daydream.SPHERE_RADIUS * 2;
  const targetCoverage = 0.85;
  const fovRad = THREE.MathUtils.degToRad(Daydream.CAMERA_FOV / 2);
  const distForHeight = diameter / (2 * Math.tan(fovRad) * targetCoverage);
  const distForWidth = distForHeight / aspect;
  return THREE.MathUtils.clamp(
    Math.max(distForHeight, distForWidth), minDistance, maxDistance);
};
