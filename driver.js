// driver.js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { pixelToSpherical } from "./geometry.js";
import { G as g } from "./geometry.js";
import { gui } from "gui" // Note: Ensure this import matches your setup (lil-gui or dat.gui)

/** @type {Array<{position: THREE.Vector3, content: string}>} Global array to store labels to be rendered. */
export var labels = [];

/**
 * Generates a unique key string for a pixel coordinate.
 * @param {number} x - The x-coordinate.
 * @param {number} y - The y-coordinate.
 * @returns {string} The pixel key in the format "x,y".
 */
export const pixelKey = (x, y) => `${x},${y}`;

/**
 * Parses a pixel key string back into an array of [x, y] strings.
 * @param {string} k - The pixel key string.
 * @returns {string[]} An array containing [x, y] as strings.
 */
export const keyPixel = (k) => k.split(',');

/**
 * The main driver class for the Daydream visualization environment.
 * It sets up the THREE.js scene, camera, renderer, and handles the animation loop.
 */
export class Daydream {
  // --- Static Configuration Constants ---
  /** @type {boolean} Enables scene antialiasing. */
  static SCENE_ANTIALIAS = true;
  /** @type {boolean} Enables scene transparency. */
  static SCENE_ALPHA = true;
  /** @type {number} The scene's background color (hex). */
  static SCENE_BACKGROUND_COLOR = 0x000000;

  /** @type {number} Camera field of view. */
  static CAMERA_FOV = 20;
  /** @type {number} Camera near clipping plane. */
  static CAMERA_NEAR = 100;
  /** @type {number} Camera far clipping plane. */
  static CAMERA_FAR = 500;
  /** @type {number} Camera initial x-position. */
  static CAMERA_X = 0;
  /** @type {number} Camera initial y-position. */
  static CAMERA_Y = 0;
  /** @type {number} Camera initial z-position. */
  static CAMERA_Z = 220;

  /** @type {number} The radius of the conceptual sphere the particles live on. */
  static SPHERE_RADIUS = 30;
  /** @type {number} The height (y-resolution) of the pixel grid. */
  static H = 20;
  /** @type {number} The width (x-resolution) of the pixel grid. */
  static W = 96;
  /** @type {number} Target frames per second (currently unused in clock logic). */
  static FPS = 16;

  /** @type {number} The visual size/radius of the rendered dot mesh. */
  static DOT_SIZE = 2;
  /** @type {number} Default dot color (hex, though overwritten by instance color). */
  static DOT_COLOR = 0x0000ff;

  /** @type {THREE.Vector3} Static representation of the X-axis. */
  static X_AXIS = new THREE.Vector3(1, 0, 0);
  /** @type {THREE.Vector3} Static representation of the Y-axis. */
  static Y_AXIS = new THREE.Vector3(0, 1, 0);
  /** @type {THREE.Vector3} Static representation of the Z-axis. */
  static Z_AXIS = new THREE.Vector3(0, 0, 1);

