/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { pixelToSpherical } from "./geometry.js";
import { G as g } from "./geometry.js";
import { vectorPool } from "./geometry.js";
import { GUI } from "gui";
import { colorPool, color4Pool } from "./color.js";
import { dotPool } from "./draw.js";

/** * Optimized LabelPool that removes objects from the Scene entirely.
 * This prevents CSS2DRenderer from traversing hidden objects.
 */
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

    // Reuse existing object if available
    if (this.activeCount < this.pool.length) {
      labelObj = this.pool[this.activeCount];
    } else {
      // Create new object if pool is empty
      const div = document.createElement("div");
      div.className = "label";
      labelObj = new CSS2DObject(div);
      labelObj.center.set(0, 1);
      this.pool.push(labelObj);
    }

    // Ensure it is in the scene (it might have been removed in cleanup)
    if (labelObj.parent !== this.scene) {
      this.scene.add(labelObj);
    }

    // Update position
    labelObj.position.copy(position).multiplyScalar(Daydream.SPHERE_RADIUS);
    labelObj.visible = true;

    // Only touch the DOM if the text actually changes
    if (labelObj.element.innerHTML !== content) {
      labelObj.element.innerHTML = content;
    }

    this.activeCount++;
  }

  cleanup() {
    // Remove unused labels from the scene entirely
    for (let i = this.activeCount; i < this.pool.length; i++) {
      const obj = this.pool[i];
      if (obj.parent === this.scene) {
        this.scene.remove(obj);
      }
    }
  }
}

/** @type {Array<{position: THREE.Vector3, content: string}>} Global array to store labels to be rendered. */
export var labels = [];

