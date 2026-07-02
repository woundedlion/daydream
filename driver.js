/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { pixelToSpherical } from "./geometry.js";
import { isViewLive } from "./pixel_view.js";
import { prettify } from "./label_format.js";

export { prettify } from "./label_format.js";

/**
 * Reuses CSS2DObject label sprites across frames so axis/effect labels can be
 * rebuilt every frame without churning the DOM. acquire() hands out pooled
 * objects in order; cleanup() hides any left over from the previous frame.
 */
class LabelPool {
  /**
   * @param {THREE.Scene} scene - Scene that pooled label objects are added to and removed from.
   */
  constructor(scene) {
    this.scene = scene;
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
      const div = document.createElement("div");
      div.className = "label";
      labelObj = new CSS2DObject(div);
      labelObj.center.set(0, 0);
      this.pool.push(labelObj);
    }

    if (labelObj.parent !== this.scene) {
      this.scene.add(labelObj);
    }

    labelObj.position.copy(position).multiplyScalar(Daydream.SPHERE_RADIUS);
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



/** Per-frame time (ms) above which a frame/segment is flagged "slow" in stats. */
export const SLOW_FRAME_MS = 62;

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

  static SPHERE_RADIUS = 30;
  // The use site rescales this by the live camera distance so the visible label
  // set doesn't drift with orbit distance.
  static LABEL_VISIBILITY_FRAMING_RATIO = Daydream.SPHERE_RADIUS / Daydream.CAMERA_Z;
  static H = 20;
  static W = 96;
  // Virtual-row padding the engine adds below the logical H (engine maps phi
  // over H + H_OFFSET rows; core/platform.h). The WASM/sim build runs with 0;
  // the device build uses 3. The sim stays at 0 (full-sphere mapping): the
  // device's south-pole clipping is a compile-time engine fork the sim cannot
  // reproduce by repositioning dots alone (see pixelToSpherical).
  static H_OFFSET = 0;
  static PIXEL_WIDTH = 2 * Math.PI / Daydream.W;
  static FPS = 16;
  // Cap on accumulated real time: the clock consumes one interval per frame, so
  // this bounds the post-stall backlog to a few frames instead of letting it grow
  // unboundedly and step every frame until drained.
  static MAX_FRAME_CATCHUP_SECONDS = 0.25;
  static DOT_SIZE = 2;
  static DOT_COLOR = 0x0000ff;

  static pixels = null;

  static X_AXIS = new THREE.Vector3(1, 0, 0);
  static Y_AXIS = new THREE.Vector3(0, 1, 0);
  static Z_AXIS = new THREE.Vector3(0, 0, 1);
  static NEG_X_AXIS = new THREE.Vector3(-1, 0, 0);
  static NEG_Y_AXIS = new THREE.Vector3(0, -1, 0);
  static NEG_Z_AXIS = new THREE.Vector3(0, 0, -1);
  static UP = Daydream.Y_AXIS;

  /**
   * Build the renderer, cameras, controls, scene, dot mesh, and axis lines, and
   * wire up resize/camera-change observers. Leaves the sim paused-capable and
   * ready for render() to be driven from an animation loop.
   */
  constructor() {
    THREE.ColorManagement.enabled = true;
    this.canvas = document.querySelector("#canvas");

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

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.setupContextLossHandling();

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = "labelLayer";
    this.canvasParent.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      Daydream.CAMERA_FOV,
      // Square fallback until the canvas has a real size: width/0 yields a
      // truthy Infinity that slips past `|| 1`, so require both dimensions > 0.
      this.canvas.width > 0 && this.canvas.height > 0
        ? this.canvas.width / this.canvas.height
        : 1,
      Daydream.CAMERA_NEAR,
      Daydream.CAMERA_FAR
    );

    this.pipCamera = this.camera.clone();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // Keep the sphere between the near and far planes: closest zoom leaves the
    // front surface outside CAMERA_NEAR, farthest keeps the back inside CAMERA_FAR.
    this.controls.minDistance = Daydream.CAMERA_NEAR + Daydream.SPHERE_RADIUS;
    this.controls.maxDistance = Daydream.CAMERA_FAR - Daydream.SPHERE_RADIUS;
    this.camera.position.set(
      Daydream.CAMERA_X,
      Daydream.CAMERA_Y,
      Daydream.CAMERA_Z
    );

