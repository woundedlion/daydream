/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { pixelToSpherical } from "./geometry.js";
import { GUI } from "gui";

// Constants
const PHI = (1 + Math.sqrt(5)) / 2;
const g = 1 / PHI;

class LabelPool {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    this.activeCount = 0;
  }

  reset() {
    this.activeCount = 0;
  }

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

export const XY = (x, y) => x + y * Daydream.W;

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
  static H = 20;
  static W = 96;
  static PIXEL_WIDTH = 2 * Math.PI / Daydream.W;
  static FPS = 16;
  static DOT_SIZE = 2;
  static DOT_COLOR = 0x0000ff;

  static pixelPositions = new Array(Daydream.W * Daydream.H);
  static pixels = null;

  static X_AXIS = new THREE.Vector3(1, 0, 0);
  static Y_AXIS = new THREE.Vector3(0, 1, 0);
  static Z_AXIS = new THREE.Vector3(0, 0, 1);
  static NEG_X_AXIS = new THREE.Vector3(-1, 0, 0);
  static NEG_Y_AXIS = new THREE.Vector3(0, -1, 0);
  static NEG_Z_AXIS = new THREE.Vector3(0, 0, -1);
  static UP = Daydream.Y_AXIS;

  constructor() {
    THREE.ColorManagement.enabled = true;
    this.canvas = document.querySelector("#canvas");

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: Daydream.SCENE_ANTIALIAS,
      alpha: Daydream.SCENE_ALPHA,
    });

    // Cap pixel ratio at 1 to disable high-DPI rendering for performance/aesthetic reasons.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));

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

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(Daydream.SCENE_BACKGROUND_COLOR);
    this.paused = false;
    this.stepFrames = 0;
    this.recorder = null;

    // Timing Variables
    this.clock = new THREE.Clock(true);
    this.frameInterval = 1 / Daydream.FPS; // single source of truth (was hardcoded 1/16)
    this.timeAccumulator = 0;

    this.resources = [];
    this.labelPool = new LabelPool(this.scene);

    this.setupDots();

    this.axisMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      linewidth: 5
    });

    // Axis Geometries
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

    // Initialization
    this.pixelMatrices = [];
    this.timeAccumulator = 0;
    this.labelAxes = false;
    this.cullBackSphere = false;

    // Cache stats elements lazily
    this._statsGroup = null;

    this.precomputeMatrices();
  }

  keydown(e) {
    if (e.key == ' ') {
      this.paused = !this.paused;
    } else if (this.paused && e.key == "ArrowRight") {
      this.stepFrames++;
    }
  }

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
    this.camera.position.z = Math.max(distForHeight, distForWidth);

    this.renderer.setSize(width, height);
    this.labelRenderer.setSize(width, height);
  }

  render(effect) {
    if (!this._advanceFrameClock()) return;

    const advanced = this._stepSimulation(effect);

    this.controls.update();
    this._updateCullUniforms();

    this.renderer.setScissorTest(true);
    this._renderMainView();

    // Capture a video frame (simulation-synced) — only when the simulation
    // actually advanced this tick, so pausing freezes the recording instead of
    // padding it with duplicate frames.
    if (this.recorder && advanced) this.recorder.captureFrame();

    // Rebuild labels every rendered frame, not just on a simulation step, so a
    // paused frame still tracks camera orbits and clears the label DOM when
    // labels are toggled off (otherwise stale label DIVs persist while paused).
    this._refreshLabels(effect);
    if (this.labelPool.activeCount > 0) {
      this.labelRenderer.render(this.scene, this.camera);
    }

    this._renderPip();
    this.renderer.setScissorTest(false);
  }

  /// Fixed-timestep gate. Accumulates real elapsed time (clamped to avoid a
  /// spiral-of-death after a stall) and returns true — consuming one frame
  /// interval — only when enough has accrued to advance a frame.
  _advanceFrameClock() {
    const delta = this.clock.getDelta();
    this.timeAccumulator += delta;
    if (this.timeAccumulator > 0.25) this.timeAccumulator = 0.25;
    if (this.timeAccumulator < this.frameInterval) return false;
    this.timeAccumulator -= this.frameInterval;
    return true;
  }

  /// Advance the simulation one frame when running or single-stepping: clear the
  /// pixel buffer, draw the effect, refresh stats/labels. Returns whether the
  /// simulation actually advanced (false while paused) so the caller can gate
  /// the recorder on the same decision — captured before stepFrames is
  /// decremented.
  _stepSimulation(effect) {
    const advanced = !this.paused || this.stepFrames != 0;
    if (!advanced) return false;

    if (this.stepFrames != 0) this.stepFrames--;

    if (Daydream.pixels) Daydream.pixels.fill(0);

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

    this.xAxis.visible = this.labelAxes;
    this.yAxis.visible = this.labelAxes;
    this.zAxis.visible = this.labelAxes;

    return true;
  }

  /// Rebuild the floating label set (axis labels + effect-supplied labels),
  /// acquiring pooled sprites only for labels on the camera-facing hemisphere.
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

    for (const label of labels) {
      if (label.position.dot(this.camera.position) > Daydream.SPHERE_RADIUS) {
        this.labelPool.acquire(label.position, label.content);
      }
    }

    this.labelPool.cleanup();
  }

  /// Push the current camera position / cull mode into the backface-cull shader
  /// uniforms.
  _updateCullUniforms() {
    if (this.cullUniforms) {
      this.cullUniforms.uCameraPos.value.copy(this.camera.position);
      this.cullUniforms.uCullThreshold.value = this.cullBackSphere
        ? -Daydream.DOT_SIZE / Daydream.SPHERE_RADIUS
        : -2.0;
    }
  }

  /// Render the main sphere view into its viewport. Assumes the scissor test is
  /// already enabled by the caller.
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

  /// Render the picture-in-picture corner view. Skipped on mobile, under
  /// headless automation (Playwright/Puppeteer/Selenium set navigator.webdriver),
  /// and while recording, so clean screenshots/videos aren't obscured by the
  /// PiP corner.
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

  setupDots() {
    if (this.dotMesh) {
      this.scene.remove(this.dotMesh);
      this.dotMesh.geometry.dispose();
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

  precomputeMatrices() {
    Daydream.pixelPositions = new Array(Daydream.W * Daydream.H);
    this.pixelMatrices = new Array(Daydream.W * Daydream.H);
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

      Daydream.pixelPositions[i] = vector.clone().normalize();
      this.pixelMatrices[i] = dummy.matrix.clone();

      if (this.dotMesh) {
        this.dotMesh.setMatrixAt(i, this.pixelMatrices[i]);
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

    if (this.dotMesh) {
      this.scene.remove(this.dotMesh);
      this.dotMesh.geometry?.dispose();
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
  if (Math.abs(r - g) <= 0.00001) return "φ";
  if (Math.abs(r - 1 / g) <= 0.00001) return "φ\u207b\u00b9";
  if (Math.abs(r + g) <= 0.00001) return "-φ";
  if (Math.abs(r + 1 / g) <= 0.00001) return "-φ\u207b\u00b9";
  if (Math.abs(r - 1 / Math.sqrt(3)) <= 0.00001) return "\u221a3\u207b\u00b9";
  if (Math.abs(r + 1 / Math.sqrt(3)) <= 0.00001) return "-\u221a3\u207b\u00b9";
  return r.toFixed(precision);
}

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