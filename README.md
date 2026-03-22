# Holosphere

A persistence-of-vision (POV) LED sphere and its real-time simulator. The device spins a strip of LEDs at 480 RPM while a Teensy microcontroller fires pixels at microsecond intervals to paint full-color imagery on the surface of a virtual sphere. The simulator renders the same effects in a browser window at up to 288×144 resolution using the identical C++ code compiled to WebAssembly.

---

## Table of Contents

1. [Hardware](#1-hardware)
2. [Repository Map](#2-repository-map)
3. [Architecture Overview](#3-architecture-overview)
4. [Data Flow: Frame Lifecycle](#4-data-flow-frame-lifecycle)
5. [The Rendering Pipeline](#5-the-rendering-pipeline)
   - [End-to-End Flow](#end-to-end-flow)
   - [Pipeline Domain Transitions](#pipeline-domain-transitions)
   - [The Canvas](#the-canvas)
   - [The Filter Pipeline](#the-filter-pipeline)
6. [Core Subsystems](#6-core-subsystems)
   - [6.0 The Shader Interface](#60-the-shader-interface)
   - [6.1 SDF Shapes and the Scan Rasterizer](#61-sdf-shapes-sdfh-and-the-scan-rasterizer-scanh)
   - [6.2 The Curve Rasterizer](#62-the-curve-rasterizer-ploth)
   - [6.3 The Animation System](#63-the-animation-system-animationh)
   - [6.4 Geometry Transformers](#64-geometry-transformers-transformersh)
   - [6.5 Memory Architecture](#65-memory-architecture-memoryh-memorycpp)
   - [6.6 The Color System](#66-the-color-system-colorh)
   - [6.7 The Mesh System](#67-the-mesh-system-meshh-conwayh-hankinh-spatialh-solidsh)
   - [6.8 Generators](#68-generators-generatorsh)
   - [6.9 The Preset System](#69-the-preset-system-presetsh)
   - [6.10 DMA LED Controller](#610-dma-led-controller-dma_ledh)
7. [The Effect System](#7-the-effect-system)
8. [Effects Reference](#8-effects-reference)
9. [The Web Simulator (Daydream)](#9-the-web-simulator-daydream)
10. [Building](#10-building)
11. [Design Notes](#11-design-notes)

---

## 1. Hardware

Two physical targets share the same rendering engine:

### Holosphere (2015)

| Component | Detail |
|---|---|
| Controller | Teensy 4.1 (600 MHz ARM Cortex-M7) |
| LEDs | 40-pixel addressable strip (20 per half-arm, two-arm rotation) |
| Protocol | SPI via FastLED (WS2801 at 6 MHz) or DMA (HD107S at 12 MHz) |
| Rotation | 480 RPM (8 revolutions/second) |
| Virtual resolution | 96 × 20 |
| Pin assignments | DATA: pin 11, CLOCK: pin 13, RANDOM seed: analog pin 15 |

### New Art Piece

| Component | Detail |
|---|---|
| LEDs | 2 × 144-pixel strips around the ring |
| Virtual resolution | 288 × 144 (effect-dependent horizontal; most use 288) |

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
├── Holosphere.ino          Entry point — POVDisplay setup and effect playlist
├── constants.h             RPM, NUM_PIXELS, MAX_W/MAX_H
├── platform.h              Arduino vs. WASM vs. Desktop abstraction layer
│
├── led.h                   POVDisplay<S,RPM> — ISR, double-buffer, effect dispatch
├── dma_led.h               Non-blocking DMA LED controller for HD107S (Teensy 4.x only)
├── canvas.h                Effect base class + Canvas RAII write-buffer guard
├── effects_engine.h        Master include for the full engine (incl. hankin/conway)
├── effects.h               Include list for all effects
├── effects_legacy.h        Pre-engine effects (TheMatrix, Spirals, etc.)
├── effect_registry.h       Self-registering factory: REGISTER_EFFECT macro
│
├── 3dmath.h                Vector, Quaternion, Spherical, Complex, Möbius math
├── geometry.h              Fragment, Dots/Points, PixelLUT, coord conversions
├── color.h                 Pixel16 (16-bit linear), Color4, blend modes, palettes
├── palettes.h              Named palette instances (ProceduralPalette + Gradient)
├── color_luts.h            Precomputed sRGB ↔ linear LUTs
│
├── concepts.h              C++20 concepts: TrailFn, PlotFn, FragmentShaderFn, etc.
├── filter.h                Composable render pipeline + all Filter::World/Screen/Pix
├── sdf.h                   SDF shape primitives, CSG operations, distance queries
├── scan.h                  Rasterization primitives (Ring, Circle, Star, Mesh, etc.)
├── plot.h                  Line/curve rasterizer with geodesic/planar strategies
├── animation.h             Timeline, all Animation:: types, ParticleSystem
├── transformers.h          Ripple, Noise, Möbius warp geometry transformers
├── easing.h                Easing functions (cubic, sine, elastic, expo, etc.)
├── waves.h                 sin_wave / tri_wave / square_wave generators
│
├── memory.h / memory.cpp   Arena allocator, ScratchScope, Persist<T>
├── mesh.h                  PolyMesh, HalfEdgeMesh, MeshOps (compile, clone, etc.)
├── conway.h                Conway operators (dual, kis, ambo, truncate, expand, etc.)
├── hankin.h                Hankin pattern compilation and update system
├── solids.h                Platonic + Archimedean + Catalan + Islamic solid registry
├── spatial.h               AABB, KDTree, k-nearest-neighbor, MeshState
├── static_circular_buffer.h Fixed-capacity non-allocating circular buffer
├── rotate.h                Quaternion projection helpers
├── generators.h            Universal `generate()` wrapper for procedural geometry creation
├── presets.h               Generic Presets<Params, Size> template for preset management
├── styles.h                Feedback::Style named presets + Feedback::Filter<W,H> wrapper
├── util.h                  wrap(), fast_wrap(), clamp()
│
├── reaction_graph.h        Precomputed Fibonacci-lattice K-NN graph for reaction-diffusion
├── reaction_graph.cpp      301 KB neighbor table (RD_N=7680, RD_K=6)
│
├── effects/                One .h per effect (27 effects + 2 test effects)
│   ├── BZReactionDiffusion.h
│   ├── ChaoticStrings.h
│   ├── Comets.h
│   ├── DreamBalls.h
│   ├── Dynamo.h
│   ├── FlowField.h
│   ├── Flyby.h
│   ├── GnomonicStars.h
│   ├── GSReactionDiffusion.h
│   ├── HankinSolids.h
│   ├── HopfFibration.h
│   ├── IslamicStars.h
│   ├── Liquid2D.h
│   ├── Raymarch.h
│   ├── MeshFeedback.h
│   ├── Metaballs.h
│   ├── MindSplatter.h
│   ├── MobiusGrid.h
│   ├── Moire.h
│   ├── PetalFlow.h
│   ├── RingShower.h
│   ├── RingSpin.h
│   ├── SphericalHarmonics.h
│   ├── SplineFlow.h
│   ├── Thrusters.h
│   ├── Voronoi.h
│   ├── Test.h              (test/debug)
│   └── TestShapes.h         (test/debug)
│
├── wasm_bridge.cpp         Emscripten bindings — HolosphereEngine JS class
├── CMakeLists.txt          Emscripten build (outputs holosphere_wasm.js + .wasm)
├── tests/                  Unit tests (CMake subdirectory)
├── FastNoiseLite.h         Third-party: single-header noise library
└── FastNoiseLite_config.h  FastNoiseLite build configuration
```

---

## 3. Architecture Overview

The system has two physical execution targets sharing one codebase:

```
┌─────────────────────────────────────────────────────────────────┐
│                        C++ Codebase                             │
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
    ISR + FastLED/DMA        (Emscripten build)
          │                         │
    Physical LED strip         ┌────┴──────────┐
    spinning at 480 RPM        │  daydream/    │
                               │  Three.js +   │
                               │  WASM Engine  │
                               └───────────────┘
```

### Compile-Time Resolution Parameterization

Every rendering-related class is templated on `<int W, int H>`:

```cpp
template <int W, int H> class HopfFibration : public Effect { ... };
template <int W, int H, typename... Filters> struct Pipeline { ... };
```

This means the compiler generates fully specialized, zero-overhead versions of the entire pipeline for each supported resolution. The original Holosphere runs `<96, 20>` (96 columns × 20 rows). The new art piece runs `<288, 144>`. The simulator supports both resolutions.

The `platform.h` header abstracts all target-specific differences:

| Symbol | Arduino/Teensy | WASM/Desktop |
|---|---|---|
| `DMAMEM` | Teensy DMA-accessible RAM segment | No-op macro |
| `hs::log()` | `Serial.println()` | `std::cout` |
| `hs::millis()` | `::millis()` | `std::chrono` |
| `hs::rand_f()` | `random()` | `std::mt19937` |
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

Three `std::atomic<int>` indices manage the double buffer:

| Index | Role |
|---|---|
| `cur_` | Which buffer the main loop is currently writing |
| `next_` | The last completed frame (queued by `queue_frame()`) |
| `prev_` | The frame the ISR is currently reading |

The ISR never touches `cur_`. The main loop atomically updates `next_` inside `queue_frame()` with interrupts disabled. `advance_display()` is called by the ISR at every half-revolution to flip `prev_` to `next_`.

Buffer storage is placed in Teensy DMAMEM for DMA-accessible SPI throughput:

```cpp
static DMAMEM Pixel buffer_a[MAX_W * MAX_H];
static DMAMEM Pixel buffer_b[MAX_W * MAX_H];
```

### WASM Path

In the simulator there is no ISR. `HolosphereEngine::drawFrame()` calls `draw_frame()` then `advance_display()` directly. The pixel buffer is a flat 16-bit array that is read back by JavaScript as a zero-copy `typed_memory_view`:

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

### End-to-End Flow

A typical effect frame follows a four-stage pipeline. Not every effect uses every stage — some skip generation entirely, others skip transformations — but the available primitives compose along this flow:

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Generate   │     │  Transform   │     │  Rasterize   │     │   Filter     │
│             │ ──▸ │              │ ──▸ │              │ ──▸ │   Pipeline   │
│ geometry.h  │     │transformers.h│     │ sdf.h/scan.h │     │  filter.h    │
│ solids.h    │     │              │     │ plot.h       │     │              │
│ generators.h│     │              │     │              │     │              │
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘

  Solids::get()      MeshOps::transform    Scan::Mesh::draw     Pipeline<W,H,
  MeshOps::hankin    RippleTransformer      Scan::Ring::draw       Orient,
  generate(arena,fn) NoiseTransformer       Plot::SplineChain      AntiAlias,
  ParticleSystem     OrientTransformer      Scan::Shader::draw     Feedback>
```

**Generate**: Create or update geometry — mesh from the solids registry, Hankin pattern compilation, Fibonacci lattice for reaction-diffusion, or particle positions from physics. The `generate()` wrapper manages arena lifecycle.

**Transform**: Deform geometry in world space — ripple wavelets, noise displacement, Möbius warps, quaternion rotation. `MeshOps::transform()` chains transformers: `transform(input, output, arena, ripple, orient)`.

**Rasterize**: Convert geometry to pixels. Two families:
- **SDF path** (`sdf.h` → `scan.h`): analytic shapes with scanline intervals and `quintic_kernel` anti-aliasing
- **Plot path** (`plot.h`): line/curve rasterization with adaptive step size scaled by `sin(φ)` for uniform sampling
- **Shader path** (`Scan::Shader`): full-screen per-pixel evaluation with optional SSAA

**Filter**: The `Pipeline<W, H, Filters...>` variadic template processes each plotted point through a chain of filter stages before it reaches the canvas.

### Pipeline Domain Transitions

The filter pipeline operates across three coordinate domains. Each filter declares which domain it works in, and the pipeline automatically converts between them at compile time:

```
          World Space                Screen Space             Pixel Space
     (3D unit-sphere vectors)     (fractional x, y)       (integer x, y)
    ┌──────────────────────┐    ┌─────────────────┐    ┌─────────────────┐
    │ World::Orient        │    │ Screen::AntiAlias│    │ Pixel::Feedback │
    │ World::Trails        │──▸ │ Screen::Blur     │──▸ │ Pixel::Chromatic│
    │ World::Replicate     │    │ Screen::Trails   │    │   Shift         │
    │ World::Mobius        │    │                  │    │                 │
    │ World::Hole          │    │                  │    │                 │
    └──────────────────────┘    └─────────────────┘    └─────────────────┘
    Coordinate: Vector(x,y,z)   Coordinate: float x,y   Coordinate: int x,y

         vector_to_pixel() ──▸         floor/clamp ──▸
    ◂── pixel_to_vector()         ◂── expand to float
```

**World → Screen**: `vector_to_pixel()` projects a 3D unit-sphere vector to fractional pixel coordinates via `(theta / 2π * W, phi / π * H)`.

**Screen → Pixel**: `AntiAlias` distributes the fractional coordinate to its 4 nearest integer pixels using `quintic_kernel` bilinear weights, with `sin(φ)` density compensation.

**Pixel → Canvas**: The base `Pipeline<W,H>` (the identity terminal) blends the final color into `canvas(x, y)` using the active blend mode.

**World filters** operate on the 3D vector before projection — they can rotate, replicate, or warp geometry in spherical coordinates without loss. **Screen filters** operate after projection but before integer snapping — they distribute sub-pixel energy for anti-aliasing and blur. **Pixel filters** operate per-frame on the full canvas — feedback and chromatic aberration read from the previous frame buffer.

### The Canvas

`Canvas` is a RAII scope guard for one frame of rendering. Constructing it acquires the next write buffer; destroying it queues the finished frame for display.

```cpp
void MyEffect::draw_frame() override {
    Canvas canvas(*this);   // advance_buffer() — grab write buffer
                            // clear buffer if !persist_pixels
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
| `World::Trails<W, Capacity>` | Stores world-space points in an arena-allocated ring buffer with a TTL countdown. On `flush()`, re-draws aged points through a `TrailFn` color function. Trail items are quantized to 8 bytes each (int16 xyz + uint8 TTL). |
| `World::Replicate<W>` | Clones geometry N times around the Y-axis by re-plotting each point rotated by `2π/N`. |
| `World::VertexReplicate<W, N>` | Replicates geometry onto the N vertices of a solid by precomputing rotation quaternions from vertex[0] to each other vertex. |
| `World::Mobius<W>` | Applies a Möbius transformation via stereographic projection: sphere → complex plane → Möbius(z) → back to sphere. |
| `World::Hole<W>` | Masks out a spherical cap by attenuating points within a radius via quintic falloff. Supports both by-value and by-reference origin (`HoleRef<W>`). |
| `World::OrientSlice<W>` | Selects from a list of orientations based on each point's projection along an axis — enables per-hemisphere rotation effects. |

#### Screen-Space Filters

| Filter | Effect |
|---|---|
| `Screen::AntiAlias<W,H>` | Distributes a sub-pixel coordinate to its 4 nearest integer pixels using `quintic_kernel` bilinear weights. Scales the X fractional by `sin(φ)` from a trig LUT for spherical density compensation near the poles. |
| `Screen::Blur<W, H>` | Applies a parameterized 3×3 Gaussian convolution kernel at plot time. |
| `Screen::Trails<W>` | Screen-space variant of trail decay; stores 2D coordinates with TTL and redraws via a trail color function. Uses arena-allocated storage. |

#### Pixel-Space Filters

| Filter | Effect |
|---|---|
| `Pixel::Feedback<W, H, SpaceTransformFn, ColorTransformFn>` | Low-level full-screen feedback loop. Samples the previous frame from the Canvas front buffer with bilinear interpolation, applies a spatial transformation and color transform with fade, then blends into the back buffer. Stateless — uses Canvas double-buffering, no internal frame storage. Most effects should use the higher-level `Feedback::Filter` wrapper instead (see below). |
| `Pixel::ChromaticShift<W>` | Splits a pixel into R, G, B channels and offsets them by 1–3 pixels horizontally to simulate chromatic aberration. |

#### Feedback Styles (`styles.h`)

`Feedback::Style` bundles spatial transform, color transform, and scalar parameters into a single POD-copyable struct with named presets. `Feedback::Filter<W,H>` is a drop-in pipeline filter that takes a `Style&` directly — no template parameters for transform types, no adapter boilerplate.

```cpp
// Declare a style member and use it in the pipeline:
Feedback::Style style = Feedback::Style::Smoke();
Pipeline<W, H, Filter::World::Orient<W>, Filter::Screen::AntiAlias<W, H>,
         Feedback::Filter<W, H>> filters(..., Feedback::Filter<W, H>(style));
```

The Filter auto-syncs from the Style every frame — when the Style lerps between presets, the function pointers snap at the midpoint while scalars interpolate smoothly.

| Preset | Description |
|---|---|
| `Style::Churn()` | Dense fine-grain turbulence with strong hue shift. Tight scale, slow drift. |
| `Style::Smoke()` | Gentle drifting haze with slow noise. Classic smoke look. |
| `Style::Frozen()` | Static frozen distortion — no temporal movement. |
| `Style::Shatter()` | Extreme static warping with fast decay. Shattering glass look. |
| `Style::Drift()` | Flowing medium-strength distortion. Gentle liquid drift. |

Available transform functions:

| Space Transform | Description |
|---|---|
| `Feedback::noise_warp` (default) | 3D simplex noise distortion via `noise_transform()` |
| `Feedback::identity_warp` | No spatial distortion (pass-through) |

| Color Transform | Description |
|---|---|
| `Feedback::hue_fade` (default) | Multiplies by fade, then rotates hue by `style.hue_shift` |
| `Feedback::plain_fade` | Multiplies by fade only — no color shift |

Custom presets can use any function matching the `Feedback::SpaceFn` / `Feedback::ColorFn` signatures.

#### Combining Filters

Filters compose freely. The order matters — world-space filters must precede screen-space filters if both are present. Some common combinations:

```cpp
// Rotating geometry with anti-aliasing
Pipeline<W, H, Filter::World::Orient<W>, Filter::Screen::AntiAlias<W, H>>

// Particle trails in world space with orientation
Pipeline<W, H,
    Filter::World::Trails<W, 50000>,
    Filter::World::Orient<W>,
    Filter::Screen::AntiAlias<W, H>>

// Orientation + anti-aliasing + feedback with Smoke style
Pipeline<W, H,
    Filter::World::Orient<W>,
    Filter::Screen::AntiAlias<W, H>,
    Feedback::Filter<W, H>>
```

---

## 6. Core Subsystems

### 6.0 The Shader Interface

All rasterizers — SDF scanline, curve plotting, mesh, volumetric, and full-screen shader — share a common shading model based on the `Fragment` struct and two function signatures.

#### The Fragment

A `Fragment` (`geometry.h`) is the data packet exchanged between rasterizers and shaders. It carries the pixel position, four general-purpose float registers, and the output color:

```cpp
struct Fragment {
  Vector pos;              // World-space position (unit vector on sphere)
  float v0 = 0.0f;        // Register 0: normalized progress t (0–1)
  float v1 = 0.0f;        // Register 1: arc length / distance
  float v2 = 0.0f;        // Register 2: index / face ID
  float v3 = 0.0f;        // Register 3: auxiliary
  float size = 1.0f;      // Size metric for normalization
  float age = 0.0f;       // Age (for trail decay / motion blur)
  Color4 color;           // Output: shader writes RGBA here
};
```

The registers are *inputs* — populated by the rasterizer before the shader runs. The shader reads them and writes `color`. The rasterizer then forwards the color through the filter pipeline to the canvas.

#### Shader Signatures

Two shader types are defined as zero-allocation `FunctionRef` callables (`concepts.h`):

| Signature | Type | Role |
|---|---|---|
| `FragmentShaderFn` | `void(const Vector &, Fragment &)` | Per-pixel/per-sample shader. Receives the world position and a pre-populated Fragment; writes `color`. Called for every rasterized point. |
| `VertexShaderFn` | `void(Fragment &)` | Per-vertex or per-pixel-center shader. Runs once before sub-sampling to set up expensive shared state in the Fragment registers. Optional. |

`FunctionRef` is a non-owning, non-allocating type-erased callable (similar to `std::function_ref` from C++26). It captures a pointer to any lambda, functor, or function pointer with zero heap allocation — critical for ISR-safe code on Teensy.

Effects pass lambdas that capture their state:

```cpp
auto shader = [&](const Vector &p, Fragment &f) {
    float t = f.v0;           // read: normalized progress from rasterizer
    f.color = palette.get(t); // write: color from palette lookup
};
Scan::Ring::draw<W, H>(pipeline, canvas, basis, radius, thickness, shader);
```

#### Register Conventions by Rasterizer

Each rasterizer family populates the Fragment registers with a consistent convention. Shaders can rely on these semantics:

**SDF Scanline Path** (`Scan::Ring`, `Scan::Star`, `Scan::Polygon`, `Scan::Flower`, `Scan::Line`, `Scan::Mesh`):

| Register | Source | Meaning |
|---|---|---|
| `v0` | `DistanceResult.t` | Normalized parameter (0–1) — azimuthal angle for rings, perimeter progress for polygons |
| `v1` | `DistanceResult.raw_dist` | Unsigned distance to shape centerline (for distance-based effects) |
| `v2` | Set by rasterizer | Face index for `Scan::Mesh` (0 otherwise) |
| `v3` | `DistanceResult.aux` | Auxiliary — barycentric coordinate for faces, secondary parameter for others |
| `size` | `DistanceResult.size` | Shape radius or apothem for normalization |

The `DistanceResult` struct is returned by each SDF shape's `distance<ComputeUVs>()` method:

```cpp
struct DistanceResult {
  float dist;        // Signed distance (negative = inside)
  float t;           // Normalized parameter (0–1)
  float raw_dist;    // Unsigned / supplementary distance
  float aux;         // Auxiliary (barycentric, etc.)
  float size = 1.0f; // Size metric
};
```

**Curve Plot Path** (`Plot::Line`, `Plot::Multiline`, `Plot::Ring`, `Plot::Polygon`, `Plot::SplineChain`, `Plot::Bezier`):

| Register | Meaning |
|---|---|
| `v0` | Path progress (0.0 → 1.0 along the full curve) |
| `v1` | Cumulative arc length in radians |
| `v2` | Vertex index (integer cast to float) |
| `v3` | Inherited from control-point Fragment (user-defined) |

Plot primitives interpolate registers between control-point Fragments via `Fragment::lerp()`. The vertex shader, if provided, runs once per control point before rasterization.

**Full-Screen Shader Path** (`Scan::Shader`):

Registers are not pre-populated — the shader receives only `pos` (reconstructed from pixel coordinates). The single-callback overload provides a `Color4(const Vector &)` interface. The two-callback overload separates per-pixel vertex setup from per-subsample fragment evaluation.

**Volumetric Path** (`Scan::Volume`):

The fragment shader receives `pos` set to the closest local-space hit point (in the SDF's coordinate frame) and `size` set to the closest signed distance. No register convention — the shader computes lighting from the local-space position directly.

### 6.1 SDF Shapes (`sdf.h`) and the Scan Rasterizer (`scan.h`)

The rendering pipeline splits shape definitions from rasterization. `sdf.h` defines the SDF shape primitives, each implementing three methods:

1. **`get_vertical_bounds()`** — analytic tight bounding box in pixel-Y space (phi angle range). Only rows within this range are scanned.
2. **`get_horizontal_intervals(y, out)`** — analytic scanline intervals per row. Called per row to skip empty columns without evaluating the distance function.
3. **`distance<ComputeUVs>(p, result)`** — signed distance from a sphere-surface point `p` to the shape boundary, plus texture coordinate and auxiliary data in `DistanceResult`.

`scan.h` contains `Scan::rasterize()`, which drives the scanline loop and anti-aliasing, plus convenience wrappers that pair SDF shapes with the rasterizer.

The `process_pixel` function applies anti-aliasing based on shape type:
- **Solid shapes**: quintic smoothstep over a 1-pixel AA border. Full interior pixels (`d < -pixel_width`) skip AA math entirely.
- **Strokes**: opacity falloff across the full stroke thickness.

#### SDF Shape Primitives (`sdf.h`)

| Shape | Description |
|---|---|
| `SDF::Ring` | Geodesic circle at a given radius and thickness |
| `SDF::DistortedRing` | Ring with per-azimuth radius perturbation via a callback |
| `SDF::Polygon` | Regular N-gon in the tangent plane of a basis vector |
| `SDF::SphericalPolygon` | Regular N-gon with geodesic (great-circle) edges |
| `SDF::Star` | N-pointed star using the standard inradius/circumradius construction |
| `SDF::Flower` | Inverted star (N-petal flower shape from the antipodal perspective) |
| `SDF::HarmonicBlob` | Shape defined by a spherical harmonic Yˡₘ function |
| `SDF::Line` | Geodesic line segment between two sphere-surface points |
| `SDF::Face` | Planar polygon face (used for mesh rendering) |
| `SDF::Torus` | Torus SDF with configurable major/minor radii |
| `SDF::TwistedTorus` | Torus with configurable twist deformation and amplitude |

#### CSG Operations (`sdf.h`)

Shapes can be combined using Constructive Solid Geometry:

```cpp
SDF::Union<Ring, Polygon>        // min(d_A, d_B)
SDF::SmoothUnion<Ring, Polygon>  // smooth minimum with blending radius
SDF::Subtract<Ring, Polygon>     // max(d_A, -d_B)
SDF::Intersection<Ring, Polygon> // max(d_A, d_B) with interval intersection
SDF::AngularRepeat<Shape>        // N-fold angular repetition around an axis
```

#### Scan Rasterization Primitives (`scan.h`)

Convenience structs that construct an SDF shape and rasterize in a single `draw()` call:

| Primitive | Description |
|---|---|
| `Scan::Ring` | Rasterizes a ring (from `SDF::Ring`) |
| `Scan::Circle` | Filled circle (ring with radius-wide thickness) |
| `Scan::Point` | Thick dot at a sphere-surface position |
| `Scan::Line` | Geodesic line segment between two points |
| `Scan::Star` | N-pointed star shape |
| `Scan::Flower` | N-petal flower shape |
| `Scan::DistortedRing` | Ring with per-azimuth radius perturbation |
| `Scan::PlanarPolygon` | Regular N-gon in the tangent plane |
| `Scan::SphericalPolygon` | Regular N-gon with geodesic (great-circle) edges |
| `Scan::HarmonicBlob` | Spherical harmonic shape |
| `Scan::Mesh` | Rasterizes all faces of a `MeshState` or `PolyMesh` |
| `Scan::Shader` | Full-screen per-pixel shader with configurable SSAA (super-sample anti-aliasing). The single-callback overload accepts a fragment shader. The two-callback overload separates a per-pixel vertex shader (called once at pixel center) from a per-subsample fragment shader (called SAMPLES×) — enabling efficient SSAA with expensive per-pixel work computed once (used by BZReactionDiffusion for 4× SSAA). |
| `Scan::TransformedVolume` | Wraps an SDF shape with a world-space position and orientation quaternion for volumetric rendering |
| `Scan::Volume` | Volumetric ray-marcher that steps along the view direction through a `TransformedVolume`, applying a fragment shader at the hit point with configurable step count and AA width |

### 6.2 The Curve Rasterizer (`plot.h`)

For drawing lines, curves, and paths, the `Plot` namespace provides a geodesic/planar rasterizer with adaptive step size. The key insight is that near the poles of the sphere, pixels are much denser in latitude than near the equator. Step size is scaled by `sqrt(1 - y²)` — the sine of the polar angle — so curves remain smooth at all latitudes without over-sampling at the equator.

```cpp
Plot::Line::draw<W, H>(pipeline, canvas, start, end, fragment_shader);
Plot::Bezier::draw<W, H>(pipeline, canvas, p0, p1, p2, p3, fragment_shader);
Plot::SplineChain::draw<W, H>(pipeline, canvas, control_points, tension, shader);
```

All `Plot` primitives accept a `Fragments` array (an arena-backed `ArenaVector<Fragment>`) where each fragment carries position, texture registers (v0–v3), age, color, and blend mode. The rasterizer supports two interpolation strategies via `SplineMode`:
- **Geodesic**: great-circle arc between segment endpoints (default)
- **Planar**: planar projection within the tangent plane of a basis (for effects that live in a 2D local space)

#### Plot Primitives

| Primitive | Description |
|---|---|
| `Plot::Point` | Single point with adaptive thickness |
| `Plot::Line` | Geodesic line segment between two points |
| `Plot::Vertices` | Vertex set rendering |
| `Plot::Multiline` | Connected line strip from a sequence of fragments |
| `Plot::Ring` | Circle rasterized as a plotted polyline |
| `Plot::PlanarPolygon` | Regular N-gon in the tangent plane |
| `Plot::SphericalPolygon` | Regular N-gon with geodesic (great-circle) edges |
| `Plot::DistortedRing` | Ring with per-azimuth radius perturbation via callback |
| `Plot::Spiral` | Fibonacci spiral on the sphere |
| `Plot::Star` | N-pointed star shape (alternating inner/outer radii) |
| `Plot::Flower` | N-petal flower shape |
| `Plot::Mesh` | Wireframe mesh rendering with edge deduplication |
| `Plot::ParticleSystem` | Particle trail rendering from `VectorTrail` history |
| `Plot::Bezier` | Single cubic Bézier curve on the sphere |
| `Plot::SplineChain` | Catmull-Rom spline chain through control points with configurable tension |

### 6.3 The Animation System (`animation.h`)

The `Timeline<W>` class manages a list of running `IAnimation` objects. Each frame, `timeline.step(canvas)` advances all active animations. Finished animations are removed; repeating animations are rewound. All animation types inherit from `AnimationBase` and support method chaining via `.then()` for sequencing.

#### Animation Types

| Type | Description |
|---|---|
| `Rotation<W>` | Quaternion rotation of an `Orientation` around an axis, with optional repeat. Supports World and Local coordinate spaces. |
| `RandomWalk<W>` | Continuously perturbs an `Orientation` with smoothly changing random angular velocity driven by Perlin noise. Configurable via `Options` presets (Languid, Energetic). |
| `Motion<W, PathT>` | Moves an `Orientation` along a `Path` or `ProceduralPath` |
| `Sprite` | Calls a draw function over a duration with fade-in and fade-out envelopes |
| `PeriodicTimer` | Fires a callback at regular intervals (once or repeatedly) |
| `RandomTimer` | Fires a callback after a random delay within a min/max range |
| `Transition` | Smoothly interpolates a float variable from its current value to a target over a duration with easing |
| `Mutation` | Applies a custom scalar function to a float variable over time with easing |
| `Driver` | Continuously increments a float variable each frame (wraps at 0..1) |
| `Lerp` | Type-erased interpolation between any `T` that implements `lerp(start, target, t)`. The caller owns start, subject, and target data; Lerp holds pointers and a type-erased lerp function. |
| `ColorWipe` | Smoothly interpolates a `GenerativePalette` toward a target palette |
| `ParticleSystem<W>` | Physics simulation with emitters, attractors, friction, gravity. Particles have `VectorTrail` history for trail rendering. |
| `Ripple` | Animates a `RippleParams` to expand a Ricker wavelet across the sphere |
| `MobiusWarp` | Animates `MobiusParams` to apply and release a Möbius transformation |
| `Noise` | Animates `NoiseParams` over time for flowing distortion fields |
| `MeshCarousel<W>` | Double-buffered mesh transition system with crossfade. Manages a pair of `MeshState` buffers and an `Animation::Lerp` to morph between shapes. Used by IslamicStars, MeshFeedback, and HankinSolids for smooth geometry transitions. |

#### Orientation and Motion Blur

`Orientation<W>` stores a history of up to 4 quaternions (configurable via `CAP` template parameter) accumulated during one frame step. The `World::Orient` filter iterates over this history to distribute motion blur: each point is plotted once per orientation step, with the `age` field increasing backward in time. This means fast-rotating effects naturally show streak-like motion blur with no extra code.

```cpp
timeline.add(0, Animation::Rotation<W>(orientation, Y_AXIS, 2 * PI_F, 600, ease_mid, true));
// orientation.orientations[] now grows by 1 per sub-step
// World::Orient distributes all steps → motion blur
```

`Orientation::upsample(count)` resamples the orientation history to a higher resolution via SLERP. This is used to rewrite the history when combining multiple animations for accurate parallel sub-frame path tracing — ensuring that concurrent rotations, motions, and walks all contribute to a single coherent set of intermediate orientations.

#### OrientationTrail

`OrientationTrail<OrientationType, CAPACITY>` maintains a circular buffer of past `Orientation` snapshots, allowing effects to recall where an object was over previous frames. Each snapshot is a full `Orientation` (with its own sub-frame history).

#### VectorTrail

`VectorTrail<CAPACITY>` maintains a circular buffer of past world-space `Vector` positions. Used by `ParticleSystem` to record per-particle trajectories for trail rendering.

#### `tween` and `deep_tween`

Two traversal helpers linearize multi-level orientation history into a single callback loop:

| Function | Input | Description |
|---|---|---|
| `tween(orientation, callback)` | `Orientation<W>` | Iterates over the sub-frame quaternion history of a single orientation, calling `callback(quaternion, t)` for each step with `t ∈ [0, 1]`. Used by `World::Orient` to distribute motion blur. |
| `deep_tween(trail, callback)` | Any `Tweenable` (`Orientation` or `OrientationTrail`) | Flattens a trail of orientations into a single continuous traversal, calling `callback(quaternion, t)` with a global `t` spanning all frames and sub-frames. Used by `Plot::Mesh::Particle` for rendering trails with full sub-frame accuracy. |

#### Animations and Mutable State

Animations do not render directly — they mutate external state that the rendering pipeline reads. Each animation type targets a specific kind of mutable variable:

| Animation | Target State | What It Mutates |
|---|---|---|
| `Rotation`, `RandomWalk`, `Motion` | `Orientation<W>` | Quaternion orientation — pushes sub-frame steps into the orientation history, which `World::Orient` reads for motion blur |
| `Transition` | `float*` | Smoothly interpolates any float parameter (e.g. `speed`, `alpha`, `twist`) from current value to target with easing |
| `Mutation` | `float*` | Applies an arbitrary scalar function `f(t)` to a float over time (more general than `Transition`) |
| `Driver` | `float*` | Continuously increments a float each frame, wrapping at 0..1 — used for phase accumulators |
| `Lerp` | `T*` (type-erased) | Interpolates any type with a `lerp()` function — `MeshState`, params structs, etc. The caller owns start, subject, and target; Lerp holds pointers |
| `ColorWipe` | `GenerativePalette*` | Interpolates palette coefficients toward a target palette using `lerp_oklch_srgb` |
| `Ripple`, `MobiusWarp`, `Noise` | `TransformerParams` | Animate transformer parameters (expansion radius, warp strength, noise scale) which the transformer pool reads during `MeshOps::transform()` |
| `ParticleSystem` | `Vector[]` positions | Physics simulation updates particle positions; `VectorTrail` records history for trail rendering |

This separation means effects declare *what state exists* (orientations, floats, palettes) and *what animations drive that state* (rotations, transitions, drivers), but never manually interpolate or update values per-frame. The `Timeline` handles all timing, easing, sequencing, and cleanup:

```cpp
// Effect declares mutable state:
Orientation<W> orientation;
float twist = 0.0f;
GenerativePalette palette;

// Timeline drives state via animations:
timeline.add(0, Animation::Rotation<W>(orientation, Y_AXIS, TAU, 600, ease_mid, true));
timeline.add(0, Animation::Transition(twist, 2.5f, 1000, easing::cubic_in_out));
timeline.add(0, Animation::ColorWipe(palette, target_palette, 2000));

// Rendering reads state — no manual updates needed:
void draw_frame() {
    Canvas canvas(*this);
    timeline.step(canvas);  // all state updated automatically
    // orientation, twist, palette are now current-frame values
    filters.plot(canvas, v, palette.get(t), ...);
}
```

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
| `RippleTransformer` | Expands Ricker wavelets from a point, bending the sphere surface radially. Uses fast-reject dot-product heuristic — ~90-95% of vertices skip the slow `acosf` path. |
| `MobiusWarpTransformer` | Applies and releases a Möbius transformation |
| `MobiusWarpCircularTransformer` | Loops a Möbius warp continuously |
| `MobiusWarpGnomonicTransformer` | Möbius via gnomonic projection (preserves straight lines in hemisphere) |
| `NoiseTransformer` | Distorts surface positions with 3D simplex noise |
| `OrientTransformer` | Applies an `Orientation` quaternion rotation to all vertices |

Transformers integrate with the `MeshOps::transform()` pipeline and can be chained: `MeshOps::transform(input, output, arena, ripple_transformer, orient_transformer)`.

#### Standalone Utilities

`stereo_noise_warp()` (`transformers.h`) is a free function, not a `Transformer<>` specialization — it is called directly by effects rather than managed through the transformer pool. It projects a sphere point to the complex plane via `stereo()`, adds FastNoiseLite-driven displacement with pole attenuation, then reprojects. Returns a `StereoWarpResult` containing the warped coordinates and displacement magnitude (used for hue shift by Liquid2D and Flyby).

### 6.5 Memory Architecture (`memory.h`, `memory.cpp`)

A single contiguous memory block (`GLOBAL_ARENA_SIZE = 335 KB`) is partitioned into three arena allocators. This block is the same size on both Teensy and WASM targets. Individual effects can call `configure_arenas()` to repartition the block at runtime.

| Arena | Default Size | Purpose |
|---|---|---|
| `persistent_arena` | 303 KB | Long-lived compiled mesh data, persists across frames |
| `scratch_arena_a` | 16 KB | Short-lived intermediate geometry (RAII scoped) |
| `scratch_arena_b` | 16 KB | Secondary scratch for ping-pong subdivision passes |

Effects that need more scratch memory can repartition at init time:

```cpp
configure_arenas(256 * 1024, 48 * 1024, 41 * 1024);
```

`ScratchScope` (aliased as `ScopedScratch` for backward compatibility) provides stack-like RAII lifetime:

```cpp
{
    ScratchScope _(scratch_arena_a);     // save offset
    // ... allocate from scratch_arena_a ...
}                                        // restore offset — all allocations freed
```

All functions that require scratch memory take explicit `Arena&` parameters — there are no hidden arena references or implicit state:

```cpp
scratch_arena_a.reset();
scratch_arena_b.reset();
ScratchScope _a(scratch_arena_a);
ScratchScope _b(scratch_arena_b);
PolyMesh result = MeshOps::kis(mesh, scratch_arena_a, scratch_arena_b);
```

Conway operators take `(Arena& target, Arena& temp)`, generator functions take `(Arena& a, Arena& b)`, and `classify_faces_by_topology` takes `(Arena& scratch_a, Arena& scratch_b, Arena& persistent)`. This purely functional approach gives total control over the exact memory layout during heavy geometric operations.

#### Compaction with `Persist<T>`

`Persist<T>` is an RAII class that safely evacuates live data from the persistent arena, allowing it to be reset and defragmented, then automatically restores the data on destruction:

```cpp
{
    Persist<MeshState> p(live_mesh, scratch_arena_a, persistent_arena);
    persistent_arena.reset();
    // ... allocate fresh data into persistent_arena ...
}   // ~Persist: clones backup back into persistent_arena
```

#### Additional Data Structures

| Type | Description |
|---|---|
| `ArenaVector<T>` | Fixed-capacity, arena-backed vector (no dynamic growth). Copy-disabled, move-enabled. Debug builds detect use-after-free via arena generation tracking. |
| `ArenaSpan<T>` | Non-owning read-only view into an `ArenaVector` (explicit borrow) |

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
| `GenerativePalette` | Procedurally generated palette from harmony rules (triadic, analogous, etc.) combined with brightness/saturation profiles. Supports snapshot/lerp for animated transitions. |
| `SolidColorPalette` | Constant color, adapts to the `Palette` interface. |

Twenty-one named `ProceduralPalette` instances are pre-defined: `darkRainbow`, `bloodStream`, `vintageSunset`, `richSunset`, `undersea`, `lateSunset`, `mangoPeel`, `iceMelt`, `lemonLime`, `algae`, `embers`, `fireGlow`, `darkPrimary`, `mauveFade`, `lavenderLake`, `desertRose`, `bruisedMoss`, `bruisedBanana`, `brightSunrise`, `fireAndIce`, and `peachPop`.

#### OKLCH Perceptual Color

All palette interpolation and procedural color generation is performed in the OKLCH perceptual color space. The pipeline:

```
Pixel (sRGB 16-bit) → linear RGB float → OKLab (L, a, b) → OKLCH (L, C, h)
                                                                  ↓
                                              shortest-arc hue interpolation
                                                                  ↓
                                    OKLCH → OKLab → linear RGB → Pixel
```

| Function | Description |
|---|---|
| `linear_rgb_to_oklab()` | Convert linear RGB to the OKLab perceptual space |
| `oklab_to_oklch()` | Convert OKLab (rectangular) to OKLCH (polar: Lightness, Chroma, Hue) |
| `lerp_oklch()` | Interpolate two OKLCH values with shortest-arc hue (avoids the red→green→blue detour) |
| `lerp_oklch_srgb()` | Same as above but returns an sRGB `CPixel` (used by `GenerativePalette` transitions) |
| `hue_rotate()` | Rodrigues hue rotation in linear RGB space — a single-axis rotation in the color cube. Used by `MeshFeedback`'s `HueShiftFade` and `Flyby`'s displacement-driven hue shift. |

#### Palette Modifiers

Seven modifier types compose with any palette source via `StaticPalette<Source, Mods...>` at compile time:

| Modifier | Effect |
|---|---|
| `CycleModifier` | Shifts the lookup parameter by a continuously incrementing offset (palette scrolling) |
| `BreatheModifier` | Oscillates the lookup parameter with a sinusoidal "breathing" envelope |
| `RippleModifier` | Applies a wavelet distortion to the lookup parameter |
| `FoldModifier` | Folds the parameter space (mirror at edges) to create ping-pong patterns |
| `PinchModifier` | Non-linearly warps the lookup parameter toward a focal point |
| `QuantizeModifier` | Posterizes the palette into discrete bands |
| `ScaleModifier` | Scales and offsets the lookup parameter |

```cpp
// Compose a baked palette with a breathing modifier
StaticPalette<BakedPalette, BreatheModifier> palette;
```

#### Additional Palette Types

| Type | Description |
|---|---|
| `MutatingPalette` | Extends `ProceduralPalette` with continuous random coefficient mutation |
| `AnimatedPalette` | Wraps any `Palette` with a time-varying lookup offset |
| `CircularPalette` | Wraps the lookup parameter modulo 1.0 for seamless looping |
| `ReversePalette` | Mirrors the lookup parameter (1.0 - t) |
| `VignettePalette` | Applies a radial brightness falloff based on distance from center |
| `TransparentVignette` | Like `VignettePalette` but fades alpha instead of brightness |
| `AlphaFalloffPalette` | Applies a custom alpha curve (via callback) over the palette parameter |
| `BakedPalette` | Precomputes a `GenerativePalette` into a fast 16-bit LUT for O(1) lookup. Arena-allocated. |

### 6.7 The Mesh System (`mesh.h`, `conway.h`, `hankin.h`, `spatial.h`, `solids.h`)

The mesh system is split across several files:

- **`mesh.h`** — Core data structures (`PolyMesh`, `HalfEdgeMesh`) and fundamental `MeshOps` (compile, clone, classify)
- **`conway.h`** — Conway mesh operators and vertex transformations
- **`hankin.h`** — Hankin pattern compilation and dynamic update
- **`spatial.h`** — `MeshState` (flat-array renderer format), `AABB`, `KDTree`
- **`solids.h`** — Platonic + Archimedean + Catalan + Islamic Star Pattern solid geometry data and registry

`PolyMesh` stores vertices and face connectivity via `ArenaVector` arrays. `MeshState` (in `spatial.h`) is the flat compiled format consumed by the renderer. `HalfEdgeMesh` provides a half-edge traversal structure built from either a `PolyMesh` or `MeshState`.

#### Core MeshOps (`mesh.h`)

| Operation | Description |
|---|---|
| `MeshOps::compile` | Convert a `PolyMesh` to the flat-array `MeshState` format used by the renderer |
| `MeshOps::clone` | Arena-safe deep copy |
| `MeshOps::classify_faces_by_topology` | Group faces by vertex count and neighbor topology for palette assignment |

#### Conway Operators (`conway.h`)

All Conway operators take explicit `(const PolyMesh& mesh, Arena& target, Arena& temp)` parameters. They produce their result into `target` and use `temp` for intermediate computation:

| Operation | Description |
|---|---|
| `MeshOps::transform` | Apply a chain of vertex transformers to produce a new `MeshState` |
| `MeshOps::dual` | Dual mesh (faces ↔ vertices) |
| `MeshOps::kis` | Raise a pyramid on each face |
| `MeshOps::ambo` | Truncate vertices to edge midpoints |
| `MeshOps::truncate` | Cut corners off the polyhedron (configurable depth) |
| `MeshOps::expand` | Separate faces (ambo of ambo) |
| `MeshOps::chamfer` | Bevel edges (hexagonal expansion) |
| `MeshOps::bitruncate` | Truncate the rectified mesh |
| `MeshOps::snub` | Chiral semi-regular polyhedron with twist |
| `MeshOps::gyro` | Gyro operator |
| `MeshOps::canonicalize` | Iterative canonicalization |
| `MeshOps::normalize` | Project all vertices onto the unit sphere |
| `MeshOps::compute_kdtree` | Build a KDTree for nearest-neighbor queries on mesh vertices |
| `MeshOps::closest_point_on_mesh_graph` | Find the closest point on a mesh edge graph |

#### Hankin Pattern System (`hankin.h`)

| Operation | Description |
|---|---|
| `MeshOps::compile_hankin` | Pre-compute topological data for fast Hankin pattern updates |
| `MeshOps::update_hankin` | Update dynamic vertices based on angle parameter (no reallocation) |
| `MeshOps::hankin` | One-shot Hankin pattern generation (compile + update) |

`compile_hankin` produces a `CompiledHankin` struct containing base vertices, static midpoints, and dynamic instructions. `update_hankin` evaluates the dynamic vertices by sweeping the Hankin angle, producing the star polygon line intersections for each face without reallocating memory.

#### Solids Library (`solids.h`)

`solids.h` provides constexpr vertex/face data for all Platonic solids plus procedural generators for Archimedean, Catalan, and Islamic Star Pattern families. The solids are organized into three registries, unified under `Solids::get(arena, a, b, index)` and `Solids::get_by_name(arena, a, b, name)`:

| Registry | Count | Description |
|---|---|---|
| `simple_registry` | 16 entries | 5 Platonic (tetrahedron through icosahedron) + 11 Archimedean solids |
| `catalan_registry` | 13 entries | Duals of the Archimedean solids (triakisTetrahedron, rhombicDodecahedron, pentakisDodecahedron, etc.) |
| `islamic_registry` | 23 entries | Complex multi-operator recipes producing Islamic star patterns from base solids |

Total: **52 registered solids** (`Solids::NUM_ENTRIES`).

`Collections` namespace provides typed spans for iterating subsets: `get_platonic_solids()`, `get_archimedean_solids()`, `get_simple_solids()`, `get_catalan_solids()`, `get_islamic_solids()`.

`SolidBuilder` provides a fluent interface for chaining Conway operators with automatic arena swapping:

```cpp
return SolidBuilder(to_polymesh<Icosahedron>(a), a, b)
    .truncate()
    .dual()
    .build();
```

Islamic Star Pattern recipes chain multiple operators with Hankin pattern generation:

```cpp
SolidBuilder(dodecahedron(a, b), a, b)
    .hankin(54.0f * D2R).ambo().hankin(72.0f * D2R).build();
```

### 6.8 Generators (`generators.h`)

`generators.h` provides a single universal generation wrapper that manages arena lifecycle for all procedural geometry creation:

```cpp
template <typename GenerateFn, typename... Args>
auto generate(Arena &target, GenerateFn &&fn, Args &&...args);
```

It resets and scopes both scratch arenas, then invokes `fn(target, scratch_a, scratch_b, args...)`. All procedural geometry creation goes through this wrapper to ensure deterministic arena lifecycle:

```cpp
auto mesh = generate(persistent_arena, Solids::get_by_name, std::string_view("icosahedron"));
```

### 6.9 The Preset System (`presets.h`)

`Presets<Params, Size>` is a generic template for managing parameter presets. It stores a fixed-size array of `PresetEntry<Params>` (each containing only a `Params` struct — no name field) and provides navigation and interpolation support:

```cpp
Presets<MeshFeedbackParams, 4> presets = {{
    {{{0.95f, 1.2f, ...}}},
    {{{0.88f, 0.5f, ...}}},
    ...
}};
presets.next();  // advance to next preset
presets.apply(current_params);  // copy current preset into live params
```

### 6.10 DMA LED Controller (`dma_led.h`)

An optional non-blocking DMA-based LED output path for HD107S (APA102-compatible) LEDs on Teensy 4.x. Enabled by defining `USE_DMA_LEDS` in `led.h`; the default FastLED/WS2801 path remains as fallback.

The system has three layers:

| Class | Role |
|---|---|
| `HD107SFrame<N>` | Pre-formatted DMA buffer for the HD107S protocol. `packPixel()` writes `Pixel16` values directly into the frame buffer with inline color correction (color correction → temperature → gamma → brightness), bypassing the CRGB intermediate. Uses `DMAMEM` placement and `arm_dcache_flush_delete()` for cache coherency. |
| `TeensySPIDMA` | Low-level DMA+SPI driver wired to LPSPI4. Configures a `DMAChannel` with completion interrupt for fully async byte-stream transmission at 12 MHz. |
| `DMALEDController<N>` | Double-buffered high-level controller. `show(leds)` loads the back buffer and triggers DMA, returning immediately. The previous transfer is guaranteed complete before the next begins. |

In the ISR, `DMALEDController::show()` replaces `FastLED.show()` as a drop-in. The ISR writes `Pixel16` values directly via `packPixel()` — the 16-bit linear pipeline reaches all the way to the SPI wire with no 8-bit intermediate:

```cpp
// ISR path:
for (y in 0..S/2):
  frame.packPixel(S/2-y-1, get_pixel(x, y));   // Pixel16 → HD107S frame
  frame.packPixel(S/2+y,   get_pixel(x±W/2, y));
ledController_.submitFrame();  // non-blocking DMA
```

Because the DMA transfer runs in hardware, the ISR returns immediately and the main loop gets more CPU time for rendering.

---

## 7. The Effect System

Every visual effect inherits from `Effect`:

```cpp
template <int W, int H>
class MyEffect : public Effect {
public:
    MyEffect() : Effect(W, H), filters(...) {}

    void init() override {
        registerParam("Speed", &speed, 0.0f, 10.0f);
        persist_pixels = false;   // clear buffer each frame (this is the default)
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

REGISTER_EFFECT(MyEffect)
```

### Self-Registering Factory (`effect_registry.h`)

Effects register themselves into a global registry using the `REGISTER_EFFECT(ClassName)` macro placed at the bottom of each effect header. This uses a static initializer pattern — each effect creates a small registrar struct whose static member calls `EffectRegistry::add()` during program initialization, eliminating the need for a hand-maintained factory array. The registry stores resolution-specific fill functions for each supported `<W,H>` pair (96×20 and 288×144).

### Parameter Registration

Effects expose live-adjustable parameters via `registerParam()`. These are reflected into the WASM bridge and auto-generate GUI controls in the simulator:

```cpp
registerParam("Twist",   &params.twist,      -5.0f, 5.0f);   // float slider
registerParam("Enabled", &params.enabled,    false);           // boolean toggle
```

The parameter list (`ParamList` — a fixed `std::array<ParamDef, 32>`) is accessible via `getParameters()`, and `updateParameter(name, float)` sets values at runtime. Parameters support both `float*` and `bool*` targets via `std::variant`, with automatic bool threshold at 0.5. The animation system can also write to these parameters, allowing effects to animate their own exposed controls.

### The `persist_pixels` Flag

When `persist_pixels = true`, `Canvas` copies the previous frame's buffer into the new write buffer before rendering. This enables trail/decay effects without explicit trail storage — each frame partially overwrites the last. When `false` (the default), the buffer is zeroed each frame.

---

## 8. Effects Reference

### Core Effects (Modern Engine)

#### BZReactionDiffusion
Simulates the Belousov-Zhabotinsky reaction — a 3-species cyclic competition (A beats B, B beats C, C beats A) producing rotating spiral waves. The simulation runs on a spherical k-nearest-neighbor graph (`ReactionGraph`: 7680 nodes, 6 neighbors each, precomputed Fibonacci lattice) with configurable diffusion rate and time step. Spiral waves are seeded periodically and evolve continuously.

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



#### SphericalHarmonics
Renders the real spherical harmonics Yˡₘ(θ, φ) as SDF `HarmonicBlob` shapes. The harmonic defines a lobe-radius function that deforms a unit sphere surface. Animates through different (l, m) combinations.

#### Metaballs
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
Draws twisting wireframe knotted structures derived from Archimedean solids. Mesh vertices are displaced along per-vertex tangent frames to create orbiting knot patterns, and a Möbius warp is applied to the geometry. Multiple copies orbit simultaneously with animated `OrientSlice` hemisphere rotation effects.

**Parameters**: Copies (number of knot copies), Radius (displacement), Speed (orbit speed), Warp (Möbius warp scale), Alpha

#### Comets
Particles with long orientation-trail-based tails, launched in bursts and influenced by rotational gravity.

#### RingSpin / RingShower
Animated concentric ring patterns using `Scan::Ring` with per-ring phase offsets.

#### ChaoticStrings
Lissajous curves whose frequency ratios slowly sweep through rational approximations, transitioning between closed figures and dense space-filling curves.

#### MeshFeedback
Catalan solid mesh faces rendered with `Scan::Mesh`, distorted by a `NoiseTransformer` and given a feedback-loop appearance via `Filter::Pixel::Feedback`. Cycles through the Catalan solid library with crossfade morphing between shapes using `Animation::Lerp` and the `Presets` system.

#### Liquid2D
Stereographic-projection shader (extends `Effect` directly) that samples world-space through a configurable glitch lens (hemisphere mirror + squish/warp). Dual random-walk orientations animate the view and global rotation independently, producing flowing liquid distortion. Uses `Scan::Shader::draw` for full-screen pixel shading and `StaticPalette` with a `BreatheModifier` for animated palette cycling.

**Parameters**: Warp Scale, Warp Strength, Pattern Freq, Time Speed, Complexity, Pole Fade, Cycle Speed

#### MindSplatter
Random-walk particle system with Möbius warp bursts.

#### Dynamo
Rotating ring-pair patterns whose axes precess relative to each other.

#### Thrusters
Directional particle jets.

#### GnomonicStars
Star polygon SDFs that rotate continuously. Uses gnomonic projection (straight lines on sphere remain straight).

#### Raymarch
Volumetric raymarcher that renders twisted tori at the 20 vertices of a dodecahedron. Each torus is ray-marched with `Scan::Volume::draw` and lit with metallic Blinn-Phong shading (half-Lambert diffuse, specular highlights, Fresnel rim). A random-walk animation drives the camera orientation.

**Parameters**: Pulse Speed, Core Size, Max Steps, Diffuse, Specular, Fresnel, Twist, AA Width

#### Flyby
Stereographic-projection shader (extends `Effect` directly) with noise-driven warp distortion. A single `Rotation` animation continuously rotates the tangent plane around the Y-axis, producing a fly-through effect on the sphere surface. Uses `Scan::Shader::draw` for full-screen pixel shading with a baked palette.

**Parameters**: Warp Scale, Warp Strength, Pattern Freq, Speed, Pole Fade, Falloff, Drift, Hue Shift

#### SplineFlow
Catmull-Rom spline curves whose control points drift via independent random walks. Drawn with `Plot::SplineChain` in closed-loop mode through `World::Trails` for persistent trails, producing flowing organic ribbon paths.

**Parameters**: Tension, Speed, Drift, Num Pts, Alpha

### Legacy Effects (`effects_legacy.h`)

TheMatrix, ChainWiggle, RingRotate, RingTwist, Curves, Kaleidoscope, StarsFade, DotTrails, Burnout, Spinner, Spiral — built before the current engine and using an older rendering API. Functional but not representative of current architecture.

---

## 9. The Web Simulator (Daydream)

The simulator runs the identical C++ rendering engine compiled to WebAssembly via Emscripten, visualized as a 3D sphere in Three.js.

### WASM Bridge

`wasm_bridge.cpp` compiles to `holosphere_wasm.js` + `.wasm` and exposes a single `HolosphereEngine` class:

| Method | Description |
|---|---|
| `setResolution(w, h)` | Switch active resolution (96×20 or 288×144) |
| `setEffect(name)` | Instantiate a new effect by string name; resets all arenas to defaults |
| `drawFrame()` | Advance one frame and copy pixels to the output buffer |
| `getPixels()` | Return a zero-copy `Uint16Array` view into WASM linear memory |
| `setParameter(name, value)` | Update a live effect parameter |
| `getParameterDefinitions()` | Return the full `[{name, value, min, max}]` parameter list |
| `getParamValues()` | Return current parameter values (including animation-driven updates) |
| `getArenaMetrics()` | Memory usage stats for geometry, scratch, and tooling arenas |
| `getEffectSizes()` | Return `sizeof` for every registered effect at the current resolution |

The bridge also exposes a `MeshOps` class for the JavaScript tools, with dedicated 8 MB tooling arenas (separate from the engine's 335 KB arena) for interactive solid manipulation.

The WASM bridge includes stack high-water-mark instrumentation: `stack_paint_canary()` fills the stack with a known pattern at init time, and `stack_high_water_mark()` scans for the deepest overwrite. This is reported via `getArenaMetrics()` and logged on every effect switch to catch stack-hungry template instantiations early.

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


### GUI Auto-Generation

The effect parameter panel is entirely driven by what C++ registers via `registerParam()`. When an effect is loaded, the simulator calls `getParameterDefinitions()` and builds `lil-gui` controls:

```js
params.forEach(p => {
    const controller = gui.add(state, p.name, p.min, p.max);
    controller.onChange(v => wasmEngine.setParameter(p.name, v));
});
```

`getParamValues()` is polled each frame to sync the GUI with parameter values that the animation system has changed autonomously. The sync skips any control the user is currently interacting with to avoid fighting the slider.

---

## 10. Building

### Firmware (Arduino / Teensy 4.1)

1. Install [Arduino IDE](https://www.arduino.cc/en/software) with Teensyduino.
2. Install the `FastLED` library.
3. Open `Holosphere.ino`.
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
mkdir build && cd build
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release
emmake make
cmake --install .     # copies holosphere_wasm.js + .wasm to ../daydream/
```

The `CMakeLists.txt` configures:
- `-sALLOW_MEMORY_GROWTH=1` — WASM heap can grow for large meshes
- `-sMODULARIZE=1 -sEXPORT_ES6=1` — ES6 module output
- `-sSTACK_SIZE=8388608` — 8 MB stack (effects use deep template recursion)
- `-O3 -ffast-math -flto -msimd128` for release, `-O0 -g -sASSERTIONS=1` for debug

### Running the Simulator

The simulator is a static web app. Serve the daydream directory from any HTTP server:

```bash
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

Templating on `<W, H>` means every pixel coordinate transform, bounding box computation, and LUT index is resolved at compile time. The hardware target `<96, 20>` runs with no runtime overhead from generality. The simulator builds separate specializations for `<288, 144>`. Binary size increases, but for an embedded firmware this is the right trade-off.

### Why Arena Allocation?

The Teensy heap fragments under heavy mesh subdivision. The single-block partitioned arena design (persistent + scratch A + scratch B) gives deterministic memory behavior: persistent data allocated once and kept; scratch data RAII-scoped to the function that needed it. The `configure_arenas()` function allows effects to repartition the fixed 335 KB block based on their needs — mesh-heavy effects can claim more persistent space, while subdivision-heavy effects can expand their scratch pools. All functions take explicit `Arena&` parameters — Conway operators take `(Arena& target, Arena& temp)`, generators take `(Arena& a, Arena& b)` — giving total control over the exact memory layout during heavy geometric operations, with no hidden state or implicit arena references.

### Why the ISR Double Buffer?

POV display requires pixel data to be ready before each column interval fires — typically 13–130 µs for the hardware resolution at 480 RPM. A naive approach (rendering in the ISR) would block the main loop. Instead, the main loop renders freely into a back buffer while the ISR reads from a separate front buffer. `queue_frame()` / `advance_display()` synchronize with minimal interrupt-disabled critical sections.

### Coordinate Conventions

- **Y-up Cartesian**: `Vector(x, y, z)` — `y` is the vertical axis
- **Spherical**: `theta` = azimuth (longitude), `phi` = polar angle from +Y (co-latitude)
- **Pixel mapping**: `x ∈ [0, W)` → `theta ∈ [0, 2π)`, `y ∈ [0, H)` → `phi ∈ [0, π]`
- **SDF distances**: in radians on the unit sphere (matching `angle_between()`)
- All pixel LUTs are pre-computed and lazy-initialized (`PixelLUT<W,H>`) on first use

---

## License

Core infrastructure files: [Polyform Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)

New effect files: Copyright 2025 Gabriel Levy. All rights reserved.

`FastNoiseLite.h`: MIT License (Auburn / Jordan Peck)