    // On-demand rendering: a camera 'change' marks the frame dirty so an idle
    // scene does no GPU work. Starts dirty so the first frame always paints.
    this.needsRender = true;
    this.controls.addEventListener('change', () => { this.needsRender = true; });

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(Daydream.SCENE_BACKGROUND_COLOR);
    this.paused = false;
    this.stepFrames = 0;
    this.recorder = null;

    this.clock = new THREE.Clock(true);
    this.frameInterval = 1 / Daydream.FPS; // seconds per simulation frame
    this.timeAccumulator = 0;

    this.resources = [];
    this.labelPool = new LabelPool(this.scene);
    this.hadLabels = false;

    this.setupDots();

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

    this.mainViewport = { x: 0, y: 0, width: 1, height: 1 };
    this.pipViewport = { x: 0, y: 0, width: 0.25, height: 0.25 };
    this.isMobile = false;
    this.fittedDistance = 0;
    this.setCanvasSize();

    this.resizeObserver = new ResizeObserver(() => {
      this.setCanvasSize();
    });
    this.resizeObserver.observe(this.canvasParent);

    this.timeAccumulator = 0;
    this.labelAxes = false;
    this.cullBackSphere = false;
    // Persist column gap-fill overlap (see updateCullUniforms): 1.0 = pills meet
    // exactly; higher closes any hairline seam at the cost of longer terminal caps.
    this.columnFillOverlap = 1.15;

    // Round dots until an effect binds and sets its mode (see updateCullUniforms).
    this.strobeColumns = true;

    this.statsGroup = null;

