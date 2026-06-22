/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { pixelToSpherical } from "./geometry.js";

// Golden ratio and its inverse, used by prettify() to name recognizable angles.
const PHI = (1 + Math.sqrt(5)) / 2;
const g = 1 / PHI;

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

    // Labels are plain text (axis names, effect-supplied strings); use
    // textContent so a label string can never inject markup.
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
  // Label-visibility threshold, compared at the use site against cos(angle)
  // between a label's (unit) direction and the camera direction. Despite the
  // name this is a framing ratio — sphere radius over the canonical camera
  // distance — not a true cosine; it equals the intended angular cutoff only at
  // CAMERA_Z. Pinning it to the canonical framing (rather than the old
  // dot(label, cameraPos) > SPHERE_RADIUS test) keeps the visible label set from
  // drifting with orbit distance: the use site rescales it by the live distance.
  static LABEL_VISIBILITY_COS = Daydream.SPHERE_RADIUS / Daydream.CAMERA_Z;
  static H = 20;
  static W = 96;
  static PIXEL_WIDTH = 2 * Math.PI / Daydream.W;
  static FPS = 16;
  // Spiral-of-death guard for the fixed-timestep clock: after a stall (tab
  // backgrounded, GC pause, breakpoint) the accumulated real time is clamped to
  // this many seconds so the sim catches up by at most a few frames per tick
  // instead of trying to replay the entire backlog at once (which would stall
  // further and accumulate more — the runaway). 0.25 s is ~4 frames at FPS.
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

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: Daydream.SCENE_ANTIALIAS,
      alpha: Daydream.SCENE_ALPHA,
    });

    // Cap pixel ratio at 1: high-DPI rendering costs GPU work without improving
    // the dot-grid aesthetic.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Replace the silent blank-canvas failure mode of a lost GPU context with a
    // logged reason + reload prompt, and halt rendering while it is lost.
    this._setupContextLossHandling();

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = "labelLayer";
    this.canvas.parentElement.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      Daydream.CAMERA_FOV,
      this.canvas.width / this.canvas.height,
      Daydream.CAMERA_NEAR,
      Daydream.CAMERA_FAR
    );

    this.pipCamera = this.camera.clone();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.camera.position.set(
      Daydream.CAMERA_X,
      Daydream.CAMERA_Y,
      Daydream.CAMERA_Z
    );

    // On-demand rendering: repaint only when something visible changes. Any
    // camera change (drag/zoom/pan, damping settle) emits 'change' and marks the
    // frame dirty, so orbiting repaints at the display's refresh rate while an
    // idle scene does no GPU work between simulation ticks. Starts dirty so the
    // first frame always paints.
    this._needsRender = true;
    this.controls.addEventListener('change', () => { this._needsRender = true; });

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
    this._hadLabels = false; // Tracks the previous frame's label count for the N->0 hide.

    this.setupDots();

    this.axisMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      linewidth: 5
    });

    // Diametric axis lines, drawn at 0.95 of the sphere radius; hidden until the
    // axis-label toggle turns them on.
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
    this.setCanvasSize();

    this.resizeObserver = new ResizeObserver(() => {
      this.setCanvasSize();
    });
    this.resizeObserver.observe(this.canvas.parentElement);

    this.timeAccumulator = 0;
    this.labelAxes = false;
    this.cullBackSphere = false;

    // DOM stats elements are looked up and cached on first _updateStats() call.
    this._statsGroup = null;

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
  _setupContextLossHandling() {
    this._contextLost = false;

    // Reuse the engine-load error overlay styling (.loading-overlay.error).
    const overlay = document.createElement("div");
    overlay.className = "loading-overlay error context-lost-overlay";
    overlay.style.display = "none";
    const title = document.createElement("div");
    title.className = "load-error-title";
    title.textContent = "GPU context lost";
    this._contextLostDetail = document.createElement("div");
    this._contextLostDetail.className = "load-error-detail";
    const reload = document.createElement("button");
    reload.className = "context-lost-reload";
    reload.textContent = "Reload";
    reload.addEventListener("click", () => location.reload());
    overlay.append(title, this._contextLostDetail, reload);
    this.canvas.parentElement.appendChild(overlay);
    this._contextLostOverlay = overlay;

    this._onContextLost = (e) => {
      // preventDefault signals we intend to handle a restore; standard per the
      // spec even though exit_on_context_lost usually precludes one here.
      e.preventDefault();
      this._contextLost = true;
      const reason = e.statusMessage || "no reason reported";
      console.error(`[daydream] WebGL context lost: ${reason}`);
      this._contextLostDetail.textContent =
        `${reason}. The GPU process was likely reset — reload to recover.`;
      overlay.style.display = "flex";
    };

    this._onContextRestored = () => {
      this._contextLost = false;
      console.warn("[daydream] WebGL context restored");
      overlay.style.display = "none";
    };

    this.canvas.addEventListener("webglcontextlost", this._onContextLost, false);
    this.canvas.addEventListener(
      "webglcontextrestored", this._onContextRestored, false);
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
    const container = this.canvas.parentElement;
    const width = container.clientWidth;
    const height = container.clientHeight;
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

    const diameter = Daydream.SPHERE_RADIUS * 2;
    const targetCoverage = 0.85;
    const fovRad = THREE.MathUtils.degToRad(Daydream.CAMERA_FOV / 2);
    const distForHeight = diameter / (2 * Math.tan(fovRad) * targetCoverage);
    const distForWidth = distForHeight / this.camera.aspect;
    // Re-fit the camera distance along its current view direction. The orbit
    // target is the origin (sphere center), so the position vector's length is
    // the orbit radius; setLength rescales only that radius and leaves the
    // azimuth/polar angle intact, avoiding a teleport that would jar an orbited
    // camera's view direction.
    this.camera.position.setLength(Math.max(distForHeight, distForWidth));

    this.renderer.setSize(width, height);
    this.labelRenderer.setSize(width, height);

    // A resize changes the viewport and camera framing without moving the
    // OrbitControls camera or advancing the sim, so request a repaint.
    this._needsRender = true;
  }

  /**
   * Request a repaint on the next animation frame. For on-demand rendering:
   * callers that mutate the visible scene without advancing the simulation or
   * moving the camera (e.g. toggling axes/back-face culling, changing
   * resolution) must call this, otherwise the change won't show until the next
   * sim tick — or never, while paused.
   */
  invalidate() {
    this._needsRender = true;
  }

  /**
   * Animation-loop body, called once per animation frame with the active
   * effect. Advances the fixed-timestep simulation if an interval has accrued,
   * updates controls, and repaints the main view, labels, and PiP — but only
   * when the sim stepped, the camera moved, or invalidate() was called.
   * @param {Object} effect - Active effect; its drawFrame()/getLabels()/getArenaMetrics() drive the painted frame.
   */
  render(effect) {
    // A lost WebGL context rejects all GL calls, so skip rendering entirely until
    // it is restored (see _setupContextLossHandling). The animation loop keeps
    // firing; this just makes each tick a no-op instead of a stream of GL errors.
    if (this._contextLost) return;

    // The fixed-timestep clock gates only the simulation; rendering is
    // on-demand. _advanceFrameClock() runs every animation frame (so the
    // accumulator drains), but only steps the sim when an interval has accrued.
    const advanced = this._advanceFrameClock() && this._stepSimulation(effect);

    // controls.update() must run every frame for damping / auto-rotate to
    // progress; it emits 'change' (→ _needsRender) when it moves the camera.
    this.controls.update();

    // Repaint only when something visible changed — the sim drew a new frame, a
    // camera move marked us dirty, or an explicit invalidate() did. Otherwise
    // skip all GPU work this frame.
    if (!advanced && !this._needsRender) return;
    this._needsRender = false;

    // Axis-line visibility tracks the toggle every painted frame (not only on a
    // sim step), so it updates immediately even while paused.
    this.xAxis.visible = this.labelAxes;
    this.yAxis.visible = this.labelAxes;
    this.zAxis.visible = this.labelAxes;

    this._updateCullUniforms();

    this.renderer.setScissorTest(true);
    this._renderMainView();

    // Capture a video frame (simulation-synced) — only when the simulation
    // actually advanced this tick, so pausing freezes the recording instead of
    // padding it with duplicate frames. In segmented mode the worker composite
    // lands a frame late, so also require the adapter to report a real frame in
    // the buffer (captureReady) — otherwise the recording opens with the cleared
    // black frames driver.render() left before the pipeline filled.
    if (this.recorder && advanced &&
        (typeof effect.captureReady !== 'function' || effect.captureReady()))
      this.recorder.captureFrame();

    // Rebuild labels every rendered frame, not just on a simulation step, so a
    // paused frame still tracks camera orbits and clears the label DOM when
    // labels are toggled off.
    this._refreshLabels(effect);
    // CSS2DRenderer only shows/hides its label <div>s during a render pass, so
    // skipping render() at zero labels would leave the previous frame's labels
    // visible on the N->0 transition. Render one extra frame when the count
    // falls to zero so that pass can hide them, then settle into skipping.
    const hasLabels = this.labelPool.activeCount > 0;
    if (hasLabels || this._hadLabels) {
      this.labelRenderer.render(this.scene, this.camera);
    }
    this._hadLabels = hasLabels;

    this._renderPip();
    this.renderer.setScissorTest(false);
  }

  /**
   * Fixed-timestep gate. Accumulates real elapsed time (clamped to avoid a
   * spiral-of-death after a stall) and consumes one frame interval only when
   * enough has accrued to advance a frame.
   * @returns {boolean} True when a frame interval was consumed and the sim should advance.
   */
  _advanceFrameClock() {
    const delta = this.clock.getDelta();
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
  _stepSimulation(effect) {
    const advanced = !this.paused || this.stepFrames !== 0;
    if (!advanced) return false;

    if (this.stepFrames !== 0) this.stepFrames--;

    // Detach-aware guard: _stepSimulation runs before refreshPixelView heals a
    // view detached by WASM heap growth. A detached Uint16Array is still truthy,
    // and fill() on it throws TypeError, permanently freezing the app. Match the
    // byteLength check refreshPixelView uses so the next adapter drawFrame heals.
    if (Daydream.pixels && Daydream.pixels.buffer.byteLength !== 0)
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

    this._updateStats(duration, effect);

    this.dotMesh.instanceColor.needsUpdate = true;

    return true;
  }

  /**
   * Rebuild the floating label set (axis labels + effect-supplied labels),
   * acquiring pooled sprites only for labels on the camera-facing hemisphere.
   * @param {Object} effect - Active effect; its getLabels() supplies extra labels when present.
   */
  _refreshLabels(effect) {
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

    // Compare cos(angle) against a FIXED cutoff. label.position is a unit
    // direction, so label·cameraPos == |cameraPos|·cos(angle); requiring
    // cos(angle) > LABEL_VISIBILITY_COS means label·cameraPos > cutoff·|cameraPos|.
    // Scaling the fixed cosine by the live camera distance (rather than comparing
    // the raw dot against SPHERE_RADIUS) keeps the visible set independent of zoom.
    const facingThreshold =
      Daydream.LABEL_VISIBILITY_COS * this.camera.position.length();
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
  _updateCullUniforms() {
    if (this.cullUniforms) {
      this.cullUniforms.uCameraPos.value.copy(this.camera.position);
      this.cullUniforms.uCullThreshold.value = this.cullBackSphere
        ? -Daydream.DOT_SIZE / Daydream.SPHERE_RADIUS
        : -2.0;
    }
  }

  /**
   * Render the main sphere view into its viewport. Assumes the scissor test is
   * already enabled by the caller.
   */
  _renderMainView() {
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
  _renderPip() {
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
      // Load-bearing: instanceColor.array may alias WASM linear memory
      // (refreshPixelView in daydream.js rebinds it to getPixels()'s zero-copy
      // view). Detach it before dispose() so Three.js's teardown can't read or
      // re-upload a buffer the engine owns — which a resolution switch is about
      // to free/reallocate.
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

      // Uniforms for backface culling (updated per frame in render())
      this.cullUniforms = {
        uCameraPos: { value: new THREE.Vector3(0, 0, 1) },
        uCullThreshold: { value: -0.06 }
      };

      this.dotMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.uCameraPos = this.cullUniforms.uCameraPos;
        shader.uniforms.uCullThreshold = this.cullUniforms.uCullThreshold;

        // Inject uniforms declaration
        shader.vertexShader = 'uniform vec3 uCameraPos;\nuniform float uCullThreshold;\n' + shader.vertexShader;

        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `
          #include <begin_vertex>
          #if defined(USE_INSTANCING_COLOR)
             // Hide black pixels
             if (dot(instanceColor, instanceColor) < 0.00000001) {
                 transformed *= 0.0;
             }
             // Backface cull: dot of instance position with camera direction
             vec3 instPos = (instanceMatrix[3]).xyz;
             float facing = dot(normalize(instPos), normalize(uCameraPos));
             if (facing < uCullThreshold) {
                 transformed *= 0.0;
             }
          #endif
          `
        );
      };
    }

    const totalPixels = Daydream.W * Daydream.H;
    const detail = Math.max(3, Math.round(30 * Math.exp(-totalPixels / 30000)));

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
    const sph = new THREE.Spherical(); // reused scratch (out-param, no per-dot alloc)

    for (let i = 0; i < Daydream.W * Daydream.H; i++) {
      const x = i % Daydream.W;
      const y = Math.floor(i / Daydream.W);

      vector.setFromSpherical(pixelToSpherical(x, y, sph));
      vector.multiplyScalar(Daydream.SPHERE_RADIUS);

      dummy.position.set(0, 0, 0);
      dummy.lookAt(vector);
      dummy.position.copy(vector);
      dummy.updateMatrix();

      // setMatrixAt copies dummy.matrix into the instance buffer, so the scratch
      // Object3D can be reused every iteration with no per-dot matrix retained.
      if (this.dotMesh) {
        this.dotMesh.setMatrixAt(i, dummy.matrix);
      }
    }

    if (this.dotMesh) {
      if (!this.dotMesh.instanceColor) {
        this.dotMesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Uint16Array(this.dotMesh.count * 3), 3, true
        );
        this.dotMesh.instanceColor.colorSpace = THREE.LinearSRGBColorSpace;
        this.dotMesh.instanceColor.setUsage(THREE.StreamDrawUsage);
      }
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
  _updateStats(duration, effect) {
    if (!this._statsGroup) {
      this._statsGroup = {
        perf: [document.getElementById("perf-stats"), document.getElementById("perf-stats-mobile")],
        scratchA: [document.getElementById("stat-scratch-a"), document.getElementById("stat-scratch-a-m")],
        scratchB: [document.getElementById("stat-scratch-b"), document.getElementById("stat-scratch-b-m")],
        persist: [document.getElementById("stat-persistent"), document.getElementById("stat-persistent-m")],
        stack: [document.getElementById("stat-stack"), document.getElementById("stat-stack-m")]
      };
    }

    const perfText = `${duration.toFixed(3)} ms`;
    const perfColor = duration > SLOW_FRAME_MS ? 'red' : 'grey';
    this._statsGroup.perf.forEach(el => {
      if (el) { el.innerText = perfText; el.style.color = perfColor; }
    });

    if (effect && effect.getArenaMetrics) {
      const m = effect.getArenaMetrics();
      const fmt = (x) => `${(x.usage / 1024).toFixed(1)}|${(x.high_water_mark / 1024).toFixed(1)}|${(x.capacity / 1024).toFixed(0)}`;

      const updateRow = (elements, val) => {
        const text = fmt(val);
        elements.forEach(el => { if (el) el.textContent = text; });
      };

      updateRow(this._statsGroup.scratchA, m.scratch_arena_a);
      updateRow(this._statsGroup.scratchB, m.scratch_arena_b);
      updateRow(this._statsGroup.persist, m.persistent_arena);
      if (m.stack) {
        const stackText = `${(m.stack.high_water_mark / 1024).toFixed(1)}|${(m.stack.capacity / 1024).toFixed(0)}`;
        this._statsGroup.stack.forEach(el => { if (el) el.textContent = stackText; });
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

    if (this._onContextLost) {
      this.canvas.removeEventListener(
        "webglcontextlost", this._onContextLost, false);
      this.canvas.removeEventListener(
        "webglcontextrestored", this._onContextRestored, false);
    }
    this._contextLostOverlay?.remove();

    if (this.dotMesh) {
      this.scene.remove(this.dotMesh);
      this.dotMesh.geometry?.dispose();
      // Detach the possibly WASM-aliased instanceColor buffer before dispose()
      // (see setupDots() for why).
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
    this.renderer?.dispose();
  }
}

/**
 * Format a number for label display, snapping near-matches (within 1e-5) to
 * symbolic names for common angles/constants (0, ±1, multiples of π, golden
 * ratio φ, 1/√3); otherwise a 3-decimal string.
 * @param {number} r - The value to format.
 * @returns {string} The symbolic name or a 3-decimal string representation.
 */
export const prettify = (r) => {
  let precision = 3;
  if (Math.abs(r) <= 0.00001) return "0";
  if (Math.abs(r - 1) <= 0.00001) return "1";
  if (Math.abs(r + 1) <= 0.00001) return "-1";
  if (Math.abs(r - Math.PI) <= 0.00001) return "π";
  if (Math.abs(r + Math.PI) <= 0.00001) return "-π";
  if (Math.abs(r - Math.PI / 2) <= 0.00001) return "π/2";
  if (Math.abs(r + Math.PI / 2) <= 0.00001) return "-π/2";
  if (Math.abs(r - Math.PI / 4) <= 0.00001) return "π/4";
  if (Math.abs(r + Math.PI / 4) <= 0.00001) return "-π/4";
  if (Math.abs(r - 3 * Math.PI / 2) <= 0.00001) return "3π/2";
  if (Math.abs(r + 3 * Math.PI / 2) <= 0.00001) return "-3π/2";
  if (Math.abs(r - 1 / g) <= 0.00001) return "φ";
  if (Math.abs(r - g) <= 0.00001) return "φ\u207b\u00b9";
  if (Math.abs(r + 1 / g) <= 0.00001) return "-φ";
  if (Math.abs(r + g) <= 0.00001) return "-φ\u207b\u00b9";
  if (Math.abs(r - 1 / Math.sqrt(3)) <= 0.00001) return "\u221a3\u207b\u00b9";
  if (Math.abs(r + 1 / Math.sqrt(3)) <= 0.00001) return "-\u221a3\u207b\u00b9";
  return r.toFixed(precision);
}

/**
 * Build a label for a Cartesian point `c` ([x,y,z]): its position is `c`
 * reprojected onto the sphere surface, and its content lists the spherical
 * angles, raw coordinates, and normalized direction (each via prettify()).
 * @param {Array<number>} c - Cartesian point as [x, y, z].
 * @returns {{position: THREE.Vector3, content: string}} Label placement on the sphere surface and its multi-line text.
 */
export const coordsLabel = (c) => {
  let s = new THREE.Spherical().setFromCartesianCoords(c[0], c[1], c[2]);
  let n = new THREE.Vector3(c[0], c[1], c[2]).normalize();
  return {
    position: new THREE.Vector3()
      .setFromSphericalCoords(Daydream.SPHERE_RADIUS, s.phi, s.theta),
    content:
      `\u03B8, \u03A6 : ${prettify(s.theta)}, ${prettify(s.phi)}\nx, y, z : ${prettify(c[0])}, ${prettify(c[1])}, ${prettify(c[2])}\nx\u0302, y\u0302, z\u0302 : ${prettify(n.x)}, ${prettify(n.y)}, ${prettify(n.z)}`
  };
}