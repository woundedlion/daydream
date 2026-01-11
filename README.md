# Daydream Simulator

**Daydream** is a comprehensive WebGL-based simulator for the **[Holosphere](../pov)** firmware. It serves as a 1:1 development environment, enabling the writing, debugging, and visualization of C++ POV effects using modern JavaScript and Three.js prior to hardware deployment.

The architecture mirrors the C++ firmware to ensure seamless porting.

---

## 🌟 Architecture & Core Components

Daydream replicates the Holosphere firmware structure in JavaScript.

### 1. The Virtual Driver (`driver.js`)
The `Daydream` class acts as the hardware abstraction layer (HAL):
*   **Virtual Display**: Manages a pixel buffer (`Daydream.pixels`) corresponding to the spherical LED array.
*   **Instanced Rendering**: Uses `THREE.InstancedMesh` to efficiently render thousands of LEDs in a single draw call.
*   **Frame Loop**: Manages the render loop (`render()`), handling clearing, drawing effects, and updating the display.
*   **Optimization**: Features optimization strategies like object pooling (for `THREE.Vector3`, `THREE.Color`) to minimize garbage collection overhead.

### 2. Geometry & Math (`geometry.js`, `util.js`)
Handles the complex spherical mathematics required for the POV display:
*   **Spherical Conversion**: Utilities like `vectorToPixel`, `pixelToVector`, `phiToY` for mapping 3D space to the 2D LED buffer.
*   **Orientation**: The `Orientation` class manages quaternion-based rotation history, enabling motion trails and complex rotations.
*   **Lissajous**: Implementation of projection-based Lissajous curves for generating complex, non-singular paths on the sphere.
*   **Fibonacci Spirals**: Logic for evenly distributing points on the sphere.
*   **Math Utils**: Basic helpers in `util.js` for wrapping, permutation, and distance calculations.

### 3. Drawing System (`draw.js`)
A set of high-level primitives and drawing pipelines:
*   **`Plot.Point`, `Plot.Line`**: Basic primitives for drawing dots and geodesic lines (great circles).
*   **`Plot.Ring`, `Plot.Polygon`**: Tools for drawing circles and n-sided polygons on the sphere surface also supports distortion.
*   **`Plot.DistortedRing`**: Advanced ring drawing with function-based distortion (e.g., sine waves applied to the radius).
*   **`Scan.Ring`**: A scanline-based rasterizer for drawing thick, anti-aliased rings directly into the pixel buffer, supporting depth checks and clipping planes.
*   **`rasterize()`**: Converts vector paths into discrete points for the pixel buffer.

### 4. Animation Engine (`animation.js`)
A robust animation framework based on a `Timeline`:
*   **`Timeline`**: Manages a queue of animations, executing them in sync with the frame clock.
*   **Animations**: Includes `Motion` (path following), `Rotation` (axis-angle), `RandomWalk` (stochastic movement), `Sprite` (fade in/out), and `ColorWipe` (palette transitions).
*   **Easing**: A collection of easing functions (e.g., `easeOutElastic`, `easeInOutBicubic`) for natural motion.
*   **ParticleSystem**: A noise-driven particle system for flow field effects.

### 5. Render Pipeline & Filters (`filters.js`)
The `createRenderPipeline` function builds a chain of filters to process drawing operations:
*   **`FilterAntiAlias`**: Applies quintic kernel smoothing to pixel operations for high-quality visuals.
*   **`FilterOrient`**: Rotates the entire world or specific objects using an `Orientation` quaternion.
*   **`FilterMobius`**: Applies conformal Möbius transformations (Sphere -> Plane -> Transform -> Sphere) for psychedelic warping effects.
*   **`FilterTrail` & `FilterWorldTrails`**: Manages fading trails for points, creating a sense of history and motion.
*   **`FilterReplicate`**: Duplicates drawing operations across the sphere (e.g., symmetry).

### 6. Color Engine (`color.js`)
Advanced color management:
*   **`Color4`**: Extends `THREE.Color` with an alpha channel.
*   **`GenerativePalette`**: Procedurally generates harmonious color palettes (Triadic, Split-Complementary, Analogous) based on color theory.
*   **`ProceduralPalette`**: Implements cosine-based gradients ($A + B \cdot \cos(2\pi(Cx + D))$).
*   **Pooling**: `colorPool` and `color4Pool` recycle color objects to reduce allocation.

---

## 🎨 Included Effects

The `effects/` directory contains the visual sketches. Each class typically manages its own `Timeline`, `Orientation`, and render logic.

*   **`Comets`**: Lissajous-driven particles leaving trails.
*   **`Voronoi`**: Cellular noise patterns on the sphere.
*   **`MobiusGrid`**: A grid distorted by Möbius transformations.
*   **`HopfFibration`**: Visualization of the Hopf Fibration (circles interlaced on the 3-sphere projected to 2-sphere).
*   **`FlowField`**: Noise-driven particle flow.
*   **`ReactionDiffusion`**: Gray-Scott and Belousov-Zhabotinsky simulations (`GSReactionDiffusion`, `BZReactionDiffusion`).
*   **`Portholes`**: Clipping plane effects revealing inner geometries.
*   **`MetaballEffect`**: 2D Metaballs mapped to the sphere surface.
*   **`LSystem`**: Fractal plant growth simulations.
*   ...and many more (`PetalFlow`, `Moire`, `RingSpin`, `Thrusters`, etc.)

---

## 🛠 Visual Tools

Daydream provides HTML-based tools for researching math and designing assets:

### 🎨 Palette Generator (`palettes.html`)
Interactive design of procedural cosine gradients.
*   **Visualizers**: RGB waveforms and gradient preview.
*   **Export**: Generates C++/JS code.

### 🌀 Möbius Visualizer (`mobius.html`)
Playground for Möbius transformations.
*   **Interactive Plane**: Drag control points to define transformations.
*   **Presets**: Elliptic, Hyperbolic, Loxodromic, Parabolic transforms.

### ➿ Lissajous Visualizer (`lissajous.html`)
Tool to tune spherical Lissajous curves.
*   **Rational Locking**: Snaps frequencies to rational ratios for closed loops.
*   **Export**: Generates the exact formula parameters.

---

## 🚀 Getting Started

1.  **Install**:
    ```bash
    npm install
    ```

2.  **Run**:
    ```bash
    npx http-server .
    ```

3.  **Open**:
    Navigate to `http://localhost:8080`.
    *   **Controls**: Use the dat.GUI panel to switch effects and tweak parameters.
    *   **Keyboard**: SPACE to pause, ARROW RIGHT to step frames.

---
*Hardware implementation: [Holosphere Firmware](../pov/README.md)*
