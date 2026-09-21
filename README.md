# Holosphere

### [▶ Play with the live WebAssembly simulator](https://woundedlion.github.io/daydream/)

### [📖 API documentation (Doxygen)](https://woundedlion.github.io/pov/)

---

<p align="center">
  <a href="https://woundedlion.github.io/daydream/?effect=IslamicStars" target="_blank"><img src="docs/screenshots/IslamicStars.png" alt="Holosphere — IslamicStars effect" width="640"></a>
</p>

A persistence-of-vision (POV) LED sphere and its real-time simulator. The device spins a strip of LEDs at 480 RPM while a Teensy microcontroller fires pixels at microsecond intervals to paint full-color imagery on the surface of a virtual sphere. The simulator renders the same effects in a browser window at up to 288×144 resolution using the identical C++ code compiled to WebAssembly.

The project spans **two repositories** that ship as one product:

| Repo | Role | What lives here |
|---|---|---|
| [**Holosphere**](https://github.com/woundedlion/pov) | C++ engine + firmware | All rendering code, effects, hardware drivers (`pov_single.h`, `pov_segmented.h`), the Emscripten/WASM target, unit tests, and this README. |
| [**daydream**](https://github.com/woundedlion/daydream) | Web simulator | Three.js renderer, the compiled `holosphere_wasm.{js,wasm}` artifacts (output of Holosphere's WASM build), GUI/sidebar, recorder, segmented-POV Web Workers, and standalone design tools. |

Building the WASM target in Holosphere installs the `.js`/`.wasm` module and its SHA/hash/toolchain provenance triple, `hardware/pov_segment_map.json`, the shader workbench helpers, generated operator catalog, shader documents, this README, and `docs/screenshots/` into the sibling `daydream/` checkout. The live demo is daydream served from GitHub Pages.

---

## Table of Contents

1. [Hardware](#1-hardware)
   - [Holosphere (2015)](#holosphere-2015)
   - [Phantasm](#phantasm)
2. [Engineering Philosophies](#2-engineering-philosophies)
   - [Why 16-bit Linear Color?](#why-16-bit-linear-color)
   - [Why Compile-Time Resolution?](#why-compile-time-resolution)
   - [Why Arena Allocation?](#why-arena-allocation)
   - [Why the ISR Double Buffer?](#why-the-isr-double-buffer)
   - [Why Fail-Fast (`HS_CHECK`)?](#why-fail-fast-hs_check)
   - [Coordinate Conventions](#coordinate-conventions)
3. [Repository Map](#3-repository-map)
   - [Holosphere (engine + firmware)](#holosphere-engine--firmware)
   - [daydream (web simulator)](#daydream-web-simulator)
4. [Architecture Overview](#4-architecture-overview)
   - [Compile-Time Resolution Parameterization](#compile-time-resolution-parameterization)
5. [Data Flow: Frame Lifecycle](#5-data-flow-frame-lifecycle)
   - [Hardware Path](#hardware-path)
   - [WASM Path](#wasm-path)
6. [The Rendering Pipeline](#6-the-rendering-pipeline)
   - [End-to-End Flow](#end-to-end-flow)
   - [Pipeline Domain Transitions](#pipeline-domain-transitions)
   - [The Canvas](#the-canvas)
   - [The Filter Pipeline](#the-filter-pipeline)
     - [World-Space Filters](#world-space-filters)
     - [Screen-Space Filters](#screen-space-filters)
     - [Pixel-Space Filters](#pixel-space-filters)
     - [Feedback Styles](#feedback-styles-stylesh)
     - [Combining Filters](#combining-filters)
7. [Core Subsystems](#7-core-subsystems)
8. [The Effect System](#8-the-effect-system)
   - [Self-Registering Factory](#self-registering-factory-controlregistryh)
   - [Parameter Registration](#parameter-registration)
   - [The `EffectConfig` Flags](#the-effectconfig-flags)
   - [Fenced Effect-to-Effect Transition](#fenced-effect-to-effect-transition-controltransitionh)
9. [Effects Reference](#9-effects-reference)
10. [The Web Simulator (Daydream)](#10-the-web-simulator-daydream)
    - [10.1 Process and Threading Model](#101-process-and-threading-model)
    - [10.2 The WASM Bridge](#102-the-wasm-bridge)
    - [10.3 The Three.js Renderer](#103-the-threejs-renderer-driverjs)
    - [10.4 Application State](#104-application-state-statejs)
    - [10.5 The Effect Sidebar](#105-the-effect-sidebar-sidebarjs)
    - [10.6 GUI Auto-Generation](#106-gui-auto-generation)
    - [10.7 Segmented POV Workers](#107-segmented-pov-workers-segment_workerjs)
    - [10.8 Vendor Importmap](#108-vendor-importmap-cdn-by-default--local-opt-in)
    - [10.9 Video Recording](#109-video-recording-recorderjs)
    - [10.10 Resolution Presets](#1010-resolution-presets)
    - [10.11 Standalone Design Tools](#1011-standalone-design-tools-daydreamtools)
11. [Building](#11-building)
    - [Firmware (Arduino / Teensy 4.x)](#firmware-arduino--teensy-4x--holosphere-repo)
    - [WASM Build](#wasm-build--holosphere-repo-installs-into-daydream)
    - [Tests](#tests--holosphere-repo)
      - [Continuous testing](#continuous-testing)
    - [Documentation](#documentation--holosphere-repo)
    - [Running the Simulator](#running-the-simulator--daydream-repo)

- [License](#license)

---

## 1. Hardware

Two physical targets share the same rendering engine:

### Holosphere (2015)

| Component | Detail |
|---|---|
| Controller | Teensy 4.0 (600 MHz ARM Cortex-M7) |
| LEDs | 40-pixel addressable strip (20 per half-arm, two-arm rotation) |
| Protocol | SPI via FastLED (WS2801 at 6 MHz) or DMA (HD107S at 12 MHz) |
| Rotation | 480 RPM (8 revolutions/second) |
| Virtual resolution | 96 × 20 |
| Driver | `POVDisplay<40, 480>` in `pov_single.h` |
| Pin assignments | DATA: pin 11, CLOCK: pin 13, RANDOM seed: analog pin 15 |

### Phantasm

| Component | Detail |
|---|---|
| Controllers | 4× Teensy 4.0 by default; optional 8× firmware profile (600 MHz ARM Cortex-M7) |
| LEDs | 288 total: 72 per segment at N=4, 36 per segment at N=8 |
| Protocol | DMA (HD107S at 24 MHz) |
| Rotation | 480 RPM (8 revolutions/second), 16 FPS from 2 sides of the ring |
| Virtual resolution | 288 × 144 |
| Driver | `POVSegmented<288, N, 480>` in `pov_segmented.h`, power-of-two `N ≤ 8` |
| Synchronization | 1-wire: count-coded sync symbols from segment 0 discipline a per-board flywheel timebase (`hardware/pov_sync.h`) |
| Pin assignments | ID: pins 21–22 at N=4, plus pin 23 at N=8; Sync: pin 3 (shared — master drives, downstream receive), master-enable: pin 5, SPI: pins 11 + 13 |

The POV effect works because each revolution takes ~125 ms and a new column is painted every `1,000,000 / (RPM/60) / width` microseconds (on Holosphere the IntervalTimer ISR advances one column per fire; on Phantasm each board's flywheel ISR derives the column from the CPU cycle counter — see §7.10). The LED strip is mounted on both sides of a rotating arm: the top half of the strip handles one hemisphere and the bottom half handles the opposite hemisphere, and the two arms sit half a turn apart in azimuth, so half a revolution paints a complete sphere and each revolution delivers two frames — one per side.

---

## 2. Engineering Philosophies

The five design decisions below account for much of the engine's structure; the rest of the document assumes them.

### Why 16-bit Linear Color?

Most LED art codebases use gamma-corrected 8-bit values throughout and blend in sRGB space. This produces muddy mixes: red + blue = dark purple instead of magenta. Holosphere blends in linear light (16-bit precision), then gamma-encodes only at the hardware output. The improvement is most visible in soft gradients and multi-layer alpha compositing. Palette interpolation goes a step further into the OKLCH perceptual color space, with shortest-arc hue interpolation that avoids the red→green→blue detour.

### Why Compile-Time Resolution?

Templating on `<W, H>` means every pixel coordinate transform, bounding box computation, and LUT index is resolved at compile time. The hardware target `<96, 20>` runs with no runtime overhead from generality. The simulator builds separate specializations for `<288, 144>`. Each supported resolution is a separate instantiation, so binary size increases in exchange.

### Why Arena Allocation?

The Teensy heap fragments under heavy mesh subdivision. The single-block partitioned arena design (persistent + scratch A + scratch B, 298 KiB total) gives deterministic memory behavior: persistent data allocated once and kept; scratch data RAII-scoped to the function that needed it. The `configure_arenas()` function allows effects to repartition the fixed block based on their needs — mesh-heavy effects can claim more persistent space, while subdivision-heavy effects can expand their scratch pools. The geometry families take explicit `Arena&` parameters — Conway operators take `(Arena& target, Arena& temp)`, generators take `(Arena& a, Arena& b)` — so the memory layout during heavy geometric operations is explicit at every call site. The animation carriers that own arena lifetime are the exception: `MeshCarousel::compact_*` and `OpLeg` reach for the global arenas directly.

### Why the ISR Double Buffer?

POV display requires pixel data to be ready before each column interval fires — roughly 434 µs to 1.3 ms depending on resolution at 480 RPM (the per-column period is `1,000,000 / (RPM/60) / W` µs, i.e. ~434 µs for Phantasm's 288 columns and ~1302 µs for Holosphere's 96). A naive approach (rendering in the ISR) would block the main loop. Instead, the main loop renders freely into a back buffer while the ISR reads from a separate front buffer. `queue_frame()` / `advance_display()` synchronize with minimal interrupt-disabled critical sections.

### Why Fail-Fast (`HS_CHECK`)?

On hardware there is no debugger attached and no console to read — a corrupted arena that ships garbage to the LEDs is the worst possible outcome, because the failure is silent and the cause is already gone by the time it shows on the sphere. So invariant violations *trap at the violation site* rather than being masked by bounded fallbacks. `HS_CHECK(cond, ...)` (`platform.h`) is variadic: the condition is mandatory, and an optional printf-style format string with its arguments says *what* went wrong. That message is the point of the design — on a headless board the breadcrumb is the entire post-mortem, so a bare `HS_CHECK(cond)` (which delegates through a no-message overload) is the degenerate case, not the intended one. On failure the macro calls `hs::check_fail(__FILE__, __LINE__, #cond, ...)`, which formats the message into a fixed 256-byte stack buffer — no heap, so it is safe from a corrupted-arena or OOM context, and the device path uses newlib's integer-only `vsniprintf` to keep the float formatter out of ITCM — logs `HS_CHECK failed: <basename>:<line>: (<cond>) <message>`, **flushes** the log so a release build actually emits it before dying, then calls `__builtin_trap()`. When the condition holds it is a single predicted-not-taken branch. Unlike `assert()` it is **not** stripped by `NDEBUG` — it still fires in the optimized device build, where `NDEBUG` is defined only to keep newlib's `__assert_func`→`fprintf` (and all of stdio) out of the image.

The rule is deliberate about *where* it goes: `HS_CHECK` guards seams where a violation is a logic or sizing bug with no valid recovery — container growth, arena OOM, capacity and bounds guards at allocation/registration/config sites, plus checked accessors like `StaticCircularBuffer::operator[]`, which runs **per control point** (a trail snapshot, a scanline span), not per pixel. It is kept out of the per-pixel loop, which indexes the raw storage directly — `sdf.h` takes `&buf[0]` once per row and walks the array — and hot paths that need a check use a stripped `assert` backed by a cold trap at the corresponding bind/setup site. Two guarded math helpers can run per pixel. `parallel_transport()` (`geometry.h`) checks its antipodal denominator on the curl-noise midpoint path. `angle_between()` (`3dmath.h`) checks both input lengths on every call, and it is reached per pixel — up to four times — from `SDF::Line::distance`, and once per plotted point from `Filter::World::Hole::plot`. The check guards the `sqrtf(m1 * m2)` it immediately divides by, and neither call site has a bind seam that could carry it instead: `Line`'s endpoints are public fields, and `Hole` normalizes its stored origin but receives plot directions at runtime. Dropping the check would turn a degenerate input into a NaN angle that clamps silently to 0 — a soft degrade, which is the outcome the rule exists to prevent. Two more sit inside per-pixel code without adding a branch to it: `lenses::polyhedral_kaleidoscope_lens` and `lenses::dodecahedral_kaleidoscope_lens` (`lenses.h`) trap only where their bounded reflection loop falls through unconverged — the exhaustion path the loop bound already tests — and the shader chain's `kaleidoscope` sphere stage reaches both. Genuinely *transient* conditions (a DMA overrun, a dropped frame) are not invariant violations and get bounded/soft handling instead. The native test suite includes a death harness that asserts these traps actually fire (`SIGILL` / `STATUS_ILLEGAL_INSTRUCTION`), so the safety net is verified rather than assumed.

### Coordinate Conventions

- **Y-up Cartesian**: `Vector(x, y, z)` — `y` is the vertical axis
- **Spherical**: `theta` = azimuth (longitude), `phi` = polar angle from +Y (co-latitude)
- **Pixel mapping**: `x ∈ [0, W)` → `theta ∈ [0, 2π)`, `y ∈ [0, H)` → `phi = y·π / (H + H_OFFSET − 1)`
- **`hs::H_OFFSET`** (`platform.h`): virtual rows below the physical LED ring. It is 3 on device, so the bottom physical row lands short of π without stretching the geometric mapping, and 0 on the host/sim build, which maps the full `[0, π]`. Antialias samples at `y >= H` are discarded; samples at `H-1 <= y < H` fold the off-edge neighbor's weight onto the last physical row, conserving their full input alpha. Callers pass the logical `H`; `y_to_phi<H>()` / `phi_to_y<H>()` add the offset internally. `tests/h_offset_renorm_check.cpp` recompiles the engine with the hardware value so the device path is exercised on host
- **SDF distances**: in radians on the unit sphere (matching `angle_between()`)
- All geometry LUTs (`PhiLUT<H>`, `TrigLUT<W,H>`) are pre-computed eagerly via `init_geometry_luts()` at engine setup

```
   Side view (looking down −Z):          Top view (looking down −Y):

         +Y (φ=0, north pole)                   +Z (θ=π/2)
          │                                      │
          │  ╱ point P                           │
          │ ╱φ                                   │  ╱ point P
          │╱                                    │ ╱θ
  ────────●────────  equator (φ=π/2)    ────────●────────  +X (θ=0)
          │                                      │
          │                                      │
         −Y (φ=π, south pole)                   −Z (θ=3π/2)

   Pixel canvas → sphere:
      x ∈ [0, W)  →  θ ∈ [0, 2π)    column wraps around the equator (x=0 at +X)
      y ∈ [0, H)  →  φ ∈ [0, π]     row descends from north pole (y=0) to south pole
```

---

## 3. Repository Map

Both trees are gated against their repository's tracked file list: every row must name a path that exists, and a directory that names any of its children must name them all. A directory drawn as a single summary row names no children and so is exempt — nothing forces `effects/`, `tests/`, `docs/`, `.githooks/`, or `.github/workflows/` to enumerate their contents here. On top of that, `tools/docs_check.py` carries a short `_TREE_UNMAPPED` allowlist of tracked paths no row has to name at all: the VCS metadata files (`.gitattributes`, `.gitignore`, `hardware/phantasm/.gitignore`), this document itself, and everything under `tests/`.

### Holosphere (engine + firmware)

<!-- docs-check: tree exhaustive -->
```
├── core/                       Rendering engine
│   ├── platform/               Target abstraction and build-time configuration
│   │   ├── platform.h              HS_CHECK trap + Arduino vs. WASM vs. Desktop abstraction layer
│   │   ├── attributes.h            Placement and optimization attribute macros
│   │   ├── diagnostics.h           hs::log / hs::flush_log sink + HS_OS_CYCLES cycle read
│   │   ├── profiling.h             Cycle counters + HS_PROFILE / scan-metric macros
│   │   ├── inplace_function.h      Fixed-capacity in-place callable storage behind Fn
│   │   ├── rng.h                   Deterministic random number generation
│   │   ├── arduino_mocks.h         Host-side FastLED / Arduino mock surface
│   │   ├── build_features.h        Canvas size, build-time feature and instrumentation switches
│   │   └── constants.h             MAX_W, MAX_H, star ratio, pole-LOD tuning
│   ├── control/                An effect's control surface (registry, params +
│   │                            apply_if_changed, ParamHost/PresetHost, presets,
│   │                            choreography, transition)
│   ├── containers/             Reusable fixed-capacity containers
│   │   ├── static_circular_buffer.h Fixed-capacity non-allocating circular buffer
│   │   └── triangular_bitset.h     Upper-triangular unordered-pair bitset
│   ├── engine/                 Machinery: memory, callables, rosters, effect support
│   │   ├── engine.h                Engine API umbrella — included by every effect
│   │   ├── effects.h               Effect roster (includes each effect + HS_EFFECT_LIST)
│   │   ├── effects_legacy.h        Pre-engine effects (TheMatrix, Spiral, etc.)
│   │   ├── concepts.h              FunctionRef/Fn callable wrappers, PipelineRef type erasure, Tweenable concept
│   │   ├── memory.h / memory.cpp   Arena allocator, ScratchScope, Persist<T>, generate()
│   │   ├── static_storage.cpp      Definitions of the framebuffer/timeline statics (DMAMEM placement)
│   │   └── styles.h                Feedback::Style named presets + space/color transform functions
│   ├── math/                   Vector/quaternion math and scalar curves
│   │   ├── 3dmath.h                Vector, Quaternion, Spherical, Complex primitives, fast-math approximations, value noise, Snorm3
│   │   ├── 4dmath.h                Vec4 / Mat4 four-dimensional primitives + coordinate-plane rotation
│   │   ├── rotate.h                Quaternion projection helpers
│   │   ├── geometry.h              wrap()/fast_wrap()/shortest_distance, PhiLUT/TrigLUT, pixel ↔ vector mapping, pole_wrap, Orientation, Basis
│   │   ├── spherical_field.h       Latitude-ring field layout + bilinear sphere sampling
│   │   ├── spherical_harmonics.h   Real spherical harmonics in Cartesian form on the unit sphere
│   │   ├── noise_field.h           Shared scalar/vector noise-field sampling kernels
│   │   ├── projections.h           Bonne / Peirce quincuncial / Airocean / stereographic / gnomonic sphere → plane kernels (Airocean uses PROJ-derived code, MIT)
│   │   ├── stereographic.h         Stereographic / gnomonic / Möbius sphere ↔ plane maps, pole attenuation, pattern normalization
│   │   ├── lenses.h                Glitch fold, twist, kaleidoscope and polyhedral reflection-group sphere lenses
│   │   ├── easing.h                Easing functions (cubic, sine, elastic, expo, etc.)
│   │   ├── interpolate.h           Per-domain interpolators: scalar, positive scale, periodic angle, unit vector
│   │   └── waves.h                 sin_wave / tri_wave / square_wave generators
│   ├── mesh/                   Polyhedral meshes and their operators
│   │   ├── mesh.h                  PolyMesh, HalfEdgeMesh, MeshOps (compile, clone, etc.)
│   │   ├── mesh_class_types.h      Congruence-class id space + the record structs the rasterizer reads
│   │   ├── mesh_classes.h          Congruence-class clustering + canonical distance-LUT bake
│   │   ├── mesh_state.h            Arena-backed MeshState, the flat mesh format the renderer reads
│   │   ├── conway.h                Conway operators (dual, kis, ambo, truncate, etc.)
│   │   ├── conway_graph.h          Constexpr solid-to-solid operator edge graph + walk helpers
│   │   ├── recipe_types.h          Op / OpStep / Recipe: the authored op-chain model
│   │   ├── recipe.h                Recipe lowering to primitive Conway steps + replay
│   │   ├── hankin.h                Hankin pattern compilation and update system
│   │   ├── solid_generators.h     Platonic vertex/face tables, SolidBuilder, and the named solid generators
│   │   ├── solids.h                Solid registries, Recipe mirrors, and the name/index lookups
│   │   └── relax_bakes_generated.h Baked relaxed-mesh vertices (from tools/relax_bakes.py)
│   ├── spatial/                Spatial indexing and spherical graph structures
│   │   ├── kd_tree.h               KDTree k-nearest-neighbor search
│   │   └── reaction_graph.h / reaction_graph.cpp  Precomputed Fibonacci-lattice K-NN graph (90 KiB / 92,160-byte table)
│   ├── color/                  Color math and palettes
│   │   ├── color.h                 Pixel (16-bit linear), Color4, blend helpers, palettes
│   │   ├── composition.h           Palette modifiers + StaticPalette composition (via color.h)
│   │   ├── layer_composite.h       LayerComposite: front-to-back "over" accumulator for layered coverage
│   │   ├── color_luts.h            Precomputed sRGB ↔ linear LUTs
│   │   ├── srgb_decode.h           Branchless linear16 → sRGB8 encode from DTCM split tables
│   │   ├── srgb_decode_lut.h       Generated split-decode tables behind srgb_decode.h
│   │   ├── gamut_lut.h             Generated sRGB gamut-boundary chroma table for OKLab clipping
│   │   ├── generative_palette.h    GenerativePalette + PaletteRecipe compilation (via color.h)
│   │   ├── noise_hue_palette.h     Sphere-noise hue LUTs + reusable NoiseHuePalette wrapper
│   │   ├── palette_cycler.h        PaletteCycler: dwell-and-fade display LUT over a palette sequence
│   │   ├── effect_palette_recipes.h Per-effect authored PaletteRecipe constructors
│   │   ├── triadic_palette_luts.h  Generated bank of 256 triadic palette LUTs, one per base hue (from tools/mindsplatter_palette_gen.cpp)
│   │   └── palettes.h              Named ProceduralPalette instances + shared MeshPaletteBank
│   ├── render/                 Canvas, rasterizers, and the filter pipeline
│   │   ├── canvas.h                Effect base class (framebuffer half) + Canvas RAII write-buffer guard
│   │   ├── clip.h                  ClipRegion segment clip rectangle + cylindrical render band
│   │   ├── pullback.h              Typed inverse-render pipeline: umbrella over pullback/'s ten stage headers
│   │   ├── pullback/               Per-stage pullback headers (contract, fields, surface,
│   │   │                            lens, projection, warp, source, material, color,
│   │   │                            stage), the operator layer (operator_model,
│   │   │                            operator_table, operators, operators_common,
│   │   │                            operators_field, operators_project, operators_sample,
│   │   │                            operators_sphere, operators_warp), the chain
│   │   │                            interpreter (interpreter) with its catalog export
│   │   │                            (catalog_export), the shared runtime seeds
│   │   │                            (runtime_seeds), plus the composed-effect base
│   │   │                            (composed_effect)
│   │   ├── scan.h                  Scanline rasterizer: umbrella over scan/
│   │   ├── scan/                   Per-family scan headers (raster, shapes, mesh,
│   │   │                            shader, volume)
│   │   ├── plot.h                  Curve rasterizer: umbrella over plot/
│   │   ├── plot/                   Per-family plot headers (cull, raster, shapes,
│   │   │                            mesh, particles)
│   │   ├── filter.h                Composable render pipeline + all Filter::World/Screen/Pixel:
│   │   │                            umbrella over filter/
│   │   ├── filter/                 Pipeline composition (pipeline) and the shared splat
│   │   │                            helper (splat), plus one header per stage
│   │   │                            (world_orient, world_orient_slice, world_hole,
│   │   │                            world_replicate, world_vertex_replicate, world_mobius,
│   │   │                            world_trails, screen_anti_alias,
│   │   │                            screen_direct_aa_sink, screen_trails, screen_blur,
│   │   │                            pixel_chromatic_shift, pixel_feedback)
│   │   ├── sdf.h                   SDF shapes, CSG operators and volumes: umbrella over sdf/
│   │   ├── sdf/                    Per-family SDF headers (common, shapes, rings,
│   │   │                            csg, face, volume)
│   │   ├── shading.h               Fragment interpolation + mesh-topology shading helpers
│   │   └── led.h                   LED pin constants + color-correction RAII guards (driver in hardware/pov_single.h)
│   ├── animation/              Timeline scheduler + the animation type families
│   │   ├── animation.h             IAnimation/AnimationBase contract + umbrella over the fragments below
│   │   ├── timers.h                RandomTimer / PeriodicTimer callback timers
│   │   ├── params.h                Parameter-writing animations (Transition, Mutation, Progress, Driver, Lerp, ColorWipe, Mobius*, Ripple, Noise, BallDrop, NoiseProduct)
│   │   ├── motion.h                Path/ProceduralPath + the Orientation drivers (Motion, Rotation, RandomWalk)
│   │   ├── trails.h                OrientationTrail/VectorTrail/QuantizedVectorTrail history + tween/deep_tween traversal
│   │   ├── sprites.h               Sprite draw envelope, Particle/ParticleSystem
│   │   ├── timeline.h              TimelineEvent inline storage + the Timeline scheduler
│   │   ├── opleg.h                 Conway-chain morph legs: OpLeg
│   │   ├── segue.h                 Mesh-to-mesh transition policies: the Segue library
│   │   ├── carousel.h              Double-buffered mesh slot pair: MeshCarousel
│   │   └── transformer.h           Ripple, Noise, Möbius warp and displacement-field transformer pools
│   └── vendor/                 Third-party code
│       ├── FastNoiseLite.h         Single-header noise library
│       └── FastNoiseLite_config.h  FastNoiseLite build configuration
│
├── effects/                    42 headers covering 41 effects, all firmware — BZReactionDiffusion.h,
│                                HopfFibration.h, IslamicStars.h, Raymarch.h, … — plus
│                                shared base ReactionDiffusionBase.h; the
│                                composed-effect base is
│                                core/render/pullback/composed_effect.h — see §9
│
├── workbench/                  Simulator-only shader authoring surfaces, outside the firmware
│                                roster; their HS_ENABLE_* gates #error under ARDUINO — see §9
│   └── shader/                 The shader authoring workbench; everything independent of
│                                canvas resolution lives in namespace Workbench
│       ├── shader_host.h       Slot-configured shader with dynamic dispatch: registered as Shader
│       ├── chain_host.h        Effect host for a compiled operator chain: registered as ShaderChain
│       ├── config.h            Slot enums, per-stage parameter families, and the Config they compose
│       ├── limits.h            Parameter domain bounds and the predicates checking a Config against them
│       ├── options.h           Display label and stable export spelling of every enumerated field
│       ├── admission.h         Structural legality: valid configurations, bounds, admitted transitions
│       ├── presets.h           The authored presets and the assertions holding them to the admission rules
│       ├── frame_state.h       Prepared stage payloads and the immutable FrameState a shading pass reads
│       ├── resources.h         Noise-field keys per configuration and whether two of them fit the bank
│       ├── kernels.h           Pull-back kernels: camera, lens, projection, warp, source, colorize
│       ├── bindings.h          The pullback binding and its per-stage state providers
│       └── pipelines.h         Compiled stage adapters, the pipeline catalog, and the program manifest
│
├── hardware/                   Hardware drivers
│   ├── dma_led.h               Non-blocking DMA LED controller for HD107S (Teensy 4.x)
│   ├── dma_led_controller.h    Double-buffered controller templated on its transport (host-testable)
│   ├── dma_led_core.h          Pure double-buffer / transfer-length / stale-transfer math (host-testable)
│   ├── hd107s_frame.h          HD107S protocol buffer + inline color correction (host-testable)
│   ├── pov_segment_map.h       Pure segment index math (host-testable)
│   ├── pov_segment_frame.h     Retains opposite-half pixels before segmented frame publication
│   ├── pov_segment_map.json    Segment→canvas golden emitted from that header; read by daydream's cross-check
│   ├── pov_single.h            Single-Teensy POV driver (Holosphere)
│   ├── pov_single_map.h        Single-board strip mapping and column pack/submit/advance sequence (host-testable)
│   ├── pov_sync.h              Phantasm per-board sync engine over the layers below (host-testable)
│   ├── pov_sync_protocol.h     Sync ring math, Config, symbol alphabet, flip gate, edge mailbox, telemetry
│   ├── pov_sync_flywheel.h     Layer 1: position-from-time flywheel and its snap discipline
│   ├── pov_sync_content.h      Layer 3: index-beacon codec and the per-board content tracker
│   ├── pov_sync_emitter.h      Master-side symbol generation with late-burst self-censoring
│   ├── pov_handoff.h           Pure effect-handoff state machine for POVSegmented (host-testable)
│   ├── pov_submit_gate.h       Pure LED-submit accept/drop and sync-pulse width decisions for the POVSegmented ISR (host-testable)
│   ├── pov_segmented.h         Multi-Teensy segmented POV driver (Phantasm)
│   └── phantasm/               KiCad 10 project for the per-segment carrier board
│       ├── README.md               Project entry point and validation matrix
│       ├── phantasm.kicad_sch      Schematic — parts, values, footprints, full connectivity
│       ├── phantasm.kicad_pcb      Routed PCB (fabrication source of truth)
│       ├── phantasm.kicad_pro      KiCad project configuration
│       ├── phantasm.kicad_sym      Project symbol library
│       ├── phantasm.pretty/        Project footprint library and 3D model
│       ├── fp-lib-table / sym-lib-table  KiCad library mappings
│       ├── quilter_incremental/    Independently tracked incremental-router board project
│       ├── unplaced/               Net-assigned, unrouted board staged for an autoplacer
│       └── gen/                    Python design/fabrication tools (`just pcb` runs `fab.py` only)
│
├── targets/                    Per-target entry points
│   ├── Holosphere/
│   │   └── Holosphere.ino      Holosphere entry — NUM_PIXELS=40, RPM=480
│   ├── Phantasm/
│   │   ├── Phantasm.ino        Phantasm entry — 4×Teensy playlist, per-effect seeds, sync config
│   │   ├── phantasm_playlist.h HS_PHANTASM_EFFECT_LIST — device show order, per-entry durations, roster drift guards
│   │   └── phantasm_target.h   Shared Phantasm-class boilerplate — TOTAL_PIXELS=288, RPM=480, LED transport, geometry, boot, effect construction
│   ├── Profile/
│   │   └── Profile.ino         Single-effect HS_PROFILE harness on segment 0 of the segmented rig
│   └── wasm/
│       ├── wasm.cpp            Emscripten binding TU — includes the binding headers below
│       ├── engine_bindings.h   Render bridge — HolosphereEngine JS class, readback buffers, embind registration
│       ├── mesh_ops_bindings.h Mesh editor bridge — MeshOps JS class, tooling arenas, Conway/Goldberg operators
│       ├── mesh_op_bounds.h    Pure mesh-operator roster + growth factors behind the MeshOps guards (host-testable)
│       ├── palette_bindings.h  Palette bridge — PaletteOps JS class, generative palette LUT bake
│       ├── math_exports.h      Free color/palette/geometry exports the JS tool ports cross-check against
│       ├── arena_metrics.h     Arena metrics report shared by the render and mesh editor bridges
│       ├── effect_factory.h    Pure per-resolution effect factory + HS_RESOLUTIONS dispatch (host-testable)
│       ├── param_marshal.h     Pure parameter definition/value marshaling, single ordering source (host-testable)
│       └── wasm_predicates.h   Pure embind boundary validation/clamping predicates (host-testable)
│
├── CMakeLists.txt              Emscripten build (outputs holosphere_wasm.js + .wasm)
├── CMakePresets.json           Canonical presets: wasm-release, wasm-debug, wasm-strict-fp, tests
├── cmake/
│   ├── prune_mirrored_patterns.cmake     Removes obsolete engine-owned shader documents during install
│   ├── prune_mirrored_screenshots.cmake  Removes obsolete engine-owned gallery PNGs during install
│   ├── wasm_cache_key.cmake     Keys the binary URL by its content hash after linking
│   └── toolchain-native-clang.cmake  Native Clang toolchain behind the tests preset
├── platformio.ini              Teensy envs: the two shipping images plus the compile/profiling profiles
├── tests/                      Unit tests (CMake subdirectory)
│   ├── mindsplatter_whitebox.h  White-box MindSplatter accessor shared by its tests and the replay tools
│   ├── mindsplatter_replay_metrics.h  Difference metrics + clip geometry shared by the replay generator and comparator
│   └── mindsplatter_replay_corpus.h  Generated golden replay corpus (emitted by tools/mindsplatter_replay_gen.cpp)
├── patterns/                   Shader workbench source documents
├── scripts/                    Build + CI tooling
│   ├── generate_luts.py        sRGB ↔ linear LUT generator of record (emits core/color/color_luts.h)
│   ├── generate_reaction_graph.py K-NN lattice generator of record (emits core/spatial/reaction_graph.cpp)
│   ├── generate_srgb_decode.cpp Split-decode generator of record (emits core/color/srgb_decode_lut.h)
│   ├── effect_roster.mjs       Shared HS_EFFECT_LIST / REGISTER_EFFECT parser for the roster tools
│   ├── effect_roster.test.mjs  Node unit test for both roster parsers
│   ├── check_effect_roster.mjs Cross-checks HS_EFFECT_LIST against the REGISTER_EFFECT calls (CI)
│   ├── shader_workbench.mjs    Chain-document validation and canonical identity
│   ├── shader_workbench_cli.mjs Command-line validator for shader workbench documents
│   ├── shader_workbench.test.mjs Node contract tests for the shader workbench
│   ├── pattern_documents.mjs   Shared patterns/*.shader.json discovery and compilation
│   ├── generate_promoted_shader_documents.mjs Generates canonical promoted-effect documents
│   ├── promoted_digests.test.mjs Pins each promoted header's descriptor/preset-bank digest to its document
│   ├── engine_catalog.json     wasm32 operator ABI catalog the browser workbench budgets against
│   ├── export_engine_catalog.mjs Exports the installed WASM module's operator catalog
│   ├── sha256.mjs              Shared SHA-256 implementation for shader documents
│   ├── engine_bindings_contract.test.mjs Node contract tests for WASM engine binding invariants
│   ├── wasm_smoke.mjs          Runtime WASM smoke: drives every effect at both resolutions (CI)
│   ├── wasm_smoke_predicates.mjs Module-free smoke decisions: dark band, stack creep budget, param zip
│   ├── wasm_smoke_predicates.test.mjs Node unit test for those four decisions
│   ├── wasm_cache_key.test.mjs Node regression tests for generated WASM URL versioning
│   ├── capture_screenshots.mjs Headless gallery capture for docs/screenshots/
│   ├── screenshot_capture_config.mjs Per-effect capture offsets shared by capture and the CI gate
│   ├── screenshot_capture_config.test.mjs Node unit test for the capture-offset table
│   ├── screenshot_resolution.mjs Browser-free resolution descent: picks the first resolution the app honors
│   ├── screenshot_resolution.test.mjs Node unit test for that descent (fallback, empty list, prefix names)
│   ├── png_probe.mjs           Dependency-free PNG chunk/CRC/inflate validator behind the gallery gate
│   ├── png_probe.test.mjs      Node unit test for the PNG validator (corrupt/empty fixtures)
│   ├── check_screenshots.mjs   Asserts docs/screenshots/ matches the effect roster and decodes (CI)
│   ├── check_screenshots.test.mjs Node unit test for the roster/gallery partition and offset table
│   ├── check_profiles.mjs      Validates indexed timing reports against their rosters and document contract (CI)
│   ├── check_profiles.test.mjs Node regression tests for timing report structure and set discovery
│   ├── run_tests.mjs           `npm test`: runs the .test.mjs suite and rejects empty cases/files
│   ├── run_tests.test.mjs      Node regression test for the empty-case rejection
│   ├── count_assertions.mjs    NODE_OPTIONS shim counting node:assert calls and zero-delta cases
│   └── report_cases.mjs        node:test reporter tallying per-file case counts
├── tools/                      Firmware gates, device profiling, and asset bakes
│   ├── build_pins.py           Shared external-tool version pins for CI and `just`
│   ├── check_coverage.py       Catastrophic llvm-cov line-floor gate, repo-wide and per core/ subtree
│   ├── check_domain_ratchets.py  Relax-bake and death-harness coverage ratchets
│   ├── require_test_files.sh   Non-empty guard for glob-discovered test suites (CI)
│   ├── check_test_dir_pins.sh  Asserts every Python test-suite directory is discovered by CI and the justfile
│   ├── ruff_selection_guard.sh / eslint_selection_guard.sh  Shared CI and `just lint` anti-vacuity probes
│   ├── shellcheck_gate.sh      Tracked shell-file selection + shellcheck run behind `just lint`
│   ├── clang_format_gate.sh    Tracked first-party C++ selection + clang-format run behind `just clang-format`
│   ├── teensy_gate.py          Size + memory-layout gate parser/classifier (toolchain-free)
│   ├── teensy_gate_extra.py    PlatformIO post-build glue that runs the gate on every link
│   ├── teensy_budgets.json     Per-env FLASH/RAM1/RAM2 budgets the gate enforces
│   ├── teensy_size_table.py    `just teensy-size` wrapper: builds every env + prints the region table
│   ├── teensy_size_trail.py    Per-commit firmware size trail: ELF section parser, recorder, regression report
│   ├── teensy_cold_build.sh    Cold `pio run -v` over every environment, teed for the warning gate
│   ├── teensy_warnings.py      Cold-build first-party warning gate
│   ├── teensy_warning_baseline.txt  Intentionally empty local-tool default
│   ├── teensy_pre.py / teensy_isystem.py / teensy_map.py / teensy_nano.py  PlatformIO build hooks
│   ├── phantasm.ld             Phantasm linker script (memory-region layout)
│   ├── profile_one.sh / profile_sweep.sh  On-device HS_PROFILE flash + capture runs
│   ├── profile_islamic_big.sh  Focused profiling loop for IslamicStars' largest mesh
│   ├── profile_capture.py      Serial capture of the profiling image's readout
│   ├── parse_profile.py        Capture-log parser behind the per-window/per-preset reports
│   ├── pullback_profile_build.py  Profile-image Git-SHA build hook for pullback telemetry
│   ├── generate_pullback_manifest_header.py  Pullback manifest validator and native-test header generator
│   ├── pullback_operations.def                Shared capture operation codes and preset count
│   ├── pullback_capture.py / pullback_capture_native.cpp  Canonical producer + native/WASM backend
│   ├── pullback_crosscheck.py  Isolated base/candidate pullback capture runner and comparator
│   ├── device_lock.sh          Host-global per-board lock every device path takes
│   ├── device_lock_guard.py    OS file-lock guard for claim creation and removal
│   ├── pov_segment_map_export.cpp  Generator for the committed segment-map golden
│   ├── relax_bakes.py / relax_bake_harness.cpp  Relaxed-mesh bake generator of record
│   ├── gen_gamut_lut.py        sRGB gamut-boundary generator of record (emits core/color/gamut_lut.h)
│   ├── mindsplatter_palette_gen.cpp  MindSplatter palette-LUT bank generator of record
│   ├── mindsplatter_replay_gen.cpp  Golden-corpus generator of record (emits tests/mindsplatter_replay_corpus.h)
│   ├── mindsplatter_replay_main.cpp  Replay comparator over that corpus (its fixtures live under tests/)
│   ├── docs_check.py           Markdown fence/link/anchor/path validator (CI)
│   ├── docs_images.py          Resolves every documented `<img>`; `--stage` copies them into the Doxygen output (CI)
│   ├── license_check.py        Checks every tracked C/C++ source against the terms LICENSE grants it (CI)
│   └── *_tests/                Host unit tests for the gate, build + git hooks, profile parser, bakes, build pins, docs and license checks
├── docs/                       subsystems.md and effects.md — README sections 7 and 9 — plus design specs, perf ledgers, and the docs/screenshots/ gallery
├── Doxyfile                    Doxygen config for the published API reference
├── package.json                npm entry points for the scripts/*.mjs tools (ESM; Node ≥ 22, CI pinned via tools/build_pins.py)
├── package-lock.json           Pinned dependency set behind those entry points
├── requirements/               Dependabot-visible Python toolchain pins used by CI (`*.in` sources, `*.txt` hash locks from `pip-compile --generate-hashes`)
├── .clang-format               LLVM-derived C++ style; CI enforces it with clang-format 22
├── ruff.toml                   Python lint rules (defect classes only, no formatter) — the ci.yml lint job
├── eslint.config.mjs           JavaScript lint rules for scripts/*.mjs (recommended set) — the same job
├── .githooks/                  Fast staged-file pre-commit checks and a reference-transaction guard keeping master fast-forward-only
├── .github/dependabot.yml      Monthly grouped bump pull request for the SHA-pinned actions in those workflows
├── .github/workflows/          ci.yml (native, WASM, format, Teensy, provenance), docs.yml (Doxygen → Pages)
├── .github/actions/            Composite steps both workflows run: pinned-doxygen (Doxygen install + theme)
├── LICENSE                     PolyForm Noncommercial 1.0.0 (engine); effects/, workbench/ and core/engine/effects_legacy.h reserved
├── CONTRIBUTING.md             Landing model, gates, and the tool pins a contributor has to match
└── justfile                    Task runner: `just build` / `test` / `smoke` / `docs` / `install` (`just --list` for the rest)
```

### daydream (web simulator)

<!-- docs-check: tree daydream exhaustive -->
```
├── index.html                  Main simulator page
├── favicon.svg                 Sphere-mark favicon for the simulator pages
├── site_manifest.txt           Repo-relative path list deploy.yml publishes to Pages
├── LICENSE                     PolyForm Noncommercial 1.0.0 (engine); effects reserved
├── vendor-importmap.js         CDN-by-default importmap helper, local opt-in
├── holosphere_wasm.js          Installed from Holosphere's WASM build
├── holosphere_wasm.wasm        Installed from Holosphere's WASM build
├── holosphere_wasm.sha         Engine commit + tree state the module was built from
├── holosphere_wasm.wasm.sha256 `sha256sum -c` manifest over the installed .wasm and .js — verified by the deploy gate
├── holosphere_wasm.toolchain   emsdk + clang versions and the build configuration that produced the module
├── holosphere_wasm.d.ts        Hand-written declarations for the installed glue — what the typecheck sees
├── file_system_access.d.ts     Save-picker declarations lib.dom omits, for recorder.js's streaming sink
├── pov_segment_map.json        Firmware segment→canvas golden, installed from Holosphere — read by the segment cross-check
├── README.md                   Installed from Holosphere (this file)
├── docs/screenshots/           Installed from Holosphere
├── shader/                     Engine-installed documents/validator plus daydream-owned patterns/v1 and digest migration
│
├── main.js                     index.html's entry module: starts the simulator, once
├── bootstrap.js                Dynamic-import boot of daydream.js + failure overlay
├── daydream.js                 App entry: WASM loader, state wiring, GUI/sidebar
├── app_lifecycle.js            Composition-root frame adapter, Test All ticker,
│                                  module-load deadline, and teardown
├── engine_host.js              Owns the main-thread WASM engine + its reassignable display state
├── apply_notice.js             Shared notice element, owner-keyed so a clear lands only for its holder
├── display_aliases.js          The display-buffer aliases every renderer writes through, healed together
├── segment_policy.js           Segmented spawn epoch plus the single-engine fallback a failed spawn runs
├── effect_gui.js               Effect panel lifecycle: build, mount, value sync, Export, teardown
├── shader_stages.js            DOM-free shader stage taxonomy: schema detection, stage assignment, control labels
├── legacy_shader_import.js     ShaderWorkbench URL/save-state migration importer
├── effect_sequencing.js        DOM-free effect/resolution apply-order and resolution-preset rules
├── param_sync.js               DOM-free param-stream rules: slider adopt/coerce and skew guards
├── pixel_view.js               DOM-free zero-copy pixel-view detach/re-fetch contract
├── frame_constants.js          Simulation FPS and the slow-frame threshold derived from it
├── driver.js                   Three.js scene: sphere mesh, dots, OrbitControls,
│                                  axes overlay, picture-in-picture camera, resize
├── geometry.js                 Sphere-pixel position math (pixelToSpherical, etc.)
├── state.js                    AppState (pub/sub) + URLSync (query-string mirror)
├── gui.js                      lil-gui wrapper used by the main page and tools
├── sidebar.js                  Effect list + sort + keyboard navigation
├── sidebar_logic.js            DOM-free sidebar sort, keyboard-index and scroll-arrow math
├── recorder.js                 MediaRecorder pipeline (mp4 / webm), sim-synced
├── recording_settings.js       Recording settings the GUI binds before the recorder exists
├── pole_lod.js                 Pole LOD binding, held until the engine the module load builds exists
├── global_stats_view.js        Single-engine stats bar: frame draw duration and per-arena usage
├── module_warmer.js            Epoch-fenced shared-WASM compilation and warm-cache state
├── segment_controller.js       Orchestrates the segmented-POV worker pool:
│                                  dispatch, generation fence, and compositing
├── segment_worker.js           Web Worker that hosts one WASM instance per
│                                  Phantasm hardware segment (parallel render)
├── segment_layout.js           Pure segment-layout math (Node-unit-testable, no WASM/Worker)
├── segment_stats_view.js       Per-segment timing/arena stats overlay + spawn and fault states
├── worker_protocol.js          JSDoc @typedef contract plus the runtime protocol version
├── styles/                     CSS for the main page and tools
│
├── tools/                      Standalone design tools (own HTML pages)
│   ├── lissajous.html          Spherical Lissajous curve designer
│   ├── mobius.html             Möbius transformation visualizer
│   ├── mobius.css              Möbius page layout and control styling
│   ├── palettes.html           Procedural palette tuner
│   ├── palettes.css            Palette page layout and control styling
│   ├── shader.html             Pullback Shader authoring workbench
│   ├── shader.css              Shader workbench layout and control styling
│   ├── shader_documents.js     Document loading, validation, matching, and engine application
│   ├── shader_deeplink.js       Encodes and restores the workbench's complete state in the page URL
│   ├── chain_apply.js          Applies a compiled chain document: setShaderChain, then the preset values
│   ├── chain_document_store.js v2 chain document store: span replacement, legality, reconciliation, undo
│   ├── chain_strip.js          Pipeline strip: the chain as stage chips banded by carrier
│   ├── solids.html             Conway operator playground (uses MeshOps bridge)
│   ├── solids.css              Solids page layout and control styling
│   ├── shared.js               Three.js scene boilerplate for the 3D tool pages
│   ├── banner.js               Dependency-free page + fatal-error banners (no Three.js)
│   ├── clipboard.js            Dependency-free copy-to-clipboard helpers
│   ├── copy_text.js            Clipboard API write with a textarea fallback, wrapped by clipboard.js
│   ├── slider.js               Labelled range-slider factory with a live readout
│   ├── color.js                sRGB ↔ linear math mirroring the engine's transfer function
│   ├── cpp_format.js           C++ float-literal formatter shared by the code generators
│   ├── download_file.js        Blob download through a transient anchor click, shared by the tools' export actions
│   ├── engine_halt.js          Shared halted-engine predicate: the HS_MODULE_DEAD flag or a WebAssembly trap
│   ├── export_params.js        Formatter behind the GUI's Export action
│   ├── flyout.js               Button-controlled flyout with outside-click and Escape dismissal
│   ├── kb_format.js            Dependency-free kilobyte formatter shared by the stat readouts
│   ├── lissajous_math.js       Pure Lissajous curve math from lissajous.html
│   ├── lissajous_page.js       Page module extracted from lissajous.html's inline script
│   ├── mobius_page.js          Controller for the Möbius tool page
│   ├── mobius_transforms.js    Pure Möbius coefficient presets from mobius.html
│   ├── page_lifecycle.js       Animation-frame recompute coalescer + bfcache-aware teardown hook
│   ├── pointer_drag.js         Pointer-drag lifecycle shared by standalone tools
│   ├── palette_canvas.js       Gradient-strip and RGB-wave canvas painters for palettes.html
│   ├── palette_controls.js     DOM-free zoom history and locked-slider delta capping for palettes.html
│   ├── palette_math.js         ProceduralPalette / GenerativePalette mirror + the PaletteOps bridge
│   ├── palette_wheel.js        Hue-key wheel raster, markers and pointer arithmetic for palettes.html
│   ├── palettes_page.js        Controller for the palette tuner page
│   ├── solid_build.js          Mesh construction and validation for solids.html
│   ├── solid_codegen.js        Op dispatch, codegen, and op-chain sequencing for solids.html
│   ├── solid_op_rows.js        DOM construction for one op-chain row of solids.html
│   ├── solid_registry_codegen.js  Registry-paste emitter: the solids.h Entry, OpStep table, Recipe, and (when solids.h declares none) the seed's SEED_* constant
│   ├── solid_render.js         Scene construction for solids.html: faces, vertices, edges, normals, index labels
│   ├── solids_page.js          Controller for the Conway operator tool page
│   ├── tailwind.css            Prebuilt utility classes the five tool pages use, served same-origin
│   └── tools.css               Shared design tokens and control styling for the tool pages
│
├── scripts/
│   ├── browser-smoke.mjs       Headless-Chrome smoke for every manifest-served page
│   ├── check-cdn-integrity.mjs Verifies the committed import map's jsDelivr subresource-integrity hashes
│   ├── probe_harness.mjs       Manifest server, browser, console/network collector and pointer helpers every probe runs on
│   ├── browser.mjs             Browser resolution (CHROME_PATH, else the standard Chrome locations) and the launch flags the headless scripts share
│   ├── generate-importmap.mjs  Bakes the local-vs-CDN decision into vendor-importmap.js
│   ├── generate-shader-v2-documents.mjs  Regenerates the v2 pattern documents and digest-migration table from the v1 fixtures
│   ├── record-module-loads.mjs NODE_OPTIONS shim recording loaded test modules
│   ├── require-tests.mjs       `pretest` guard against empty globs, unreachable tests, and shadow installs
│   ├── serve-manifest.mjs      Local static server constrained to the published site manifest
│   ├── vendor-stage.mjs        Hard-links the manifest set into a scratch tree served with a node_modules import map, for the headless gate
│   ├── verify-ci-green.mjs     Verifies every CI job is covered by the required aggregate check
│   ├── workbench-probe.mjs     Headless pointer-level probe of the shader workbench's pipeline strip; run it for any tools/ UI change
│   ├── panel-probe.mjs         Headless probe of the effect panel's real scroll clamping and scroll restore across a rebuild
│   ├── solids-probe.mjs        Headless pointer-level probe of the solids page's op-chain row reordering
│   ├── palettes-probe.mjs      Headless pointer-level probe of the palette page's strip zoom and hue-key wheel
│   ├── mobius-probe.mjs        Headless pointer-level probe of the Möbius page's complex-plane pads
│   ├── lissajous-probe.mjs     Headless pointer-level probe of the Lissajous page's rational frequency lock and the domain it drives
│   └── run-tests.mjs           `test` script: runs the suite and checks first-party module reachability
│
├── tests/                      Node unit tests (`npm test`)
├── requirements/               Hash-locked ShellCheck toolchain used by CI
├── tsconfig.json               checkJs settings for the worker-protocol module set
├── eslint.config.mjs           JavaScript lint rules (recommended set) — the js-unit-suite.yml lint step
├── .githooks/                  staged pre-commit checks, a pre-push mirror of the JS/browser suites, and the master fast-forward guard
├── .github/workflows/          ci.yml (PR aggregate), deploy.yml (engine gate → Pages), js-unit-suite.yml + browser-smoke.yml (reusable suites)
├── .github/dependabot.yml      Monthly grouped bump pull requests for the SHA-pinned actions and the locked Node dependencies
│
├── three.js/                   Optional vendored Three.js checkout
├── vendor/                     Optional self-hosted fonts (CDN fallback)
├── node_modules/lil-gui/       Optional local lil-gui (npm install)
├── package.json
├── package-lock.json           Committed dependency pin (the optional trees above are gitignored)
├── .gitattributes              Text and generated-binary attribute rules
└── .gitignore                  Local dependency, build, and installed-engine exclusions
```

[`vendor-importmap.js`](https://github.com/woundedlion/daydream/blob/master/vendor-importmap.js) resolves libraries from jsdelivr, which is the committed default the Pages deploy and a fresh checkout serve; `npm run importmap:local` switches it to the vendored copies for offline dev. See [§10.8](#108-vendor-importmap-cdn-by-default--local-opt-in).

---

## 4. Architecture Overview

Three build targets share a common engine:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            C++ Codebase                                 │
│                                                                         │
│  ┌──────────────┐   ┌──────────────────────────────────────────────┐    │
│  │   targets/   │   │          core/  (Rendering Engine)           │    │
│  │              │   │                                              │    │
│  │ Holosphere/  │   │  Effects → Canvas → Filter Pipeline          │    │
│  │  .ino        │   │      → SDF/Plot → Pixel Buffer               │    │
│  │              │   │                                              │    │
│  │ Phantasm/    │   │  effects/  (41 visual algorithms)            │    │
│  │  .ino        │   │                                              │    │
│  │              │   ├──────────────────────────────────────────────┤    │
│  │ wasm/        │   │          hardware/  (Drivers)                │    │
│  │  wasm.cpp   │   │  pov_single.h — single-Teensy POV            │    │
│  │              │   │  pov_segmented.h — multi-Teensy segmented POV │    │
│  │              │   │  dma_led.h — HD107S DMA SPI pipeline          │    │
│  └──────┬───────┘   └──────────────────────────────────────────────┘    │
│         │                              ↑                                │
└─────────┼──────────────────────────────┼────────────────────────────────┘
          │                              │
   ┌──────┴──────┐              ┌────────┴────────┐
   │  Teensy 4.x │              │   Emscripten    │
   │  ISR + DMA  │              │   WASM build    │
   │  480 RPM    │              │                 │
   └──────┬──────┘              └────────┬────────┘
    Physical LED strip            daydream/
    (Holosphere/Phantasm)         Three.js + WASM
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
| `hs::log()` | `Serial.println()` | `vprintf`/`printf` |
| `hs::millis()` | `::millis()` | `std::chrono` |
| `hs::rand_f()` | `Pcg32(1337)` | `Pcg32(1337)` |
| `hs::disable_interrupts()` | `noInterrupts()` | No-op |
| `CRGB`, `CHSV` | FastLED types | Struct mocks |

The host-side mock implementations — the `CRGB`/`CHSV` structs plus the rest of the emulated Arduino/FastLED surface (`random8`, `beatsin8`, `SerialMock`, …) — live in `platform/arduino_mocks.h`, included from `platform.h`'s non-Arduino branch.

---

## 5. Data Flow: Frame Lifecycle

### Hardware Path

```
Main Loop (draw_frame)                    ISR (show_col, fires every N µs)
─────────────────────────────────         ─────────────────────────────────
                                          Timer fires at column interval
POVDisplay<S,RPM>::show<Effect>()
  IntervalTimer::begin(show_col, interval)

  effect->draw_frame():
    Canvas canvas(*effect)               ISR reads from bufs[prev]
      ↓ advance_buffer()                 for y in 0..S/2:
      ↓ (copies prev if persist_pixels)    leds[S/2 - y - 1] = get_pixel(x, y)
      ↓                                    leds[S/2 + y]     = get_pixel(x±W/2, y)
    [effect renders to bufs[cur]]
      ↓                                  FastLED.show()
    ~Canvas():                           if strobe_columns(): FastLED.showColor(black)
      queue_frame()                      x = (x+1) % width
      ↓ next = cur (interrupt-safe)      if x==0 || x==width/2:
                                           advance_display()  (prev = next)
                                           [new frame begins displaying]
```

Three `std::atomic<int>` indices manage the double buffer:

| Index | Role |
|---|---|
| `cur` | Which buffer the main loop is currently writing |
| `next` | The last completed frame (queued by `queue_frame()`) |
| `prev` | The frame the ISR is currently reading |

The ISR never touches `cur`. The main loop atomically updates `next` inside `queue_frame()` with interrupts disabled. `advance_display()` is called by the ISR at every half-revolution to flip `prev` to `next`.

The two framebuffers are placed in Teensy DMAMEM (OCRAM) for capacity — at `MAX_W * MAX_H` 16-bit pixels they are far too large for the tightly-coupled DTCM that holds the stack and hot data. They are software render targets, read by the ISR and packed into the LED controller's protocol frame; they are never DMA'd themselves (the eDMA TX buffer is `HD107SFrame::buffer`, in the controller, which is the buffer that actually clocks out over SPI):

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
       → bound as the instanced dot-mesh's `instanceColor` attribute, declared
         `normalized` so the GPU scales 0–65535 → 0–1 (no JS-side divide)
       → WebGL renderer
```

---

## 6. The Rendering Pipeline

### End-to-End Flow

A typical effect frame follows a four-stage pipeline. Not every effect uses every stage — some skip generation entirely, others skip transformations, and full-screen shader effects such as the composed pullback roster and Raymarch extend `Effect` directly and bypass the filter pipeline altogether — but the available primitives compose along this flow:

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Generate   │     │  Transform   │     │  Rasterize   │     │   Filter     │
│             │ ──▸ │              │ ──▸ │              │ ──▸ │   Pipeline   │
│ geometry.h  │     │transformer.h │     │ sdf.h/scan.h │     │  filter.h    │
│ solids.h    │     │              │     │ plot.h       │     │              │
│ memory.h    │     │              │     │              │     │              │
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘

  Solids::get()      MeshOps::transform    Scan::Mesh::draw     Pipeline<W,H,
  MeshOps::hankin    RippleTransformer      Scan::Ring::draw       Orient,
  generate(arena,fn) NoiseTransformer       Plot::Multiline        AntiAlias,
  ParticleSystem     OrientTransformer      Scan::Shader::draw     Feedback>
```

**Generate**: Create or update geometry — mesh from the solids registry, Hankin pattern compilation, Fibonacci lattice for reaction-diffusion, or particle positions from physics. The `generate()` wrapper manages arena lifecycle.

**Transform**: Deform geometry in world space — ripple wavelets, noise displacement, Möbius warps, quaternion rotation. `MeshOps::transform()` chains transformers: `transform(input, output, arena, ripple, orient)`.

**Rasterize**: Convert geometry to pixels. Two families:
- **SDF path** (`sdf.h` → `scan.h`): analytic shapes with scanline intervals and `quintic_kernel` anti-aliasing
- **Plot path** (`plot.h`): line/curve rasterization with adaptive step size from full 2-D screen-velocity tracking for uniform sampling
- **Shader path** (`Scan::Shader`): full-screen per-pixel evaluation with optional SSAA

**Filter**: The `Pipeline<W, H, Filters...>` variadic template processes each plotted point through a chain of filter stages before it reaches the canvas.

### Pipeline Domain Transitions

The filter pipeline operates across three stage domains. Each filter declares its domain; the pipeline converts world to screen coordinates at compile time and orders the stages by domain:

```
          World Space                Screen Space             Pixel Space
     (3D unit-sphere vectors)     (fractional x, y)      (fractional x, y)
    ┌──────────────────────┐    ┌─────────────────┐    ┌─────────────────┐
    │ World::Orient        │    │ Screen::AntiAlias│    │ Pixel::Feedback │
    │ World::Trails        │──▸ │ Screen::Blur     │──▸ │ Pixel::Chromatic│
    │ World::Replicate     │    │ Screen::Trails   │    │   Shift         │
    │ World::Mobius        │    │                  │    │                 │
    │ World::Hole          │    │                  │    │                 │
    └──────────────────────┘    └─────────────────┘    └─────────────────┘
    Coordinate: Vector(x,y,z)   Coordinate: float x,y   Coordinate: float x,y

         vector_to_pixel() ──▸       (no conversion) ──▸
    ◂── pixel_to_vector()
```

**World → Screen**: `vector_to_pixel()` projects a 3D unit-sphere vector to fractional pixel coordinates near `(theta / 2π * W, phi / π * H)`, deriving `theta`/`phi` with the approximate `fast_atan2`/`fast_acos`. The approximation makes the projection sub-pixel inexact, so `vector → pixel → vector` does not exactly invert the exact-trig `pixel_to_vector()`.

**Screen → Pixel**: no coordinate conversion — a `Pixel::` stage takes the same `float x, y` a `Screen::` stage does, and the stage's `domain_rank` only fixes its position in the chain. What lands the coordinate on pixel centers is `AntiAlias`, which distributes it to its 4 nearest integer pixels as a `quintic_kernel`-eased 2×2 splat.

**Pixel → Canvas**: The base `Pipeline<W,H>` (the identity terminal) rounds the coordinate to the nearest pixel, wraps the column into `[0, W)`, and composites the final color into `canvas(x, y)` with straight-alpha (`src * α + dst * (1-α)`) in linear light.

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

The clear covers only the current display clip unless a filter declares
`reads_outside_band`. Rendering a full frame and sampling old framebuffer
contents outside the band are separate properties: `World::Trails` needs the
former, while `Pixel::Feedback` needs both. The margin-expanded render band is
otherwise write-only scratch; its width comes from the pipeline's
`total_segment_margin` sum of each filter's `segment_margin` (how far the
stage's output lands from the plotted position), floored at 1. Filtered effects
derive all three from their pipelines.

`canvas(x, y)` is a direct array subscript into the write buffer (`bufs[cur][y * width + x]`). No bounds checking, no virtual dispatch.

### The Filter Pipeline

The **filter pipeline** is a variadic template that chains filter stages:

```cpp
Pipeline<W, H,
    Filter::World::Trails<MAX_ITEMS>,   // 3D world-space trail decay
    Filter::World::Orient,              // quaternion rotation + motion blur
    Filter::Screen::AntiAlias<W, H>        // quintic-eased 2×2 splat AA
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

The tables below are the library surface, deliberately wider than the set of stages the shipping effects instantiate; a stage with no current user is composable inventory, not dead code.

#### World-Space Filters

| Filter | Effect |
|---|---|
| `World::Orient` | Rotates every incoming 3D point by the current `Orientation` quaternion. Uses the orientation history to distribute motion-blur age values across a SLERP-interpolated sweep. |
| `World::Trails<Capacity>` | Stores world-space points in an arena-allocated ring buffer with a TTL countdown. On `flush()`, re-draws aged points through a `WorldTrailFn` color function. Trail items are quantized to 8 bytes each (int16 xyz + uint8 TTL); once saturated, compaction means eviction may select a point of arbitrary age. |
| `World::Replicate<W>` | Clones geometry N times around the Y-axis by re-plotting each point rotated by `2π/N`. |
| `World::VertexReplicate<N>` | Replicates geometry onto the N vertices of a solid by precomputing rotation quaternions from vertex[0] to each other vertex. |
| `World::Mobius` | Applies a Möbius transformation via stereographic projection: sphere → complex plane → Möbius(z) → back to sphere. |
| `World::Hole` | Masks out a spherical cap by attenuating points within a radius via quintic falloff. Its origin and radius can be retuned at runtime. |
| `World::OrientSlice` | Selects from a list of orientations based on each point's projection along an axis — enables per-hemisphere rotation effects. |

#### Screen-Space Filters

| Filter | Effect |
|---|---|
| `Screen::AntiAlias<W,H>` | Distributes a sub-pixel coordinate to its 4 nearest integer pixels as a `quintic_kernel`-eased 2×2 splat, applied uniformly on both axes in framebuffer space — no `sin(φ)` density compensation, because anti-aliasing is a property of the pixel grid, not of where the columns map on the sphere. |
| `Screen::Blur<W, H>` | Applies a parameterized 3×3 Gaussian convolution kernel at plot time. |
| `Screen::Trails<MAX_PIXELS>` | Screen-space variant of trail decay; stores 2D coordinates with TTL and redraws via a trail color function. Uses arena-allocated storage (`MAX_PIXELS` capacity, default 1024); once saturated, compaction means eviction may select a point of arbitrary age. |
| `Screen::DirectAntiAliasSink<W, H>` | Terminal stand-in for `Pipeline<W, H, AntiAlias<W, H>>` when no downstream filter is needed: the same four-tap splat and q16 source-over blend, written straight into the framebuffer with row, column and clip resolution hoisted out of the per-sample path. Call `prepare(canvas)` once per frame before the first plot — it caches the framebuffer base and the clip's visible row/column masks. |

#### Pixel-Space Filters

| Filter | Effect |
|---|---|
| `Pixel::Feedback<W, H>` | Style-driven full-screen feedback loop. It is a *replacing* terminal, so a pipeline containing it exposes neither `plot()` nor `flush(Canvas&, float)`: the effect calls `filters.begin_frame(canvas, alpha)` once at the top of the frame and plots the frame through the `PreparedTerminalFrame&` it returns. `begin_frame()` runs the feedback pass first — at `alpha >= 1` it writes every pixel, so plotting before it would be erased — and the state it returns has no flush of its own, so the pass cannot be re-run mid-frame. That pass iterates the full canvas, samples the previous frame from the Canvas front buffer with bilinear interpolation, applies the bound `Feedback::Style`'s spatial transform and color transform with fade, then blends into the back buffer. Frames come from Canvas double-buffering, so the filter holds no frame storage of its own, but it does keep a persistent warp cache: call `init_storage(Arena&)` from the effect's `init()` to reserve `STORAGE_BYTES` from the persistent arena — without it every frame rebuilds the whole control field. The spatial transform is evaluated on a spherical control lattice — latitude rings spaced `DS = style.downsample` rows apart, each carrying a `sin(φ)`-scaled sample count (`W/DS` at the equator) — except in the pole infill bands, the first `DS` rows and the last `max(DS - H_OFFSET, 0)`, which take one ring per row at the full `W/DS` count; ring count, `sample_count()` and `STORAGE_BYTES` therefore all sit above what a flat `(W/DS)×(H/DS)` grid would need. The lattice is then expanded by longitude interpolation into a `W/DS`-column offset field, one row per ring, and bilinearly upsampled while compositing. See `Feedback::Style` below for preset selection. |
| `Pixel::ChromaticShift<W, Spread>` | Emits four taps to simulate chromatic aberration: the unmodified source pixel at its sub-pixel `x`, plus single-channel R, G and B copies offset by `Spread`, `2*Spread` and `3*Spread` columns (`Spread` defaults to 1). Roughly doubles emitted energy — the source tap is kept, not replaced. The three fringe taps are snapped to the rounded integer column while the source tap keeps its sub-pixel `x`. The fringe subtends `3*Spread/W` of a turn, so raising `Spread` with `W` holds its angular width across resolutions. Requires `W > 3*Spread`. |

#### Feedback Styles (`styles.h`)

`Feedback::Style` bundles spatial transform, color transform, and scalar parameters into a single POD-copyable struct with named presets. `Filter::Pixel::Feedback<W,H>` (see Pixel-Space Filters above) takes a `Style&` directly — no template parameters for transform types, no adapter boilerplate.

```cpp
// Declare a style member and use it in the pipeline:
Feedback::Style style = Feedback::Style::Smoke();
Pipeline<W, H, Filter::World::Orient, Filter::Screen::AntiAlias<W, H>,
         Filter::Pixel::Feedback<W, H>> filters(
    ..., Filter::Pixel::Feedback<W, H>(style));
```

The Filter auto-syncs from the Style every frame — when the Style lerps between presets, the function pointers snap at the midpoint while scalars interpolate smoothly.

| Preset | Description |
|---|---|
| `Style::ArcingLightning()` | Branching, fast-moving distortion with pronounced hue rotation. |
| `Style::SlowFire()` | Broad, slowly evolving turbulence with gentle color drift. |
| `Style::EnergeticFire()` | Broad, quickly evolving turbulence with gentle color drift. |
| `Style::Smoke()` | Gentle drifting haze with slow noise. Classic smoke look. |
| `Style::SlowDust()` | Fine, slowly drifting turbulence with gentle color rotation. |
| `Style::WavyTrails()` | Fine, rapidly moving distortion with pronounced color trails. |
| `Style::MeltingHi()` | Higher-amplitude downward melt with slow drift and pronounced hue rotation. |
| `Style::MeltingLo()` | Lower-amplitude downward melt with slow drift and pronounced hue rotation. |
| `Style::Miasma()` | Drifting toxic haze — medium turbulence with slow drift and strong per-frame hue cycling. |
| `Style::LooseWormhole()` | Static high-amplitude twist over a medium scale — a loose swirling tunnel, no drift. |
| `Style::TightWormhole()` | Static high-amplitude twist over a tight scale — a tight swirling tunnel, no drift. |
| `Style::WigglingWormhole()` | Static twist over a broad scale — a wide wormhole with wandering arms, no drift. |

Available transform functions:

| Space Transform | Description |
|---|---|
| `Feedback::noise_warp` (default) | 3D simplex noise distortion via `noise_transform()` |
| `Feedback::melt_warp` | Downward melt — slerps samples toward the north pole (image drips south) plus noise wobble |

| Color Transform | Description |
|---|---|
| `Feedback::hue_fade` (default) | Multiplies by fade, then rotates hue by `style.hue_shift * -log(style.fade)` per frame. `hue_shift` is the rotation per e-fold decrease in feedback brightness, so equal brightness levels have equal hues at any fade. |

Custom presets can use any function matching the `Feedback::SpaceFn` / `Feedback::ColorFn` signatures.

#### Combining Filters

Filters compose freely. The order matters — world-space filters must precede screen-space filters if both are present. Some common combinations:

```cpp
// Rotating geometry with anti-aliasing
Pipeline<W, H, Filter::World::Orient, Filter::Screen::AntiAlias<W, H>>

// Particle trails in world space with orientation
Pipeline<W, H,
    Filter::World::Trails<50000>,
    Filter::World::Orient,
    Filter::Screen::AntiAlias<W, H>>

// Orientation + anti-aliasing + feedback with Smoke style
Pipeline<W, H,
    Filter::World::Orient,
    Filter::Screen::AntiAlias<W, H>,
    Filter::Pixel::Feedback<W, H>>
```

---

## 7. Core Subsystems

The shader interface, the SDF/scan and curve rasterizers, the animation system, geometry transformers, the arena allocator, the color system, the mesh system, generators, the preset system and the hardware drivers — including the 1-wire frame-sync datasheet — are documented in [`docs/subsystems.md`](https://github.com/woundedlion/pov/blob/master/docs/subsystems.md).

---

## 8. The Effect System

Every visual effect inherits from `Effect`:

```cpp
template <int W, int H>
class MyEffect : public Effect {
public:
    MyEffect() : Effect(W, H, {.strobe = true}), filters(...) {}

    void init() override {
        register_param("Speed", &speed, 0.0f, 10.0f);
    }

    void draw_frame() override {
        Canvas canvas(*this);       // acquire write buffer
        timeline.step(canvas);      // advance all animations
        // ... custom rendering ...
    }

private:
    Pipeline<W, H, ...> filters;
    Orientation<16> orientation;   // CAP is the sub-frame capacity, not the display width
    Timeline timeline;
    float speed = 1.0f;
};

REGISTER_EFFECT(MyEffect)
```

### Self-Registering Factory (`control/registry.h`)

Effects register themselves into a global registry using the `REGISTER_EFFECT(ClassName)` macro placed at the bottom of each effect header. This uses a static initializer pattern — each effect creates a small registrar struct whose static member calls `EffectRegistry::add()` during program initialization, eliminating the need for a hand-maintained factory array. The registry stores resolution-specific fill functions for each supported `<W,H>` pair (96×20 and 288×144).

### Parameter Registration

Effects expose live-adjustable parameters through the float `register_param()`, integer `register_int_param()`, typed-enum overloads, and runtime `enum8` registration (`control/param_host.h`). These are reflected into the WASM bridge and auto-generate GUI controls in the simulator:

```cpp
register_param("Twist",   &params.twist, -5.0f, 5.0f);        // float slider (min, max)
register_param("Enabled", &params.enabled);                   // boolean toggle (bool* overload takes no range)
register_param("Shape",   &params.shape, SHAPE_NAMES, 4);     // dropdown; float* index over [0, count-1]
register_animated_param("Speed", &params.speed, 0.0f, 2.0f);  // animation-driven slider
register_readonly_param("Particles", &params.active_count, 0.0f, 1024.0f);  // engine-written telemetry
```

The enum overload takes an array of option labels that must outlive the effect (string literals). `register_animated_param` marks the param as written by the animation system, so the GUI renders it as an auto-pausing slider that engages "Pause Animation" when touched; `register_readonly_param` marks it engine-written, so the GUI shows the live value but disables editing. The readonly flag can also be applied to an already-registered param via `mark_readonly(name)`, and `mark_global(name)` marks an already-registered param a global control rather than part of the effect's look, clearing the `preset` flag so preset exports skip it.

The parameter list (`ParamList`) is accessible via `getParameters()`, and `updateParameter(name, float)` sets values at runtime. Its default storage is a fixed `std::array<ParamDef, 32>`; an effect needing more calls `use_parameter_storage()` to swap in an arena-allocated array, as the Shader workbench does at 80 (both are fixed-capacity — the no-realloc memory-view invariant the WASM bridge depends on). Each `ParamDef` holds a plain `void *` target tagged by a `TargetType`: `FLOAT`, `BOOL`, or one of six integer widths (`INT_I8`/`INT_U8`/`INT_I16`/`INT_U16`/`INT_I32`/`INT_U32`). Every write arrives as a float and is converted on store, with automatic bool threshold at 0.5. The animation system can also write to these parameters, allowing effects to animate their own exposed controls.

### The `EffectConfig` Flags

An effect passes construction-time settings to its base as `Effect(W, H, {.strobe = ..., .persist = ...})`. `EffectConfig` (`core/render/canvas.h`) holds five members: four bools — `strobe`, `persist`, `full_frame`, `reads_outside_band` — all defaulting to false, and `int margin`, which defaults to the `ClipRegion` default of 1 rather than 0.

With `{.persist = true}`, `Canvas` copies the previous frame's buffer into the new write buffer before rendering, enabling trail/decay effects without explicit trail storage — each frame partially overwrites the last. When false (the default), the buffer is zeroed each frame. `.strobe` drives the POV column strobe (`strobe_columns()`) and `.full_frame` forces full-canvas rendering under segmented drivers (`needs_full_frame()`). `.reads_outside_band` declares that the effect samples framebuffer pixels outside the display band, so `Canvas` clears the whole buffer instead of just the display clip. `.margin` is the render-bound expansion past the display edges in pixels (`ClipRegion::margin`), raised to the `ClipRegion` default when a lower value is passed.

`pipeline_config<PipelineT>(base)` folds a filter pipeline's compile-time segment traits into the last three, so an effect stacking a filter that crosses segment boundaries, samples outside the band, or lands taps away from the plotted position need not restate those requirements at its base initializer. All three fold as "at least this much": the pipeline widens them and never clears what the effect asked for.

### Fenced Effect-to-Effect Transition (`control/transition.h`)

**Reserved surface — no shipping consumer.** `EffectTransitionController` sequences one effect out and the next one in behind a display fence, so no frame ever shows a half-built effect: fade the output to dark, publish and wait out a clear frame, destroy the outgoing effect, construct the incoming one and render its first frame while the envelope is still 0, wait out that hidden frame, commit the identity, then fade back in. Any failure while constructing or preparing the incoming effect destroys it and rolls back through the outgoing effect's restore token; a rollback that itself fails, or one whose token declares no restorable state, lands in `CLEAR_FAILSAFE` — dark output, nothing installed — which only a fresh `request()` leaves. The controller holds no effect and renders nothing: `request()` arms a destination and each `tick()` advances through immediately available edges until it reaches an external wait.

Every host-side operation the graph needs is a pure virtual on `EffectTransitionAdapter` — envelope, presentation fence, construct/destroy, handoff import, frame prepare/publish, identity commit, restore and fail-safe. The engine ships no implementation of it: today's effect swaps are unfenced, and the only adapter in the tree is the recording fixture in `tests/test_canvas.h` that drives every edge and failure branch. The header is kept as the design of record for a fenced swap, not as live machinery.

---

## 9. Effects Reference

Every effect — screenshot, description and parameter list — plus the shader authoring workbench and the legacy roster is documented in [`docs/effects.md`](https://github.com/woundedlion/pov/blob/master/docs/effects.md).

The compile-time roster and tests carry 41 firmware-capable effects. Native and WASM builds add two simulator-only registry entries, the `Shader` workbench and the `ShaderChain` chain interpreter, for 43. The simulator sidebar exposes 37 effects at 288×144 and 36 at 96×20 (§10.5); both stay out of the card lists because they open through the standalone tool. The Phantasm firmware playlist (`HS_PHANTASM_EFFECT_LIST` in `targets/Phantasm/phantasm_playlist.h`) contains 38 effects, including all eighteen promoted composed effects and excluding the three Holosphere-96×20-only effects: Dynamo, MobiusRings, and Thrusters. Each entry carries its own on-air duration, from 38 s to 240 s across the 38-entry roster. Full-cycle Teensy measurements for that playlist are indexed in the [on-device effect profiles](https://github.com/woundedlion/pov/blob/master/docs/profiles/README.md).

---

## 10. The Web Simulator (Daydream)

The [`daydream`](https://github.com/woundedlion/daydream) repo is a static web app that wraps the WASM build from this repo in a Three.js scene. The C++ rendering engine is unchanged — the same effect classes, the same arenas, the same per-frame `Pixel[]` buffer. Daydream's job is to:

1. Drive the WASM engine one frame at a time at a fixed cadence.
2. Map each `(x, y, color)` pixel to a position on a 3D sphere and render it as an instanced dot mesh.
3. Provide a UI for switching effects, tuning parameters, sweeping resolutions, recording video, and exercising the segmented-POV multi-board mode.
4. Host five standalone design tools for interactive authoring, three of which drive engine facilities through WASM.

### 10.1 Process and Threading Model

```
Main thread                                Web Workers (segment mode only)
─────────────                              ──────────────────────────────
index.html → vendor-importmap.js           segment_worker.js × N
              ↓ (resolves three/lil-gui    each owns its own WASM instance
              ↓  to local or CDN)
            main.js (entry)                engine.setClip(x0,x1,y0,y1)
              └─ bootstrap.js              engine.drawFrame()  → pixel slice
                   ├─ failure overlay +    postMessage(Transfer pixels)
                   │  refreshModuleCache()
                   └─ import('./daydream.js')
                   ├─ createHolosphereModule()
                   ├─ Daydream (driver.js)
                   │    ├─ Three.WebGLRenderer
                   │    ├─ instanced dot mesh
                   │    ├─ OrbitControls
                   │    └─ PiP camera
                   ├─ AppState + URLSync
                   ├─ EffectSidebar
                   ├─ lil-gui (params + global)
                   └─ VideoRecorder (MediaRecorder)
```

`index.html` loads exactly one module, `main.js`, whose whole body is a call to `bootstrap.js`'s exported `bootstrap()`. Keeping the side effect in the entry module rather than in `bootstrap.js` itself is what lets `daydream.js` import the failure overlay without standing up a second simulator. `bootstrap()` dynamically imports `daydream.js` inside a `try`/`catch` — the only handler for a module-graph load failure. On failure it renders the error into the page's `loading-overlay` (as `role="alert"`, with a focused **Reload** button) and falls back to the shared fatal-error banner when no overlay exists. The Reload handler first runs `refreshModuleCache()`, which re-fetches every same-origin `.js` and `.wasm` the page has already loaded with `cache: 'reload'`. That is the remedy for the deploy-skew hazard: a plain browser reload only revalidates the top-level document, so modules cached from an earlier deploy stay stale and keep failing to link against freshly fetched importers — and the WASM binary is bound to its glue by content hash, so a stale binary against fresh glue is the canonical form of the skew.

A normal page load creates one WASM instance on the main thread. The dot mesh has one instance per LED pixel; the per-frame work is `instanceColor.needsUpdate = true` after the WASM buffer view is refreshed. When the user enables Segmented POV (§10.7), `daydream.js` spawns N Web Workers, each holding its own WASM instance — its own linear memory, arenas and effect state — so the four-Teensy Phantasm layout can be exercised in software. The *compilation* behind those instances is shared: the pool spawn hands every worker one `WebAssembly.Module` compiled once on the main thread (§10.7), and a `WebAssembly.Module` carries no state, so instances stay isolated. Only a worker that is handed no module fetches and compiles the binary itself.

### 10.2 The WASM Bridge

`wasm.cpp` compiles to `holosphere_wasm.js` + `.wasm` and exposes a single `HolosphereEngine` class. At most one instance may be live per module — its effect and arenas are shared module-global storage — so `delete()` the current engine before constructing another; the constructor traps otherwise. That trap is the bridge's one unrecoverable precondition, so a bootstrap that can run twice tests `HolosphereEngine.isLive()` first rather than constructing into it.

A trap is terminal for the whole module, not just for the call that tripped it. `HS_CHECK` ends in `__builtin_trap()`, which compiles to wasm `unreachable`; that unwinds nothing, so the shadow stack pointer keeps whatever the aborted frame left it at and every later call runs on a permanently shortened stack — the release link sets `-sASSERTIONS=0`, so the eventual write past its end is silent, and `drawFrame()` keeps handing back plausible frames until the module finally dies somewhere unrelated. Before trapping, the check sets `Module.HS_MODULE_DEAD`. A caller that wraps module calls in `try`/`catch` must read it and discard the instance — no call is a recovery path, `MeshOps.clearToolingMemory()` included.

| Method | Description |
|---|---|
| `setResolution(w, h)` → `ResolutionSetResult` | Switch active resolution (96×20 or 288×144). Returns `Module.ResolutionSetResult.RESIZED` when the switch took — tearing down the current effect, so `setEffect` and any clip must be re-applied — `ALREADY_ACTIVE` for a request matching the active resolution (a pure no-op; nothing is torn down), or `UNSUPPORTED` for a size the build cannot render (ignored, prior state kept). Compare against the enum values — never by truthiness |
| `setEffect(name)` → `EffectSetResult` | Instantiate a new effect by C++ class name or stable effect ID; `ShaderBall` and `ShaderWorkbench` both remain aliases for `Shader`. The call resets all arenas to defaults. Returns `Module.EffectSetResult.INSTALLED` on success, else the rejection reason (`UNKNOWN_EFFECT`, or `UNSUPPORTED_RESOLUTION` when the active resolution has no factory); a rejection keeps the prior effect alive. Compare against the enum values — never by truthiness |
| `drawFrame()` | Advance one frame and copy pixels to the output buffer |
| `setShaderChain(entries)` → `{code, entryIndex}` | Program the loaded `ShaderChain` effect with an ordered `[{instance, operator}]` array — the chain's shape and nothing else, no values and no family tags. Alone among the engine results this is a plain JS object, not an embind enum, so compare `code` against the strings: `"APPLIED"` on commit, else the refusal's `ChainStatus` name (`NOT_CHAIN_EFFECT`, `MALFORMED_PAYLOAD`, `TOO_LONG`, `UNKNOWN_OPERATOR`, `CARRIER_MISMATCH`, …), with `entryIndex` naming the offending entry and `-1` a whole-chain refusal. `APPLIED` has already rebuilt the parameter definitions (named `instance.field-id`) and bumped `getParamGeneration()` by the time it returns, so the caller applies preset values by name straight after. Every refusal is transactional — the previous program, its definitions, the generation, and all instance state are left exactly as they were |
| `getShaderChainCatalog()` → `string` | *(static)* The chain interpreter's operator catalog as one JSON string — budgets, carriers, and every operator-table entry. Budgets, carriers, operator ids and parameter schemas match the catalog the native suite pins as its golden, which is what keeps an editor's stage library from drifting from the operator table the engine actually resolves against. The per-operator block sizes are the building ABI's and are **not** byte-identical to that golden: this module emits wasm32 figures, where a pointer-bearing `prepared` block is 4-byte-aligned and narrower than the 8-byte-aligned LP64 figure the native golden carries (8 of the 39 operators differ). The wasm32 figures are the ones an editor budgets arena bytes against, and the ones this module's own runtime allocates from; `scripts/shader_workbench.test.mjs` holds the two spellings to differing in nothing else |
| `getPixels()` | Return a zero-copy `Uint16Array` view into WASM linear memory, spanning the active resolution's prefix of the fixed backing buffer |
| `getBufferLength()` → `int` | Length of the pixel buffer (`W × H × 3`) for sizing the view, and the staleness test for a cached one: a `setResolution` moves this length without detaching the outstanding view |
| `getEffectPresetCounts()` → `object` | Map from every effect name available at the active resolution to its preset count; returns an empty object when the resolution is unsupported or uninitialized |
| `setParameter(name, value)` → `ParamSetResult` | Update a live effect parameter; returns `Module.ParamSetResult.APPLIED` on success, else the rejection reason (`NO_EFFECT`, `UNKNOWN_PARAM`, `READONLY`, or `NON_FINITE`). Compare against the enum values — never by truthiness. An `APPLIED` float may still have been clamped to the param's `[min, max]`; read the effective value back via `getParamValues()`. An `APPLIED` write to an *animated* param also engages the animation pause (the animation would otherwise overwrite the value on the next frame), and that pause survives `setEffect` — check `getAnimationsPaused()` afterwards |
| `setAnimationsPaused(paused)` | Freeze/resume the current effect's authored animation drivers (the GUI "Pause Animation" toggle). `ShaderChain` has no authored preset animation, so its operator clocks and generated palette continue advancing while this state is set |
| `getAnimationsPaused()` → `bool` | Whether those drivers are currently frozen. The engine is the owner of this state — an `APPLIED` `setParameter` on an animated param engages the pause by itself — so read it back rather than mirroring the rule in JS |
| `getPresetCount()` → `uint32` | Number of presets the current effect exposes for manual navigation; `0` when no effect is set or the effect authored none, which is how a GUI decides whether to offer preset controls at all |
| `getPresetIndex()` → `uint32` | Index of the selected preset; `0` when no effect is set, so tell that apart with `getPresetCount() != 0`. An effect whose choreography advances its own presets moves this with no JS call, so poll it rather than tracking the index last written |
| `getPresetIds()` → `string[]` | Stable preset IDs in numeric navigation order. Composed-effect identities come from the WASM-only factory metadata, so this API adds no virtual method or firmware vtable cost |
| `selectPresetById(id)` → `bool` | Select a preset through its persisted identity and engage the animation pause like `selectPreset(index)`; `false` for an empty or unknown ID or an effect without stable preset metadata |
| `selectPreset(index)` → `bool` | Select a preset for manual navigation: applies it **and engages the animation pause**, exactly as `setAnimationsPaused(true)` would, so the preset's values are not overwritten by the animation on the next frame. `false` when no effect is set, the index is malformed (non-integral, NaN, negative) or out of range, or the effect refused the preset. The pause survives `setEffect`, so read it back via `getAnimationsPaused()`; parameter values move with the preset, so re-read `getParamValues()` |
| `synchronizePreset(index)` → `bool` | Select a preset **without touching the pause state** — the call for following engine-driven advancement, which `selectPreset` would freeze. A request for the already-active index is a success no-op; `false` when no effect is set, the index is malformed (non-integral, NaN, negative) or out of range, or the effect refused the preset |
| `nextPreset()` / `previousPreset()` → `bool` | Step one preset forward/back with wraparound, pausing animations like `selectPreset`; `false` when no effect is set, the effect has no presets, or it refused the preset |
| `setPoleLod(aggressiveness)` | Set near-pole azimuthal shading decimation (the GUI "Pole LOD" slider, `[0, 2]`); non-finite and negative inputs clamp to 0, and the value saturates at 8. The setting is a module-global of the WASM instance it is called on, and each worker loads its own instance — a segmented pool needs it re-sent to every worker (§10.7) |
| `getPoleLod()` → `float` | Current decimation aggressiveness |
| `getParameterDefinitions()` | Return the parameter list; each entry is `{name, value, requestedValue, acceptedValue, animated, readonly, preset}`, and float params additionally carry `{min, max}` (bool params omit `min`/`max` and return values as JS booleans). `value` is the displayed/rendered state and `requestedValue` is the writable target copied to another renderer. `acceptedValue` is the last value the effect admitted for rendering, which is the writable target for every effect except the Shader workbench, which vets slots and params as one configuration: there a refused request leaves `requestedValue` and `acceptedValue` apart, and the accepted one is what a segment worker or URL restore must replay. An entry whose requested value cannot safely render also carries an actionable `warning` string; other valid edits continue to apply while that value stays requested. Whole-number targets — enum and integer params — additionally carry `step: 1`, absent on a float one, so the GUI knows which controls admit only whole values. `preset` is a bool, `false` only for a param the effect excluded from preset exports (`mark_global`), so an export tool skips those alongside the readonly ones. Enum params (registered with option labels) also carry `options`, an array of label strings indexed by the param's value, which the GUI renders as a dropdown; an enum registered with export literals carries `exportOptions` as well — the C++ enum literals indexed the same way, which the export formatter emits in place of a numeric literal. `exportOptions` is absent on an enum registered without them, and on every non-enum param |
| `getParamValues()` | Return current parameter values (including animation-driven updates), as raw floats in definition order, as a zero-copy view over WASM linear memory on the same lifetime contract as `getPixels()`: consume it before the next call into the module, since heap growth detaches it. A bool param streams as `0.0`/`1.0` here even though `getParameterDefinitions()` reports its `value` as a JS boolean, so a consumer reads the type off the definition and thresholds this stream at 0.5 rather than testing `typeof` on it |
| `getParamGeneration()` → `int` | Generation identifying which loaded-effect or no-effect state the definition and value streams describe. Pin it beside a `getParameterDefinitions()` snapshot and re-read it with each `getParamValues()` call; a changed value means the snapshot is stale (parameter counts repeat across the roster, so a length check alone cannot detect the switch or teardown) |
| `getArenaMetrics()` | Memory usage stats for the three engine arenas, plus the stack high-water mark (see below). Read once per frame by the HUD, so it omits the tooling arenas an engine instance never moves; `MeshOps.getArenaMetrics()` reports all six on demand. Each arena entry carries two peaks: `high_water_mark` covers only the window since that arena's last reset or re-split (an effect that re-splits mid-run, like IslamicStars on every shape spawn, restarts it), while `lifetime_high_water_mark` folds every discarded window in and is the figure to size a budget against. Only the windowed mark is bounded by `capacity` — a re-split moves the boundary — so an overrun check reads that one |
| `getEffectSizes()` | Return `sizeof` for every registered effect at the current resolution |
| `getSupportedResolutions()` → `[[w, h], …]` | *(static)* List the resolutions the build supports, as `[width, height]` pairs |
| `isLive()` → `bool` | *(static)* Whether an engine instance is currently constructed — true from the end of a successful construction until that instance's `delete()`. Every other precondition on this bridge answers a bad call with a rejection value; the singleton one traps and kills the module, so this is the guard a retrying bootstrap reads before `new HolosphereEngine()` |
| `setClip(x0, x1, y0, y1)` → `ClipSetResult` | Restrict rendering to a sub-rectangle (used by segment workers). Returns `Module.ClipSetResult.APPLIED` when the band is installed, `FULL_FRAME_KEPT` when the bounds are accepted but ignored because the effect reports `needs_full_frame()` (§10.7) and keeps the full-canvas clip, else the rejection reason (`NO_EFFECT` or `INVALID_BOUNDS`). Compare against the enum values — never by truthiness. Both `APPLIED` and `FULL_FRAME_KEPT` are successes, and a segment pool needs them apart to tell an N-way parallel speedup from N workers each computing the same full frame. The two rejections want opposite responses: `INVALID_BOUNDS` is a caller bug worth faulting on, while `NO_EFFECT` is the ordinary state between a `setResolution()` (or an `init` carrying no effect name) and the `setEffect()` that follows. A clip is dropped by any `INSTALLED` `setEffect()` or `RESIZED` `setResolution()` (an `ALREADY_ACTIVE` same-resolution call keeps the clip) and must be re-applied |
| `strobeColumns()` → `bool` | Whether the current effect renders as discrete strobed columns (dark inter-column gaps) rather than a continuous smeared band; `false` when no effect is set. Daydream reads it to decide whether to fill the inter-column gap |

Five further methods carry Shader's whole workbench configuration across a reload or into a segment worker, which the per-parameter stream above cannot. Replaying individual entries can walk through combinations the workbench refuses. None traps when the loaded effect is something else, so a caller may wire them unconditionally and hide the structural controls on the non-Shader answer.

| Method | Description |
|---|---|
| `getFullConfigSnapshot()` | Return the current Shader workbench's whole state as `{schemaVersion, accepted, requested, pendingFieldIds, hasRuntime, runtime}`, or `null` for another effect. `accepted` and `requested` are `CONFIG_FIELD_COUNT`-long arrays of field values encoded as `uint32`, in `ConfigFieldId` order; `pendingFieldIds` lists the indices of the fields carrying an unresolved edit; `runtime` is the animation clock state, meaningful only when `hasRuntime` |
| `restoreFullConfigSnapshot(snapshot)` → `FullConfigRestoreResult` | Install a current-schema snapshot atomically: `Module.FullConfigRestoreResult.APPLIED`, else `NOT_SHADER_WORKBENCH`, `UNSUPPORTED_VERSION`, `INVALID_LENGTH` (a missing snapshot, or an array whose length is not the field count), `INVALID_VALUE` (a field or runtime value outside what its slot admits), `INVALID_ACCEPTED` (fields each in range but a combination the effect will not render), or `INVALID_PENDING` (a pending list that is absent, that is not a set of in-range field indices, or that does not name exactly the fields where `accepted` and `requested` differ — retry with `[]`). Compare against the enum values — never by truthiness. Every rejection leaves the effect exactly as it was, so a failed restore needs no rollback. Only the current field layout is accepted — the `schemaVersion` a fresh `getFullConfigSnapshot()` reports; older layouts are intentionally rejected. |
| `getFullConfigFieldDefinitions()` | Return `[{id, name}]` for every field in the snapshot arrays — `id` is the index into `accepted`/`requested`/`pendingFieldIds`, `name` the stable dotted config path — or `null` when the loaded effect is not Shader. Read it to label a field rather than hardcoding an index, which moves when the schema gains a field |
| `getConfigImportNotice()` → `string` | Reserved compatibility accessor. It returns `""` for the current schema and when the loaded effect is not Shader. |
| `clearConfigImportNotice()` | Clear the reserved notice buffer. No-op when the loaded effect is not Shader. |

The bridge also exposes a `MeshOps` class — used by the `solids.html` geometry tool — with dedicated tooling arenas (an 8 MB persistent arena plus two 4 MB scratch arenas — 16 MB total, separate from the engine's 512 KiB arena) for interactive solid manipulation. `fromSolidName`, `getVertices`, `getFaces`, `classifyFaces` and the operator methods answer a rejected call with `null`; `MeshOps.getLastResult()` then names the reason as a `Module.MeshOpResult` value (`OK`, `UNKNOWN_NAME`, `CONNECTIVITY_OVERFLOW`, `FACE_DEGREE_OVERFLOW`, `ARENA_EXHAUSTED`, `NON_FINITE_ARG`, `ANGLE_OUT_OF_DOMAIN`, `STALE_WRAPPER`, or `ARENA_UNAVAILABLE`). Compare against the enum values — never by truthiness — and read it before the next such call, which overwrites it. The reasons demand opposite responses: an overflow means shrinking the op chain, `ARENA_EXHAUSTED` means calling `clearToolingMemory()`, `STALE_WRAPPER` — a wrapper used after a `clearToolingMemory()` reclaimed its storage — means rebuilding the mesh from its base solid, and `ARENA_UNAVAILABLE` — the 16 MB tooling block itself could not be allocated — means no MeshOps call can run at all, so the tool must stand down rather than retry. That last one is a reject rather than a trap for the same reason as the rest: an allocation failure in a long-lived tab must cost the page a null, not the module. A stale wrapper is rejected rather than trapped, so an interleaved wipe costs the page a null, not the module. A call that *succeeds* can still have moved what it was given: the fraction operators, `snub` and `relax` saturate a finite out-of-domain argument into the operator's domain and render from the saturated value, leaving `getLastResult()` at `OK`. `MeshOps.getLastAdjusted()` reports that, on the same read-it-before-the-next-call terms — a tool that only previews the mesh can ignore it, while one that exports the argument it passed must check it, or the exported value carries an out-of-domain bound into a firmware assert. Two class functions are pure table reads — no arenas, no wrapper, no `clearToolingMemory()` pairing: `MeshOps.getRegistry()` lists every registered solid as `{name, category}` for the editor's solid picker, and `MeshOps.getRecipe(name)` returns one entry's authored op chain as `{seed, ops: [{op, param, twist}]}` in engine-native units, answering `null` for an unknown name or for a known entry that carries no recipe. `getRegistry()` alone sits outside the `getLastResult()` contract; `getRecipe()` is inside it, clearing the channel on entry like every other entry point and recording `UNKNOWN_NAME` for the unknown-name null (the recipe-less null leaves it `OK`). A panel that refreshes a recipe therefore has to read `getLastResult()` for the preceding operator before it calls `getRecipe()`.

The bridge also exposes a `PaletteOps` class with versioned `compileAndBakeV4(recipe)` and `inspectV4(recipe)` methods. Both compile a V4 perceptual recipe and return a zero-copy view over a 256-entry sRGB LUT; inspection also returns the engine's `L`, `C`, `q`, gamut-boundary, hue-path, and fallback diagnostics. These views share the same read-before-next-call lifetime contract as `getPixels`. Recipe compilation is deterministic and does not touch global RNG. `effectPresetsV4()` completes the class: it returns the authored recipe behind each of the engine's own palette-driven effects as `[{name, randomHue, recipe}]`, which the palette tuner offers as starting points; `randomHue` marks the presets whose effect re-rolls the base hue at runtime, so the recipe's own hue is only one sample of the look.

It likewise exports the engine's color, procedural-palette, and geometry math as free functions so JavaScript tools can cross-check the real implementation: `srgb_to_linear_float`, `linear_to_srgb_float`, `srgb_to_linear_interp`, `linear_rgb_to_oklab`, `oklab_to_linear_rgb`, `hsv_to_rgb`, `procedural_palette_linear`, `named_procedural_palettes`, `lissajous`, and `mobius_transform`.

The WASM bridge includes stack high-water-mark instrumentation: `stack_paint_canary()` fills the stack with a known pattern at init time, and `stack_high_water_mark()` scans for the deepest overwrite. Every effect switch repaints the canary, so the live reading only ever describes the render path; the construction + `init()` depth measured just before that repaint is latched separately and reported as `getArenaMetrics().stack.init_high_water_mark`. `wasm_smoke.mjs` gates both against the same creep budget, so a stack-hungry template instantiation reds CI instead of only printing a number.

Pixel data is 16-bit linear light (`uint16_t` per channel). The zero-copy `Uint16Array` view is bound directly as the instanced dot-mesh's `instanceColor` attribute, declared `normalized` so Three.js scales 0–65535 → 0–1 linear **on the GPU** — there is no per-pixel divide or float copy in JavaScript (Three.js expects linear color when `THREE.ColorManagement.enabled = true`):

```js
let wasmPixels = wasmEngine.getPixels();     // Uint16Array view, zero-copy
// The `true` flag marks the attribute normalized, so the GPU divides by 65535 on
// read. No JS-side divide or Float32 copy.
dotMesh.instanceColor =
    new THREE.InstancedBufferAttribute(wasmPixels, 3, /*normalized=*/ true);
// → instanced dot-mesh per-instance colors → WebGL renderer
```

The view aliases WASM linear memory and is **not** bound once. Two independent
events invalidate it, and a cached view must be tested for both:

- **Heap growth** — with `ALLOW_MEMORY_GROWTH` (e.g. the lazy 16 MB MeshOps
  allocation) any later growth detaches the `ArrayBuffer` and leaves the cached
  view zero-length (`wasmPixels.buffer.byteLength === 0`).
- **A resolution change** — the backing buffer is pre-sized to `MAX_W × MAX_H`
  and never reallocated (§10.10), so `setResolution` detaches nothing. It moves
  the *active prefix* instead: the cached view stays live at the previous
  resolution's length. Three.js r183 throws during upload if an existing
  attribute's array byte length differs from its allocated GPU buffer. A stale
  view initially bound to a new mesh can instead allocate the wrong-sized buffer;
  check the view length against the active resolution before binding it.

```js
if (wasmPixels.buffer.byteLength === 0 ||
    wasmPixels.length !== wasmEngine.getBufferLength()) {
  wasmPixels = wasmEngine.getPixels();
  dotMesh.instanceColor =
      new THREE.InstancedBufferAttribute(wasmPixels, 3, /*normalized=*/ true);
}
```

Run that check defensively each frame. A detachment-only guard ships a latent
wrong-resolution-view bug the moment a preset is switched.

### 10.3 The Three.js Renderer (`driver.js`)

The `Daydream` class owns the entire render side. Features:

| Feature | Details |
|---|---|
| **Instanced dot mesh** | One `InstancedMesh` of `W × H` small **hemi**spheres — `THREE.SphereGeometry` with `phiLength = π`, covering only the outward-facing half. `setupDots()` builds that geometry, the material, and the mesh; `precomputeMatrices()` fills each instance matrix from `pixelToSpherical(x, y)` (a `THREE.Spherical`, applied via `setFromSpherical`) and turns the dot radially outward with a `lookAt`, so the missing half never faces the camera and `THREE.FrontSide` suffices. `precomputeMatrices()` also allocates the shared `instanceColor` buffer that per-frame colors are written into. All `W × H` dots cost one draw call per render pass — two passes per frame while the PiP view below is up. |
| **Linear color pipeline** | `THREE.ColorManagement.enabled = true` and `setPixelRatio(min(devicePixelRatio, 1))`. Colors arriving from WASM are already linear, so no extra conversion. |
| **OrbitControls camera** | A normal `PerspectiveCamera` at `(0, 0, 220)` with FOV 20°, plus `OrbitControls` for mouse/touch navigation. |
| **Keyboard orbit** | A keyboard-focused canvas uses the arrow keys to orbit and `+`/`-` to dolly. Pointer focus does not claim those keys, preserving the paused-frame shortcut on the global handler. |
| **On-demand repaint** | The animation loop repaints only after a simulation step, camera movement, or `invalidate()`. Any caller that changes visible scene state without either of the first two must call `invalidate()`, especially for changes that must appear while paused. |
| **Context-loss recovery** | `webglcontextlost` stops GL work, aborts recording, and presents an accessible reload prompt; `webglcontextrestored` clears the lost state and schedules a repaint. |
| **Picture-in-picture** | A clone of the main camera, tracking its position and orientation each frame, renders the same view into a square 30%-sized bottom-left viewport. Suppressed when `isMobile`, under `navigator.webdriver` (§ headless capture), and while recording. |
| **Axes overlay** | Three `THREE.Line`s for X/Y/Z visible on toggle, plus a `CSS2DRenderer`-backed `LabelPool` for the six axis-direction labels ("X / Y / Z" and "-X / -Y / -Z") with zero allocation per frame. |
| **Resize observer** | `ResizeObserver` on the canvas container recomputes camera aspect, viewport, and `isMobile` (width ≤ 900). |
| **Fixed-rate stepping** | The simulation ticks at `1/FPS` seconds independent of the actual render rate, with a time accumulator to keep effects deterministic. |

### 10.4 Application State (`state.js`)

Daydream uses a tiny pub/sub state container plus a URL-syncing wrapper:

```js
const appState = new AppState({ effect: 'IslamicStars', resolution: 'Phantasm (288x144)' });
const urlSync = new URLSync(appState, ['effect', 'resolution'], {
  effect: (v) => knownEffects.has(v),                 // per-key validators gate
  resolution: (v) => Object.hasOwn(resolutionPresets, v),  // the initial URL read
});

appState.subscribe((key, value, old) => {
  if (key === 'effect') applyEffect();
  else if (key === 'resolution') applyResolution();
});
```

- **`AppState`** — flat key→value store with a `subscribe(callback)` API. Setting a key fires the callback only if the value actually changed. The sidebar and lil-gui both write through `appState.set(...)`, so they stay in sync without explicit coupling. `update(patch)` batches: every key in the patch is written first and only then are subscribers notified, one event per changed key, so a callback that reads a sibling batched key sees its post-batch value instead of a half-applied state.
- **`URLSync`** — reads tracked keys from `window.location.search` on construction (URL beats default), coercing each raw string to the seeded default's type. The third constructor argument is a per-key validator map applied to that raw string; a key whose predicate rejects keeps the validated default, so a hand-edited link cannot poison state and no consumer has to re-validate afterwards. A predicate that gates on a lookup table tests own keys (`Object.hasOwn`) and the table carries a `null` prototype, or `?resolution=constructor` passes on the prototype chain. Writes back to the query string are debounced 200 ms through `history.replaceState`. Shareable links like `?effect=Raymarch&resolution=Phantasm%20(288x144)` work out of the box.
- **URL write ownership** — `URLSync` is the app-wide single owner of URL writes, reachable as `getActiveURLSync()`; constructing a new one disposes the previous. `gui.js` routes each parameter change through `setParam(key, value)`, which buffers an ad-hoc entry (numbers rounded to 5 *significant digits* through the shared `roundUrlNumber`, `null` marking a deletion) rather than writing directly. Significant digits, not decimal places: a lil-gui slider's implicit step is a thousandth of its range, so the rule resolves every step at any magnitude, including a param whose whole range is a small fraction of 1. The debounced flush is a read-modify-write at fire time: it re-reads the live query string, overlays the tracked state keys, then overlays the ad-hoc buffer — so concurrent state and GUI updates merge into one `replaceState` instead of clobbering each other. `reset(excludedKeys)` drops every param outside the exclusion set through that same debounced flush, which re-asserts tracked state and surviving ad-hoc entries so a change still inside the window is not lost — an effect switch resets on every change, so a burst costs one write rather than one per switch. Every writer — both `URLSync` paths and the two standalone-page fallbacks in `gui.js` — emits through the exported `writeUrl(params)`, which assembles `pathname + ?query + location.hash` and calls `replaceState`, so no path can drop the fragment. Both it and the exported `replaceUrl(url)` under it swallow a refused write (browsers rate-limit `replaceState` and throw past the limit): the URL is cosmetic, and a throw escaping into a switch rollback would be reported as unrecoverable state.
- **Refused writes retry, bounded** — a refused flush leaves the URL as it was, so the ad-hoc buffer and any pending reset are held and the flush re-arms at `URL_FLUSH_RETRY_MS` (2 s, deliberately longer than the debounce so the ladder does not spend the write budget faster than the rate limit it is waiting out). Tracked keys need no such hold — every flush re-reads them from state. A shorter debounce never displaces an armed longer delay, or a concurrent GUI edit would pull the ladder forward into the window it is pacing. The ladder stops at `URL_FLUSH_MAX_RETRIES` (20): the product outlasts WebKit's 30 s rate-limit window, and a refusal that survives it is a standing one — a sandboxed iframe or a `file://` document refuses every write for the page's lifetime — so the buffer is dropped with a warning rather than held by a timer that re-arms forever.
- **`suspend()` / `resume()`** — bracket a multi-step state transaction so no URL is written from inside it; `daydream.js` uses this to hold the write while a legacy shader deep link is migrated to its replacement effect, releasing it once the migrated effect has been applied. `suspend()` disarms an already-armed flush (the constructor's canonicalization arms one before any caller can suspend) and carries its delay, so a suspension crossing a retry cannot let `resume()` pull the ladder's wait forward. Nesting is counted; the outermost `resume()` schedules the accumulated write.

### 10.5 The Effect Sidebar (`sidebar.js`)

The left-edge effect list is a small custom widget:

- **Preset count in the label**: each button reads `Name (N)`, where N is the effect's authored preset count from the engine's `getEffectPresetCounts()` — the registry's `preset_count`, which is `PRESET_IDS.size()` when the effect names its presets and `authored_preset_count()` (the `PRESETS` table's length) otherwise. The displayed value is floored at 1, so an effect with no preset table still shows `(1)`; if the call fails the counts are dropped and every button falls back to that floor.
- **Persistent button references**: re-sorting by name or size (live `sizeof` from `getEffectSizes()`) re-appends the existing button nodes in the new order without recreating them; `setEffects()` itself rebuilds the list from scratch.
- **Keyboard navigation**: arrow keys move the focused button (wrapping at the ends), Home and End jump to the first and last; Enter or Space selects.
- **Mobile horizontal scroll**: when laid out as a horizontal strip, scroll arrows fade in/out based on scroll position via a `ResizeObserver` + scroll listener.
- **Per-resolution filtering**: each resolution has its own curated effect list, shown in the sidebar. An effect that is not in the active resolution's list — including one hydrated from a `?effect=…` link — is replaced with that list's first effect, so only curated effects load at a given resolution.

### 10.6 GUI Auto-Generation

The parameter controls in the effect panel are entirely driven by what C++ registers via `register_param()`; a fixed set of panel actions sits above them. When an effect is loaded, the simulator calls `getParameterDefinitions()` and builds `lil-gui` controls:

```js
params.forEach(p => {
    const controller = gui.add(state, p.name, p.min, p.max);
    controller.onChange(v => wasmEngine.setParameter(p.name, v));
});
```

`getParamValues()` is polled after simulation steps and on invalidated frames to sync the GUI with parameter values that the animation system has changed autonomously. While paused, the panel continues reconciling on each animation frame. The sync skips any control the user is currently interacting with to avoid fighting the slider. A per-effect **Reset** rebuilds the GUI from defaults, and **Export** copies the current `{ name, value }` set as a C++-formatted initializer suitable for `PRESETS` tables. If a segmented-render parameter snapshot is temporarily unavailable after an edit, Export uses the values displayed by the current parameter schema. An effect that persists through the exhaustive versioned snapshot API instead of per-parameter values — the Shader workbench, which the engine answers `getFullConfigSnapshot()` for — takes the other branch: Export copies that snapshot as pretty-printed JSON, and fails visibly rather than falling back to an initializer when the snapshot is unavailable. An effect that reports presets also gets a **Preset** dropdown over the zero-indexed live index — a live control, not a readout: choosing an entry selects that preset — flanked by **Previous Preset** / **Next Preset** buttons that step it, and each sync first mirrors the live preset into the engine that owns the definitions, skipping the rest of the update when that mirror fails.

Three behaviours the definitions loop above does not show. **Stage folders**: pullback-shaded effects are grouped rather than listed flat — the panel matches the registered names against a per-effect stage assignment and builds one folder per pipeline stage, in pullback order; a parameter no stage claims is still built, at the panel's top level, and the orphan is logged. **Warnings**: a definition carrying a `warning` — the engine's answer to a value it accepted as a request but will not render — renders that text into a node beside the control (a node, not a `title` attribute, which would be mouse-only), and the panel re-reads the warning set after each edit and rebuilds once the engine's warnings have moved off the ones it was built from. **Persistence**: the panel restores itself across a reload, storing accepted parameter values for an ordinary effect and, for one on the full-config path, `getFullConfigSnapshot()` as JSON — replayed through `restoreFullConfigSnapshot()`, which is atomic, so a snapshot that fails to parse or that the engine rejects is dropped rather than half-applied.

### 10.7 Segmented POV Workers (`segment_worker.js`)

Phantasm hardware uses N Teensys, each rendering one segment rectangle: an arm's half-width crossed with a Y-band computed by the engine's `segment_map()`/`segment_x_col()` (`pov_segment_map.h`). N=4 is the qualified default; N=8 is the compile-tested firmware profile. Daydream reproduces the *partitioning* in software — its `computeSegmentRange()` (`segment_layout.js`) mirrors the engine's arm/Y-band split (a general even-N tiler that also drives the 2–8-way preview), though it does not model southern segments' reversed strip direction (`y_step = -1`) or the hardware's power-of-two segment-count constraint — so the band partition, not the full strip wiring, is exercised before fabrication. A `SegmentController` (`segment_controller.js`) owns the worker pool — dispatching renders (`renderParallel()`), fencing stale frames by generation, and compositing results (`composite()`) — while each `segment_worker.js` hosts one WASM instance:

```
Main thread                  Workers (one WASM each)
───────────                  ──────────────────────────
drawFrame() {                postMessage({type:'render'})
  if (pendingSegmentFrame)
    controller.composite();    worker N:
  controller.renderParallel();   engine.setClip(xN0, xN1, yN0, yN1)
}                                engine.drawFrame()
                                 postMessage({type:'frame', pixels:Transferable})
```

Key properties:
- **Isolated WASM instances per worker** — each segment has its own arena, its own RNG stream, and its own effect state. The stream is *per effect load*: every `setEffect()` reseeds the shared `Pcg32` from `hs::stable_effect_seed(stable_id)`, mirroring the device's per-effect reseed. The seed is a pure function of the effect's stable id, so every instance loading the same effect derives the same stream locally — a pool rebuilt mid-session matches a main-thread engine that has already switched effects N times.
- **Effect-switch recovery is bounded** — if a worker rejects an effect switch, the controller may rebuild the pool twice for that switch. A third failure latches the pool fault instead of entering an unbounded rebuild loop.
- **One shared compilation, warmed before the spawn** — `warmModules()` (`module_warmer.js`, exported as `pageWarmer`) re-fetches the worker's whole module graph — `segment_worker.js`, the WASM glue, `segment_layout.js`, `worker_protocol.js` and the binary — with `cache: 'no-cache'`, so a worker cannot load a module cached from an earlier deploy against freshly fetched peers. It also compiles the drained binary into the page-wide `ModuleWarmer`, and the spawn passes that `WebAssembly.Module` in each worker's `init`: an N-worker pool costs one compilation of the 2.7 MiB module instead of N. Warms are deduped per module graph over `WARM_INTERVAL_MS` (10 s), because lil-gui fires `onChange` per drag step and the segment-count slider would otherwise revalidate the graph several times a second. A binary the engine refuses drops the held module — reported by the worker as `engineRejected` with `sharedModule` — and triggers a bounded automatic boot retry that compiles per worker. A warm past the dedupe window re-fetches the shared module.
- **`setClip(x0, x1, y0, y1)`** — for a non-stateful effect the WASM engine restricts *rendering* to the worker's segment rectangle: the rasterizer's scanline culling skips out-of-clip rows and columns, so out-of-band pixels are never shaded. The pixel readback in `drawFrame()` copies only that same rectangle out of the canvas buffer, leaving the rest of the readback buffer holding whatever it last did; `segment_worker.js` then extracts that rectangle with one `extractSegment()` call before transferring the result back, so only the segment crosses the worker boundary. That call lives in `segment_layout.js`, the module both ends share: the worker extracts with it and the main thread composites with its `compositeSegment()` counterpart, so one blit routine defines the segment rectangle for both directions.
- **Per-instance render settings must be re-sent** — `setPoleLod` writes `pole_lod_aggressiveness`, a module-global of the WASM instance it is called on. A worker's instance carries its own copy, so a value set on the main-thread engine does not reach the pool: the controller must forward the setting to every worker (a protocol message of its own, applied like `setAnimationsPaused`) or the composited preview renders undecimated while the slider reads non-zero.
- **Cross-segment stateful effects render full-frame** — an effect whose per-frame state reads pixels *outside* the worker's band (`MeshFeedback`'s feedback warp samples the previous frame at unbounded offsets; `Dynamo` reprojects `World::Trails` under rotation) cannot be band-clipped: a clipped worker would have stale/zero history outside its band, so cross-band trails read as black and seams appear. Those effects report `Effect::needs_full_frame()` (derived from a compile-time `any_crosses_segments` filter-pipeline trait), and `setClip` leaves their clip at the full canvas and reports `FULL_FRAME_KEPT` — every worker computes the bit-identical full frame and `segment_worker.js` slices its segment rectangle from the full readback. The device's driver keeps the full canvas for a wider set: `clip_to_segment` skips clipping when an effect reports `needs_full_frame()` **or** `persists_pixels()`, while the simulator's `setClip` tests only `needs_full_frame()`. An effect that persists pixels without forcing a full frame is therefore band-clipped in the preview and full-frame on the device, so the preview manufactures the seam the gate exists to prevent.
- **One-frame pipeline** — frame N's render is dispatched fire-and-forget; frame N-1's results are composited synchronously when they arrive. The stats overlay's `max` row — the slowest worker's own `drawFrame()` — is the comparable number, and is the closest stand-in for what the multi-Teensy hardware sees. It is not a bound on it: `computeSegmentRange()` pins each arm to a fixed column half, while the firmware's `segment_clip()` trades the two halves between the arms every half-revolution, so a segment's `Compute` — and the `max` over them — covers one of the two halves that board actually sweeps rather than the costlier one. The `round-trip` row below it spans dispatch to last worker response, so it also carries structured-clone, `ArrayBuffer` transfer and main-thread event-loop latency that the hardware has no analogue for.
- **Boundary overlay** — a "Show Boundaries" toggle paints cyan markers on the segment edges in the composite buffer to make the partition visible.
- **Protocol version handshake** — `worker_protocol.js` exports a `PROTOCOL_VERSION` that both ends stamp and check. Each worker posts a `booted` ping carrying it *before* instantiating WASM, and the controller's `init` message carries it back; either side faults on a mismatch — a stale cached worker or glue file against a newer peer — instead of drifting on reshaped message fields.
- **Watchdogs, bounded boot retry, and a latched fault** — a worker that hangs or fails to load without throwing fires no `onerror`, so three deadlines bound the pipeline: the `booted` ping (module fetch + evaluate), pool readiness (WASM instantiate), and render liveness. The render deadline is re-armed on every distinct segment frame, so a slow effect keeps extending it while a true stall still faults. A message-less `error` event or a rejected shared module before the pool is ready rebuilds the pool a bounded number of times with a short backoff; other failures and exhausted retries latch. Latching terminates every worker and halts the pool with no auto-restart, replacing the per-segment stats table with a fault banner naming the segment and the reason — it stays down until a user-driven resolution or segmented-mode change rebuilds the pool.

### 10.8 Vendor Importmap (CDN by Default / Local Opt-In)

`vendor-importmap.js` is loaded as a regular (non-module) `<script>` by `index.html` and by the four tool pages that import bare specifiers. `palettes.html` imports none — every module it loads is page-relative — so it carries no importmap script at all. At parse time the helper:

1. Locates itself via `document.currentScript.src`, so it works whether called as `./vendor-importmap.js` (root) or `../vendor-importmap.js` (a tool page).
2. Reads a build-time-baked `VENDOR` decision (per library, `'cdn'` or `'local'`).
3. Builds a `<script type="importmap">` with local page-relative URLs for any `'local'` library, otherwise jsdelivr URLs pinned to versions from `package.json`.
4. Injects that importmap into `<head>` before any module loads.

The local-vs-CDN choice is **baked at build time**, not probed at runtime — there is no main-thread-blocking synchronous XHR and nothing 404s on the CDN-only Pages deploy. The committed default is all-CDN, which is what the deploy and a fresh checkout serve. For offline / local dev with a populated `three.js/` and `node_modules/`, run `npm run importmap:local` (detects vendored dirs and rewrites the `VENDOR` block); `npm run importmap` reverts to all-CDN. The generated `local` block must not be committed — it would break the live deploy.

The generated integrity map covers the top-level libraries and the two addons
the app imports directly. Relative sub-imports inside those modules bypass the
import map, so the exact package-version pin is the primary defense; the
available SRI entries are additional partial coverage. Import-map `integrity`
is Chromium-only — Firefox and Safari ignore the key entirely, so SRI is no
coverage at all there. A `Content-Security-Policy` meta tag, carried by
`index.html` and each of the five tool pages, bounds this on every browser
by origin: script loads are restricted to `'self'` plus the CDN origins that
page actually uses. It is an origin boundary, not an XSS one — every page
carries `'unsafe-inline'`, required by the four tool pages' inline module
blocks and by the import map `vendor-importmap.js` injects. Pages that load the WASM engine need `'wasm-unsafe-eval'`
for the module instantiation itself, but not the far broader `'unsafe-eval'`:
the module is linked `-sDYNAMIC_EXECUTION=0 -sEMBIND_AOT=1`, so embind's
per-binding invokers are emitted into the glue at link time instead of being
built with `new Function` at module-creation time, and the shipped glue
generates no code at runtime (asserted by `wasm_smoke.mjs`). `font-src` allows
`data:` for the woff2 lil-gui inlines in its stylesheet.

A page can add its own local imports by setting `window.daydreamExtraImports` to a `{ specifier: url }` map before the helper script; no page currently does.

### 10.9 Video Recording (`recorder.js`)

A `VideoRecorder` wraps `MediaRecorder` over an offscreen capture canvas's `captureStream(0)`. A capture is due on a tick that advanced the simulation, and the driver issues at most one `recorder.captureFrame()` — which blits the source canvas into the offscreen canvas and requests a frame from the stream — per repaint, because several `requestFrame()` calls in one task carry a single timestamp and the stream cannot emit them as separate video frames. When a detached instance-color alias sends the repaint round again, the due capture joins a `heldCaptures` backlog that drains one frame per subsequent repaint. Manual requests select when images are offered to the track; encoded timing follows real elapsed time, not the effect's fixed simulation timestep. The segmented path captures only ticks where `captureReady()` reports that a composite landed, so a pool overrun can omit a captured image. Browsers without track `requestFrame()` use a wall-clock capture timer. A deterministic simulated image sequence does not guarantee a fixed-rate encoded timeline or byte-identical recordings; browser scheduling, codec behavior, and encoding metadata can differ.

Codec priority is MP4/H.264 → WebM/VP9 → WebM/VP8. Capture always goes through the offscreen canvas: it is either scaled to a target height for size-controlled exports, or pinned to the source's start-time size at native resolution. Either way the recorded track's frame size is fixed for the whole session, so a mid-recording resolution change cannot alter the encoded dimensions. The per-frame blit is a centered letterbox/pillarbox fit rather than a plain rescale: the source is scaled until it fills whichever offscreen dimension it reaches first, centered, and the leftover margin is cleared — so a source whose aspect no longer matches the pinned track is bordered, never stretched. A transient 0×0 source mid-resize is skipped and the offscreen keeps its last good frame.

Both save paths bound how much video may sit in RAM, and crossing either bound stops the recording rather than letting the tab climb to an OOM that would lose it outright; whatever was captured up to that point is still saved. A browser without the File System Access API (Firefox, Safari) has no streaming save and buffers the whole recording in memory, so that sink ends the session at **512 MB** (`MEMORY_BUFFER_LIMIT_BYTES`). On the streaming path the file handle comes from a Save dialog, and every chunk that arrives before the user answers it is held in memory; that backlog is capped at `PICKER_GRACE_SECONDS` (120 s) of video at the latched bitrate — **240 MB** at the default 16 Mbps — after which the session stops, and the queued chunks still reach the file as a clean prefix if one is eventually picked. Cancelling the Save dialog also ends the session, so the recorder never keeps capturing frames nothing will write.

### 10.10 Resolution Presets

| Name | Width × Height | Notes |
|---|---|---|
| `Holosphere (96x20)` | 96 × 20 | Matches the original Holosphere hardware |
| `Phantasm (288x144)` | 288 × 144 | Matches Phantasm; default in the web simulator |

Switching presets does a full WASM reset: `setResolution(w, h)` updates the active width/height and drops the current effect — the pixel buffer is pre-sized to `MAX_W × MAX_H` and deliberately never resized (a realloc could move its backing store under `ALLOW_MEMORY_GROWTH` and detach every outstanding `getPixels()` view), so `getPixels()` returns a view over just the active prefix. `setEffect(name)` then rebuilds the effect at the new template instantiation. The sidebar swaps to the matching favorites list (§10.5).

### 10.11 Standalone Design Tools (`daydream/tools/`)

Five standalone HTML pages. Four render with Three.js; `palettes.html` renders with 2D canvas contexts. Three are backed by the engine's WASM build so their math stays identical to the C++ engine — `shader.html` through the authoring-only `Shader` effect, `solids.html` via the `MeshOps` class, and `palettes.html` via `PaletteOps` — and all three hard-require it: a failed module load raises a fatal banner instead of falling back. `lissajous.html` and `mobius.html` implement their geometry math directly in JavaScript:

| Tool | What it does |
|---|---|
| `lissajous.html` | Designs spherical Lissajous curves with live frequency / phase sliders; outputs a C++ `LissajousParams` initializer for the engine's Lissajous effects (`Fishbowl`, `Comets`). |
| `mobius.html` | Visualizes Möbius transformations on the sphere via the engine's stereographic projection; lets you sweep the four complex coefficients, see the warp on a latitude-longitude grid, and copy a C++ `MobiusParams` initializer. |
| `palettes.html` | Tunes `ProceduralPalette` cosine coefficients and versioned `GenerativePalette` recipes, exports complete canonical C++ recipes, renders engine-returned LUTs on 2D canvas contexts, and reports compile status and normalization adjustments inline. |
| `shader.html` | Authors pullback shaders against the complete stage vocabulary with the live sphere preview. The chain is a pipeline strip of stage chips banded by carrier family, each stage tuned by parameters inline on its own chip; a band's `+` opens a popup listing the operators that band's gap accepts. It is the destination for unmatched legacy ShaderWorkbench documents and is deliberately absent from the normal effect-card roster. |
| `solids.html` | Conway operator playground — chain `truncate`, `kis`, `ambo`, `dual`, etc. on Platonic / Archimedean / Catalan / Islamic-pattern seeds and visualize the result. Backed by the WASM `MeshOps` bridge with dedicated tooling arenas (16 MB, separate from the engine's 512 KiB arena). |

The four Three.js pages reuse `vendor-importmap.js`, so they resolve from the CDN by default or from the local `three.js/` after `npm run importmap:local`. `palettes.html` imports only page-relative modules, so it carries no importmap script and its CSP `script-src` drops the `https://cdn.jsdelivr.net` origin the other four allow, keeping `'self' 'unsafe-inline' 'wasm-unsafe-eval'`; its `style-src` and `font-src` still name the Google Fonts origins the self-hosted-font fallback needs.

---

## 11. Building

The two repos should be checked out as siblings so the WASM install step can write directly into the simulator tree:

```
work/
├── Holosphere/          (this repo — C++ engine + firmware + WASM build)
└── daydream/            (web simulator — receives WASM artifacts)
```

Agent sessions that commit to this repo work under the ground rules in [`docs/agent_workflow.md`](https://github.com/woundedlion/pov/blob/master/docs/agent_workflow.md).

### Firmware (Arduino / Teensy 4.x) — Holosphere repo

Each hardware target has its own `.ino` entry point in `targets/`:

1. Install [Arduino IDE](https://www.arduino.cc/en/software) with Teensyduino (or use [Visual Micro](https://www.visualmicro.com/) for Visual Studio).
2. Install the `FastLED` library.
3. Open `targets/Holosphere/Holosphere.ino` (or `targets/Phantasm/Phantasm.ino`).
4. Set **Additional Include Directories** to: `../../core;../../effects;../../hardware`
5. Select **Board: Teensy 4.0**, **CPU Speed: 600 MHz**.
6. Upload.

> **Headless size/layout gate — an active CI job, optional locally.** A
> PlatformIO build (`just teensy-size`) builds
> the two budgeted shipping images plus the `holosphere_dma`, `phantasm8`,
> `profile`, and `profile_o3` compile/link profiles
> on a stock machine. It checks shipping-image size and memory-region layout
> against committed budgets while closing the device-only `#ifdef ARDUINO`
> compile/size blind spot VMicro alone leaves uncovered. CI runs the same build
> and the same budgets on every master push and pull-request update as the
> `teensy-size` job, alongside `teensy-warnings` (a cold rebuild enforcing the
> first-party warning ratchet) and `teensy-gate-tests` (host-Python proofs that
> each budget and layout invariant fails on a broken fixture) — the firmware is
> compiled and gated in CI, and only running it on real hardware is manual.
> Locally it coexists with VMicro (it owns `.pio/`, never `__vm/`) and asserts
> the images *fit*, not byte-identity
> with the bench build. Install PlatformIO from `requirements/platformio.txt`:
> the recipe opens with `build_pins.py --check-tool platformio` and refuses any
> version but the pinned one.

Target-specific constants live with their target rather than in a global `constants.h` — the Holosphere entry defines its own, while the Phantasm-class targets share `targets/Phantasm/phantasm_target.h` (`TOTAL_PIXELS = 288`, `RPM = 480`):
```cpp
// targets/Holosphere/Holosphere.ino
static constexpr int NUM_PIXELS = 40;
static constexpr unsigned int RPM = 480;
```

Pin assignments are in `core/render/led.h` (also included by `hardware/pov_single.h`):
```cpp
inline constexpr int PIN_DATA   = 11;
inline constexpr int PIN_CLOCK  = 13;
inline constexpr int PIN_RANDOM = 15;
```

### WASM Build — Holosphere repo (installs into daydream)

The build is driven by **CMake presets** ([`CMakePresets.json`](https://github.com/woundedlion/pov/blob/master/CMakePresets.json)) so the same commands work on any platform with CMake ≥ 3.29, Ninja, and [Emscripten](https://emscripten.org/). Set up the Emscripten environment once (`emsdk_env`, which exports `EMSDK`), then:

```bash
cmake --preset wasm-release                     # configure (Emscripten toolchain)
cmake --build  --preset wasm-release            # build holosphere_wasm.{js,wasm}
cmake --build  --preset wasm-release-install    # build + install into ../daydream/
```

Use `wasm-debug` for an unoptimized build with assertions (`-sASSERTIONS=1`). Build outputs go to `build/<preset>/`. The `justfile` provides cross-platform shortcuts that forward to these presets: `just build` (release), `just build-debug`, and `just install` (smoke + install into `../daydream`). `just smoke` rebuilds and then drives the shipped module through [`scripts/wasm_smoke.mjs`](https://github.com/woundedlion/pov/blob/master/scripts/wasm_smoke.mjs) under Node — the same runtime gate CI's `wasm` job runs. The recipe graph is `install → smoke → build`, so the module and provenance markers written into daydream are exactly the ones the runtime gate exercised and a release build is never shipped un-exercised.

The WASM target (`CMakeLists.txt`, `EMSCRIPTEN` branch) configures:
- Source paths: `targets/wasm/wasm.cpp`, `core/engine/memory.cpp`, `core/engine/static_storage.cpp`, `core/spatial/reaction_graph.cpp`
- Include paths: project root (for `effects/`, `hardware/`) and `core/` (for engine headers)
- `-sALLOW_MEMORY_GROWTH=1` — WASM heap can grow for large meshes
- `-sMODULARIZE=1 -sEXPORT_ES6=1` — ES6 module output
- `-sSTACK_SIZE` — per build type: 8192 for release (minimal; effects use arena allocation, not deep recursion) and 65536 for debug, where `-O0` disables inlining and stack-slot coalescing and inflates frames past the release budget. Each build-type block sets it exactly once and the shared block never does, so the effective value cannot depend on link-line ordering
- `-O3 -ffast-math -fno-finite-math-only -flto -msimd128` for release, `-O0 -g -sASSERTIONS=1` for debug (`-fno-finite-math-only` must follow `-ffast-math`, which otherwise folds `std::isfinite()` to true and lets the compiler assume no NaN/Inf — the render sink relies on real finite semantics)

The install step also writes `hardware/pov_segment_map.json` — the segment→canvas golden the simulator's cross-check reads as the firmware reference — the shader validator helpers, shader documents and migration manifest, the wasm32 operator catalog, `README.md`, and `docs/screenshots/`. Beside the `.js`/`.wasm` pair it records the engine SHA, binary hash, and toolchain marker consumed by Daydream's provenance gate.

### Tests — Holosphere repo

The unit suite is a native (non-WASM) Clang build with asserts enabled, also driven by a preset:

```bash
cmake --preset tests          # configure (cmake/toolchain-native-clang.cmake)
cmake --build --preset tests  # build the run_tests executable
ctest --preset tests          # run the suite at the 8-frame default window
just test                     # the same suite at CI's 120-frame window
```

The per-effect smoke and determinism window is `HS_SMOKE_FRAMES`, 8 frames by default. At 8 frames no preset transition arms, so the pause, slot-reuse and FIFO-expiry paths never execute; `just test` and every CI leg raise it to 120, and `run_tests` refuses a shallower window when `CI` is set.

The suite must use Clang — the engine relies on GCC/Clang `__attribute__` extensions MSVC rejects. The native toolchain file ([`cmake/toolchain-native-clang.cmake`](https://github.com/woundedlion/pov/blob/master/cmake/toolchain-native-clang.cmake)) locates Clang via `EMSDK` (or a sibling `../emsdk`) and, on Windows, transparently handles the resource compiler and `lld-link` so no Visual Studio Developer Prompt is required. Reusable CMake interface targets select test capabilities and widen the host-only budgets: the inline type-erased animation slot (the 64-bit host inflates every embedded pointer past the 32-bit device footprint) and, most significantly, `GLOBAL_ARENA_SIZE` — **8 MiB for host effect harnesses against the device's 298 KiB**, so the effect smoke harness can render every effect without OOMing mid-run. The firmware/WASM footprint is unchanged: the real budget stays available as `DEVICE_GLOBAL_ARENA_SIZE`, which the device-budget `static_assert`s check even in the host suite. A high-water mark measured in the native suite is therefore *not* a device figure — it is a 64-bit measurement against an inflated ceiling.

Coverage spans the math/geometry/memory core, color, easing/waves, the reaction-diffusion graph integrity, filters, the plot samplers and the Scan/mesh rasterizer, solids-registry invariants, the Conway/Hankin mesh operators, and animation. Beyond those unit checks the suite also runs: an effect smoke harness that constructs and renders every effect with asserts on, plus a cross-run determinism pass that re-renders each effect under a fixed clock and diffs the frames — at the small-aspect 96×20 simulator/test resolution by default (the only firmware image that renders 96×20 is Holosphere — the `holosphere`/`holosphere_dma` PlatformIO envs build `-DCANVAS_W=96 -DCANVAS_H=20` and the sketch shows a single effect; the Phantasm image and every other env are 288×144), and additionally at the production 288×144 alongside a white-box correctness block when `HS_EFFECTS_FULL=1` is set. Pull requests use the quick tier; every master push runs the full IEEE correctness leg and the shipping fast-math smoke leg. The suite also includes a death harness that spawns subprocesses to confirm `HS_CHECK` invariants trap — its cases pin a subset of the guard sites the generated census counts, and the remaining sites are recorded per file in `GUARD_GAP_ALLOW`, so the harness is a pinned sample of the fail-fast surface rather than full coverage; the Phantasm multi-board sync core (`hardware/pov_sync.h`, spec §12); the HD107S SPI wire-format and color-correction tests; the POV driver tiling proofs (each LED write covers the canvas exactly once); and the WASM param-marshaling coverage (the JS definition/value streams stay index-aligned). `tests/run_tests.cpp` is the driver. Extending it with a `tests/test_<module>.h` takes three edits, each pinned by its own CTest case:

1. `#include` the header in `run_tests.cpp`'s include block. The `unit_module_includes` test balances that block's size against the roster row count and requires every header in `tests/` outside a small non-module list to be included by name — so neither an orphaned include nor a test file nothing compiles survives.
2. Add an `X(name, entry_point)` row to `HS_TEST_MODULE_LIST`, the X-macro that expands into `MODULES[]`. `end_module()` rejects a module that runs no assertions, while the `unit_case_calls` CTest scans every `void test_*(` / `void check_*(` definition in `tests/` and requires a reference elsewhere in its own header (or in the shared corpus for cross-file helpers). There are no measured assertion floors or exact case-count pins to update when a test changes.
3. Add the module name to `_hs_test_modules` in [`tests/CMakeLists.txt`](https://github.com/woundedlion/pov/blob/master/tests/CMakeLists.txt), which generates the one-CTest-test-per-module the CI shards target. `run_tests --check-modules` (the `unit_module_roster` test) fails if the CMake list and the roster diverge either way, so a module added to one but not the other can never run silently.

#### Continuous testing

Three layers run the same suite so a regression can't reach the live demo:

- **Local pre-commit hooks** — both repositories reject staged whitespace errors and validate documentation from an isolated copy of the Git index. POV also runs clang-format over staged first-party C++, ruff/eslint over staged sources, and the fast license/build-pin checks. Daydream runs ESLint over staged JavaScript and validates the Pages manifest graph. A required tool missing for an applicable change fails the commit. Builds, typechecking, unit suites, browser probes, firmware budgets, and coverage remain pre-push or CI, keeping the normal hook near two seconds while protected-branch `CI green` remains authoritative.

- **Presubmit CI** (`.github/workflows/ci.yml`, Holosphere repo) — on master pushes and pull-request updates (a push to a branch with no open PR triggers nothing), runs the native suite on Linux (clang-22) and builds the WASM module. The Windows leg (emsdk Clang, which exercises the `lld-link` / rc.exe toolchain branch from a plain shell) runs on master pushes only, and is the one job `ci-green` accepts as `skipped` on a pull request. It then **smoke-tests the WASM at runtime** ([`scripts/wasm_smoke.mjs`](https://github.com/woundedlion/pov/blob/master/scripts/wasm_smoke.mjs)) and **verifies the install provenance set** consumed by Daydream, then runs Daydream's own suite over that bundle in a `daydream-consumer` job, against the daydream commit pinned in `tools/build_pins.py`. Native coverage is retained as HTML/LCOV and has a loose 70% line floor against a current baseline around 78%, so catastrophic loss fails without pinning normal refactors to an exact artistic implementation. The native suite also runs at `-O2`, under ASan + UBSan, and for concurrency modules under TSan. A `shard-coverage` job proves every registered CTest belongs to exactly one shard. Pull requests use the quick effect tier; master runs the production-resolution IEEE correctness leg and shipping fast-math smoke leg. The six lint legs check Python, JavaScript, shell, the GitHub workflows, the `justfile`, and the profiling roster with defect-oriented rules.
- **Gated deploy** (`.github/workflows/deploy.yml`, **daydream repo**) — daydream's GitHub Pages source is *GitHub Actions*. On a push to daydream's `master` (or manual dispatch), the engine's native unit suite runs as a **gate** (checking out the engine repo) alongside daydream's own JS suite and its headless-Chrome job (`browser-smoke.yml`, which drives seven probes in one runner: the page smoke over every `site_manifest.txt` entry, `workbench-probe.mjs` driving the workbench's pipeline strip with a real mouse, `panel-probe.mjs` scrolling the effect panel and requiring the offset to survive a rebuild, `solids-probe.mjs` dragging the solids page's op-chain rows into a new order, `palettes-probe.mjs` sweeping the palette strip's zoom and hue-key wheel, `mobius-probe.mjs` pressing the Möbius page's complex-plane pads, and `lissajous-probe.mjs` driving the Lissajous page's rational frequency lock). Those seven are the only checks that resolve the import map, instantiate the WASM module under a page's CSP and measure where an element actually lands — the unit suite runs over `daydream/tests/fake_dom.js`, which has neither layout nor pointer capture. `deploy` `needs: [gate, js-tests, browser-smoke]`, so only if all three pass does the workflow publish the simulator to Pages. The engine's WASM is whatever is committed in daydream (built + installed from Holosphere). If the engine repo is private, add a `POV_TOKEN` secret (a read-access PAT) for the gate's checkout.

The simulator's JavaScript lives in the daydream repo and carries its own suite there: `tests/*.test.js`, run by `npm test` (`node --test`), covering the driver and clock, the sidebar and GUI, the segment workers and layout, param marshaling, color/palette math, and the geometry tools' math modules. Its anti-vacuity checks reject an empty glob, unreachable test files, shadow dependency installs, and unexplained first-party modules without pinning file, case, or assertion totals. On every pull request, [Daydream CI](https://github.com/woundedlion/daydream/blob/master/.github/workflows/ci.yml) runs the reusable static/unit suite and all seven real-browser probes, then reports one required `CI green` status. The deploy workflow calls the same suites before publishing.

### Documentation — Holosphere repo

```bash
just docs-check   # validate tracked Markdown (the ci.yml docs-markdown job)
just docs         # docs-check, then build the Doxygen reference into build/docs/html/
```

The design specs are outside the Doxygen reference and carry their own index:
[`docs/specs/README.md`](https://github.com/woundedlion/pov/blob/master/docs/specs/README.md)
lists each one with its status and says which spec owns which half where two
overlap.

`just docs-check` runs [`tools/docs_check.py`](https://github.com/woundedlion/pov/blob/master/tools/docs_check.py) and its own unit tests: it checks fence balance, link and anchor targets, and backticked repo paths across every tracked Markdown file. The `effects/` row of the file map above draws no subtree, so the exhaustive-tree gate cannot reach its counts; they get their own assertion instead — the header count against the tracked tree, the effect count against `HS_EFFECT_LIST`'s cardinality. The gate is **structural, not semantic**: it reads fences, targets and backticked repo paths, so a green run means the documentation's structure is intact, not that its prose is true. A wrong number in a sentence, a renamed symbol in a table, and any path written without backticks or a link are all outside what it can see; those are on the reader. `just docs` needs `doxygen` on `PATH` at the version `tools/build_pins.py` pins — it runs `build_pins.py --check-tool doxygen` first and refuses any other, because warning text and generated markup move between releases; it clones the pinned doxygen-awesome theme into `.doxygen-awesome/` on first run and synthesizes `Doxyfile.local` from `Doxyfile` plus [`docs/doxygen-theme.cfg`](https://github.com/woundedlion/pov/blob/master/docs/doxygen-theme.cfg) — the same combination `.github/workflows/docs.yml` publishes to <https://woundedlion.github.io/pov/>.

### Running the Simulator — daydream repo

The simulator is a static web app. Serve the daydream directory from any HTTP server:

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

URL parameters control the initial state (mirrored back by `URLSync`, §10.4):
```
?effect=IslamicStars&resolution=Phantasm%20(288x144)
```

**Optional local vendor checkout.** The simulator runs against jsdelivr CDN by default. To work offline (and to get the WebGPU renderer file, which isn't in npm), populate the local vendor dirs:

```bash
cd daydream
npm install              # populates node_modules/lil-gui/
git clone --depth 1 https://github.com/mrdoob/three.js.git
```

After populating them, run `npm run importmap:local` to point [`vendor-importmap.js`](https://github.com/woundedlion/daydream/blob/master/vendor-importmap.js) at the local copies (don't commit the result); `npm run importmap` reverts to all-CDN (§10.8).

**Live demo.** The `master` branch of daydream is published to <https://woundedlion.github.io/daydream/> via GitHub Pages. It serves the committed all-CDN import map.

---

## License

This project is split-licensed: the rendering engine and the visual effects carry different terms.

**Engine — non-commercial.** The core infrastructure — the rendering engine, math, scan/raster, hardware drivers, and test harness, which in the Holosphere repository is everything outside `effects/`, `workbench/` and `core/engine/effects_legacy.h` — is licensed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/) (see [`LICENSE`](https://github.com/woundedlion/pov/blob/master/LICENSE)). You may use, modify, and distribute it for any non-commercial purpose; commercial use is not granted.

**Effects — proprietary.** The visual effects — the Holosphere repository's `effects/`, `workbench/` and `core/engine/effects_legacy.h` sources, and their compiled form in any distributed build artifact, including the `holosphere_wasm.wasm` module daydream ships — are Copyright 2025 Gabriel Levy. All rights reserved. They are not covered by the PolyForm license — no rights to use, copy, modify, or distribute them are granted.

**Per-file notices are a C++ convention only.** The `Required Notice` banner at the top of engine and effect sources is a courtesy for files that travel alone; it is not what grants or withholds rights. Build tooling, generator and gate scripts, and test files — Python, shell, and JavaScript in either repo — deliberately carry no banner, and `tools/license_check.py` gates the C/C++ ones only. Scope is decided by the terms above and by the file's location in the tree, banner or not.

**Third-party.** The engine vendors [FastNoiseLite](https://github.com/Auburn/FastNoiseLite) 1.1.1 as `core/vendor/FastNoiseLite.h` under the MIT License (Auburn / Jordan Peck), patched in tree as recorded in `core/vendor/FastNoiseLite_config.h` (first-party). `core/math/projections.h` carries map projections derived from [PROJ](https://proj.org) under the MIT License (Frank Warmerdam, Gerald I. Evenden, Kristian Evers, Toby C Wilkinson and the PROJ contributors); it sits outside `core/vendor/` because the engine's own projections are developed alongside them in the same header, and `LICENSE` names it as an exception. The simulator vendors one file: `daydream/tools/tailwind.css`, a prebuilt [Tailwind CSS](https://tailwindcss.com) 3.4.17 utility sheet (MIT, Tailwind Labs) served same-origin to the five tool pages, carrying its upstream MIT banner; its preflight reset derives from [modern-normalize](https://github.com/sindresorhus/modern-normalize) (MIT, Sindre Sorhus), itself derived from normalize.css (MIT, Nicolas Gallagher and Jonathan Neal). Everything else the simulator uses loads at runtime: [three.js](https://github.com/mrdoob/three.js) (MIT, three.js authors) and [lil-gui](https://github.com/georgealways/lil-gui) (MIT, George Michael Brower) come from the jsdelivr CDN at the versions pinned in `daydream/package.json` (currently three 0.183.1, lil-gui 0.21.0). The optional self-hosted fonts under `daydream/vendor/fonts/` (Inter and JetBrains Mono, both SIL OFL 1.1) are gitignored and distributed by neither repo.
