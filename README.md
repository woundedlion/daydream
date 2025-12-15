# Daydream Simulator

**Daydream** is a comprehensive WebGL-based simulator for the **[Holosphere](../pov)** firmware. It is designed to act as a 1:1 development environment, allowing you to write, debug, and visualize C++ POV effects using modern JavaScript and Three.js before deploying them to hardware.

The project structure deliberately mirrors the C++ firmware architecture to make porting code seamless.

---

## 🌟 Architecture & Component Mapping

Daydream is not just a visualizer; it is a port of the Holosphere engine logic to JavaScript.

### 1. The Virtual Driver (`driver.js`)
This acts as the "hardware" layer of the simulator.
* **Virtual Display**: It creates a buffer of `W * H` pixels (`Daydream.pixels`), mimicking the raw LED buffer in the firmware.
* **Instanced Rendering**: Instead of creating thousands of Sphere meshes, it uses `THREE.InstancedMesh` to render 2,000+ LED dots efficiently in a single draw call.
* **Spherical Mapping**: It maps the 2D `(x, y)` coordinates of the pixel buffer to 3D `(x, y, z)` coordinates on a sphere, simulating the physical layout of the POV device.

### 2. Engine Core (Ported Modules)
These files map directly to their C++ counterparts in the `pov` project:

| JavaScript File | C++ Counterpart | Function |
| :--- | :--- | :--- |
| **`geometry.js`** | `geometry.h` | Implements `Orientation`, `Dot`, and `Vector` logic. Includes the `tween` function for motion blur. |
| **`3dmath.js`** | `3dmath.h` | Math utilities including complex numbers for Möbius transforms (`mobius`, `stereo`, `invStereo`) and `fibSpiral` generation. |
| **`filters.js`** | `filter.h` | The render pipeline. Includes `FilterOrient` (world rotation), `FilterAntiAlias` (quintic smoothing), and `FilterDecay` (trails). |
| **`animation.js`** | `animation.h` | The `Timeline` class, `Transition`, `Sprite`, `Mutation`, and easing functions. |
| **`color.js`** | `color.h` | `GenerativePalette` and `ProceduralPalette` logic for dynamic color creation. |
| **`draw.js`** | `draw.h` | Geometry generators like `drawLine`, `drawRing`, and `rasterize`. |
| **`StaticCircularBuffer.js`** | `static_circular_buffer.h` | A fixed-size ring buffer implementation to mimic the memory constraints and behavior of the C++ firmware. |

### 3. Hot Module Replacement (HMR)
The entry point `daydream.js` is set up to support rapid iteration. You can tweak effect parameters, math formulas, or animation timings in the code, and the simulator will update instantly without a full page reload, preserving the current state where possible.

---

## 🛠 Included Visual Tools

Daydream includes standalone HTML tools to assist in generating the math constants used in the effects.

### 🎨 Palette Generator (`palettes.html`)
An interactive tool for designing `ProceduralPalette`s based on the cosine formula:
$$color(t) = A + B \cdot \cos(2\pi(C \cdot t + D))$$
* **Visualizers**: Shows individual R/G/B waveforms and the resulting color gradient.
* **Real-time Preview**: Displays an animated swatch.
* **Export**: Generates the exact C++ or JavaScript array code to paste into your effect.

### 🌀 Möbius Visualizer (`mobius.html`)
A playground for exploring Conformal Möbius transformations projected onto a sphere.
* **Interactive Plane**: Drag points on the complex plane to adjust the complex parameters $A, B, C, D$.
* **Presets**: Visualize standard transformations like Elliptic (rotation), Hyperbolic (zoom), and Loxodromic (spiral).
* **Grid Visualization**: Renders a longitude/latitude grid to visualize the distortion.

### ➿ Lissajous Visualizer (`lissajous.html`)
A tool to visualize spherical Lissajous curves used in effects like `Comets`.
* **Rational Locking**: Automatically snaps frequency sliders to simple rational ratios (e.g., 3:2, 5:4) to ensure the generated curves are closed loops.
* **Code Export**: Generates the lambda function required to render the curve in the engine.

---

## 🚀 Getting Started

1.  **Install Dependencies**:
    Daydream uses standard ES6 modules but requires a local server to handle imports correctly due to CORS.
    ```bash
    npm install
    ```

2.  **Run Simulator**:
    Start a local web server (using Vite, http-server, or Python):
    ```bash
    npx http-server .
    ```

3.  **Access**:
    Open `http://localhost:8080` (or the port provided) in your browser.
    * **Main Simulator**: `index.html`
    * **Palette Tool**: `palettes.html`
    * **Mobius Tool**: `mobius.html`

4.  **Controls**:
    * Use the **GUI dropdown** in the top right to switch between effects.
    * Expand folders in the GUI to tweak effect-specific parameters (Speed, Alpha, etc.) in real-time.
    * Press **Space** to pause/resume the animation.
    * Press **Arrow Right** while paused to step forward one frame.

---
*Hardware implementation: [Holosphere Firmware](../pov/README.md)*
