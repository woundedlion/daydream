// driver.js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { pixelToSpherical } from "./geometry.js";
import { G as g } from "./geometry.js";
import { GUI } from "gui"; // Fixed import

/** @type {Array<{position: THREE.Vector3, content: string}>} Global array to store labels to be rendered. */
export var labels = [];

export const pixelKey = (x, y) => `${x},${y}`;
export const keyPixel = (k) => k.split(',');

export class Daydream {
  static SCENE_ANTIALIAS = true;
  static SCENE_ALPHA = true;
  static SCENE_BACKGROUND_COLOR = 0x000000;

  static CAMERA_FOV = 20;
  static CAMERA_NEAR = 100;
  static CAMERA_FAR = 1000; // Increased to allow camera to move back further
  static CAMERA_X = 0;
  static CAMERA_Y = 0;
  static CAMERA_Z = 220;

  static SPHERE_RADIUS = 30;
  static H = 20;
  static W = 96;
  static FPS = 16;

  static DOT_SIZE = 2;
  static DOT_COLOR = 0x0000ff;

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

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.className = "labelLayer";
    this.canvas.parentElement.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      Daydream.CAMERA_FOV,
      this.canvas.width / this.canvas.height,
      Daydream.CAMERA_NEAR,
      Daydream.CAMERA_FAR
    );

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // Initial position, will be adjusted in setCanvasSize
    this.camera.position.set(
      Daydream.CAMERA_X,
      Daydream.CAMERA_Y,
      Daydream.CAMERA_Z
    );

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(Daydream.SCENE_BACKGROUND_COLOR);
    this.paused = false;
    this.stepFrames = 0;
    this.clock = new THREE.Clock(true);
    this.resources = [];

    this.dotGeometry = new THREE.SphereGeometry(
      Daydream.DOT_SIZE,
      32,
      16,
      0,
      Math.PI
    );

    this.dotMaterial = new THREE.MeshBasicMaterial({
      side: THREE.FrontSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      depthWrite: false
    });

    this.axisMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      linewidth: 5
    });

    // --- Axis Geometries and Meshes ---
    let xAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.X_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS),
      Daydream.X_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS)
    ]);
    this.xAxis = new THREE.Line(xAxisGeometry, this.axisMaterial);

    let yAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.Y_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS),
      Daydream.Y_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS)
    ]);
    this.yAxis = new THREE.Line(yAxisGeometry, this.axisMaterial);

    let zAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.Z_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS),
      Daydream.Z_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS)
    ]);
    this.zAxis = new THREE.Line(zAxisGeometry, this.axisMaterial);

    this.dotMesh = new THREE.InstancedMesh(
      this.dotGeometry,
      this.dotMaterial,
      Daydream.W * Daydream.H
    );
    this.dotMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dotMesh.count = 0;
    this.scene.add(this.dotMesh);

    this.mainViewport = { x: 0, y: 0, width: 1, height: 1 };
    this.pipViewport = { x: 0, y: 0, width: 0.25, height: 0.25 };

    this.isMobile = false;

    this.setCanvasSize();

    // ResizeObserver to handle layout changes (e.g. GUI expanding)
    this.resizeObserver = new ResizeObserver(() => {
      this.setCanvasSize();
    });
    this.resizeObserver.observe(this.canvas.parentElement);

    // Global pixel buffer
    Daydream.pixels = Array.from({ length: Daydream.W * Daydream.H }, () => new THREE.Color(0, 0, 0));

    this.labelAxes = false;
  }

  keydown(e) {
    if (e.key == ' ') {
      this.paused = !this.paused;
    } else if (this.paused && e.key == "ArrowRight") {
      this.stepFrames++;
    }
  }

  makeLabel(position, content) {
    const div = document.createElement("div");
    div.className = "label";
    div.innerHTML = content;
    const label = new CSS2DObject(div);
    label.position.copy(position);
    label.position.multiplyScalar(Daydream.SPHERE_RADIUS);
    label.center.set(0, 1);
    this.scene.add(label)
  }

  setCanvasSize() {
    const container = this.canvas.parentElement;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Mobile detection
    this.isMobile = width <= 900;

    this.mainViewport.x = 0;
    this.mainViewport.y = 0;
    this.mainViewport.width = width;
    this.mainViewport.height = height;

    const pipWidth = Math.floor(width * 0.3);
    const pipHeight = Math.floor(height * 0.3);
    const pipMargin = 0;

    this.pipViewport.x = pipMargin;
    this.pipViewport.y = pipMargin;
    this.pipViewport.width = pipWidth;
    this.pipViewport.height = pipHeight;

    // Update Camera Aspect Ratio
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // --- FIX: Adjust Camera Distance for Mobile Portrait Mode ---
    // If aspect ratio is narrow (portrait), we must pull the camera back 
    // so the sphere (radius 30) fits within the horizontal FOV.
    if (this.camera.aspect < 1.0) {
      // Calculate required distance to fit the sphere width + padding
      const targetVisibleWidth = Daydream.SPHERE_RADIUS * 2.4; // 2.4 gives some padding
      // Math: visible_width = 2 * dist * tan(fov/2) * aspect
      // dist = (visible_width / 2) / (tan(fov/2) * aspect)
      const fovRad = THREE.MathUtils.degToRad(Daydream.CAMERA_FOV / 2);
      const dist = (targetVisibleWidth / 2) / (Math.tan(fovRad) * this.camera.aspect);

      this.camera.position.z = dist;
    } else {
      // Reset to default for landscape/desktop
      this.camera.position.z = Daydream.CAMERA_Z;
    }

    this.renderer.setSize(width, height);
    this.labelRenderer.setSize(width, height);
  }

  render(effect) {
    if (this.clock.getElapsedTime() * 1000 > 62.5) {
      this.clock.start();
      if (!this.paused || this.stepFrames != 0) {
        if (this.stepFrames != 0) {
          this.stepFrames--;
        }

        for (let i = this.scene.children.length - 1; i >= 0; i--) {
          const obj = this.scene.children[i];
          if (obj.isCSS2DObject) {
            this.scene.remove(obj);
          }
        }
        labels = [];

        // Clear buffer
        for (let i = 0; i < Daydream.pixels.length; i++) {
          Daydream.pixels[i].setHex(0);
        }

        // Draw effect to buffer
        effect.drawFrame();

        // Render buffer to InstanceMesh
        let instanceCount = 0;
        const vector = new THREE.Vector3();
        const dummy = new THREE.Object3D();
        const MAX_INSTANCES = this.dotMesh.count; // Total capacity

        for (let i = 0; i < Daydream.pixels.length; i++) {
          const pixelColor = Daydream.pixels[i];

          // Skip empty (black) pixels
          if (pixelColor.r === 0 && pixelColor.g === 0 && pixelColor.b === 0) continue;

          // Compute coordinates
          const x = i % Daydream.W;
          const y = Math.floor(i / Daydream.W);

          // Get 3D position
          vector.setFromSpherical(pixelToSpherical(x, y));
          vector.multiplyScalar(Daydream.SPHERE_RADIUS);

          // Reset position for correct rotation relative to origin
          dummy.position.set(0, 0, 0);
          dummy.lookAt(vector);
          dummy.position.copy(vector);
          dummy.updateMatrix();

          this.dotMesh.setMatrixAt(instanceCount, dummy.matrix);
          this.dotMesh.setColorAt(instanceCount, pixelColor);

          instanceCount++;
        }

        this.dotMesh.count = instanceCount;
        if (this.dotMesh.instanceColor) {
          this.dotMesh.instanceColor.needsUpdate = true;
        }
        this.dotMesh.instanceMatrix.needsUpdate = true;

        if (this.labelAxes) {
          labels.push({ "position": Daydream.X_AXIS, "content": "X" });
          labels.push({ "position": Daydream.Y_AXIS, "content": "Y" });
          labels.push({ "position": Daydream.Z_AXIS, "content": "Z" });
        }

        if (typeof effect.getLabels === 'function') {
          labels.push(...effect.getLabels());
        }

        for (const label of labels) {
          // Cull labels on the back side of the sphere
          if (label.position.dot(this.camera.position) > Daydream.SPHERE_RADIUS) {
            this.makeLabel(label.position, label.content);
          }
        }
      }
    }

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
    this.labelRenderer.render(this.scene, this.camera);

    // Only render PIP if NOT on mobile
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