  constructor() {
    THREE.ColorManagement.enabled = true;
    /** @type {HTMLCanvasElement} */
    this.canvas = document.querySelector("#canvas");

    /** @type {THREE.WebGLRenderer} */
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: Daydream.SCENE_ANTIALIAS,
      alpha: Daydream.SCENE_ALPHA,
    });

    /** @type {CSS2DRenderer} */
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.className = "labelLayer";
    this.canvas.parentElement.appendChild(this.labelRenderer.domElement);

    /** @type {THREE.PerspectiveCamera} */
    this.camera = new THREE.PerspectiveCamera(
      Daydream.CAMERA_FOV,
      this.canvas.width / this.canvas.height,
      Daydream.CAMERA_NEAR,
      Daydream.CAMERA_FAR
    );
    /** @type {OrbitControls} */
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.camera.position.set(
      Daydream.CAMERA_X,
      Daydream.CAMERA_Y,
      Daydream.CAMERA_Z
    );
    /** @type {THREE.Scene} */
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(Daydream.SCENE_BACKGROUND_COLOR);
    /** @type {boolean} */
    this.paused = false;
    /** @type {number} */
    this.stepFrames = 0;
    /** @type {THREE.Clock} */
    this.clock = new THREE.Clock(true);
    /** @type {Array<any>} */
    this.resources = [];

    /** @type {THREE.SphereGeometry} */
    this.dotGeometry = new THREE.SphereGeometry(
      Daydream.DOT_SIZE,
      32,
      16,
      0,
      Math.PI
    );

    /** @type {THREE.MeshBasicMaterial} */
    this.dotMaterial = new THREE.MeshBasicMaterial({
      side: THREE.FrontSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      depthWrite: false
    });

    /** @type {THREE.LineBasicMaterial} */
    this.axisMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      linewidth: 5
    });

    // --- Axis Geometries and Meshes ---
    let xAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.X_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS),
      Daydream.X_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS)
    ]);
    /** @type {THREE.Line} */
    this.xAxis = new THREE.Line(xAxisGeometry, this.axisMaterial);

    let yAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.Y_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS),
      Daydream.Y_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS)
    ]);
    /** @type {THREE.Line} */
    this.yAxis = new THREE.Line(yAxisGeometry, this.axisMaterial);

    let zAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.Z_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS),
      Daydream.Z_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS)
    ]);
    /** @type {THREE.Line} */
    this.zAxis = new THREE.Line(zAxisGeometry, this.axisMaterial);

    // --- Dot Mesh (InstancedMesh for performance) ---
    /** @type {THREE.InstancedMesh} */
    this.dotMesh = new THREE.InstancedMesh(
      this.dotGeometry,
      this.dotMaterial,
      Daydream.W * Daydream.H
    );
    this.dotMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dotMesh.count = 0;
    this.scene.add(this.dotMesh);

    /** @type {{x: number, y: number, width: number, height: number}} */
    this.mainViewport = { x: 0, y: 0, width: 1, height: 1 };
    /** @type {{x: number, y: number, width: number, height: number}} */
    this.pipViewport = { x: 0, y: 0, width: 0.25, height: 0.25 };

    // NEW: Track mobile state
    this.isMobile = false;

    this.setCanvasSize();

    this.labelAxes = false;
    // Note: Assuming 'gui' is imported correctly from your importmap (either dat.gui or lil-gui)
    this.gui = new gui.GUI();
    this.gui.add(this, 'labelAxes');
  }

  /**
   * Handles keyboard input for pausing/stepping.
   * @param {KeyboardEvent} e - The keyboard event.
   */
  keydown(e) {
    if (e.key == ' ') {
      this.paused = !this.paused;
    } else if (this.paused && e.key == "ArrowRight") {
      this.stepFrames++;
    }
  }

  /**
   * Creates and positions a 2D HTML label in the scene.
   * @param {THREE.Vector3} position - The world position for the label.
   * @param {string} content - The HTML content of the label.
   */
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

  /**
   * Sets the canvas size and updates the camera aspect ratio and viewports.
   */
  setCanvasSize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // NEW: Check if screen is narrow (mobile)
    this.isMobile = width <= 768;

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

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height);
    this.labelRenderer.setSize(width, height);
  }

  /**
   * The main render loop function.
   * @param {Object} effect - The effect object containing the drawFrame() method.
   */
  render(effect) {
    if (this.clock.getElapsedTime() * 1000 > 62.5) {
      this.clock.start();
      if (!this.paused || this.stepFrames != 0) {
        if (this.stepFrames != 0) {
          this.stepFrames--;
        }

        // Clean up old labels
        for (let i = this.scene.children.length - 1; i >= 0; i--) {
          const obj = this.scene.children[i];
          if (obj.isCSS2DObject) {
            this.scene.remove(obj);
          }
        }
        labels = [];

        let pixels = effect.drawFrame();
        this.dotMesh.count = pixels.size;

        const vector = new THREE.Vector3();

        let i = 0;
        for (const [key, pixel] of pixels) {
          let p = keyPixel(key);
          vector.setFromSpherical(pixelToSpherical(p[0], p[1]));
          vector.multiplyScalar(Daydream.SPHERE_RADIUS);
          const dummy = new THREE.Object3D();
          dummy.lookAt(vector);
          dummy.position.copy(vector);
          dummy.updateMatrix();
          this.dotMesh.setMatrixAt(i, dummy.matrix);
          this.dotMesh.setColorAt(i, pixel);
          this.dotMesh.instanceColor.needsUpdate = true;
          this.dotMesh.instanceMatrix.needsUpdate = true;
          ++i;
        }

        // draw axes
        if (this.labelAxes) {
          labels.push({ "position": Daydream.X_AXIS, "content": "X" });
          labels.push({ "position": Daydream.Y_AXIS, "content": "Y" });
          labels.push({ "position": Daydream.Z_AXIS, "content": "Z" });
        }

        for (const label of labels) {
          this.makeLabel(label.position, label.content);
          console.log(labels.size)
        }
      }
    }

    this.controls.update();

    // --- Render Main Viewport ---
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

    // --- Render PiP Viewport (ONLY if not mobile) ---
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

/**
 * Converts a floating-point number to a user-friendly string representation...
 * (Rest of file remains unchanged)
 */
// ... (prettify and coordsLabel functions remain the same)
export const prettify = (r) => {
  let precision = 3;

  if (Math.abs(r) <= 0.00001) {
    return "0";
  }

  if (Math.abs(r - 1) <= 0.00001) {
    return "1";
  }

  if (Math.abs(r + 1) <= 0.00001) {
    return "-1";
  }

  if (Math.abs(r - Math.PI) <= 0.00001) {
    return "&pi;";
  }
  if (Math.abs(r + Math.PI) <= 0.00001) {
    return "-&pi;";
  }

  if (Math.abs(r - Math.PI / 2) <= 0.00001) {
    return "&pi;/2";
  }
  if (Math.abs(r + Math.PI / 2) <= 0.00001) {
    return "-&pi;/2";
  }

  if (Math.abs(r - Math.PI / 4) <= 0.00001) {
    return "&pi;/4";
  }
  if (Math.abs(r + Math.PI / 4) <= 0.00001) {
    return "-&pi;/4";
  }

  if (Math.abs(r - 3 * Math.PI / 2) <= 0.00001) {
    return "3&pi;/2";
  }
  if (Math.abs(r + 3 * Math.PI / 2) <= 0.00001) {
    return "-3&pi;/2";
  }

  if (Math.abs(r - g) <= 0.00001) {
    return "&phi;";
  }
  if (Math.abs(r - 1 / g) <= 0.00001) {
    return "&phi;\u207b\u00b9";
  }
  if (Math.abs(r + g) <= 0.00001) {
    return "-&phi;";
  }
  if (Math.abs(r + 1 / g) <= 0.00001) {
    return "-&phi;\u207b\u00b9";
  }

  if (Math.abs(r - 1 / Math.sqrt(3)) <= 0.00001) {
    return "\u221a3\u207b\u00b9";
  }
  if (Math.abs(r + 1 / Math.sqrt(3)) <= 0.00001) {
    return "-\u221a3\u207b\u00b9";
  }

  return r.toFixed(precision);
}

export const coordsLabel = (c) => {
  const p = 3;
  let s = new THREE.Spherical().setFromCartesianCoords(c[0], c[1], c[2]);
  let n = new THREE.Vector3(c[0], c[1], c[2]).normalize();
  return {
    position: new THREE.Vector3()
      .setFromSphericalCoords(Daydream.SPHERE_RADIUS, s.phi, s.theta),
    content:
      `\u03B8, \u03A6 :
        ${prettify(s.theta)},
        ${prettify(s.phi)}
       <br>

       x, y, z :
        ${prettify(c[0])},
        ${prettify(c[1])}, 
        ${prettify(c[2])}
       <br>

       x\u0302, y\u0302, z\u0302 :
        ${prettify(n.x)},
        ${prettify(n.y)},
        ${prettify(n.z)}
       `
  };
}