    this.precomputeMatrices();
  }

  /**
   * Wire WebGL context-loss / -restore handling on the canvas.
   * @details On this project's typical hardware Chrome applies the
   *          `exit_on_context_lost` workaround (the D3D device can't be reset
   *          inside the GPU sandbox), so a lost context tears down the whole GPU
   *          process and generally will NOT auto-restore — recovery is a page
   *          reload. These handlers do not prevent the loss; they replace the
   *          silent blank canvas (and the later uncaught throw on re-create) with
   *          a logged reason plus a visible reload prompt, and they flip a flag so
   *          render() stops pushing GL calls into a dead context. The restore
   *          handler is wired for completeness on hardware that can recover.
   */
  setupContextLossHandling() {
    this.contextLost = false;

    const overlay = document.createElement("div");
    overlay.className = "loading-overlay error context-lost-overlay";
    overlay.style.display = "none";
    const title = document.createElement("div");
    title.className = "load-error-title";
    title.textContent = "GPU context lost";
    this.contextLostDetail = document.createElement("div");
    this.contextLostDetail.className = "load-error-detail";
    const reload = document.createElement("button");
    reload.className = "context-lost-reload";
    reload.textContent = "Reload";
    reload.addEventListener("click", () => location.reload());
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
    };

    this.onContextRestored = () => {
      this.contextLost = false;
      console.warn("[daydream] WebGL context restored");
      overlay.style.display = "none";
    };

    this.canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    this.canvas.addEventListener(
      "webglcontextrestored", this.onContextRestored, false);
  }

  /**
   * Keyboard handler: space toggles pause; right-arrow single-steps one frame
   * while paused.
   * @param {KeyboardEvent} e - The keydown event whose key drives pause/step.
   */
  keydown(e) {
    if (e.key === ' ') {
      this.paused = !this.paused;
    } else if (this.paused && e.key === "ArrowRight") {
      this.stepFrames++;
    }
  }

  /**
   * Fit renderer, label layer, and both cameras to the container size. Switches
   * to mobile layout at <=900px wide, sizes the square PiP viewport to 30% of
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
    this.isMobile = width <= 900;
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
    const orbitRadius = this.camera.position.length();
    if (
      this.fittedDistance === 0 ||
      Math.abs(orbitRadius - this.fittedDistance) < 1e-3 * this.fittedDistance
    ) {
      const diameter = Daydream.SPHERE_RADIUS * 2;
      const targetCoverage = 0.85;
      const fovRad = THREE.MathUtils.degToRad(Daydream.CAMERA_FOV / 2);
      const distForHeight = diameter / (2 * Math.tan(fovRad) * targetCoverage);
      const distForWidth = distForHeight / this.camera.aspect;
      this.fittedDistance = Math.max(distForHeight, distForWidth);
      this.camera.position.setLength(this.fittedDistance);
    }

    // Re-apply on resize so moving to a different-DPR monitor refreshes the ratio.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
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
   * Animation-loop body, called once per animation frame with the active
   * effect. Advances the fixed-timestep simulation if an interval has accrued,
   * updates controls, and repaints the main view, labels, and PiP — but only
   * when the sim stepped, the camera moved, or invalidate() was called.
   * @param {Object} effect - Active effect; its drawFrame()/getLabels()/getArenaMetrics() drive the painted frame.
   */
  render(effect) {
    if (this.contextLost) return;

    // A pending single-step must fire immediately, even while paused and before
    // the fixed-timestep clock has accrued a full interval; the frame clock still
    // advances once per frame either way.
    const clockReady = this.advanceFrameClock();
    const advanced =
      (clockReady || this.stepFrames !== 0) && this.stepSimulation(effect);

    // Services live pointer interaction; emits 'change' (→ needsRender).
    this.controls.update();

    if (!advanced && !this.needsRender) return;
    this.needsRender = false;

    this.xAxis.visible = this.labelAxes;
    this.yAxis.visible = this.labelAxes;
    this.zAxis.visible = this.labelAxes;

    this.updateCullUniforms();

    this.renderer.setScissorTest(true);
    this.renderMainView();

    // Capture only when the sim advanced. In segmented mode the composite lands a
    // frame late, so captureReady() gates out the leading cleared black frames.
    if (this.recorder && advanced &&
        (typeof effect.captureReady !== 'function' || effect.captureReady()))
      this.recorder.captureFrame();

    this.refreshLabels(effect);
    // CSS2DRenderer hides label <div>s only during a render pass, so render one
    // extra frame when the count falls to zero to let that pass hide them.
    const hasLabels = this.labelPool.activeCount > 0;
    if (hasLabels || this.hadLabels) {
      this.labelRenderer.render(this.scene, this.camera);
    }
    this.hadLabels = hasLabels;

    this.renderPip();
    this.renderer.setScissorTest(false);
  }

  /**
   * Fixed-timestep gate. Accumulates real elapsed time (clamped to avoid a
   * spiral-of-death after a stall) and consumes one frame interval only when
   * enough has accrued to advance a frame.
   * @returns {boolean} True when a frame interval was consumed and the sim should advance.
   */
  advanceFrameClock() {
    const delta = this.clock.getDelta();
    // Drain getDelta each frame but don't accrue while paused, so unpause neither
    // stalls on an emptied accumulator nor replays the paused span as backlog.
    if (this.paused) return false;
    this.timeAccumulator += delta;
    if (this.timeAccumulator > Daydream.MAX_FRAME_CATCHUP_SECONDS)
      this.timeAccumulator = Daydream.MAX_FRAME_CATCHUP_SECONDS;
    if (this.timeAccumulator < this.frameInterval) return false;
    this.timeAccumulator -= this.frameInterval;
    return true;
  }

  /**
   * Advance the simulation one frame when running or single-stepping: clear the
   * pixel buffer, draw the effect, refresh stats.
   * @param {Object} effect - Active effect whose drawFrame() paints the pixel buffer.
   * @returns {boolean} Whether the simulation actually advanced (false while paused), so the caller can gate the recorder on the same decision.
   */
  stepSimulation(effect) {
    const advanced = !this.paused || this.stepFrames !== 0;
    if (!advanced) return false;

    if (this.stepFrames !== 0) this.stepFrames--;

    // A WASM-detached Uint16Array is still truthy but fill() on it throws, so skip
    // it (isViewLive checks byteLength); the next drawFrame heals the view.
    if (isViewLive(Daydream.pixels))
      Daydream.pixels.fill(0);

    if (this.labelAxes) {
      this.xAxis.position.set(0, 0, 0);
      this.yAxis.position.set(0, 0, 0);
      this.zAxis.position.set(0, 0, 0);
    }

    const start = performance.now();
    if (effect) {
      effect.drawFrame();
    }
    const duration = performance.now() - start;

    this.updateStats(duration, effect);

    this.dotMesh.instanceColor.needsUpdate = true;

    return true;
  }

  /**
   * Rebuild the floating label set (axis labels + effect-supplied labels),
   * acquiring pooled sprites only for labels on the camera-facing hemisphere.
   * @param {Object} effect - Active effect; its getLabels() supplies extra labels when present.
   */
  refreshLabels(effect) {
    this.labelPool.reset();
    let labels = [];

    if (this.labelAxes) {
      labels.push({ "position": Daydream.X_AXIS, "content": "X" });
      labels.push({ "position": Daydream.Y_AXIS, "content": "Y" });
      labels.push({ "position": Daydream.Z_AXIS, "content": "Z" });
      labels.push({ "position": Daydream.NEG_X_AXIS, "content": "-X" });
      labels.push({ "position": Daydream.NEG_Y_AXIS, "content": "-Y" });
      labels.push({ "position": Daydream.NEG_Z_AXIS, "content": "-Z" });
    }

    if (effect && typeof effect.getLabels === 'function') {
      labels.push(...effect.getLabels());
    }

    // position is a unit direction, so position·cameraPos == |cameraPos|·cos(angle);
    // scaling the cutoff by the live distance keeps the visible set zoom-independent.
    const facingThreshold =
      Daydream.LABEL_VISIBILITY_FRAMING_RATIO * this.camera.position.length();
    for (const label of labels) {
      if (label.position.dot(this.camera.position) > facingThreshold) {
        this.labelPool.acquire(label.position, label.content);
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
        ? -Daydream.DOT_SIZE / Daydream.SPHERE_RADIUS
        : -2.0;
      // Persist effects pass the equator half-arc (PI*R/W) so the shader fills the
      // inter-column gaps; strobe and the pre-effect default pass 0 (round dots).
      this.cullUniforms.uColumnFillArc.value = this.strobeColumns === false
        ? this.columnFillOverlap * Math.PI * Daydream.SPHERE_RADIUS / Daydream.W
        : 0;
    }
  }

  /**
   * Set the active effect's POV column-strobe mode (from the engine's
   * strobeColumns()). false (persist) fills the inter-column gaps so columns
   * merge into a continuous band; true (strobe) leaves discrete dots with dark
   * gaps. Applied via uColumnFillScale in updateCullUniforms() each frame.
   * @param {boolean} strobe - true to strobe columns, false to persist/smear.
   */
  setStrobeColumns(strobe) {
    this.strobeColumns = strobe;
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

    this.renderer.setClearColor(this.scene.background, Daydream.SCENE_ALPHA ? 0 : 1);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Render the picture-in-picture corner view. Skipped on mobile, under
   * headless automation (Playwright/Puppeteer/Selenium set navigator.webdriver),
   * and while recording, so clean screenshots/videos aren't obscured by the
   * PiP corner.
   */
  renderPip() {
    if (this.isMobile || navigator.webdriver || this.recorder?.isRecording) return;

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
             if (dot(instanceColor, instanceColor) < 0.00000001) {
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

    // Per-dot sphere LOD: segment count decays exponentially as pixel count rises
    // so the triangle budget stays bounded.
    const MAX_DOT_SEGMENTS = 30;
    const LOD_DECAY_PIXELS = 30000;
    const MIN_DOT_SEGMENTS = 3;
    const totalPixels = Daydream.W * Daydream.H;
    const detail = Math.max(
      MIN_DOT_SEGMENTS,
      Math.round(MAX_DOT_SEGMENTS * Math.exp(-totalPixels / LOD_DECAY_PIXELS)));

    this.dotGeometry = new THREE.SphereGeometry(
      Daydream.DOT_SIZE,
      detail,
      detail,
      0,
      Math.PI
    );

    this.dotMesh = new THREE.InstancedMesh(
      this.dotGeometry,
      this.dotMaterial,
      Daydream.W * Daydream.H
    );

    this.dotMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.dotMesh.count = Daydream.W * Daydream.H;
    this.dotMesh.frustumCulled = false;
    this.scene.add(this.dotMesh);
  }

  /**
   * Compute each dot's instance matrix: map its pixel (x,y) to a point on the
   * sphere and orient the dot to face outward from the center. Also allocates
   * the shared instanceColor buffer (exposed as Daydream.pixels) that effects
   * write pixel colors into.
   */
  precomputeMatrices() {
    const vector = new THREE.Vector3();
    const dummy = new THREE.Object3D();
    const sph = new THREE.Spherical(); // reused scratch out-param

    for (let i = 0; i < Daydream.W * Daydream.H; i++) {
      const x = i % Daydream.W;
      const y = Math.floor(i / Daydream.W);

      vector.setFromSpherical(pixelToSpherical(x, y, Daydream, sph));
      vector.multiplyScalar(Daydream.SPHERE_RADIUS);

      dummy.position.set(0, 0, 0);
      dummy.lookAt(vector);
      dummy.position.copy(vector);
      dummy.updateMatrix();

      if (this.dotMesh) {
        this.dotMesh.setMatrixAt(i, dummy.matrix);
      }
    }

    if (this.dotMesh) {
      const needed = this.dotMesh.count * 3;
      // Reallocate on a count change too, not just when null — a stale buffer
      // sized to a previous count would silently mismatch the instance count.
      if (!this.dotMesh.instanceColor ||
          this.dotMesh.instanceColor.array.length !== needed) {
        this.dotMesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Uint16Array(needed), 3, true
        );
        this.dotMesh.instanceColor.colorSpace = THREE.LinearSRGBColorSpace;
        this.dotMesh.instanceColor.setUsage(THREE.StreamDrawUsage);
      }
      // A fresh JS-owned buffer, not WASM memory; the next refreshPixelView()
      // re-fetches the WASM view and re-points all three aliases.
      Daydream.pixels = this.dotMesh.instanceColor.array;
      Daydream.pixels.fill(0);

      this.dotMesh.instanceMatrix.needsUpdate = true;
      this.dotMesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Write the per-frame stats panels (desktop + mobile): the frame draw
   * duration (red past SLOW_FRAME_MS) and, if the effect exposes arena metrics,
   * each arena's usage|high-water|capacity in KiB.
   * @param {number} duration - Frame draw time in milliseconds.
   * @param {Object} effect - Active effect; its getArenaMetrics() supplies arena usage when present.
   */
  updateStats(duration, effect) {
    if (!this.statsGroup) {
      this.statsGroup = {
        perf: [document.getElementById("perf-stats"), document.getElementById("perf-stats-mobile")],
        scratchA: [document.getElementById("stat-scratch-a"), document.getElementById("stat-scratch-a-m")],
        scratchB: [document.getElementById("stat-scratch-b"), document.getElementById("stat-scratch-b-m")],
        persist: [document.getElementById("stat-persistent"), document.getElementById("stat-persistent-m")],
        stack: [document.getElementById("stat-stack"), document.getElementById("stat-stack-m")]
      };
    }

    const perfText = `${duration.toFixed(3)} ms`;
    const perfColor = duration > SLOW_FRAME_MS ? 'red' : 'grey';
    this.statsGroup.perf.forEach(el => {
      if (el) { el.innerText = perfText; el.style.color = perfColor; }
    });

    if (effect && effect.getArenaMetrics) {
      const m = effect.getArenaMetrics();
      if (!m) return;
      const fmt = (x) => `${(x.usage / 1024).toFixed(1)}|${(x.high_water_mark / 1024).toFixed(1)}|${(x.capacity / 1024).toFixed(0)}`;

      const updateRow = (elements, val) => {
        const text = fmt(val);
        elements.forEach(el => { if (el) el.textContent = text; });
      };

      updateRow(this.statsGroup.scratchA, m.scratch_arena_a);
      updateRow(this.statsGroup.scratchB, m.scratch_arena_b);
      updateRow(this.statsGroup.persist, m.persistent_arena);
      if (m.stack) {
        const stackText = `${(m.stack.high_water_mark / 1024).toFixed(1)}|${(m.stack.capacity / 1024).toFixed(0)}`;
        this.statsGroup.stack.forEach(el => { if (el) el.textContent = stackText; });
      }
    }
  }

  /**
   * Change the sphere's pixel grid to `h`x`w` with the given dot size, then
   * rebuild the dot mesh and its instance matrices/color buffer.
   * @param {number} h - New grid height in pixels.
   * @param {number} w - New grid width in pixels.
   * @param {number} dotSize - New dot radius in scene units.
   */
  updateResolution(h, w, dotSize) {
    Daydream.H = h;
    Daydream.W = w;
    Daydream.PIXEL_WIDTH = 2 * Math.PI / Daydream.W;
    Daydream.DOT_SIZE = dotSize;

    this.setupDots();

    this.precomputeMatrices();
  }

  /**
   * Release everything this instance owns: the ResizeObserver, the WebGL
   * program/geometry/material resources, the OrbitControls listeners, and the
   * label DOM layer. Call before discarding a Daydream (e.g. on SPA navigation
   * away) so it leaves behind no live observer firing into a dead scene and no
   * leaked GPU material/geometry/context.
   */
  dispose() {
    this.resizeObserver?.disconnect();

    if (this.onContextLost) {
      this.canvas.removeEventListener(
        "webglcontextlost", this.onContextLost, false);
      this.canvas.removeEventListener(
        "webglcontextrestored", this.onContextRestored, false);
    }
    this.contextLostOverlay?.remove();

    if (this.dotMesh) {
      this.scene.remove(this.dotMesh);
      this.dotMesh.geometry?.dispose();
      // Detach the possibly WASM-aliased instanceColor buffer before dispose()
      // (see setupDots()).
      if (this.dotMesh.instanceColor) this.dotMesh.instanceColor.array = null;
      this.dotMesh.dispose();
      this.dotMesh = null;
    }
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
    // Stop the rAF callback before disposal so it never fires into the nulled
    // dotMesh / disposed renderer on a real page discard.
    this.renderer?.setAnimationLoop(null);
    this.renderer?.dispose();
  }
}

// Reused scratch for coordsLabel's transient conversions (synchronous, no overlap).
const coordsScratchSph = new THREE.Spherical();
const coordsScratchVec = new THREE.Vector3();

/**
 * Build a label for a Cartesian point `c` ([x,y,z]): its position is `c`'s
 * direction as a unit vector (the getLabels contract — LabelPool.acquire scales
 * it to the sphere surface and refreshLabels' facing test assumes unit length),
 * and its content lists the spherical angles, raw coordinates, and normalized
 * direction (each via prettify()).
 * @param {Array<number>} c - Cartesian point as [x, y, z].
 * @returns {{position: THREE.Vector3, content: string}} Unit-direction label placement and its multi-line text.
 */
export const coordsLabel = (c) => {
  const s = coordsScratchSph.setFromCartesianCoords(c[0], c[1], c[2]);
  const n = coordsScratchVec.set(c[0], c[1], c[2]).normalize();
  return {
    position: new THREE.Vector3()
      .setFromSphericalCoords(1, s.phi, s.theta),
    content:
      `\u03B8, \u03A6 : ${prettify(s.theta)}, ${prettify(s.phi)}\nx, y, z : ${prettify(c[0])}, ${prettify(c[1])}, ${prettify(c[2])}\nx\u0302, y\u0302, z\u0302 : ${prettify(n.x)}, ${prettify(n.y)}, ${prettify(n.z)}`
  };
}