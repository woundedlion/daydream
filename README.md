# Holosphere

A persistence-of-vision (POV) LED sphere and its real-time simulator. The device spins a strip of LEDs at 480 RPM while a Teensy microcontroller fires pixels at microsecond intervals to paint full-color imagery on the surface of a virtual sphere. The simulator renders the same effects in a browser window at up to 576×288 resolution using the identical C++ code compiled to WebAssembly.

```
pov-master/      C++20 firmware, rendering engine, and all effects
daydream-master/ Three.js web simulator (runs the same WASM binary)
```

---

## Table of Contents

1. [Hardware](#1-hardware)
2. [Repository Map](#2-repository-map)
3. [Architecture Overview](#3-architecture-overview)
4. [Data Flow: Frame Lifecycle](#4-data-flow-frame-lifecycle)
5. [The Rendering Pipeline](#5-the-rendering-pipeline)
6. [Core Subsystems](#6-core-subsystems)
7. [The Effect System](#7-the-effect-system)
8. [Effects Reference](#8-effects-reference)
9. [The Web Simulator (Daydream)](#9-the-web-simulator-daydream)
10. [Building](#10-building)
11. [Design Notes](#11-design-notes)

---

## 1. Hardware

| Component | Detail |
|---|---|
| Controller | Teensy 4.1 (600 MHz ARM Cortex-M7) |
| LEDs | 96-pixel WS2801 addressable strip (40 physical pixels exposed per half-arm) |
| Protocol | SPI at 6 MHz via FastLED |
| Rotation | 480 RPM (8 revolutions/second) |
| Virtual resolution | 96 columns × 20 rows (hardware), up to 576×288 (WASM simulator) |
| Pin assignments | DATA: pin 11, CLOCK: pin 13, RANDOM seed: analog pin 15 |

The POV effect works because each revolution takes ~125 ms and the ISR fires every `1,000,000 / (RPM/60) / width` microseconds to advance one column. The LED strip is mounted on both sides of a rotating arm: the top half of the strip handles one hemisphere and the bottom half handles the opposite hemisphere, so one full revolution paints a complete sphere.

### Slew Rate Limiting

The firmware directly manipulates Teensy 4 IOMUX registers to enable slew rate limiting on both SPI pins, reducing electromagnetic interference at 6 MHz:

```cpp
IOMUXC_SW_PAD_CTL_PAD_GPIO_B0_02 &= ~IOMUXC_PAD_SRE;  // Pin 11 (DATA)
IOMUXC_SW_PAD_CTL_PAD_GPIO_B0_03 &= ~IOMUXC_PAD_SRE;  // Pin 13 (CLOCK)
```

---

## 2. Repository Map

```
pov-master/
├── Holosphere.ino          Entry point — POVDisplay setup and effect playlist
├── constants.h             RPM, NUM_PIXELS, MAX_W/MAX_H
├── platform.h              Arduino vs. WASM vs. Desktop abstraction layer
│
├── led.h                   POVDisplay<S,RPM> — ISR, double-buffer, effect dispatch
├── canvas.h                Effect base class + Canvas RAII write-buffer guard
├── effects_engine.h        Master include for the full engine
├── effects.h               Include list for all effects
├── effects_legacy.h        Pre-engine effects (TheMatrix, Spirals, etc.)
│
├── 3dmath.h                Vector, Quaternion, Spherical, Complex, Möbius math
├── geometry.h              Fragment, Dots/Points, PixelLUT, coord conversions
├── color.h                 Pixel16 (16-bit linear), Color4, blend modes, palettes
├── palettes.h              Named palette instances (ProceduralPalette + Gradient)
├── color_luts.h            Precomputed sRGB ↔ linear LUTs
│
├── canvas.h                Effect/Canvas double-buffer + friend access
├── concepts.h              C++20 concepts: TrailFn, PlotFn, FragmentShaderFn, etc.
├── filter.h                Composable render pipeline + all Filter::World/Screen/Pix
├── scan.h                  SDF rasterizer: shapes, CSG, anti-aliasing
├── plot.h                  Line/curve rasterizer with geodesic/planar strategies
├── animation.h             Timeline, all Animation:: types, ParticleSystem
├── transformers.h          Ripple, Noise, Möbius warp geometry transformers
├── easing.h                Easing functions (cubic, sine, elastic, expo, etc.)
├── waves.h                 sin_wave / tri_wave / square_wave generators
│
├── memory.h / memory.cpp   Arena allocator, ArenaMarker RAII, ScratchContext
├── mesh.h                  PolyMesh, MeshState, MeshOps (compile, subdivide, etc.)
├── solids.h                Platonic + Archimedean + Islamic solid geometry data
├── spatial.h               AABB, BVH, k-nearest-neighbor graph
├── static_circular_buffer.h Lock-free fixed-capacity circular buffer
├── rotate.h                Quaternion tween helpers
├── generators.h            IGenerator<T> interface for procedural geometry
├── presets.h               Pre-built filter pipeline type aliases
├── util.h                  wrap(), fast_wrap(), clamp()
│
├── effects/                One .h per effect (30+ total)
│   ├── BZReactionDiffusion.h
│   ├── ChaoticStrings.h
│   ├── Comets.h
│   ├── DreamBalls.h
│   ├── Dynamo.h
│   ├── FlamingMesh.h
│   ├── FlowField.h
│   ├── GnomonicStars.h
│   ├── GSReactionDiffusion.h
│   ├── HankinSolids.h
│   ├── HopfFibration.h
│   ├── IslamicStars.h
│   ├── LSystem.h
│   ├── MetaballEffect.h
│   ├── MindSplatter.h
│   ├── MobiusGrid.h
│   ├── Moire.h
│   ├── PetalFlow.h
│   ├── RingShower.h
│   ├── RingSpin.h
│   ├── SphericalHarmonics.h
│   ├── SpinShapes.h
│   └── Voronoi.h
│
├── wasm_bridge.cpp         Emscripten bindings — HolosphereEngine JS class
├── CMakeLists.txt          Emscripten build (outputs holosphere_wasm.js + .wasm)
└── FastNoiseLite.h         Third-party: single-header noise library

daydream-master/
├── index.html              Single-page app shell
├── daydream.js             Top-level: WASM init, effect switching, GUI wiring
├── driver.js               Daydream class — Three.js sphere visualization
├── geometry.js             pixel ↔ spherical ↔ vector coordinate helpers
├── gui.js                  URL parameter persistence for GUI state
├── holosphere_wasm.js      Emscripten JS glue (generated)
├── holosphere_wasm.wasm    Compiled binary (generated)
└── tools/
    ├── lissajous.html      Interactive Lissajous curve explorer
    ├── mobius.html         Möbius transformation visualizer
    ├── palettes.html       Palette browser and editor
    └── solids.html         Archimedean solid inspector
```

---

## 3. Architecture Overview

The system has three physical execution targets sharing one codebase:

```
┌─────────────────────────────────────────────────────────────────┐
│                        pov-master C++                           │
│                                                                 │
│  ┌─────────────┐   ┌──────────────────────────────────────┐    │
│  │ Holosphere  │   │            Rendering Engine           │    │
│  │    .ino     │   │                                       │    │
│  │             │   │  Effects → Canvas → Filter Pipeline   │    │
│  │ POVDisplay  │   │      → SDF/Plot → Pixel Buffer        │    │
│  │ <96, 480>   │   │                                       │    │
│  └──────┬──────┘   └──────────────────────────────────────┘    │
│         │                         ↑                             │
└─────────┼─────────────────────────┼─────────────────────────────┘
          │                         │
    Arduino/Teensy             wasm_bridge.cpp
    ISR + FastLED            (Emscripten build)
          │                         │
    Physical LED strip         ┌────┴──────────┐
    spinning at 480 RPM        │ daydream-master│
                               │  Three.js +   │
                               │  WASM Engine  │
                               └───────────────┘
```

### Compile-Time Resolution Parameterization

Every rendering-related class is templated on `<int W, int H>`:

```cpp
template <int W, int H> class HopfFibration : public Effect { ... };
template <int W, int H> struct Pipeline<W, H, Filter1, Filter2, ...> { ... };
```

This means the compiler generates fully specialized, zero-overhead versions of the entire pipeline for each supported resolution. The hardware runs `<96, 20>` (96 columns × 20 rows). The simulator supports `<96, 20>`, `<288, 144>`, and `<576, 288>`.

The `platform.h` header abstracts all target-specific differences:

| Symbol | Arduino/Teensy | WASM/Desktop |
|---|---|---|
| `DMAMEM` | Teensy DMA-accessible RAM segment | No-op macro |
| `hs::log()` | `Serial.println()` | `std::cout` |
| `hs::millis()` | `::millis()` | `std::chrono` |
| `hs::rand_f()` | `random()` | `std::rand()` |
| `hs::disable_interrupts()` | `noInterrupts()` | No-op |
| `CRGB`, `CHSV` | FastLED types | Struct mocks |

---

## 4. Data Flow: Frame Lifecycle

### Hardware Path

```
Main Loop (draw_frame)                    ISR (show_col, fires every N µs)
─────────────────────────────────         ─────────────────────────────────
                                          Timer fires at column interval
POVDisplay<S,RPM>::show<Effect>()
  IntervalTimer::begin(show_col, interval)

  effect->draw_frame():
    Canvas canvas(*effect)               ISR reads from bufs_[prev_]
      ↓ advance_buffer()                 for y in 0..S/2:
      ↓ (copies prev if persist_pixels)    leds[S/2 - y - 1] = get_pixel(x, y)
      ↓                                    leds[S/2 + y]     = get_pixel(x±W/2, y)
    [effect renders to bufs_[cur_]]
      ↓                                  FastLED.show()
    ~Canvas():                           if show_bg(): FastLED.showColor(black)
      queue_frame()                      x = (x+1) % width
      ↓ next_ = cur_ (interrupt-safe)    if x==0 || x==width/2:
                                           advance_display()  (prev_ = next_)
                                           [new frame begins displaying]
```

Three volatile indices manage the double buffer:

| Index | Role |
|---|---|
| `cur_` | Which buffer the main loop is currently writing |
| `next_` | The last completed frame (queued by `queue_frame()`) |
| `prev_` | The frame the ISR is currently reading |

The ISR never touches `cur_`. The main loop atomically updates `next_` inside `queue_frame()` with interrupts disabled. `advance_display()` is called by the ISR at every half-revolution to flip `prev_` to `next_`.

Buffer storage is placed in Teensy DMAMEM for DMA-accessible SPI throughput:

```cpp
inline static DMAMEM Pixel buffer_a[MAX_W * MAX_H];  // 576×288 × 6 bytes = ~1 MB
inline static DMAMEM Pixel buffer_b[MAX_W * MAX_H];
```

### WASM Path

In the simulator there is no ISR. `HolosphereEngine::drawFrame()` calls `draw_frame()` then `advance_display()` directly. The pixel buffer is a flat `std::vector<uint16_t>` that is read back by JavaScript as a zero-copy `typed_memory_view`:

```
C++: wasmEngine.drawFrame()
       → currentEffect->draw_frame()
       → currentEffect->advance_display()
       → copy Pixel(r,g,b) into pixelBuffer as uint16_t triples

JS:  wasmEngine.getPixels()
       → Uint16Array view into WASM linear memory (no copy)
       → divide by 65535 → Float32Array of linear light values
       → Three.js DataTexture → sphere mesh material
```

---

## 5. The Rendering Pipeline

### The Canvas

`Canvas` is a RAII scope guard for one frame of rendering. Constructing it acquires the next write buffer; destroying it queues the finished frame for display.

```cpp
void MyEffect::draw_frame() override {
    Canvas canvas(*this);   // advance_buffer() — grab write buffer
                            // optionally clear if !persist_pixels
    // ... render here using canvas(x, y) = pixel ...
}                           // ~Canvas() — queue_frame()
```

`canvas(x, y)` is a direct array subscript into the write buffer (`bufs_[cur_][y * width + x]`). No bounds checking, no virtual dispatch.

### The Filter Pipeline

The most powerful engine component is the **variadic template filter pipeline**:

```cpp
Pipeline<W, H,
    Filter::World::Trails<W, MAX_ITEMS>,   // 3D world-space trail decay
    Filter::World::Orient<W>,              // quaternion rotation + motion blur
    Filter::Screen::AntiAlias<W, H>        // bilinear sub-pixel AA
> filters;
```

`Pipeline<W, H, Filters...>` is a recursive template that chains filter stages. Each stage receives a `plot()` call and can transform it before forwarding downstream:

```
filters.plot(canvas, world_position, color, age, alpha)
    → World::Trails: store for later decay, pass through
    → World::Orient: rotate by current quaternion, adjust age
    → Screen::AntiAlias: distribute to 4 nearest pixels
    → Pipeline<W,H> (base): vector_to_pixel → canvas(x,y) = blend(color, alpha)
```

The pipeline handles the 3D/2D coordinate mismatch automatically at compile time: if a 3D filter receives a 2D coordinate it lifts it via `pixel_to_vector`; if a 2D filter receives a 3D vector it projects via `vector_to_pixel`.

#### World-Space Filters

| Filter | Effect |
|---|---|
| `World::Orient<W>` | Rotates every incoming 3D point by the current `Orientation` quaternion. Uses the orientation history to distribute motion-blur age values across a SLERP-interpolated sweep. |
| `World::Trails<W, Capacity>` | Stores world-space points in a circular buffer with a TTL countdown. On `flush()`, re-draws aged points through a `TrailFn` color function. |
| `World::Replicate<W>` | Clones geometry N times around the Y-axis by re-plotting each point rotated by `2π/N`. |
| `World::Mobius<W>` | Applies a Möbius transformation via stereographic projection: sphere → complex plane → Möbius(z) → back to sphere. |
| `World::Hole<W>` | Masks out a spherical cap by attenuating points within a radius via quintic falloff. |
| `World::OrientSlice<W>` | Selects from a list of orientations based on each point's projection along an axis — enables per-hemisphere rotation effects. |

#### Screen-Space Filters

| Filter | Effect |
|---|---|
| `Screen::AntiAlias<W,H>` | Distributes a sub-pixel coordinate to its 4 nearest integer pixels using `quintic_kernel` bilinear weights. |
| `Screen::Temporal<W, Capacity, TTLFn>` | Buffers screen-space draws and re-emits them over a configurable time window. Used for motion blur and temporal supersampling. |
| `Screen::Blur<W, H>` | Applies a parameterized 3×3 Gaussian convolution kernel at plot time. |
| `Screen::Trails<W>` | Screen-space variant of trail decay; stores 2D coordinates with TTL and redraws via a trail color function. |
| `Screen::Slew<W, Capacity>` | Phosphor-style persistence: every plotted pixel is re-drawn with exponentially decaying alpha until it fades out. |
| `Pix::ChromaticShift<W>` | Splits a pixel into R, G, B channels and offsets them by 1–3 pixels horizontally to simulate chromatic aberration. |

#### Combining Filters

Filters compose freely. The order matters — world-space filters must precede screen-space filters if both are present. Some common pre-built combinations (from `presets.h`):

```cpp
// Rotating geometry with anti-aliasing
Pipeline<W, H, Filter::World::Orient<W>, Filter::Screen::AntiAlias<W, H>>

// Particle trails in world space with orientation
Pipeline<W, H,
    Filter::World::Trails<W, 50000>,
    Filter::World::Orient<W>,
    Filter::Screen::AntiAlias<W, H>>
```

---

## 6. Core Subsystems

### 6.1 The SDF Rasterizer (`scan.h`)

Effects that draw geometric shapes use the Signed Distance Field rasterizer. Each shape implements three methods:

1. **`get_vertical_bounds()`** — analytic tight bounding box in pixel-Y space (phi angle range). Only rows within this range are scanned.
2. **`get_horizontal_intervals(y, out)`** — analytic scanline intervals per row. Called per row to skip empty columns without evaluating the distance function.
3. **`distance<ComputeUVs>(p, result)`** — signed distance from a sphere-surface point `p` to the shape boundary, plus texture coordinate and auxiliary data in `DistanceResult`.

The `process_pixel` function applies anti-aliasing based on shape type:
- **Solid shapes**: quintic smoothstep over a 1-pixel AA border. Full interior pixels (`d < -pixel_width`) skip AA math entirely.
- **Strokes**: opacity falloff across the full stroke thickness.

#### Available SDF Shapes

| Shape | Description |
|---|---|
| `SDF::Ring` | Geodesic circle at a given radius and thickness |
| `SDF::DistortedRing` | Ring with per-azimuth radius perturbation via a callback |
| `SDF::Polygon` | Regular N-gon in the tangent plane of a basis vector |
| `SDF::Star` | N-pointed star using the standard inradius/circumradius construction |
| `SDF::Flower` | Inverted star (N-petal flower shape from the antipodal perspective) |
| `SDF::HarmonicBlob` | Shape defined by a spherical harmonic Yˡₘ function |
| `SDF::Line` | Geodesic line segment between two sphere-surface points |
| `SDF::Face` | Planar polygon face (used for mesh rendering) |

#### CSG Operations

Shapes can be combined using Constructive Solid Geometry:

```cpp
SDF::Union<Ring, Polygon>       // min(d_A, d_B)
SDF::Subtract<Ring, Polygon>    // max(d_A, -d_B)
SDF::Intersection<Ring, Polygon>// max(d_A, d_B) with interval intersection
```

### 6.2 The Curve Rasterizer (`plot.h`)

For drawing lines, curves, and paths, the `Plot` namespace provides a geodesic/planar rasterizer with adaptive step size. The key insight is that near the poles of the sphere, pixels are much denser in latitude than near the equator. Step size is scaled by `sqrt(1 - y²)` — the sine of the polar angle — so curves remain smooth at all latitudes without over-sampling at the equator.

```cpp
Plot::Line::draw<W, H>(pipeline, canvas, start, end, fragment_shader);
Plot::Curve::draw<W, H>(pipeline, canvas, fragments, fragment_shader, cache);
```

Curves accept a `Fragments` array (a `std::vector<Fragment>`) where each fragment carries position, texture registers (v0–v3), age, color, and blend mode. The rasterizer supports two interpolation strategies:
- **Geodesic**: great-circle arc between segment endpoints (default)
- **Planar**: planar projection within the tangent plane of a basis (for effects that live in a 2D local space)

### 6.3 The Animation System (`animation.h`)

The `Timeline<W>` class manages a list of running `Animation` objects. Each frame, `timeline.step(canvas)` advances all active animations. Finished animations are removed; repeating animations are rewound.

#### Animation Types

| Type | Description |
|---|---|
| `Rotation<W>` | Quaternion rotation of an `Orientation` around an axis, with optional repeat |
| `RandomWalk<W>` | Continuously perturbs an `Orientation` with smoothly changing random angular velocity |
| `Motion<W, PathT>` | Moves an `Orientation` along a `Path` or `ProceduralPath` |
| `Sprite` | Calls a draw function over a duration with fade-in and fade-out envelopes |
| `PeriodicTimer` | Fires a callback once (or repeatedly) after a delay |
| `ParticleSystem<W>` | Physics simulation with emitters, attractors, friction, gravity |
| `Ripple` | Animates a `RippleParams` to expand a Ricker wavelet across the sphere |
| `MobiusWarp` | Animates `MobiusParams` to apply and release a Möbius transformation |
| `Noise` | Animates `NoiseParams` over time for flowing distortion fields |

#### Orientation and Motion Blur

`Orientation<W>` stores a history of up to 32 quaternions accumulated during one frame step. The `World::Orient` filter iterates over this history to distribute motion blur: each point is plotted once per orientation step, with the `age` field increasing backward in time. This means fast-rotating effects naturally show streak-like motion blur with no extra code.

```cpp
timeline.add(0, Animation::Rotation<W>(orientation, Y_AXIS, 2 * PI_F, 600, ease_mid, true));
// orientation.orientations[] now grows by 1 per sub-step
// World::Orient distributes all steps → motion blur
```

`Orientation::upsample(count)` resamples the history to a higher resolution via SLERP — used to increase motion blur quality without changing the animation speed.

### 6.4 Geometry Transformers (`transformers.h`)

Transformers deform the sphere geometry before rendering. The `Transformer<W, ParamsT, AnimT, TransformFunc, CAPACITY>` class manages a pool of active transform instances, each with its own animated parameters:

```cpp
template <int W, int CAPACITY>
using RippleTransformer = Transformer<W, RippleParams, Animation::Ripple,
                                      ripple_transform, CAPACITY>;
```

Available transformers:

| Transformer | Effect |
|---|---|
| `RippleTransformer` | Expands Ricker wavelets from a point, bending the sphere surface radially |
| `MobiusWarpTransformer` | Applies and releases a Möbius transformation |
| `MobiusWarpCircularTransformer` | Loops a Möbius warp continuously |
| `MobiusWarpGnomonicTransformer` | Möbius via gnomonic projection (preserves straight lines in hemisphere) |
| `NoiseTransformer` | Distorts surface positions with 3D simplex noise |

Transformers integrate with the `MeshOps::transform()` pipeline and can be chained: `MeshOps::transform(input, output, arena, ripple_transformer, orient_transformer)`.

### 6.5 Memory Architecture (`memory.h`)

Three arena allocators manage all geometry memory with zero `malloc`/`new` in the rendering hot path:

| Arena | Size | Purpose |
|---|---|---|
| `geometry_arena` | 128 KB | Long-lived compiled mesh data, persists across frames |
| `scratch_arena_a` | 128 KB | Short-lived intermediate geometry (RAII scoped) |
| `scratch_arena_b` | 256 KB | Secondary scratch for ping-pong subdivision passes |

`ArenaMarker` provides stack-like RAII lifetime:

```cpp
{
    ArenaMarker _(scratch_arena_a);     // save offset
    // ... allocate from scratch_arena_a ...
}                                        // restore offset — all allocations freed
```

`ScratchContext` handles double-buffered subdivision where each pass reads from one arena and writes to the other:

```cpp
ScratchContext ctx(scratch_arena_a, scratch_arena_b);
for (int pass = 0; pass < iterations; ++pass) {
    subdivide(ctx.source, ctx.target);
    ctx.swap_and_clear();               // flip buffers, wipe old source
}
```

### 6.6 The Color System (`color.h`)

All internal color data is **16-bit linear light** (`uint16_t r, g, b` in range 0–65535). This avoids the precision loss and incorrect blending that occurs with gamma-encoded 8-bit values.

The conversion pipeline:
```
Input (sRGB 8-bit) → sRGB→linear LUT → Pixel16 (linear 16-bit) → blend ops
                                                                      ↓
FastLED output ← CRGB(gamma encode) ← linear→sRGB ← Pixel16
```

`Color4` wraps `Pixel` with a float alpha channel. Blend modes at the canvas sink:

| Tag | Mode | Formula |
|---|---|---|
| `BLEND_OVER` (default) | Alpha composite | `dst = src * α + dst * (1-α)` |
| `BLEND_ADD` | Additive | `dst = src * α + dst` (clamped) |
| `BLEND_MAX` | Maximum | `dst = max(src * α, dst)` |

#### Palette Types

| Type | Description |
|---|---|
| `ProceduralPalette` | Cosine palette: `0.5 + 0.5*cos(2π*(c*t + d))` per channel. Defined by 4 vec3 coefficients. |
| `Gradient` | Linear interpolation between a sorted list of (position, color) stops. |
| `GenerativePalette` | Procedurally generated palette from harmony rules (triadic, analogous, etc.) combined with brightness/saturation profiles. |
| `SolidColorPalette` | Constant color, adapts to the `Palette` interface. |

Twenty named `ProceduralPalette` instances are pre-defined: `richSunset`, `embers`, `lavenderLake`, `bruisedMoss`, `brightSunrise`, `undersea`, `iceMelt`, `fireGlow`, `darkPrimary`, and more.

### 6.7 The Mesh System (`mesh.h`, `solids.h`)

`PolyMesh` and `MeshState` represent polygon meshes whose vertices live on the unit sphere. `MeshOps` provides a suite of operations:

| Operation | Description |
|---|---|
| `MeshOps::compile` | Convert a `PolyMesh` to the flat-array `MeshState` format used by the renderer |
| `MeshOps::transform` | Apply a chain of vertex transformers to produce a new `MeshState` |
| `MeshOps::clone` | Arena-safe deep copy |
| `MeshOps::classify_faces_by_topology` | Group faces by vertex count (triangles, quads, pentagons, etc.) |
| `MeshOps::subdivide_midpoint` | Midpoint subdivision with optional normalization back to sphere surface |

`solids.h` provides constexpr vertex/face data for all Platonic solids plus procedural generators for the full Archimedean solid family:

**Simple Solids**: Tetrahedron, Cube, Octahedron, Dodecahedron, Icosahedron, Cuboctahedron, Rhombicuboctahedron

**Islamic Solids** (used by `IslamicStars`): Truncated Icosahedron, Icosidodecahedron, Rhombicosidodecahedron, Truncated Cuboctahedron, Snub Cube (uses tribonacci constant T ≈ 1.8393), Truncated Icosidodecahedron, and more

Each solid is generated by a `SolidGenerator` that builds and normalizes vertices, then pushes face connectivity into a `PolyMesh` via an `Arena`.

---

## 7. The Effect System

Every visual effect inherits from `Effect`:

```cpp
template <int W, int H>
class MyEffect : public Effect {
public:
    MyEffect() : Effect(W, H), filters(...) {
        registerParam("Speed", &speed, 0.0f, 10.0f);
        persist_pixels = false;   // clear buffer each frame
    }

    bool show_bg() const override { return false; }

    void draw_frame() override {
        Canvas canvas(*this);       // acquire write buffer
        timeline.step(canvas);      // advance all animations
        // ... custom rendering ...
    }

private:
    Pipeline<W, H, ...> filters;
    Orientation<W> orientation;
    Timeline<W> timeline;
    float speed = 1.0f;
};
```

### Parameter Registration

Effects expose live-adjustable parameters via `registerParam()`. These are reflected into the WASM bridge and auto-generate GUI controls in the simulator:

```cpp
registerParam("Twist",   &params.twist,      -5.0f, 5.0f);   // float slider
registerParam("Enabled", &params.enabled,    false);           // boolean toggle
```

The parameter map (`std::map<std::string, ParamDef>`) is accessible via `getParameters()`, and `updateParameter(name, float)` sets values at runtime. The animation system can also write to these parameters, allowing effects to animate their own exposed controls.

### The `persist_pixels` Flag

When `persist_pixels = true` (the default), `Canvas` copies the previous frame's buffer into the new write buffer before rendering. This enables trail/decay effects without explicit trail storage — each frame partially overwrites the last. When `false`, the buffer is zeroed each frame.

---

## 8. Effects Reference

### Core Effects (Modern Engine)

#### BZReactionDiffusion
Simulates the Belousov-Zhabotinsky reaction — a 3-species cyclic competition (A beats B, B beats C, C beats A) producing rotating spiral waves. The simulation runs on a spherical k-nearest-neighbor graph with configurable diffusion rate and time step. Spiral waves are seeded periodically and evolve continuously.

**Parameters**: Alpha (color intensity), Diff (diffusion rate), Speed (time step), GlobalAlpha

#### GSReactionDiffusion
Gray-Scott reaction-diffusion system (U + 2V → 3V, V → P) on a spherical mesh. Produces spots, stripes, and labyrinthine patterns depending on feed/kill rates.

#### HopfFibration
Visualizes the Hopf fibration — a map from S³ to S². Points on S² (the base space) are lifted to fibers on S³ via the quaternion parameterization `q = [cos(η)cos(φ+β), cos(η)sin(φ+β), sin(η)cos(β), sin(η)sin(β)]`, then stereographically projected back to S³ and plotted on the sphere. A 4D tumble (R_xw × R_yz rotation) continuously rotates the fibration.

**Parameters**: Flow Spd, Tumble Spd, Folding, Twist, Alpha

#### IslamicStars
Procedurally generates authentic Islamic geometric patterns using Hankin's method (pentagon-based subdivision of the Archimedean solids). Each face of a rotating solid is decorated with its characteristic star polygon, colored by face topology (triangles, pentagons, hexagons, etc.). Ripple waves periodically distort the geometry.

**Parameters**: Duration, Ripp Amp, Ripp Width, Ripp Decay, Ripp Dur

#### HankinSolids
Similar to IslamicStars but sequences through the full Archimedean solid library with animated palette transitions.

#### LSystem
L-systems rendered by a `SphericalTurtle` that advances by geodesic arcs and turns around the surface normal. Three built-in rule sets (fractal tree, Koch snowflake variant, Lévy curve) with live angle and step-size modulation.

**Parameters**: Rule (0–2), Angle (modifier), Step (modifier)

#### SphericalHarmonics
Renders the real spherical harmonics Yˡₘ(θ, φ) as SDF `HarmonicBlob` shapes. The harmonic defines a lobe-radius function that deforms a unit sphere surface. Animates through different (l, m) combinations.

#### MetaballEffect
Spherical metaballs: N point-sources on the sphere whose implicit field functions sum and threshold into a rendered surface.

#### MobiusGrid
A latitude-longitude grid that undergoes live Möbius transformation animation via `MobiusWarpCircularTransformer`.

#### Moire
Overlapping ring families that produce interference patterns as their angular frequencies slowly drift.

#### FlowField
FastNoiseLite-driven curl flow field. Particles follow the gradient of a 3D noise function mapped onto the sphere.

#### Voronoi
Spherical Voronoi diagram with animated seed positions. Cell boundaries are drawn as geodesic edges; cells are optionally filled.

#### PetalFlow
Flowers constructed from distorted ring SDFs whose radii oscillate via sine waves.

#### DreamBalls
Physics-based particle system. Particles are spawned at random positions, attracted toward configurable attractor points, and leave color trails via `World::Trails`.

#### SpinShapes
Catalog of spinning SDF shapes (rings, stars, polygons, flowers) with live rotation and color cycling.

#### Comets
Particles with long orientation-trail-based tails, launched in bursts and influenced by rotational gravity.

#### RingSpin / RingShower
Animated concentric ring patterns using `Scan::Ring` with per-ring phase offsets.

#### ChaoticStrings
Lissajous curves whose frequency ratios slowly sweep through rational approximations, transitioning between closed figures and dense space-filling curves.

#### FlamingMesh
Icosahedral mesh faces rendered with `Scan::Mesh`, distorted by a `NoiseTransformer` and given a phosphor-trail appearance via `Screen::Slew`.

#### MindSplatter
Random-walk particle system with Möbius warp bursts.

#### Dynamo
Rotating ring-pair patterns whose axes precess relative to each other.

#### Thrusters
Directional particle jets.

#### GnomonicStars
Star polygon SDFs that rotate continuously. Uses gnomonic projection (straight lines on sphere remain straight).

### Legacy Effects (`effects_legacy.h`)

TheMatrix, ChainWiggle, RingRotate, RingTwist, Curves, Kaleidoscope, StarsFade, DotTrails, Burnout, Spinner, Spiral — built before the current engine and using an older rendering API. Functional but not representative of current architecture.

---

## 9. The Web Simulator (Daydream)

The simulator runs the identical C++ rendering engine compiled to WebAssembly via Emscripten, visualized as a 3D sphere in Three.js.

### WASM Bridge

`wasm_bridge.cpp` compiles to `holosphere_wasm.js` + `.wasm` and exposes a single `HolosphereEngine` class:

| Method | Description |
|---|---|
| `setResolution(w, h)` | Switch active resolution (96×20, 288×144, or 576×288) |
| `setEffect(name)` | Instantiate a new effect by string name; resets all arenas |
| `drawFrame()` | Advance one frame and copy pixels to the output buffer |
| `getPixels()` | Return a zero-copy `Uint16Array` view into WASM linear memory |
| `setParameter(name, value)` | Update a live effect parameter |
| `getParameterDefinitions()` | Return the full `[{name, value, min, max}]` parameter list |
| `getParamValues()` | Return current parameter values (including animation-driven updates) |
| `getArenaMetrics()` | Memory usage stats for geometry and scratch arenas |

Pixel data is 16-bit linear light (`uint16_t` per channel). JavaScript divides by 65535 to produce float linear values:

```js
const wasmPixels = wasmEngine.getPixels();   // Uint16Array view, zero-copy
for (let i = 0; i < wasmPixels.length; i++) {
    Daydream.pixels[i] = wasmPixels[i] / 65535.0;  // linear float
}
// → Three.js DataTexture → sphere mesh
```

### Resolution Presets

| Name | Width × Height | Notes |
|---|---|---|
| Holosphere (20×96) | 96 × 20 | Matches physical hardware |
| Phantasm (144×288) | 288 × 144 | High-quality preview (default) |
| Pie-in-the-sky (288×576) | 576 × 288 | Maximum fidelity |

### GUI Auto-Generation

The effect parameter panel is entirely driven by what C++ registers via `registerParam()`. When an effect is loaded, the simulator calls `getParameterDefinitions()` and builds `lil-gui` controls:

```js
params.forEach(p => {
    const controller = gui.add(state, p.name, p.min, p.max);
    controller.onChange(v => wasmEngine.setParameter(p.name, v));
});
```

`getParamValues()` is polled each frame to sync the GUI with parameter values that the animation system has changed autonomously. The sync skips any control the user is currently interacting with to avoid fighting the slider.

### Tools

Four standalone HTML tools are included:

| Tool | Description |
|---|---|
| `tools/lissajous.html` | Interactive explorer for spherical Lissajous curves — adjust frequency ratios m1, m2 and phase offset to find closed curves and transition zones |
| `tools/mobius.html` | Visualize Möbius transformations on the sphere in real time — adjust complex parameters a, b, c, d |
| `tools/palettes.html` | Browse and tune all palette definitions — live preview with gradient strip and sphere visualization |
| `tools/solids.html` | Inspect every Archimedean and Platonic solid — vertex counts, face topology, wireframe view |

---

## 10. Building

### Firmware (Arduino / Teensy 4.1)

1. Install [Arduino IDE](https://www.arduino.cc/en/software) with Teensyduino.
2. Install the `FastLED` library.
3. Open `pov-master/Holosphere.ino`.
4. Select **Board: Teensy 4.1**, **CPU Speed: 600 MHz**.
5. Upload.

Hardware configuration is in `constants.h`:
```cpp
static constexpr unsigned int RPM       = 480;
static constexpr int          NUM_PIXELS = 40;
```

And in `led.h`:
```cpp
static constexpr int PIN_DATA   = 11;
static constexpr int PIN_CLOCK  = 13;
static constexpr int PIN_RANDOM = 15;
```

### WASM (Simulator)

Requires [Emscripten](https://emscripten.org/) and CMake.

```bash
cd pov-master
mkdir build && cd build
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release
emmake make
cmake --install .     # copies holosphere_wasm.js + .wasm to ../daydream-master/
```

The `CMakeLists.txt` configures:
- `-sALLOW_MEMORY_GROWTH=1` — WASM heap can grow for large meshes
- `-sMODULARIZE=1 -sEXPORT_ES6=1` — ES6 module output
- `-sSTACK_SIZE=8388608` — 8 MB stack (effects use deep template recursion)
- `-O3` for release, `-O0 -g -sASSERTIONS=1` for debug

### Running the Simulator

The simulator is a static web app. Serve `daydream-master/` from any HTTP server:

```bash
cd daydream-master
python3 -m http.server 8080
# open http://localhost:8080
```

URL parameters control the initial state:
```
?effect=IslamicStars&resolution=Phantasm%20(144x288)&wasm=true
```

---

## 11. Design Notes

### Why 16-bit Linear Color?

Most LED art codebases use gamma-corrected 8-bit values throughout and blend in sRGB space. This produces muddy mixes: red + blue = dark purple instead of magenta. Holosphere blends in linear light (16-bit precision), then gamma-encodes only at the hardware output. The improvement is most visible in soft gradients and multi-layer alpha compositing.

### Why Compile-Time Resolution?

Templating on `<W, H>` means every pixel coordinate transform, bounding box computation, and LUT index is resolved at compile time. The hardware target (`<96, 20>`) runs with no runtime overhead from generality. The simulator builds separate specializations for `<288, 144>` and `<576, 288>`. Binary size increases, but for an embedded firmware this is the right trade-off.

### Why Arena Allocation?

The Teensy heap fragments under heavy mesh subdivision. The three-arena design (geometry, scratch A, scratch B) gives deterministic memory behavior: geometry data allocated once and kept; scratch data RAII-scoped to the function that needed it. The ping-pong `ScratchContext` pattern allows iterative subdivision algorithms to alternate between arenas without `malloc`/`free` cycles.

### Why the ISR Double Buffer?

POV display requires pixel data to be ready before each column interval fires — typically 13–130 µs for the hardware resolution at 480 RPM. A naive approach (rendering in the ISR) would block the main loop. Instead, the main loop renders freely into a back buffer while the ISR reads from a separate front buffer. `queue_frame()` / `advance_display()` synchronize with minimal interrupt-disabled critical sections.

### Coordinate Conventions

- **Y-up Cartesian**: `Vector(i, j, k)` — `j` is the vertical axis
- **Spherical**: `theta` = azimuth (longitude), `phi` = polar angle from +Y (co-latitude)
- **Pixel mapping**: `x ∈ [0, W)` → `theta ∈ [0, 2π)`, `y ∈ [0, H)` → `phi ∈ [0, π]`
- **SDF distances**: in radians on the unit sphere (matching `angle_between()`)
- All pixel LUTs are pre-computed and lazy-initialized (`PixelLUT<W,H>`) on first use

---

## License

Core infrastructure files: [Polyform Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)

New effect files: Copyright 2025 Gabriel Levy. All rights reserved.

`FastNoiseLite.h`: MIT License (Auburn / Jordan Peck)