export const pixelKey = (x, y) => `${x},${y}`;
export const keyPixel = (k) => k.split(',');
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
  static FPS = 16;
  static DOT_SIZE = 2;
  static DOT_COLOR = 0x0000ff;
  static pixelPositions = new Array(Daydream.W * Daydream.H);

  static X_AXIS = new THREE.Vector3(1, 0, 0);
  static Y_AXIS = new THREE.Vector3(0, 1, 0);
  static Z_AXIS = new THREE.Vector3(0, 0, 1);

  constructor() {
    THREE.ColorManagement.enabled = true;
    this.canvas = document.querySelector("#canvas");

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: Daydream.SCENE_ANTIALIAS,
      alpha: Daydream.SCENE_ALPHA,
    });

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = "labelLayer";
    this.canvas.parentElement.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      Daydream.CAMERA_FOV,
      this.canvas.width / this.canvas.height,
      Daydream.CAMERA_NEAR,
      Daydream.CAMERA_FAR
    );

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

    // Timing Variables
    this.clock = new THREE.Clock(true);
    this.frameInterval = 1 / 16; // 62.5ms target
    this.timeAccumulator = 0;

    this.resources = [];
    this.labelPool = new LabelPool(this.scene);

    // Optimized Geometry (Low Poly for high FPS rendering)
    this.dotGeometry = new THREE.SphereGeometry(
      Daydream.DOT_SIZE,
      8,
      8,
      0,
      Math.PI
    );

    this.dotMaterial = new THREE.MeshBasicMaterial({
      side: THREE.FrontSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      depthWrite: false
    });

    this.dotMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
          #include <begin_vertex>
          #if defined(USE_INSTANCING_COLOR)
             if (dot(instanceColor, instanceColor) < 0.0001) {
                 transformed *= 0.0;
             }
          #endif
          `
      );
    };

    this.axisMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      linewidth: 5
    });

    // --- Axis Geometries ---
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

    this.dotMesh = new THREE.InstancedMesh(
      this.dotGeometry,
      this.dotMaterial,
      Daydream.W * Daydream.H
    );
    this.dotMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.dotMesh.count = Daydream.W * Daydream.H;
    this.dotMesh.frustumCulled = false;
    this.scene.add(this.dotMesh);
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

    Daydream.pixels = Array.from({ length: Daydream.W * Daydream.H }, () => new THREE.Color(0, 0, 0));
    this.pixelMatrices = [];
    this.precomputeMatrices();
    this.labelAxes = false;
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

    const pipWidth = Math.floor(width * 0.3);
    const pipHeight = Math.floor(height * 0.3);
    this.pipViewport.x = 0;
    this.pipViewport.y = 0;
    this.pipViewport.width = pipWidth;
    this.pipViewport.height = pipHeight;

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
    // 1. Accumulate Time
    const delta = this.clock.getDelta();
    this.timeAccumulator += delta;

    // Safety: prevent spiral of death
    if (this.timeAccumulator > 0.25) this.timeAccumulator = 0.25;

    // 2. SIMULATION LOOP (Runs exactly at 16 FPS / 62.5ms chunks)
    // Using a while loop ensures we catch up if a frame was late, maintaining exact speed.
    while (this.timeAccumulator >= this.frameInterval) {
      this.timeAccumulator -= this.frameInterval;

      if (!this.paused || this.stepFrames != 0) {
        if (this.stepFrames != 0) this.stepFrames--;

        // Reset Pools
        colorPool.reset();
        color4Pool.reset();
        dotPool.reset();
        vectorPool.reset();

        // Clear Pixels
        for (let i = 0; i < Daydream.pixels.length; i++) {
          Daydream.pixels[i].setHex(0);
        }

        // Draw Effect
        const start = performance.now();
        effect.drawFrame();
        const duration = performance.now() - start;
        const stats = document.getElementById("perf-stats");
        if (stats) stats.innerText = `${duration.toFixed(3)} ms`;

        // Update GPU Colors (Direct Buffer Access)
        const colorArray = this.dotMesh.instanceColor.array;
        for (let i = 0; i < Daydream.pixels.length; i++) {
          const pixelColor = Daydream.pixels[i];
          const stride = i * 3;
          colorArray[stride] = pixelColor.r;
          colorArray[stride + 1] = pixelColor.g;
          colorArray[stride + 2] = pixelColor.b;
        }
        // Mark for upload to GPU
        this.dotMesh.instanceColor.needsUpdate = true;

        // Update Labels
        this.xAxis.visible = this.labelAxes;
        this.yAxis.visible = this.labelAxes;
        this.zAxis.visible = this.labelAxes;

        this.labelPool.reset();
        labels = [];

        if (this.labelAxes) {
          labels.push({ "position": Daydream.X_AXIS, "content": "X" });
          labels.push({ "position": Daydream.Y_AXIS, "content": "Y" });
          labels.push({ "position": Daydream.Z_AXIS, "content": "Z" });
          labels.push({ "position": Daydream.X_AXIS.clone().negate(), "content": "-X" });
          labels.push({ "position": Daydream.Y_AXIS.clone().negate(), "content": "-Y" });
          labels.push({ "position": Daydream.Z_AXIS.clone().negate(), "content": "-Z" });
        }

        if (typeof effect.getLabels === 'function') {
          labels.push(...effect.getLabels());
        }

        for (const label of labels) {
          if (label.position.dot(this.camera.position) > Daydream.SPHERE_RADIUS) {
            this.labelPool.acquire(label.position, label.content);
          }
        }

        this.labelPool.cleanup();
      }
    }

    // 3. RENDER LOOP (Runs at Monitor Refresh Rate / 60 FPS)
    // This allows the camera to be smooth while the LEDs strobe at 16 FPS.

    this.controls.update();

    this.renderer.setScissorTest(true);
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

    if (this.labelPool.activeCount > 0) {
      this.labelRenderer.render(this.scene, this.camera);
    }

    if (!this.isMobile) {
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
      this.renderer.render(this.scene, this.camera);
    }

    this.renderer.setScissorTest(false);
  }

  precomputeMatrices() {
    Daydream.pixelPositions = new Array(Daydream.W * Daydream.H);
    this.pixelMatrices = new Array(Daydream.W * Daydream.H);
    const vector = new THREE.Vector3();
    const dummy = new THREE.Object3D();

    for (let i = 0; i < Daydream.W * Daydream.H; i++) {
      const x = i % Daydream.W;
      const y = Math.floor(i / Daydream.W);

      vector.setFromSpherical(pixelToSpherical(x, y));
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

    // Allocate color buffer if missing
    if (this.dotMesh) {
      if (!this.dotMesh.instanceColor) {
        this.dotMesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(this.dotMesh.count * 3), 3
        );
      }
      const colorArray = this.dotMesh.instanceColor.array;
      colorArray.fill(0);
      this.dotMesh.instanceMatrix.needsUpdate = true;
      this.dotMesh.instanceColor.needsUpdate = true;
    }
  }

  updateResolution(h, w, dotSize) {
    Daydream.H = h;
    Daydream.W = w;
    Daydream.DOT_SIZE = dotSize;

    this.scene.remove(this.dotMesh);
    this.dotGeometry.dispose();

    // Maintain Low-Poly optimization
    this.dotGeometry = new THREE.SphereGeometry(
      Daydream.DOT_SIZE,
      8,
      8,
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

    Daydream.pixels = Array.from({ length: Daydream.W * Daydream.H }, () => new THREE.Color(0, 0, 0));
    this.precomputeMatrices();
  }
}

export const prettify = (r) => {
  let precision = 3;
  if (Math.abs(r) <= 0.00001) return "0";
  if (Math.abs(r - 1) <= 0.00001) return "1";
  if (Math.abs(r + 1) <= 0.00001) return "-1";
  if (Math.abs(r - Math.PI) <= 0.00001) return "&pi;";
  if (Math.abs(r + Math.PI) <= 0.00001) return "-&pi;";
  if (Math.abs(r - Math.PI / 2) <= 0.00001) return "&pi;/2";
  if (Math.abs(r + Math.PI / 2) <= 0.00001) return "-&pi;/2";
  if (Math.abs(r - Math.PI / 4) <= 0.00001) return "&pi;/4";
  if (Math.abs(r + Math.PI / 4) <= 0.00001) return "-&pi;/4";
  if (Math.abs(r - 3 * Math.PI / 2) <= 0.00001) return "3&pi;/2";
  if (Math.abs(r + 3 * Math.PI / 2) <= 0.00001) return "-3&pi;/2";
  if (Math.abs(r - g) <= 0.00001) return "&phi;";
  if (Math.abs(r - 1 / g) <= 0.00001) return "&phi;\u207b\u00b9";
  if (Math.abs(r + g) <= 0.00001) return "-&phi;";
  if (Math.abs(r + 1 / g) <= 0.00001) return "-&phi;\u207b\u00b9";
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
      `\u03B8, \u03A6 : ${prettify(s.theta)}, ${prettify(s.phi)}<br>
       x, y, z : ${prettify(c[0])}, ${prettify(c[1])}, ${prettify(c[2])}<br>
       x\u0302, y\u0302, z\u0302 : ${prettify(n.x)}, ${prettify(n.y)}, ${prettify(n.z)}`
  };
}