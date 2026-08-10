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
| [**daydream**](https://github.com/woundedlion/daydream) | Web simulator | Three.js renderer, the compiled `holosphere_wasm.{js,wasm}` artifacts (output of Holosphere's WASM build), GUI/sidebar, recorder, segmented-POV Web Workers, and standalone geometry tools. |

Building the WASM target in Holosphere installs `holosphere_wasm.js`, `holosphere_wasm.wasm`, this README, and `docs/screenshots/` into the sibling `daydream/` checkout — so both repos always serve the same README. The live demo is daydream served from GitHub Pages.

---

## Table of Contents

1. [Hardware](#1-hardware)
2. [Engineering Philosophies](#2-engineering-philosophies)
3. [Repository Map](#3-repository-map)
4. [Architecture Overview](#4-architecture-overview)
5. [Data Flow: Frame Lifecycle](#5-data-flow-frame-lifecycle)
6. [The Rendering Pipeline](#6-the-rendering-pipeline)
   - [End-to-End Flow](#end-to-end-flow)
   - [Pipeline Domain Transitions](#pipeline-domain-transitions)
   - [The Canvas](#the-canvas)
   - [The Filter Pipeline](#the-filter-pipeline)
7. [Core Subsystems](#7-core-subsystems)
   - [7.0 The Shader Interface](#70-the-shader-interface)
   - [7.1 SDF Shapes and the Scan Rasterizer](#71-sdf-shapes-sdfh-and-the-scan-rasterizer-scanh)
   - [7.2 The Curve Rasterizer](#72-the-curve-rasterizer-ploth)
   - [7.3 The Animation System](#73-the-animation-system-animationh)
   - [7.4 Geometry Transformers](#74-geometry-transformers-transformersh)
   - [7.5 Memory Architecture](#75-memory-architecture-memoryh-memorycpp)
   - [7.6 The Color System](#76-the-color-system-colorh)
   - [7.7 The Mesh System](#77-the-mesh-system-coremesh)
   - [7.8 Generators](#78-generators-generatorsh)
   - [7.9 The Preset System](#79-the-preset-system-presetsh)
   - [7.10 Hardware Drivers](#710-hardware-drivers-dma_ledh-pov_singleh-pov_segmentedh)
     - [Frame Sync Protocol: 1-Wire Signal Datasheet](#frame-sync-protocol-1-wire-signal-datasheet)
8. [The Effect System](#8-the-effect-system)
9. [Effects Reference](#9-effects-reference)
   - [ShaderBall Shader Vocabulary](#shaderball-shader-vocabulary)
10. [The Web Simulator (Daydream)](#10-the-web-simulator-daydream)
    - [10.1 Process and Threading Model](#101-process-and-threading-model)
    - [10.2 The WASM Bridge](#102-the-wasm-bridge)
    - [10.3 The Three.js Renderer](#103-the-threejs-renderer-driverjs)
    - [10.4 Application State](#104-application-state-statejs)
    - [10.5 The Effect Sidebar](#105-the-effect-sidebar-sidebarjs)
    - [10.6 GUI Auto-Generation](#106-gui-auto-generation)
    - [10.7 Segmented POV Workers](#107-segmented-pov-workers-segment_workerjs)
    - [10.8 Vendor Importmap](#108-vendor-importmap-local-first--cdn-fallback)
    - [10.9 Video Recording](#109-video-recording-recorderjs)
    - [10.10 Resolution Presets](#1010-resolution-presets)
    - [10.11 Geometry Tools](#1011-geometry-tools-daydreamtools)
11. [Building](#11-building)

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

The POV effect works because each revolution takes ~125 ms and a new column is painted every `1,000,000 / (RPM/60) / width` microseconds (on Holosphere the IntervalTimer ISR advances one column per fire; on Phantasm each board's flywheel ISR derives the column from the CPU cycle counter — see §7.10). The LED strip is mounted on both sides of a rotating arm: the top half of the strip handles one hemisphere and the bottom half handles the opposite hemisphere, so one full revolution paints a complete sphere.

---

## 2. Engineering Philosophies

The five design decisions below account for much of the engine's structure; the rest of the document assumes them.

### Why 16-bit Linear Color?

Most LED art codebases use gamma-corrected 8-bit values throughout and blend in sRGB space. This produces muddy mixes: red + blue = dark purple instead of magenta. Holosphere blends in linear light (16-bit precision), then gamma-encodes only at the hardware output. The improvement is most visible in soft gradients and multi-layer alpha compositing. Palette interpolation goes a step further into the OKLCH perceptual color space, with shortest-arc hue interpolation that avoids the red→green→blue detour.

### Why Compile-Time Resolution?

Templating on `<W, H>` means every pixel coordinate transform, bounding box computation, and LUT index is resolved at compile time. The hardware target `<96, 20>` runs with no runtime overhead from generality. The simulator builds separate specializations for `<288, 144>`. Each supported resolution is a separate instantiation, so binary size increases in exchange.

### Why Arena Allocation?

The Teensy heap fragments under heavy mesh subdivision. The single-block partitioned arena design (persistent + scratch A + scratch B, 298 KiB total) gives deterministic memory behavior: persistent data allocated once and kept; scratch data RAII-scoped to the function that needed it. The `configure_arenas()` function allows effects to repartition the fixed block based on their needs — mesh-heavy effects can claim more persistent space, while subdivision-heavy effects can expand their scratch pools. All functions take explicit `Arena&` parameters — Conway operators take `(Arena& target, Arena& temp)`, generators take `(Arena& a, Arena& b)` — so the memory layout during heavy geometric operations is explicit at every call site, with no hidden state or implicit arena references.

### Why the ISR Double Buffer?

POV display requires pixel data to be ready before each column interval fires — roughly 434 µs to 1.3 ms depending on resolution at 480 RPM (the per-column period is `1,000,000 / (RPM/60) / W` µs, i.e. ~434 µs for Phantasm's 288 columns and ~1302 µs for Holosphere's 96). A naive approach (rendering in the ISR) would block the main loop. Instead, the main loop renders freely into a back buffer while the ISR reads from a separate front buffer. `queue_frame()` / `advance_display()` synchronize with minimal interrupt-disabled critical sections.

### Why Fail-Fast (`HS_CHECK`)?

On hardware there is no debugger attached and no console to read — a corrupted arena that ships garbage to the LEDs is the worst possible outcome, because the failure is silent and the cause is already gone by the time it shows on the sphere. So invariant violations *trap at the violation site* rather than being masked by bounded fallbacks. `HS_CHECK(cond)` (`platform.h`) compiles to a single predicted-not-taken branch to `__builtin_trap()` and, unlike `assert()`, is **not** stripped by `NDEBUG` — it still fires in the optimized device build, where `NDEBUG` is defined only to keep newlib's `__assert_func`→`fprintf` (and all of stdio) out of the image. It pulls in no stdio of its own.

The rule is deliberate about *where* it goes: `HS_CHECK` guards seams where a violation is a logic or sizing bug with no valid recovery — container growth, arena OOM, capacity and bounds guards at allocation/registration/config sites, plus checked accessors like `StaticCircularBuffer::operator[]`, which runs **per control point** (a trail snapshot, a scanline span), not per pixel. It is kept out of the per-pixel loop, which indexes the raw storage directly — `sdf.h` takes `&buf[0]` once per row and walks the array — and hot paths that need a check use a stripped `assert` backed by a cold trap at the corresponding bind/setup site. One exception is named and deliberate: `angle_between()` (`3dmath.h`) checks both input lengths on every call, and it is reached per pixel — up to four times — from `SDF::Line::distance`, and once per plotted point from `Filter::World::Hole::plot`. The check guards the `sqrtf(m1 * m2)` it immediately divides by, and neither call site has a bind seam that could carry it instead: `Line`'s endpoints are public fields and `Hole::set_origin` does not renormalize, so an effect can move either between frames. Dropping the check would turn a degenerate input into a NaN angle that clamps silently to 0 — a soft degrade, which is the outcome the rule exists to prevent. Genuinely *transient* conditions (a DMA overrun, a dropped frame) are not invariant violations and get bounded/soft handling instead. The native test suite includes a death harness that asserts these traps actually fire (`SIGILL` / `STATUS_ILLEGAL_INSTRUCTION`), so the safety net is verified rather than assumed.

### Coordinate Conventions

- **Y-up Cartesian**: `Vector(x, y, z)` — `y` is the vertical axis
- **Spherical**: `theta` = azimuth (longitude), `phi` = polar angle from +Y (co-latitude)
- **Pixel mapping**: `x ∈ [0, W)` → `theta ∈ [0, 2π)`, `y ∈ [0, H)` → `phi = y·π / (H + H_OFFSET − 1)`
- **`hs::H_OFFSET`** (`platform.h`): virtual rows below the physical LED ring. It is 3 on device, so the bottom physical row lands short of π — the image is clipped, not stretched, where the LEDs stop short of the south pole — and 0 on the host/sim build, which maps the full `[0, π]`. Callers pass the logical `H`; `y_to_phi<H>()` / `phi_to_y<H>()` add the offset internally. `tests/h_offset_renorm_check.cpp` recompiles the engine with the hardware value so the device path is exercised on host
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

### Holosphere (engine + firmware)

<!-- docs-check: tree exhaustive -->
```
├── core/                       Rendering engine
│   ├── engine/                 Machinery: platform layer, memory, callables, rosters, effect support
│   │   ├── platform.h              Arduino vs. WASM vs. Desktop abstraction layer
│   │   ├── platform_arduino_mocks.h Off-device emulation of the Arduino/FastLED API
│   │   ├── profiling.h             Cycle counters + HS_PROFILE / scan-metric macros
│   │   ├── constants.h             MAX_W, MAX_H + ClipRegion segment clip rectangle
│   │   ├── engine.h                Engine API umbrella — included by every effect
│   │   ├── effects.h               Effect roster (includes each effect + HS_EFFECT_LIST)
│   │   ├── effects_legacy.h        Pre-engine effects (TheMatrix, Spirals, etc.)
│   │   ├── effect_registry.h       Self-registering factory: REGISTER_EFFECT macro
│   │   ├── concepts.h              FunctionRef/Fn callable wrappers, PipelineRef type erasure, Tweenable concept
│   │   ├── inplace_function.h      Fixed-capacity in-place callable storage behind Fn
│   │   ├── memory.h / memory.cpp   Arena allocator, ScratchScope, Persist<T>
│   │   ├── static_storage.cpp      Definitions of the framebuffer/timeline statics (DMAMEM placement)
│   │   ├── static_circular_buffer.h Fixed-capacity non-allocating circular buffer
│   │   ├── generators.h            Universal generate() wrapper for procedural geometry
│   │   ├── util.h                  wrap(), fast_wrap(), shortest_distance, apply_if_changed
│   │   ├── transformers.h          Ripple, Noise, Möbius warp geometry transformers
│   │   ├── styles.h                Feedback::Style named presets + space/color transform functions
│   │   ├── presets.h               Generic Presets<Params, Size> template
│   │   └── reaction_graph.h / reaction_graph.cpp  Precomputed Fibonacci-lattice K-NN graph (90 KiB / 92,160-byte table)
│   ├── math/                   Vector/quaternion math and scalar curves
│   │   ├── 3dmath.h                Vector, Quaternion, Spherical, Complex, Möbius math
│   │   ├── rotate.h                Quaternion projection helpers
│   │   ├── geometry.h              PhiLUT/TrigLUT, pixel ↔ vector mapping, pole_wrap, Orientation, Basis
│   │   ├── spherical_field.h       Latitude-ring field layout + bilinear sphere sampling
│   │   ├── easing.h                Easing functions (cubic, sine, elastic, expo, etc.)
│   │   └── waves.h                 sin_wave / tri_wave / square_wave generators
│   ├── mesh/                   Polyhedral meshes and their operators
│   │   ├── mesh.h                  PolyMesh, HalfEdgeMesh, MeshOps (compile, clone, etc.)
│   │   ├── mesh_classes.h          Congruence-class clustering + canonical distance-LUT bake
│   │   ├── spatial.h               KDTree k-nearest-neighbor search, arena-backed MeshState
│   │   ├── conway.h                Conway operators (dual, kis, ambo, truncate, etc.)
│   │   ├── conway_graph.h          Constexpr solid-to-solid operator edge graph + walk helpers
│   │   ├── recipe.h                Recipe lowering to primitive Conway steps + replay
│   │   ├── hankin.h                Hankin pattern compilation and update system
│   │   ├── solids.h                Platonic + Archimedean + Catalan + Islamic solid registry
│   │   └── relax_bakes_generated.h Baked relaxed-mesh vertices (from tools/relax_bakes.py)
│   ├── color/                  Color math and palettes
│   │   ├── color.h                 Pixel (16-bit linear), Color4, blend helpers, palettes
│   │   ├── composition.h           Palette modifiers + StaticPalette composition (via color.h)
│   │   ├── color_luts.h            Precomputed sRGB ↔ linear LUTs
│   │   ├── srgb_decode.h           Branchless linear16 → sRGB8 encode from DTCM split tables
│   │   ├── srgb_decode_lut.h       Generated split-decode tables behind srgb_decode.h
│   │   ├── gamut_lut.h             Generated sRGB gamut-boundary chroma table for OKLab clipping
│   │   ├── generative_palette.h    GenerativePalette + PaletteRecipe compilation (via color.h)
│   │   ├── palette_cycler.h        PaletteCycler: dwell-and-fade display LUT over a palette sequence
│   │   ├── effect_palette_recipes.h Per-effect authored PaletteRecipe constructors
│   │   └── palettes.h              Named ProceduralPalette instances + shared MeshPaletteBank
│   ├── render/                 Canvas, rasterizers, and the filter pipeline
│   │   ├── canvas.h                Effect base class + Canvas RAII write-buffer guard
│   │   ├── scan.h                  Rasterization primitives (Ring, Circle, Star, Mesh, etc.)
│   │   ├── plot.h                  Line/curve rasterizer with geodesic/planar strategies
│   │   ├── filter.h                Composable render pipeline + all Filter::World/Screen/Pix
│   │   ├── sdf.h                   SDF shape primitives, CSG operations, distance queries
│   │   ├── sdf_volume.h            3D volumetric SDF shapes + domain warps for Scan::Volume
│   │   ├── shading.h               Fragment + mesh-topology shading helpers, null shaders
│   │   └── led.h                   LED pin constants + color-correction RAII guards (driver in hardware/pov_single.h)
│   ├── animation/              Timeline scheduler + the animation type families
│   │   ├── animation.h             IAnimation/AnimationBase contract + umbrella over the fragments below
│   │   ├── timers.h                RandomTimer / PeriodicTimer callback timers
│   │   ├── params.h                Parameter-writing animations (Transition, Mutation, Driver, Lerp, ColorWipe, Mobius*, Ripple, Noise)
│   │   ├── motion.h                Path/ProceduralPath + the Orientation drivers (Motion, Rotation, RandomWalk)
│   │   ├── trails.h                OrientationTrail/VectorTrail/QuantizedVectorTrail history + tween/deep_tween traversal
│   │   ├── sprites.h               Sprite draw envelope, Particle/ParticleSystem
│   │   ├── timeline.h              TimelineEvent inline storage + the Timeline scheduler
│   │   ├── opleg.h                 Conway-chain morph legs: OpLeg
│   │   ├── segue.h                 Mesh-to-mesh transition policies: the Segue library
│   │   └── carousel.h              Double-buffered mesh slot pair: MeshCarousel
│   └── vendor/                 Third-party code
│       ├── FastNoiseLite.h         Single-header noise library
│       └── FastNoiseLite_config.h  FastNoiseLite build configuration
│
├── effects/                    26 headers: one per effect (23) plus the shared
│                                ReactionDiffusionBase.h, mindsplatter_palettes.h and
│                                shaderball_projections.h:
│                                BZReactionDiffusion.h, HopfFibration.h, IslamicStars.h,
│                                Raymarch.h, … — see §9 Effects Reference
│
├── hardware/                   Hardware drivers
│   ├── dma_led.h               Non-blocking DMA LED controller for HD107S (Teensy 4.x)
│   ├── dma_led_controller.h    Double-buffered controller templated on its transport (host-testable)
│   ├── dma_led_core.h          Pure double-buffer / transfer-length / stale-transfer math (host-testable)
│   ├── hd107s_frame.h          HD107S protocol buffer + inline color correction (host-testable)
│   ├── pov_segment_map.h       Pure segment index math (host-testable)
│   ├── pov_segment_map.json    Segment→canvas golden emitted from that header; read by daydream's cross-check
│   ├── pov_single.h            Single-Teensy POV driver (Holosphere)
│   ├── pov_single_map.h        Pure single-board strip index math (host-testable)
│   ├── pov_sync.h              Phantasm sync protocol core: flywheel timebase, symbol codec, epoch/beacon (host-testable)
│   ├── pov_handoff.h           Pure effect-handoff state machine for POVSegmented (host-testable)
│   ├── pov_submit_gate.h       Pure LED-submit accept/drop decision for the POVSegmented ISR (host-testable)
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
│   ├── common/
│   │   └── phantasm_target.h   Shared Phantasm-class boilerplate — LED transport, geometry, boot, effect construction
│   ├── Holosphere/
│   │   └── Holosphere.ino      Holosphere entry — NUM_PIXELS=40, RPM=480
│   ├── Phantasm/
│   │   └── Phantasm.ino        Phantasm entry — 4×Teensy, TOTAL_PIXELS=288, RPM=480
│   ├── Profile/
│   │   └── Profile.ino         Single-effect HS_PROFILE harness on segment 0 of the segmented rig
│   └── wasm/
│       ├── wasm.cpp            Emscripten binding TU — includes the binding headers below
│       ├── engine_bindings.h   Render bridge — HolosphereEngine JS class, resolution/effect dispatch
│       ├── mesh_ops_bindings.h Mesh editor bridge — MeshOps JS class, tooling arenas, Conway/Goldberg operators
│       ├── mesh_op_bounds.h    Pure mesh-operator roster + growth factors behind the MeshOps guards (host-testable)
│       ├── palette_bindings.h  Palette bridge — PaletteOps JS class, generative palette LUT bake
│       ├── math_exports.h      Free color/palette/geometry exports the JS tool ports cross-check against
│       ├── arena_metrics.h     Arena metrics report shared by the render and mesh editor bridges
│       ├── param_marshal.h     Pure parameter definition/value marshaling, single ordering source (host-testable)
│       └── wasm_predicates.h   Pure embind boundary validation/clamping predicates (host-testable)
│
├── CMakeLists.txt              Emscripten build (outputs holosphere_wasm.js + .wasm)
├── CMakePresets.json           Canonical presets: wasm-release, wasm-debug, tests
├── cmake/
│   └── toolchain-native-clang.cmake  Native Clang toolchain behind the tests preset
├── platformio.ini              Teensy envs: the two shipping images plus the compile/profiling profiles
├── tests/                      Unit tests (CMake subdirectory)
│   ├── mindsplatter_whitebox.h  White-box MindSplatter accessor shared by its tests and the replay tools
│   ├── mindsplatter_replay_metrics.h  Difference metrics + clip geometry shared by the replay generator and comparator
│   └── mindsplatter_replay_corpus.h  Generated golden replay corpus (emitted by tools/mindsplatter_replay_gen.cpp)
├── scripts/                    Build + CI tooling
│   ├── generate_luts.py        sRGB ↔ linear LUT generator of record (emits core/color/color_luts.h)
│   ├── generate_reaction_graph.py K-NN lattice generator of record (emits core/engine/reaction_graph.cpp)
│   ├── generate_srgb_decode.cpp Split-decode generator of record (emits core/color/srgb_decode_lut.h)
│   ├── effect_roster.mjs       Shared HS_EFFECT_LIST / REGISTER_EFFECT parser for the roster tools
│   ├── effect_roster.test.mjs  Node unit test for both roster parsers
│   ├── check_effect_roster.mjs Cross-checks HS_EFFECT_LIST against the REGISTER_EFFECT calls (CI)
│   ├── wasm_smoke.mjs          Runtime WASM smoke: drives every effect at both resolutions (CI)
│   ├── capture_screenshots.mjs Headless gallery capture for docs/screenshots/
│   ├── screenshot_capture_config.mjs Per-effect capture offsets shared by capture and the CI gate
│   ├── screenshot_capture_config.test.mjs Node unit test for the capture-offset table
│   ├── screenshot_resolution.mjs Browser-free resolution descent: picks the first resolution the app honors
│   ├── screenshot_resolution.test.mjs Node unit test for that descent (fallback, empty list, prefix names)
│   ├── png_probe.mjs           Dependency-free PNG chunk/CRC/inflate validator behind the gallery gate
│   ├── png_probe.test.mjs      Node unit test for the PNG validator (corrupt/empty fixtures)
│   └── check_screenshots.mjs   Asserts docs/screenshots/ matches the effect roster and decodes (CI)
├── tools/                      Firmware gates, device profiling, and asset bakes
│   ├── build_pins.py           Shared external-tool version pins for CI and `just`
│   ├── teensy_gate.py          Size + memory-layout gate parser/classifier (toolchain-free)
│   ├── teensy_gate_extra.py    PlatformIO post-build glue that runs the gate on every link
│   ├── teensy_budgets.json     Per-env FLASH/RAM1/RAM2 budgets the gate enforces
│   ├── teensy_size_table.py    `just teensy-size` wrapper: builds every env + prints the region table
│   ├── teensy_size_trail.py    Per-commit firmware size trail: ELF section parser, recorder, regression report
│   ├── teensy_warnings.py / teensy_warning_baseline.txt  Warning-hygiene ratchet + its baseline
│   ├── teensy_pre.py / teensy_isystem.py / teensy_map.py / teensy_nano.py  PlatformIO build hooks
│   ├── phantasm.ld             Phantasm linker script (memory-region layout)
│   ├── profile_one.sh / profile_sweep.sh  On-device HS_PROFILE flash + capture runs
│   ├── profile_islamic_big.sh  Focused profiling loop for IslamicStars' largest mesh
│   ├── profile_capture.py      Serial capture of the profiling image's readout
│   ├── parse_profile.py        Capture-log parser behind the per-window/per-preset reports
│   ├── device_lock.sh          Host-global per-board lock every device path takes
│   ├── pov_segment_map_export.cpp  Generator for the committed segment-map golden
│   ├── relax_bakes.py / relax_bake_harness.cpp  Relaxed-mesh bake generator of record
│   ├── gen_gamut_lut.py        sRGB gamut-boundary generator of record (emits core/color/gamut_lut.h)
│   ├── mindsplatter_palette_gen.cpp  MindSplatter palette-LUT bank generator of record
│   ├── mindsplatter_replay_gen.cpp  Golden-corpus generator of record (emits tests/mindsplatter_replay_corpus.h)
│   ├── mindsplatter_replay_main.cpp  Replay comparator over that corpus (its fixtures live under tests/)
│   ├── docs_check.py           Markdown fence/link/anchor/path validator (CI)
│   ├── docs_images.py          Stages README images into the Doxygen output and resolves every `<img>` (CI)
│   └── *_tests/                Host unit tests for the gate, hooks, profile parser, bakes, docs checks
├── docs/                       Design specs, perf ledgers, and the docs/screenshots/ gallery
├── Doxyfile                    Doxygen config for the published API reference
├── package.json                npm entry points for the scripts/*.mjs tools (ESM; Node ≥ 22, CI pinned via tools/build_pins.py)
├── package-lock.json           Pinned dependency set behind those entry points
├── .clang-format               LLVM-derived C++ style; CI enforces it with clang-format 18
├── ruff.toml                   Python lint rules (defect classes only, no formatter) — the ci.yml lint job
├── eslint.config.mjs           JavaScript lint rules for scripts/*.mjs (recommended set) — the same job
├── .githooks/                  pre-commit format/test/size gate, post-commit size-trail recorder, and a reference-transaction guard keeping master fast-forward-only
├── .github/workflows/          ci.yml (native, WASM, format, Teensy, provenance), docs.yml (Doxygen → Pages)
├── LICENSE                     PolyForm Noncommercial 1.0.0 (engine); effects/ reserved
└── justfile                    Task runner: `just build` / `test` / `smoke` / `docs` / `install` (`just --list` for the rest)
```

### daydream (web simulator)

<!-- docs-check: tree daydream exhaustive -->
```
├── index.html                  Main simulator page
├── site_manifest.txt           Repo-relative path list deploy.yml publishes to Pages
├── LICENSE                     PolyForm Noncommercial 1.0.0 (engine); effects reserved
├── vendor-importmap.js         Local-first / CDN-fallback importmap helper
├── holosphere_wasm.js          Installed from Holosphere's WASM build
├── holosphere_wasm.wasm        Installed from Holosphere's WASM build
├── holosphere_wasm.sha         Engine commit + tree state the module was built from
├── holosphere_wasm.wasm.sha256 `sha256sum -c` manifest over the installed .wasm and .js — verified by the deploy gate
├── holosphere_wasm.toolchain   emsdk + clang versions that built the module
├── holosphere_wasm.d.ts        Hand-written declarations for the installed glue — what the typecheck sees
├── pov_segment_map.json        Firmware segment→canvas golden, installed from Holosphere — read by the segment cross-check
├── README.md                   Installed from Holosphere (this file)
├── docs/screenshots/           Installed from Holosphere
│
├── bootstrap.js                Dynamic-import boot of daydream.js + failure overlay
├── daydream.js                 App entry: WASM loader, state wiring, GUI/sidebar
├── app_lifecycle.js            Composition-root frame adapter, display-alias heal, Test All
│                                  ticker, segmented spawn epoch, and teardown
├── app_lifecycle.d.ts          Hand-written declarations for app_lifecycle.js — what the typecheck sees
├── engine_host.js              Owns the main-thread WASM engine + its reassignable display state
├── effect_gui.js               Effect panel lifecycle: build, mount, value sync, Export, teardown
├── effect_sequencing.js        DOM-free effect/resolution apply-order and preset rules
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
├── global_stats_view.js        Single-engine stats bar: frame draw duration and per-arena usage
├── segment_controller.js       Orchestrates the segmented-POV worker pool:
│                                  dispatch, generation fence, and compositing
├── segment_worker.js           Web Worker that hosts one WASM instance per
│                                  Phantasm hardware segment (parallel render)
├── segment_layout.js           Pure segment-layout math (Node-unit-testable, no WASM/Worker)
├── segment_stats_view.js       Per-segment timing/arena stats overlay + spawn and fault states
├── worker_protocol.js          JSDoc @typedef contract plus the runtime protocol version
├── styles/                     CSS for the main page and tools
│
├── tools/                      Standalone geometry tools (own HTML pages)
│   ├── lissajous.html          Spherical Lissajous curve designer
│   ├── mobius.html             Möbius transformation visualizer
│   ├── palettes.html           Procedural palette tuner
│   ├── solids.html             Conway operator playground (uses MeshOps bridge)
│   ├── shared.js               Three.js scene boilerplate for the 3D tool pages
│   ├── banner.js               Dependency-free page + fatal-error banners (no Three.js)
│   ├── clipboard.js            Dependency-free copy-to-clipboard helpers
│   ├── copy_text.js            Clipboard API write with a textarea fallback, wrapped by clipboard.js
│   ├── slider.js               Labelled range-slider factory with a live readout
│   ├── color.js                sRGB ↔ linear math mirroring the engine's transfer function
│   ├── cpp_format.js           C++ float-literal formatter shared by the code generators
│   ├── export_params.js        Formatter behind the GUI's Export action
│   ├── flyout.js               Button-controlled flyout with outside-click and Escape dismissal
│   ├── kb_format.js            Dependency-free kilobyte formatter shared by the stat readouts
│   ├── lissajous_math.js       Pure Lissajous curve math from lissajous.html
│   ├── mobius_transforms.js    Pure Möbius coefficient presets from mobius.html
│   ├── page_lifecycle.js       Animation-frame recompute coalescer + bfcache-aware teardown hook
│   ├── palette_canvas.js       Gradient-strip and RGB-wave canvas painters for palettes.html
│   ├── palette_controls.js     DOM-free zoom history and locked-slider delta capping for palettes.html
│   ├── palette_math.js         ProceduralPalette / GenerativePalette mirror + the PaletteOps bridge
│   ├── solid_codegen.js        Op dispatch, codegen, and op-chain sequencing for solids.html
│   ├── solid_op_rows.js        DOM construction for one op-chain row of solids.html
│   ├── solid_registry_codegen.js  Registry-paste emitter: the solids.h Entry, OpStep table, Recipe, and (when solids.h declares none) the seed's SEED_* constant
│   ├── solid_render.js         Scene construction for solids.html: faces, vertices, edges, normals, index labels
│   ├── tailwind.css            Prebuilt utility classes the four tool pages use, served same-origin
│   └── tools.css               Shared design tokens and control styling for the tool pages
│
├── scripts/
│   ├── count-assertions.mjs    NODE_OPTIONS shim counting each test file's node:assert calls
│   ├── generate-importmap.mjs  Bakes the local-vs-CDN decision into vendor-importmap.js
│   ├── report-cases.mjs        node:test reporter tallying per-file case and skip counts
│   ├── require-tests.mjs       `pretest` guard: fails below the committed test-file floor
│   └── run-tests.mjs           `test` script: runs the suite, gates the total it reports
│
├── tests/                      Node unit tests (`npm test`)
├── tsconfig.json               checkJs settings for the worker-protocol module set
├── eslint.config.mjs           JavaScript lint rules (recommended set) — the js-unit-suite.yml lint step
├── .githooks/                  pre-push mirror of the JS unit suite, and a reference-transaction guard keeping master fast-forward-only
├── .github/workflows/          deploy.yml (engine gate → Pages), js-tests.yml / js-unit-suite.yml (npm test)
│
├── three.js/                   Optional vendored Three.js checkout
├── vendor/                     Optional self-hosted fonts (CDN fallback)
├── node_modules/lil-gui/       Optional local lil-gui (npm install)
├── package.json
└── package-lock.json           Committed dependency pin (the optional trees above are gitignored)
```

When the local `three.js/` and `node_modules/lil-gui/` directories are absent (e.g. on the GitHub Pages deploy, and by default), [`vendor-importmap.js`](https://github.com/woundedlion/daydream/blob/master/vendor-importmap.js) resolves libraries from jsdelivr; `npm run importmap:local` switches it to the vendored copies for offline dev. See [§10.8](#108-vendor-importmap-local-first--cdn-fallback).

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
│  │ Phantasm/    │   │  effects/  (23 visual algorithms)            │    │
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

The host-side mock implementations — the `CRGB`/`CHSV` structs plus the rest of the emulated Arduino/FastLED surface (`random8`, `beatsin8`, `SerialMock`, …) — live in `platform_arduino_mocks.h`, included from `platform.h`'s non-Arduino branch.

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

A typical effect frame follows a four-stage pipeline. Not every effect uses every stage — some skip generation entirely, others skip transformations, and a few full-screen shader effects (e.g. ShaderBall, Raymarch) extend `Effect` directly and bypass the filter pipeline altogether — but the available primitives compose along this flow:

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
| `Screen::Trails<MAX_PIXELS>` | Screen-space variant of trail decay; stores 2D coordinates with TTL and redraws via a trail color function. Uses arena-allocated storage (`MAX_PIXELS` capacity, default 1024). |
| `Screen::DirectAntiAliasSink<W, H>` | Terminal stand-in for `Pipeline<W, H, AntiAlias<W, H>>` when no downstream filter is needed: the same four-tap splat and q16 source-over blend, written straight into the framebuffer with row, column and clip resolution hoisted out of the per-sample path. Call `prepare(canvas)` once per frame before the first plot — it caches the framebuffer base and the clip's visible row/column masks. |

#### Pixel-Space Filters

| Filter | Effect |
|---|---|
| `Pixel::Feedback<W, H>` | Style-driven full-screen feedback loop. During `flush()` iterates the full canvas, samples the previous frame from the Canvas front buffer with bilinear interpolation, applies the bound `Feedback::Style`'s spatial transform and color transform with fade, then blends into the back buffer. Frames come from Canvas double-buffering, so the filter holds no frame storage of its own, but it does keep a persistent warp cache: call `init_storage(Arena&)` from the effect's `init()` to reserve `STORAGE_BYTES` from the persistent arena — without it every `flush()` rebuilds the whole control field. The spatial transform is evaluated on a spherical control lattice — latitude rings spaced `DS = style.downsample` rows apart, each carrying a `sin(φ)`-scaled sample count (`W/DS` at the equator) — except in the pole infill bands, the first `DS` rows and the last `max(DS - H_OFFSET, 0)`, which take one ring per row at the full `W/DS` count; ring count, `sample_count()` and `STORAGE_BYTES` therefore all sit above what a flat `(W/DS)×(H/DS)` grid would need. The lattice is then expanded by longitude interpolation into a `W/DS`-column offset field, one row per ring, and bilinearly upsampled while compositing. See `Feedback::Style` below for preset selection. |
| `Pixel::ChromaticShift<W>` | Emits four taps to simulate chromatic aberration: the unmodified source pixel at its sub-pixel `x`, plus single-channel R, G and B copies offset by 1, 2 and 3 columns. Roughly doubles emitted energy — the source tap is kept, not replaced. The three fringe taps are snapped to the rounded integer column while the source tap keeps its sub-pixel `x`. Requires `W >= 4`. |

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
| `Style::MeltingHi()` | Strong downward melt with slow drift and pronounced hue rotation. |
| `Style::MeltingLo()` | Gentle downward melt with slow drift and pronounced hue rotation. |
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

### 7.0 The Shader Interface

All rasterizers — SDF scanline, curve plotting, mesh, volumetric, and full-screen shader — share a common shading model based on the `Fragment` struct and two function signatures.

#### The Fragment

A `Fragment` (`render/shading.h`) is the data packet exchanged between rasterizers and shaders. It carries the pixel position, four general-purpose float registers, and the output color:

```cpp
struct Fragment {
  Vector pos;              // Position (typically a unit vector on the sphere)
  float v0 = 0.0f;        // Register 0: normalized progress t (0–1)
  float v1 = 0.0f;        // Register 1: arc length / distance
  float v2 = 0.0f;        // Register 2: stroke coverage / face ID
  float v3 = 0.0f;        // Register 3: auxiliary
  float size = 1.0f;      // Size metric for normalization
  float age = 0.0f;       // Age (for trail decay / motion blur)
  Color4 color = Color4(0, 0, 0, 0); // Output: shader writes RGBA here; defaults to transparent black (alpha 0.0)
};
```

The registers are *inputs* — populated by the rasterizer before the shader runs. The shader reads them and writes `color`. The rasterizer then forwards the color through the filter pipeline to the canvas.

#### Shader Signatures

Two shader types are defined as zero-allocation `FunctionRef` callables (`concepts.h`):

| Signature | Type | Role |
|---|---|---|
| `FragmentShaderFn` | `void(const Vector &, Fragment &)` | Per-pixel/per-sample shader. Receives the world position and a pre-populated Fragment; writes `color`. Called for every rasterized point. |
| `VertexShaderRef` | `void(Fragment &)` | Per-vertex or per-pixel-center shader. Runs once before sub-sampling to set up expensive shared state in the Fragment registers. Optional on the `Plot::` primitives (a null callable is skipped); required by `Scan::Shader::draw`'s split vertex/fragment overload, which traps on a null one. |

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

**SDF Scanline Path** (`Scan::Ring`, `Scan::Star`, `Scan::PlanarPolygon`, `Scan::Flower`, `Scan::Line`, `Scan::Mesh`):

| Register | Source | Meaning |
|---|---|---|
| `v0` | `DistanceResult.t` | Normalized azimuth (0–1) for `Scan::Ring` and `Scan::Star`; normalized radial position for `Scan::PlanarPolygon`, `Scan::SphericalPolygon` and `Scan::Flower` (polar angle over the shape radius, so it passes 1 outside the body); unused (0) for `Scan::Line` and `Scan::Mesh` faces |
| `v1` | `DistanceResult.raw_dist` | Unsigned distance to shape centerline (for distance-based effects); `Scan::Mesh` faces carry the signed edge distance instead — negative inside the face, in gnomonic plane units — which `fragment_edge_dist()` turns into normalized inward depth as `-v1 / size` |
| `v2` | Set by rasterizer | Stroke AA coverage (0–1, also applied by Scan at plot time), 0 for solid shapes, or face index for `Scan::Mesh` |
| `v3` | `DistanceResult.aux` | Auxiliary — shape-dependent secondary parameter (0 when unused, including faces) |
| `size` | `DistanceResult.size` | Stroke half-width for stroke shapes, or radius or apothem for filled shapes (mesh `Face` floors it at 0.25× the face circumradius, so on a sliver face — whose true inradius approaches zero — the reported size overstates it without bound) |

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

**Curve Plot Path** (`Plot::Line`, `Plot::Multiline`, `Plot::Ring`, `Plot::Polygon`):

| Register | Meaning |
|---|---|
| `v0` | Path progress (0.0 → 1.0 along the full curve) |
| `v1` | Cumulative arc length in radians |
| `v2` | Index of the segment's start vertex, interpolated toward the next index across the segment — only the control points land on whole numbers, interior samples are fractional; `Plot::Ring` writes the strided grid index (stride up to W/8), `Plot::Line` has no interior vertices and writes 0 on every sample, and `Plot::Mesh` writes a constant edge index instead |
| `v3` | Inherited from control-point Fragment (user-defined) |

Plot primitives interpolate registers between control-point Fragments via `Fragment::lerp_registers()`. The vertex shader, if provided, runs once per control point before rasterization. For `Plot::Polygon<Plot::PlanarProjection>`, `Plot::Star<Plot::PlanarProjection>`, and `Plot::Flower`, the rasterizer re-derives `v0`/`v1` from the rendered azimuthal-equidistant arc — which bows longer than the great-circle chord between vertices — so both stay consistent with the drawn position.

**Full-Screen Shader Path** (`Scan::Shader`):

Registers are not pre-populated — the shader receives only `pos` (reconstructed from pixel coordinates). The single-callback overload provides a `Color4(const Vector &)` interface. The two-callback overload separates per-pixel vertex setup from per-subsample fragment evaluation.

**Volumetric Path** (`Scan::Volume`):

The fragment shader receives `pos` set to the closest local-space hit point (in the SDF's coordinate frame) and `size` set to the closest signed distance. No register convention — the shader computes lighting from the local-space position directly.

### 7.1 SDF Shapes (`sdf.h`) and the Scan Rasterizer (`scan.h`)

The rendering pipeline splits shape definitions from rasterization. `sdf.h` defines the SDF shape primitives, each implementing three methods:

1. **`get_vertical_bounds()`** — analytic tight bounding box in pixel-Y space (phi angle range). Only rows within this range are scanned.
2. **`get_horizontal_intervals(y, out)`** — analytic scanline intervals per row. Called per row to skip empty columns without evaluating the distance function.
3. **`distance<ComputeUVs>(p, result)`** — signed distance from a sphere-surface point `p` to the shape boundary, plus texture coordinate and auxiliary data in `DistanceResult`.

`scan.h` contains `Scan::rasterize()`, which drives the scanline loop and anti-aliasing, plus convenience wrappers that pair SDF shapes with the rasterizer.

The `process_pixel` function applies anti-aliasing based on shape type:
- **Solid shapes**: quintic smoothstep over a 2-pixel AA band centered on the edge (`-pixel_width <= d <= pixel_width`). Full interior pixels (`d < -pixel_width`) skip AA math entirely. `pixel_width` is the compile-time constant `2π/W` — the angular width of one *equatorial* pixel — so the band is a fixed angular thickness at every latitude, and near the poles (where columns converge) it spans more than two columns.
- **Strokes**: opacity falloff across the full stroke thickness.

#### SDF Shape Primitives (`sdf.h`)

| Shape | Description |
|---|---|
| `SDF::Ring` | Geodesic circle at a given radius and thickness |
| `SDF::DistortedRing` | Ring with per-azimuth radius perturbation via a callback |
| `SDF::PlanarPolygon` | Regular N-gon in the tangent plane of a basis vector |
| `SDF::SphericalPolygon` | Regular N-gon with geodesic (great-circle) edges |
| `SDF::Star` | N-pointed star using the standard inradius/circumradius construction |
| `SDF::Flower` | Inverted star (N-petal flower shape from the antipodal perspective) |
| `SDF::Line` | Geodesic line segment between two sphere-surface points |
| `SDF::Face` | Planar polygon face (used for mesh rendering) |

The table covers the effect-facing shapes. `sdf.h` also holds internal specializations that only the matching `scan.h` wrapper constructs — `SDF::FlatDistortedRing`, an undisplaced `DistortedRing` with an exact polar centerline distance, is instantiated by `Scan::DistortedRing::draw_flat` and never named by an effect.

#### Volumetric Shapes (`sdf_volume.h`)

The 3D family marched by `Scan::Volume` lives in its own header. It shares the `SDF` namespace but not the scanline contract above: these shapes return a plain `float` distance in Cartesian ray-space, have no vertical bounds or horizontal intervals, and are reached only from the march loop. `sdf.h` does not include `sdf_volume.h`, so an effect that draws only 2D shapes never parses or instantiates it.

| Shape | Description |
|---|---|
| `SDF::Torus` | 3D volumetric torus SDF with configurable major/minor radii (Cartesian ray-space, not a 2D sphere-surface shape) |
| `SDF::Warp::Twist` | Domain warp composed with a volumetric SDF via `SDF::WarpedVolume<Shape, Warp>` — e.g. `WarpedVolume<Torus, Warp::Twist>` twists a torus by oscillating Y around the ring azimuth, with an analytic Lipschitz bound for safe sphere-tracing (used by Raymarch) |

#### CSG Operations (`sdf.h`)

Shapes can be combined using Constructive Solid Geometry:

```cpp
SDF::Union<Ring, Line>           // min(d_A, d_B)
SDF::SmoothUnion<Line, Line>     // smooth minimum with blending radius
SDF::Subtract<Ring, PlanarPolygon> // max(d_A, -d_B)
SDF::Intersection<Ring, Line>    // max(d_A, d_B) with interval intersection
SDF::AngularRepeat<Shape>        // N-fold angular repetition around an axis
```

`Union`, `SmoothUnion` and `Intersection` require both children to share
`is_solid`; a solid+stroke mix routes one winner through the wrong AA branch and
is rejected at compile time. `Subtract` tracks the minuend's solidity, so a
solid carved by a stroke (or the reverse) is legal. `SmoothUnion` adds a second
compile-time rule, `blends_smoothly`: its weld term needs a real signed distance
outside the surface, so `Ring`, `DistortedRing`, `FlatDistortedRing` and `Face`
— which clamp to a far sentinel past their reject band — cannot be its children,
directly or nested inside a combinator.

#### Scan Rasterization Primitives (`scan.h`)

Convenience structs that construct an SDF shape and rasterize in a single `draw()` call:

| Primitive | Description |
|---|---|
| `Scan::Ring` | Rasterizes a ring (from `SDF::Ring`) |
| `Scan::RingGroup` | Fused single-pass rasterizer for a small group of rings — one scan over the union band paints every member in slot order, so the per-row interval math runs once instead of per ring. Fragments carry position, stroke coverage and size only (no UVs, no raw distance) |
| `Scan::Circle` | Disc (ring with radius-wide thickness) — stroke coverage ramps quintically from center to rim, and the shader styles it from register 2 |
| `Scan::Point` | Dot at a sphere-surface position, with the same center-to-rim coverage ramp |
| `Scan::Line` | Geodesic line segment between two points |
| `Scan::Star` | N-pointed star shape |
| `Scan::Flower` | N-petal flower shape |
| `Scan::DistortedRing` | Ring with per-azimuth radius perturbation |
| `Scan::DistortedRingStack` | Fused single-pass rasterizer for an evenly spaced same-axis stack of distorted rings — the per-pixel frame every ring shares is computed once and the candidate rings fall out of its polar angle by arithmetic; the shader takes a ring slot alongside the fragment |
| `Scan::PlanarPolygon` | Regular N-gon in the tangent plane |
| `Scan::SphericalPolygon` | Regular N-gon with geodesic (great-circle) edges |
| `Scan::Mesh` | Rasterizes all faces of a `MeshState` or `PolyMesh` |
| `Scan::Shader` | Full-screen per-pixel shaders with configurable SSAA (super-sample anti-aliasing), across three entry points. `draw(canvas, shader)` takes a single fragment shader. `draw(canvas, fragment_shader, vertex_shader)` separates a per-pixel vertex shader (called once at pixel center) from a per-subsample fragment shader (called SAMPLES×), so expensive per-pixel work is computed once — both callables are required, and a null one traps. No shipping effect takes this path; the SSAA reaction-diffusion effects use `draw_grid`. `draw_grid(canvas, vertex_shader, pixel_shader)` hands the seeded fragment and the row's sub-pixel grid to a templated pixel shader that owns the sampling and returns the finished pixel (used by BZReactionDiffusion). |
| `Scan::TransformedVolume` | Wraps an SDF shape with a world-space position and orientation quaternion for volumetric rendering |
| `Scan::Volume` | Volumetric ray-marcher that steps along the view direction through a `TransformedVolume`, applying a fragment shader at the hit point with configurable step count and AA width |

#### Near-Pole Azimuthal LOD

A row at colatitude φ has horizontal pixel pitch `sin(φ)` times the vertical, so `1/sin(φ)` columns share one physical LED footprint and need only one shade between them. The scan walk offers those columns as a block of `pole_lod_aggressiveness / sin(φ)` (`constants.h`, clamped to `POLE_LOD_MAX_RUN = 32`), and the sink settles the whole block from one probe wherever the probe can vouch for it. Only full canvas-aligned blocks are offered — partial blocks at clip or span edges go per column — so a column shades identically whichever segment renders it.

`pole_lod_aggressiveness` is a hardware-calibrated knob, not a derived constant: the true masking width depends on the LED's angular size and the per-column exposure. 1.0 tracks the footprint exactly; smaller values stay inside it; 0 makes every offer one column and the walk bit-identical to an undecimated one. It defaults to 0 (`HS_POLE_LOD_DEFAULT`). Firmware compiles it in as a `constexpr` with no setter — at the default, the decimation branches fold away entirely — while host and WASM builds keep it mutable so it can be tuned live (§10.2 `setPoleLod`).

### 7.2 The Curve Rasterizer (`plot.h`)

For drawing lines, curves, and paths, the `Plot` namespace provides a geodesic/planar rasterizer with adaptive step size. Each sub-step is sized from the curve's full 2-D screen-space speed (`sqrt(vx² + vy²)`, combining longitudinal and latitudinal motion), so samples land roughly one pixel apart everywhere on the curve regardless of latitude. The step is clamped to keep the equator near one sample per column and floored near the poles — where screen speed diverges — so pole oversampling stays bounded.

```cpp
Plot::Line::draw<W, H>(pipeline, canvas, start, end, fragment_shader);
Plot::Multiline::draw<W, H>(pipeline, canvas, vertices, fragment_shader);
```

All `Plot` primitives accept a `Fragments` array (an arena-backed `ArenaVector<Fragment>`) where each fragment carries position, texture registers (v0–v3), age, and color.

- **Edge interpolation** — how consecutive fragments are joined. *Geodesic* (the default) walks the great-circle arc between endpoints; *planar* interpolates along an azimuthal-equidistant straight line in a basis's tangent plane (for effects that live in a 2D local space). This is selected by whether a **planar basis** is supplied to the draw call (`null` ⇒ geodesic).

#### Sampling Policy

`rasterize` takes a `RasterSamplingPolicy` template parameter setting the adaptive sample density. `DEFAULT` targets `SCREEN_STEP_PX` (0.9 px) and compiles the alternative away; `BALANCED` always trades samples for speed; `SELECTABLE` defers the choice to `RasterOptions::balanced_sampling`, so one instantiation serves both and the policy is picked per draw call. Only the single-pass rasterizer reads it — the cached-replay path always samples at the default density.

Balanced sampling stretches each adaptive step by `BALANCED_SCREEN_STEP_PX / SCREEN_STEP_PX` (1.25×), clamped to one base step (2π/W) and left exact below the pole floor (`MIN_POLE_SCALE * BALANCED_POLE_GUARD_SCALE` base steps), where spacing is already at its minimum. Two consequences:

- **Emitted alpha changes.** Sparser samples lay down less coverage per unit arc, so each fragment's alpha is scaled by `balanced_sample_alpha()` — gain `1 + (ratio - 1) * (0.88 - 0.20 * alpha)`, saturating at 1, with `ratio` the balanced step over the default step. The gain shrinks as alpha rises because opaque samples compound less; it is a linear fit to source-over accumulation, close to exact below alpha 0.4 and over-boosting above it, so a stroke past alpha ~0.85 saturates at 1 and loses its soft edge. A balanced draw is not pixel-identical to a default one.
- **Step evaluation is reused.** Where the walk is locally straight and clear of the poles (tangent dot > 0.995, step change under 10%, step under 0.9 base steps), the next sample recomputes position only and carries the previous step forward, skipping the tangent and the screen-velocity step.

`ShapeShifter` is the sole caller: `SELECTABLE`, on for policy-selected stars at 32 or more contours and off for every other primitive.

#### Plot Primitives

| Primitive | Description |
|---|---|
| `Plot::Line` | Geodesic line segment between two points |
| `Plot::Multiline` | Connected line strip from a sequence of fragments |
| `Plot::Ring` | Circle rasterized as a plotted polyline |
| `Plot::Polygon<Plot::PlanarProjection>` | Regular N-gon in the tangent plane |
| `Plot::Polygon<Plot::GeodesicProjection>` | Regular N-gon with geodesic (great-circle) edges |
| `Plot::DistortedRing` | Ring with per-azimuth radius perturbation via callback |
| `Plot::Star<Projection>` | N-pointed star with planar or geodesic edges |
| `Plot::Flower` | N-petal flower shape |
| `Plot::Mesh` | Wireframe mesh rendering with edge deduplication. The dedup bitset holds `DEDUP_CAPACITY = 128` vertices; a larger mesh traps as its faces are walked — at setup for `extract_edges()`, but every frame at render time for `draw()`. Conway operators pass 128 vertices within two or three ops, so a wireframe fed from an `OpLeg` chain must keep its vertex count under the cap |
| `Plot::ParticleSystem` | Particle trail rendering from `QuantizedVectorTrail` history |

### 7.3 The Animation System (`animation.h`)

The `Timeline` class manages a list of running `IAnimation` objects. Each frame, `timeline.step(canvas)` advances all active animations. Finished animations are removed; repeating animations are rewound. All animation types inherit from `AnimationBase` and support method chaining via `.then()` for sequencing.

`animation.h` defines the contract every animation implements — `IAnimation`, the CRTP `AnimationBase`, and `Animation::Space` — and then includes nine fragment headers grouped by what they animate:

| Header | Subject | Contents |
|---|---|---|
| `timers.h` | Callbacks on a clock | `RandomTimer`, `PeriodicTimer` |
| `params.h` | A caller-owned parameter, written each frame | `Transition`, `Mutation`, `Driver`, `Lerp`, `ColorWipe`, the `Mobius*` family, `Ripple`, `Noise`, `BallDrop`, `NoiseProduct` |
| `motion.h` | An `Orientation` driven through space | `Path`/`ProceduralPath`, `Motion`, `Rotation`, `RandomWalk` |
| `trails.h` | Recorded history | `OrientationTrail`, `VectorTrail`, `QuantizedVectorTrail`, the `tween`/`deep_tween` traversals |
| `sprites.h` | Visible things | `Sprite`, `Particle`/`ParticleSystem` |
| `timeline.h` | Scheduling | `TimelineEvent`, `Timeline` |
| `opleg.h` | One Conway-chain morph leg, swept per frame | `OpLeg` |
| `segue.h` | How one mesh hands the sphere to the next | the `Segue` policies |
| `carousel.h` | Two persistent mesh slots + arena compaction | `MeshCarousel` |

The fragments compile only inside `animation.h` (a direct include fails with an `#error`); consumers include `animation.h` alone. Their types span three scopes rather than one: the animations themselves are in `namespace Animation`; the transition policies are in `namespace Segue`; and `TimelineEvent`/`Timeline`, `MeshCarousel`, `Path`/`ProceduralPath`, and the `tween`/`deep_tween` traversals sit at global scope.

#### Animation Types

| Type | Description |
|---|---|
| `Rotation<W>` | Quaternion rotation of an `Orientation` around an axis, with optional repeat. Supports World and Local coordinate spaces. |
| `RandomWalk<W>` | Continuously perturbs an `Orientation` with smoothly changing random angular velocity driven by Perlin noise. Configurable via `Options` presets (Languid, Energetic). |
| `Motion<W, CAP>` | Moves an `Orientation` along a `Path` or `ProceduralPath` (the path is a constructor argument; `CAP` is the orientation sub-frame capacity, default 4) |
| `Sprite` | Calls a draw function over a duration with fade-in and fade-out envelopes |
| `PeriodicTimer` | Fires a callback at regular intervals (once or repeatedly) |
| `RandomTimer` | Fires a callback after a random delay within a min/max range |
| `Transition` | Smoothly interpolates a float variable from its current value to a target over a duration with easing |
| `Mutation` | Applies a custom scalar function to a float variable over time with easing |
| `Driver` | Continuously increments a float variable each frame (wraps at 0..1) |
| `Lerp` | Type-erased interpolation between any `T` that implements `lerp(start, target, t)`. The caller owns start, subject, and target data; Lerp holds pointers and a type-erased lerp function. |
| `ColorWipe` | Smoothly interpolates a `GenerativePalette` toward a target palette |
| `ParticleSystem<W>` | Physics simulation with emitters, attractors, friction, gravity. Particles have `QuantizedVectorTrail` history for trail rendering. |
| `Ripple` | Animates a `RippleParams` to expand a Ricker wavelet across the sphere |
| `MobiusWarp` | Animates `MobiusParams` to apply and release a Möbius transformation |
| `MobiusWarpCircular` | Animates `MobiusParams` for a circular warp that stays warped throughout, suitable for repeating effects |
| `MobiusWarpEvolving` | Continuously modulates `MobiusParams` over multiple frequencies for a non-repeating, evolving warp |
| `MobiusFlow` | Animates `MobiusParams` for a continuous loxodromic flow |
| `Noise` | Animates `NoiseParams` over time for flowing distortion fields |
| `BallDrop` | Animates a `BumpParams` to drop one spherical-cap bump from the north pole to the south along a fixed meridian, ramping the footprint envelope so the bump emerges from and vanishes into the poles |
| `NoiseProduct` | Integrates the time axis of a `NoiseProductParams` (`time += speed` per frame) to flow a two-octave product-noise field; perpetual |
| `OpLeg` | Animates one leg of a mesh operator chain: a Conway-operator parameter sweep along a `ConwayGraph` edge or recipe step, a hankin contact-angle sweep on a fixed seed, a relax or medial slerp, or a gated partition swap. Each frame it rebuilds the swept mesh in scratch, compiles it, attaches the leg's hoisted congruence classification, pre-blends the (from, to) palette ramps at the leg's crossfade weight, and hands the mesh to a draw callback — exactly one mesh drawn per frame. Each leg's `.then()` completion handler schedules the next, so a run of legs walks a whole morph path. |
| `MeshCarousel<SegueT>` | Double-buffered mesh transition system, parameterized on a compile-time segue policy (`namespace Segue`) that owns the transition's animation scheduling via `schedule_segue()` and shapes its rendering through phase-driven hooks (`opacity`/`fill`/`grade`, plus optional `warp`, per-face sweep ordering, and `retarget` for per-transition anchors). Manages a pair of `MeshState` buffers and exposes the front index (`front_index`/`set_front`); the flip itself belongs to the effect, which builds the incoming mesh into the back slot, calls `set_front` on it, and only then calls `schedule_segue` — so the sprite's captured slot index already names the new shape. `schedule_segue` enforces that ordering with an always-on `HS_CHECK` that the passed slot is already the front index, and forwards an optional pause gate to the policy's `schedule()` hook — a signature the `Segue::Schedulable` concept pins so no policy can shadow it with a shorter one. The concept sees the arity only; a policy taking the gate and never passing it on is caught by test (`test_segue_policies_forward_pause_gate`), which steps each policy's sprite under a set flag and requires the envelope to hold. `Segue::Crossfade` schedules one fading `Animation::Sprite` per transition and returns a next-transition delay that makes consecutive sprites **overlap**: each transition fades only its own incoming shape in (and back out), while the previous transition's sprite — still alive in its fade-out tail — keeps drawing the outgoing shape; no single call ever draws both meshes, but two are rasterized per overlap frame. The overlap length is configurable via the policy's `overlap` member (frames, clamped to the fade window; negative — the default — selects the full window, and `0` makes the schedule sequential so a single mesh renders per frame). `Segue::Dissolve` overlaps the same way but hands the two draws complementary `DissolveMask`s (same threshold and salt, opposite `invert`), so they partition the wireframe's edges and the overlap frame still costs one mesh's scan; it is the only policy that partitions rasterizer work rather than fragments in the shader, so effects pass its masks to `Plot::Mesh::draw`'s edge-list overload themselves — the only entry point that takes a mask, which is why a solid-mesh pair cannot dissolve. Every other segue is **sequential** (one mesh per frame): `IrisBloom` (faces contract to glowing center points, then the new tessellation blooms out), `Lace` (fill drains to a glowing edge band and floods back), `TerminatorSweep` (a day/night line pinned to the mesh sweeps across it at constant speed; once the line reaches a face, that face fades over a per-face random length in the live `fade_frames_min`/`fade_frames_max` range, fraying the front), `Shockwave` (an expanding wave erases outward from a point; its echo redraws), `Breakdown` (the pattern breaks down one topology class at a time — every face of a color family fades together, classes in a random order reshuffled per swap, each fully gone before the next starts), `SpinFlip` (rigid spin-up, swap hidden in POV motion blur), and `GoldConvergence` (palettes converge to molten gold around the swap). Used by IslamicStars (fixed to `Segue::TerminatorSweep`); HankinSolids keeps a single mesh and drives `OpLeg` directly instead, and DreamBalls uses `Segue::Crossfade` standalone with no carousel, at `overlap = 0` — the sequential case above, so its sprite hand-off never has two meshes on screen at once. |

#### Orientation and Motion Blur

`Orientation<CAP>` stores a history of up to `CAP` quaternions (default 4) accumulated during one frame step. The template parameter is the history *capacity*, not the display width — effects use a small value like `Orientation<16>`, never `Orientation<288>`. The `World::Orient` filter iterates over this history to distribute motion blur: each point is plotted once per orientation step, with the `age` field increasing backward in time. This means fast-rotating effects naturally show streak-like motion blur with no extra code.

```cpp
timeline.add(0, Animation::Rotation<W>(orientation, Y_AXIS, 2 * PI_F, 600, ease_linear, true));
// orientation.orientations[] now grows by 1 per sub-step
// World::Orient distributes all steps → motion blur
```

`Orientation::upsample(count)` resamples the orientation history to a higher resolution via SLERP. This is used to rewrite the history when combining multiple animations for accurate parallel sub-frame path tracing — ensuring that concurrent rotations, motions, and walks all contribute to a single coherent set of intermediate orientations.

#### OrientationTrail

`OrientationTrail<OrientationType, CAPACITY>` maintains a circular buffer of past `Orientation` snapshots, allowing effects to recall where an object was over previous frames. Each snapshot is a full `Orientation` (with its own sub-frame history).

#### VectorTrail and QuantizedVectorTrail

`VectorTrail<CAPACITY>` maintains a circular buffer of past world-space `Vector` positions — 12 B per sample, stored exactly. Used by HopfFibration for its per-fiber trails.

`QuantizedVectorTrail<CAPACITY>` is the unit-sphere variant: each sample is three snorm16 components (6 B, half of `Vector`), clamped to [-1, 1] on record and decoded by value on `get()`, so the round-trip error is at most 1/65534 per component. Used by `ParticleSystem` to record per-particle trajectories for trail rendering.

#### `tween` and `deep_tween`

Two traversal helpers linearize multi-level orientation history into a single callback loop:

| Function | Input | Description |
|---|---|---|
| `tween(orientation, callback)` | `Orientation<CAP>` | Iterates over the sub-frame quaternion history of a single orientation, calling `callback(quaternion, t)` for each step with `t ∈ (0, 1]`. Sub-frame 0 is the pose carried over from the previous frame's end and is skipped unless it is the only snapshot (which reads `t = 1`, age-neutral). Used by `World::Orient` to distribute motion blur. |
| `deep_tween(trail, callback)` | `OrientationTrail` (any `Tweenable`) | Flattens a trail of orientations into a single continuous traversal, calling `callback(quaternion, t)` with a global `t` spanning all frames and sub-frames. Used by the orientation-trail effects (Comets, ChaoticStrings, RingSpin) for rendering trails with full sub-frame accuracy. A bare `Orientation` has no per-frame structure to flatten and is rejected by the `Tweenable` concept — use `tween` for that. |

#### Animations and Mutable State

Animations do not render directly — they mutate external state that the rendering pipeline reads. Each animation type targets a specific kind of mutable variable:

| Animation | Target State | What It Mutates |
|---|---|---|
| `Rotation`, `RandomWalk`, `Motion` | `Orientation<CAP>` | Quaternion orientation — pushes sub-frame steps into the orientation history, which `World::Orient` reads for motion blur |
| `Transition` | `float*` | Smoothly interpolates any float parameter (e.g. `speed`, `alpha`, `twist`) from current value to target with easing |
| `Mutation` | `float*` | Applies an arbitrary scalar function `f(t)` to a float over time (more general than `Transition`) |
| `Driver` | `float*` | Continuously increments a float each frame, wrapping at 0..1 — used for phase accumulators |
| `Lerp` | `T*` (type-erased) | Interpolates any type with a `lerp()` function — `MeshState`, params structs, etc. The caller owns start, subject, and target; Lerp holds pointers |
| `ColorWipe` | `GenerativePalette*` | Interpolates palette keys toward a target palette in OKLCH along coherent hue arcs |
| `Ripple`, `MobiusWarp`, `Noise` | `TransformerParams` | Animate transformer parameters (expansion radius, warp strength, noise scale) which the transformer pool reads during `MeshOps::transform()` |
| `BallDrop` | `BumpParams` | Walks the bump center down a meridian and re-derives the push axis from the stack's orientation, ramping the footprint envelope; the field pool sums the caps during `field()` |
| `NoiseProduct` | `NoiseProductParams` | Advances the field time axis so the two-octave product noise keeps flowing under live speed edits; the field pool reads it during `field()` |
| `ParticleSystem` | `Vector[]` positions | Physics simulation updates particle positions; `QuantizedVectorTrail` records history for trail rendering |

This separation means effects declare *what state exists* (orientations, floats, palettes) and *what animations drive that state* (rotations, transitions, drivers), but never manually interpolate or update values per-frame. The `Timeline` handles all timing, easing, sequencing, and cleanup:

```cpp
// Effect declares mutable state:
Orientation<16> orientation;   // CAP is the sub-frame capacity, not the display width
float twist = 0.0f;
GenerativePalette palette;

// Timeline drives state via animations:
timeline.add(0, Animation::Rotation<W>(orientation, Y_AXIS, 2 * PI_F, 600, ease_linear, true));
timeline.add(0, Animation::Transition(twist, 2.5f, 1000, ease_in_out_cubic));
timeline.add(0, Animation::ColorWipe(palette, target_palette, 2000, ease_linear));

// Rendering reads state — no manual updates needed:
void draw_frame() {
    Canvas canvas(*this);
    timeline.step(canvas);  // all state updated automatically
    // orientation, twist, palette are now current-frame values
    filters.plot(canvas, v, palette.get(t), ...);
}
```

### 7.4 Geometry Transformers (`transformers.h`)

Transformers deform the sphere geometry before rendering. The `Transformer<ParamsT, AnimT, TransformFunc, CAPACITY>` class manages a pool of active transform instances, each with its own animated parameters:

```cpp
template <int CAPACITY>
using RippleTransformer = Transformer<Animation::RippleParams, Animation::Ripple,
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

Transformers integrate with the `MeshOps::transform()` pipeline and can be chained: `MeshOps::transform(input, output, arena, ripple_transformer, orient_transformer)`. `transform()` takes any callable with a `transform(Vector)`, so a pool specialization and a plain adapter compose in the same call.

#### Displacement Fields

`FieldTransformer<ParamsT, AnimT, FieldFunc, CAPACITY>` is the scalar counterpart: entities superpose by summation instead of composing as warps, so an effect can feed the summed field into a displacement path (e.g. a `DistortedRing` shift LUT). `field(p)` sums the active entities; `field_bound()` returns a per-frame upper bound on `|field()|` for sizing conservative culls. Where overlapping bodies must dominate instead of stacking, feed the per-entity values through `DominantFieldAccumulator`, which blends them magnitude-weighted (`sum(s³)/sum(s²)`).

| Field | Effect |
|---|---|
| `BallDropTransformer` | Spherical-cap bumps that fall pole-to-pole through a frame, bowing the surface away from each cap |
| `NoiseProductTransformer` | Two-octave product noise where octave 1 envelopes octave 2, so perturbations bunch where the envelope runs strong |

#### Pool Lifecycle

Both classes derive from `TransformerPool`, which fixes the call order:

1. `init_storage(Arena&)` — from the effect's `init()`, after any `configure_arenas()` and before the first spawn.
2. `spawn(in_frames, args...)` — the returned pointer is transient; use it at the call site, not across frames.
3. `spawn_pinned(in_frames, args...)` — same, but the pointer may be retained (e.g. registered as a live GUI param). Valid only for an animation that never completes on its own — infinite, or repeating (it rewinds rather than reaching `done()`) — and is added before any finite timeline event, so compaction cannot shift it.
4. `prepare_frame()` — each frame before `transform()` / `field()`, whenever active params changed through animation or live config. The composition reads that prepared state but cannot verify it is current. Its per-entity hooks (`refresh_from(const ParamsT&)` for live config, `sync()` for derived state) are found by detection, so every `ParamsT` must declare one bool per hook — `static constexpr bool NEEDS_REFRESH_FROM` and `static constexpr bool NEEDS_SYNC` — each true only when that hook is carried. Either mismatch is its own `static_assert`, which is what turns a renamed or signature-drifted hook into a compile error instead of a silently unrefreshed entity.
5. `reclaim_storage(Arena&)` — from the after-reset callback of an arena that is compacted mid-effect (e.g. a mesh carousel). Spawned animations hold `Params` references into the slots, so the caller must replay the same allocation order after the reset as after `init_storage()`; the re-claimed blocks must land at their original addresses (asserted). A reset only rewinds the offset, so the untouched bytes carry live entities through.

#### Standalone Utilities

`OrientTransformer<CAP>` (`transformers.h`) is a plain adapter struct, not a `Transformer<>` specialization: it holds a reference to an `Orientation<CAP>` and applies `orientation.orient()` to each vertex. It has no pool, no params and no lifecycle — effects construct one on the stack at the call site (a deduction guide takes `CAP` from the orientation) and hand it straight to `MeshOps::transform()`.

`stereo_noise_warp()` (`transformers.h`) is a free function, not a `Transformer<>` specialization — it is called directly by effects rather than managed through the transformer pool. It takes an already-projected stereographic coordinate `z` (a `Complex`) plus its precomputed `r_sq` (|z|²) — the caller does the `stereo()` projection — and adds FastNoiseLite-driven displacement attenuated near the projection pole. Returns a `StereoWarpResult` containing the warped coordinate and displacement magnitude (used for hue shift by ShaderBall).

### 7.5 Memory Architecture (`memory.h`, `memory.cpp`)

A single contiguous memory block (`GLOBAL_ARENA_SIZE = 298 KiB`) is partitioned into three arena allocators. This block is the same size on both Teensy and WASM targets. Individual effects can call `configure_arenas()` to repartition the block at runtime.

| Arena | Default Size | Purpose |
|---|---|---|
| `persistent_arena` | 266 KiB | Long-lived compiled mesh data, persists across frames |
| `scratch_arena_a` | 16 KB | Short-lived intermediate geometry (RAII scoped) |
| `scratch_arena_b` | 16 KB | Secondary scratch for ping-pong subdivision passes |

The native unit-test build (`-DHS_TEST_BUILD`, §11) is the one exception: it raises `GLOBAL_ARENA_SIZE` to 8 MiB — and with it the persistent default, which is whatever the two 16 KB scratch arenas leave — so the smoke harness can render every effect without OOMing. The device budget stays reachable as `DEVICE_GLOBAL_ARENA_SIZE` / `DEVICE_PERSISTENT_BUDGET`, which the per-effect footprint `static_assert`s check against instead, so an effect that outgrows the device still fails in the host suite.

Effects that need more scratch memory can repartition at init time:

```cpp
// The three sizes must not exceed GLOBAL_ARENA_SIZE (298 KiB on device); an
// over-subscribed partition traps at init() via HS_CHECK rather than silently
// scaling down. Under-subscription is allowed (the surplus is just unused),
// but partitioning the full budget is the norm. Here scratch is doubled at the
// expense of persistent space:
configure_arenas(234 * 1024, 32 * 1024, 32 * 1024);  // 234 + 32 + 32 = 298 KiB
```

A global that caches a pointer into arena storage registers an `ArenaResetHook` beside itself, and drops the pointer from the callback. `configure_arenas()` and the mesh carousel's compaction run the whole list before handing the storage out again, so the owner never has to be named by the allocator:

```cpp
inline void release_gamut_lut() { g_gamut_lut = GamutLut{}; }
inline const ArenaResetHook GAMUT_LUT_RESET_HOOK(release_gamut_lut);
```

`ScratchScope` provides stack-like RAII lifetime:

```cpp
{
    ScratchScope scratch_a_guard(scratch_arena_a);  // save offset
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

Conway operators take `(Arena& target, Arena& temp)`, generator functions take `(Arena& a, Arena& b)`, and `classify_faces_by_topology` takes `(Arena& scratch_a, Arena& scratch_b, Arena& persistent)`. This purely functional approach makes the memory layout during heavy geometric operations explicit at every call site.

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
| `ArenaVector<T>` | Arena-backed vector whose capacity is fixed between `bind()` calls — appending never grows it (`push_back` traps at capacity). A `bind()` that asks for more re-reserves and abandons the old block until the arena is reset. Copy-disabled, move-enabled. Debug builds detect use-after-free via arena generation tracking. |
| `ArenaSpan<T>` | Non-owning read-only view into an `ArenaVector` (explicit borrow) |

### 7.6 The Color System (`color.h`)

All internal color data is **16-bit linear light** (`uint16_t r, g, b` in range 0–65535). This avoids the precision loss and incorrect blending that occurs with gamma-encoded 8-bit values.

The conversion pipeline:
```
Input (sRGB 8-bit) → sRGB→linear LUT → Pixel (linear 16-bit) → blend ops
                                                                      ↓
FastLED output ← CRGB(gamma encode) ← linear→sRGB ← Pixel
```

`Color4` wraps `Pixel` with a float alpha channel. The canvas sink composites with a single straight-alpha "over" operation — `blend_alpha(α)`, i.e. `dst = src * α + dst * (1-α)`, applied in 16-bit linear light (see `filter.h`). There is no selectable blend-mode tag.

#### Palette Types

| Type | Description |
|---|---|
| `ProceduralPalette` | Cosine palette: `a + b*cos(2π*(c*t + d))` per channel. Defined by 4 vec3 coefficients. |
| `Gradient` | OKLCH interpolation between a sorted list of (position, color) stops. |
| `GenerativePalette` | Procedurally generated palette from harmony rules (triadic, analogous, etc.) combined with brightness/saturation profiles. Supports snapshot/lerp for animated transitions. |
| `SolidColorPalette` | Constant color, adapts to the `Palette` interface. |

Twenty-seven named `ProceduralPalette` instances are pre-defined in the `Palettes` namespace: `DARK_RAINBOW`, `BLOOD_STREAM`, `VINTAGE_SUNSET`, `RICH_SUNSET`, `UNDERSEA`, `LATE_SUNSET`, `MANGO_PEEL`, `ICE_MELT`, `LEMON_LIME`, `ALGAE`, `EMBERS`, `FIRE_GLOW`, `DARK_PRIMARY`, `MAUVE_FADE`, `LAVENDER_LAKE`, `DESERT_ROSE`, `BRUISED_MOSS`, `BRUISED_BANANA`, `BRIGHT_SUNRISE`, `FIRE_AND_ICE`, `PEACH_POP`, `POPPED_PEACH`, `BLUE_LAGOON`, `ORANGE_CRUSH`, `PLUM_SUNRISE`, `CORAL_BLUE`, and `BRUISED_MANGO`. Six of them — `EMBERS`, `RICH_SUNSET`, `BRIGHT_SUNRISE`, `BRUISED_MOSS`, `LAVENDER_LAKE`, `POPPED_PEACH` — are the slots of `MeshPaletteBank`, the shared baked bank the mesh effects draw from.

#### OKLCH Perceptual Color

Palette interpolation is performed in the OKLCH perceptual color space: both `Gradient` (color-stop interpolation) and `GenerativePalette` (harmony-key interpolation and animated transitions) build their tables in OKLCH. The cosine `ProceduralPalette` is the exception — it evaluates its per-channel waveform directly in sRGB. The pipeline:

```
Pixel (linear 16-bit) → linear RGB float → OKLab (L, a, b) → OKLCH (L, C, h)
                                                                  ↓
                                              shortest-arc hue interpolation
                                                                  ↓
                                    OKLCH → OKLab → linear RGB → Pixel
                                                       ↓ (only if out of gamut)
                                              reduce chroma, hold hue + L
```

| Function | Description |
|---|---|
| `linear_rgb_to_oklab()` | Convert linear RGB to the OKLab perceptual space |
| `oklab_to_oklch()` | Convert OKLab (rectangular) to OKLCH (polar: Lightness, Chroma, Hue) |
| `lerp_oklch()` | Interpolate two OKLCH values with shortest-arc hue (avoids the red→green→blue detour) |
| `gamut_clip_preserve_chroma()` | Maps an out-of-gamut OKLab color back into the sRGB cube by reducing chroma while holding hue and lightness (walk-then-bisect on the chroma scale). The hue-preserving alternative to a per-channel RGB clip. Gated behind an in-gamut test (`oklab_to_linear_rgb_gamut`), so in-gamut colors — the vast majority — pay only the test and skip the search. |
| `hue_rotate()` | Perceptual hue rotation — rotates the (a,b) chroma plane in OKLab, preserving lightness and chroma. Forward nonlinearity uses `fast_cbrt` (hot per-pixel path); inverse is exact. Out-of-gamut results are chroma-reduced rather than per-channel clipped, which holds hue and stabilizes the feedback loop against saturated-color drift. Used by the feedback `hue_fade` transform and `ShaderBall`'s displacement-driven hue shift. |

#### The Gamut Boundary Grid

The chroma clip brackets the sRGB boundary from a generated table (`core/color/gamut_lut.h`, emitted by `tools/gen_gamut_lut.py`) indexed by the diamond angle of (b, a) and by L. Each cell stores the minimum and maximum boundary chroma over the region it covers, so the true boundary of every ray in the cell lies inside the stored bracket at any resolution; the per-pixel path walks that bracket in `GAMUT_SCAN_STEPS` and bisects the straddling step `GAMUT_BRACKET_STEPS` times. Grid resolution only sets how wide the bracket starts — the bisection sets how far it is narrowed.

The clip reads the 256 × 128 flash master by default. An effect that clips per pixel can arm a coarser arena copy, which buys read latency alone (RAM rather than QSPI flash):

| Function | Description |
|---|---|
| `init_gamut_lut(arena, angle_steps, l_steps)` | Downsamples the flash master into `arena` and points the clip at the copy. Both step counts must divide the master's 256 × 128 (trapped). Costs `gamut_lut_bytes(angle_steps, l_steps)`. Call from the effect's `init()`, after any `configure_arenas()`. |
| `release_gamut_lut()` | Drops the copy and points the clip back at the flash master. Registered as an `ArenaResetHook`, so `configure_arenas()` and the mesh carousel's compaction both run it before handing the storage out again. |

`ShaderBall` and `MeshFeedback` arm a copy; every other effect clips against the flash master.

#### Palette Modifiers

Modifiers compose around any palette source at compile time via
`StaticPalette<Source, Coords<...>, Colors<...>, Wrap>`. There are two axes: a
**coordinate** chain that remaps the lookup parameter `t` *before* the source is
sampled, and a **color** chain that reshapes the resulting sample *after*, with
the original coordinate in hand. Both chains are inlined by fold expression with
zero runtime overhead. `Wrap` (default `true`) wraps the final coordinate into
`[0,1)` before the lookup — leave it on for cycling modifiers that overflow the
range; set it `false` for bounded remaps that must reach the source endpoints.
Both directions are `static_assert`ed: an unbounded modifier rejects
`Wrap=false`, and a bounded final modifier rejects `Wrap=true` (wrapping would
fold its 1.0 output to 0.0 and destroy the top endpoint). Only a modifier that
re-bounds *arbitrary* input (`WrapModifier`'s fold, `FoldModifier`'s triangle
wave, `InsetModifier`'s clamp) clears an unbounded predecessor; `ReverseModifier`
and `MirrorModifier` are bounded on `[0,1]` but pass an out-of-range coordinate
straight through — chaining one after a cycling modifier needs a `WrapModifier`
between them and `Wrap=false`.

Coordinate modifiers (`modify(float) -> float`):

| Modifier | Effect |
|---|---|
| `CycleModifier` | Shifts the lookup parameter by a continuously incrementing offset (palette scrolling) |
| `BreatheModifier` | Oscillates the lookup parameter with a sinusoidal "breathing" envelope |
| `RippleModifier` | Applies a wavelet distortion to the lookup parameter |
| `FoldModifier` | Folds the parameter space (mirror at edges) to create ping-pong patterns |
| `PinchModifier` | Non-linearly warps the lookup parameter toward a focal point; the per-sample `powf` suits bake-time sampling |
| `QuantizeModifier` | Posterizes the palette into discrete bands |
| `ScaleModifier` | Scales and offsets the lookup parameter |
| `ReverseModifier` | Mirrors the lookup parameter (1.0 - t) |
| `MirrorModifier` | Maps [0,1] to [0,1,0] for a seamless symmetric loop |
| `InsetModifier` | Compresses the source domain into an inset window, clamping outside |
| `WrapModifier` | Folds the lookup parameter into `[0,1)` mid-chain, so a bounded modifier can follow a cycling one |
| `NoiseWarpModifier` | Displaces the lookup parameter with smooth value noise — the aperiodic counterpart to `RippleModifier` |
| `DriftModifier` | Meanders the whole palette along a per-frame noise walk (wanders, hesitates, reverses) |

Color modifiers (`shade(Color4, float) -> Color4`):

| Modifier | Effect |
|---|---|
| `AlphaFalloffShade` | Scales alpha by a caller-supplied falloff curve over the coordinate |
| `EdgeFadeShade` | Fades the sample color to black near the edges (opaque vignette) |
| `EdgeAlphaShade` | Fades the sample alpha near the edges (transparent vignette) |
| `HueSpinShade` | Rotates every sample's hue in OKLab by a driver amount (continuous hue cycling); the rotation folds into a per-frame memoized 3×3 |
| `HueWobbleShade` | Rotates hue by an amount that varies along the domain (iridescent drift); per-sample cost suits bake-time sampling |
| `SparkleShade` | Ignites sparse traveling glints where an evolving noise field exceeds a threshold |
| `ChromaPulseShade` | Breathes OKLab chroma between pastel and vivid on a per-frame memoized pulse |
| `LightnessGrainShade` | Grains brightness with evolving noise; uniform linear-RGB gain, so hue is exact below the saturation point (a gain above 1 clips bright channels) |
| `IridescentShade` | Adds a thin-film cosine sheen with per-channel phase offsets, saturating at white |

The noise-driven modifiers sample the deterministic `value_noise_1d`/`value_noise_2d`
hash lattice (`3dmath.h`) with a per-instance seed, so two modifiers on the same
driver decorrelate by seed. Frame-constant work memoizes against the driver
value (`HueSpinShade`'s rotation matrix, `ChromaPulseShade`'s pulse factor,
`DriftModifier`'s walk offset). The OKLab shades still pay a per-sample
conversion, so they pair well with `BakedPalette::rebake`, which re-samples a
256-entry LUT once per frame; the noise and cosine shades are cheap enough for
live per-pixel paths.

```cpp
// Compose a baked palette with a breathing coordinate modifier
StaticPalette<BakedPalette, Coords<BreatheModifier>> palette;

// A transparent vignette: inset the source, fade alpha at the edges
StaticPalette<ProceduralPalette, Coords<InsetModifier>,
              Colors<EdgeAlphaShade>, /*Wrap=*/false> vignette;

// Psychedelic composite: noise-warped coordinate, continuously spinning hue,
// glints riding on top
StaticPalette<ProceduralPalette, Coords<NoiseWarpModifier>,
              Colors<HueSpinShade, SparkleShade>> lava;
```

#### Additional Palette Types

| Type | Description |
|---|---|
| `MutatingPalette` | Extends `ProceduralPalette` with continuous coefficient mutation between two procedural palettes |
| `SolidColorPalette` | Returns a single fixed color for every coordinate |
| `PaletteFacade<SP>` | Exposes a compile-time `StaticPalette` composition through the polymorphic `Palette` API, for preset tables and baking |
| `BakedPalette` | Precomputes any palette source (a `Palette` or a `StaticPalette`) into a fast 16-bit LUT for O(1) lookup. Arena-allocated. |

### 7.7 The Mesh System (`core/mesh/`)

The mesh system is split across nine files:

- **`mesh.h`** — Core data structures (`PolyMesh`, `HalfEdgeMesh`) and fundamental `MeshOps` (compile, clone, classify)
- **`conway.h`** — Conway mesh operators and vertex transformations
- **`conway_graph.h`** — Constexpr 23-edge morph graph over the 18 simple-registry solids: per-edge operator/seed/reseed specs, bridge-aware walk weighting, and the closed `ORDERED_TOUR`
- **`recipe.h`** — Lowers an authored recipe to primitive steps (`expand_to_primitives`), sizes that lowering at compile time (`lowered_step_count`, `max_lowered_step_count`), replays either form through `SolidBuilder` (`build_recipe`, `build_steps`), and decides which lowered steps a morph leg can sweep (`is_morphable_step`)
- **`hankin.h`** — Hankin pattern compilation and dynamic update
- **`mesh_classes.h`** — Congruence-class clustering plus one canonical distance-LUT bake per class, allocated by descending face count under an 18 KB per-mesh budget
- **`spatial.h`** — `MeshState` (flat-array renderer format) and `KDTree`
- **`solids.h`** — Platonic + Archimedean + Catalan + Islamic Star Pattern solid geometry data and registry
- **`relax_bakes_generated.h`** — Baked relaxed-mesh vertices behind `MeshOps::relax_baked`, generated by `tools/relax_bakes.py`

`PolyMesh` stores vertices and face connectivity via `ArenaVector` arrays. `MeshState` (in `spatial.h`) is the flat compiled format consumed by the renderer. `HalfEdgeMesh` provides a half-edge traversal structure built from either a `PolyMesh` or `MeshState`.

#### Core MeshOps (`mesh.h`)

| Operation | Description |
|---|---|
| `MeshOps::compile` | Convert a `PolyMesh` to the flat-array `MeshState` format used by the renderer |
| `MeshOps::clone` | Arena-safe deep copy |
| `MeshOps::classify_faces_by_topology` | Group faces by vertex count, sorted whole-degree-rounded interior angles, and neighbor topology for palette assignment. The angle vector is the discriminator that separates faces of equal side count, so a solid whose interior angles straddle a rounding boundary classifies differently either side of it |

#### Conway Operators (`conway.h`)

All Conway *geometry* operators (`dual` through `bevel` below) take `(const PolyMesh& mesh, Arena& target, Arena& temp)` and return a `PolyMesh`; `truncate`, `expand`, `chamfer`, `snub` and `bevel` take a defaulted shape parameter `float t` after the arenas, and `snub` a `float twist` after that. `medial` takes the same two arenas but writes its two outputs through reference parameters — `(const PolyMesh& mesh, PolyMesh& out_a, ArenaVector<Vector>& out_b, Arena& target, Arena& temp)`. `ambo`, `truncate`, `expand`, `chamfer` and `snub` each carry a second overload taking a caller-built `const HalfEdgeMesh&` right after `mesh`: the output topology is the same at every `t`, so one connectivity build serves a whole parameter sweep instead of one per call. `transform`, `transform_in_place`, `relax`, `relax_baked`, and `normalize` are listed in the same table but are mesh utilities with their own signatures. Every operator, primitive or composed, produces its `PolyMesh` into `target` and uses `temp` for intermediate computation; composed operators (`gyro`, `meta`, `needle`, `zip`, `bevel`) reuse the same internal ping-pong as their constituent ops, with an even-length composition starting its first step in `temp` so the last one lands in `target` (see the COMPOSITION POLARITY note in `conway.h`):

| Operation | Description |
|---|---|
| `MeshOps::transform` | Apply a chain of vertex transformers to produce a new `MeshState` |
| `MeshOps::transform_in_place` | Apply a chain of vertex transformers to a `MeshState`'s own vertices, leaving topology untouched |
| `MeshOps::dual` | Dual mesh (faces ↔ vertices) |
| `MeshOps::kis` | Raise a pyramid on each face |
| `MeshOps::ambo` | Truncate vertices to edge midpoints |
| `MeshOps::truncate` | Cut corners off the polyhedron (configurable depth) |
| `MeshOps::expand` | Separate faces (ambo of ambo) |
| `MeshOps::chamfer` | Bevel edges (hexagonal expansion) |
| `MeshOps::snub` | Chiral semi-regular polyhedron with twist (Newell-method face normals) |
| `MeshOps::gyro` | Gyro operator (= dual ∘ snub) |
| `MeshOps::meta` | Meta operator = kis ∘ dual ∘ ambo |
| `MeshOps::needle` | Needle operator = kis ∘ dual |
| `MeshOps::zip` | Zip operator = dual ∘ kis |
| `MeshOps::bevel` | Bevel operator = truncate ∘ ambo |
| `MeshOps::medial` | Both endpoint vertex sets of the dual morph on one shared medial (rectified) connectivity: `out_a` is `ambo(mesh)`, `out_b` the matching `ambo(dual(mesh))` positions |
| `MeshOps::relax` | Edge-length relaxation by spring forces on the unit sphere. |
| `MeshOps::relax_baked` | Substitute a flash-baked relax result for the pass. Its runtime checks catch a source/bake mismatch (dimensions, topology hash) and payload corruption (output hash, re-derived from the bake's own vertex bits) — they say nothing about freshness, since a positional retune that leaves connectivity intact passes every one of them. Freshness is the `relax_bake_verify` ctest's job: it re-runs the live `relax` and asserts bit-exact equality with the committed payload |
| `MeshOps::normalize` | Project all vertices onto the unit sphere |

#### Hankin Pattern System (`hankin.h`)

| Operation | Description |
|---|---|
| `MeshOps::compile_hankin` | Pre-compute topological data for fast Hankin pattern updates |
| `MeshOps::update_hankin` | Update dynamic vertices based on angle parameter (no new allocation when reusing a sufficiently-sized output mesh) |
| `MeshOps::hankin` | One-shot Hankin pattern generation (compile + update) |

`compile_hankin` produces a `CompiledHankin` struct containing base vertices, static midpoints, and dynamic instructions. `update_hankin` evaluates the dynamic vertices by sweeping the Hankin angle, producing the star polygon line intersections for each face. It re-binds the output mesh's vectors on every call, so it avoids new allocation only in the steady state — reusing the same output mesh against the same arena, already sized large enough.

#### Solids Library (`solids.h`)

`solids.h` provides constexpr vertex/face data for all Platonic solids plus procedural generators for Archimedean, Catalan, and Islamic Star Pattern families. The solids are organized into three registries. A solid is built by name via `Solids::get_by_name(arena, a, b, name)` (the shared firmware and WASM entry point); the WASM geometry tools enumerate the registries by index with `Solids::get_entry(index)` to populate the picker, then build the selected solid by name:

| Registry | Count | Description |
|---|---|---|
| `simple_registry` | `PLATONIC_COUNT + ARCHIMEDEAN_COUNT` | 5 Platonic (tetrahedron through icosahedron) + 13 Archimedean solids |
| `catalan_registry` | `CATALAN_COUNT` | Duals of the Archimedean solids (triakisTetrahedron, rhombicDodecahedron, pentakisDodecahedron, etc.) |
| `islamic_registry` | `ISLAMIC_COUNT` | Complex multi-operator recipes producing Islamic star patterns from base solids |

Total: `Solids::NUM_ENTRIES`. Each count is a named constant in `solids.h`, `static_assert`ed against its registry's size (and their sum against `NUM_ENTRIES`), so the values live there rather than being restated here.

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

### 7.8 Generators (`generators.h`)

`generators.h` provides a single universal generation wrapper that manages arena lifecycle for all procedural geometry creation:

```cpp
namespace hs {
template <typename GenerateFn, typename... Args>
auto generate(Arena &target, GenerateFn &&fn, Args &&...args);
}
```

It resets and scopes both scratch arenas, then invokes `fn(target, scratch_a, scratch_b, args...)`. Direct registry lookups and effect geometry creation go through this wrapper for a deterministic arena lifecycle:

```cpp
auto mesh = hs::generate(persistent_arena, Solids::get_by_name, std::string_view("icosahedron"));
```

One deliberate exception: `SolidBuilder`'s fluent Conway chain (`solids.h`) owns its own two-arena ping-pong, swapping the scratch arenas between operators, so it manages arena lifecycle directly rather than through `generate()`.

### 7.9 The Preset System (`presets.h`)

`Presets<Params, Size, SegueT>` is a generic template for managing parameter presets. It stores a fixed-size array of `PresetEntry<Params>` (each containing only a `Params` struct — no name field) and provides cyclic navigation (`next()`/`prev()`, with `current_index()`/`prev_index()` reporting where it stands). It interpolates nothing itself: it tracks the entry active before the last move, and the caller drives the crossfade with an `Animation::Lerp` from `prev_get()` to `get()` (the `Params` type supplies the `lerp()` the animation calls).

```cpp
Presets<Feedback::Style, 12> presets = {{
    {{{0.95f, 1.2f, ...}}},
    {{{0.88f, 0.5f, ...}}},
    ...
}};
presets.next();  // advance to next preset
presets.apply(style);  // copy current preset into live params
// or crossfade into it over 48 frames instead of snapping:
timeline.add(0, Animation::Lerp(style, presets.prev_get(), presets.get(), 48, ease_linear));
```

`SegueT` is the same compile-time segue policy `MeshCarousel` takes (`namespace Segue`; `Segue::Base` by default), inherited privately and reachable through `segue()`. `schedule_segue(timeline, draw_fn, duration, window, paused)` hands the policy the draw callback and returns the frame count after which the caller should advance to the next preset — the `Segue::Schedulable` concept pins that signature, so no policy can shadow it with a shorter one. Forwarding the pause gate from that signature is the policy's own contract — the concept cannot see it, so a test pins it instead.

`get_entries()` returns a span over all entries, const for read-only iteration and mutable for rebinding a preset in place. The free `constexpr` helper `all_presets_in_ranges(entries, in_ranges)` runs a slider-range predicate over an entry table so an effect can `static_assert` its whole preset table against its registered parameter ranges — a loop rather than an unrolled conjunction, so appended entries are covered automatically.

### 7.10 Hardware Drivers (`dma_led.h`, `pov_single.h`, `pov_segmented.h`)

Three hardware drivers form a layered stack.  `dma_led.h` handles the SPI wire protocol; `pov_single.h` and `pov_segmented.h` sit above it and manage the POV column sweep, differing only in how many Teensys share the work.

#### DMA LED Controller (`dma_led.h`)

Non-blocking DMA-based LED output for HD107S (APA102-compatible) LEDs on Teensy 4.x.  Enabled by `#define USE_DMA_LEDS` in the target's boilerplate header (`targets/common/phantasm_target.h`) before it includes the driver; `led.h` stays neutral (the define is commented out there) and the default FastLED/WS2801 path remains as fallback. The FastLED fallback applies only to the single-board `POVDisplay`; the segmented `POVSegmented` driver `#error`s without `USE_DMA_LEDS` (FastLED's bit-bang `show()` masks IRQs for windows that break the sync symbol margins, which are derived from a mask window M ≈ 0), so DMA LEDs are mandatory on Phantasm.

| Class | Role |
|---|---|
| `HD107SFrame<N>` | Pre-formatted DMA buffer for the HD107S protocol. `packPixel()` writes `Pixel` values directly into the frame buffer with inline color correction (color correction → temperature → brightness), bypassing the CRGB intermediate. The buffer is 32-byte-aligned (`__attribute__((aligned(32)))`) and cleaned with `arm_dcache_flush()` (clean, no invalidate — the buffer is TX-only) for cache coherency. |
| `TeensySPIDMA` | Low-level DMA+SPI driver wired to LPSPI4. Configures a `DMAChannel` with completion interrupt for fully async byte-stream transmission. |
| `DMALEDController<N>` | Double-buffered high-level controller. The ISR packs pixels into `backFrame()`, then `submitFrame()` flushes it and triggers async DMA, returning immediately. If the previous transfer is still in flight, `submitFrame()` **drops** the new frame (bumping `getOverrunCount()`) rather than spinning — the in-flight DMA keeps showing the previous column; a transfer that never completes is surfaced as a wedged-channel fault. |

The 16-bit linear pipeline reaches from the canvas all the way to the SPI wire with no 8-bit intermediate:

```cpp
// ISR path (per column): fetch the display buffer once, index it directly
const Pixel* buf = effect->display_buffer();               // 16-bit linear pixels
// Physical LED index comes from the single-source-of-truth map (pov_single_map.h),
// which applies the top-arm reversal / bottom-arm offset — never the raw row index.
frame.packPixel(pov::strip_top_led(y, S), buf[y * width + x]); // Pixel → HD107S frame
ledController.submitFrame();                                // non-blocking DMA, drops on overrun
```

#### Single-Teensy POV Driver (`pov_single.h`)

`POVDisplay<S, RPM>` drives the Holosphere — one Teensy owns the entire LED strip.  An `IntervalTimer` ISR fires at `1,000,000 / (RPM/60) / width` µs intervals to advance one column:

```
Main Loop                              ISR (IntervalTimer)
──────────                             ───────────────────
effect->draw_frame()                   show_col() fires every N µs
  Canvas canvas(*this)                   for y in 0..S/2:
    render to bufs[cur]                    packPixel(strip_top_led(y,S),    get_pixel(x, y))                      // top arm
  ~Canvas → queue_frame()                  packPixel(strip_bottom_led(y,S), get_pixel(strip_opposite_col(x,W), y)) // bottom arm
                                         submitFrame() → async DMA
                                         x = (x+1) % width
                                         if x==0 || x==width/2: advance_display()
```

The top arm's physical LED ordering is reversed (LED 0 at the tip, descending in Y), and the bottom arm shows the opposite half of the image (x offset by W/2).

| Parameter | Value (Holosphere) |
|---|---|
| S (total pixels) | 40 |
| RPM | 480 |
| Column interval | ~1302 µs (= 125 ms / 96 columns) |
| ISR duration | ~20 µs |

#### Multi-Teensy Segmented POV Driver (`pov_segmented.h`)

`POVSegmented<S, N, RPM>` drives Phantasm — N Teensys (4 by default, up to 8) each control a contiguous Y-segment on one arm. IDs `[0, N/2)` map to arm A and `[N/2, N)` to arm B. Within an arm, northern bands advance in +Y and southern bands run from the S pole toward the junction in -Y.

**Physical strip layout (N=4, S=288):**

```
Arm A                               Arm B (x offset by W/2)
┌──────────────────────────┐        ┌──────────────────────────┐
│ Seg 0 (top)              │        │ Seg 2 (top)              │
│ LED 0 at N pole (y=0)    │        │ LED 0 at N pole (y=0)    │
│ → LED 71 at junction     │        │ → LED 71 at junction     │
├────────── junction ──────┤        ├────────── junction ──────┤
│ Seg 1 (bottom, reversed) │        │ Seg 3 (bottom, reversed) │
│ LED 0 at S pole (y=143)  │        │ LED 0 at S pole (y=143)  │
│ → LED 71 at junction     │        │ → LED 71 at junction     │
└──────────────────────────┘        └──────────────────────────┘
```

At N=8, each arm has four 36-pixel bands: north outer `0–35`, north inner
`36–71`, south outer `143–108`, and south inner `107–72`. Arm A uses IDs 0–3;
arm B uses IDs 4–7. The firmware profile is compile-tested, but an eight-board
480-RPM rotor requires a separately qualified mounting, balance, cable, and
swept-envelope design before operation.

**Hardware ID detection**: Each Teensy reads `log2(N)` active-low GPIO straps: pin 21 (ID0), pin 22 (ID1), and pin 23 (ID2, N=8 only). The ID is `(~raw) & (N-1)`, so grounding a strap sets its bit and all-floating selects ID 0 (sync master). The header supports power-of-two `N ≤ 8`.

**Branchless ISR**: All per-segment decisions are resolved at boot time into three precomputed values:

| Value | Description |
|---|---|
| `y_base` | Starting Y index for this segment's row band |
| `y_step` | +1 for northern bands, -1 for reversed southern bands |
| `arm_b` | Whether this segment is on arm B (x offset by W/2) |

The ISR loop has no branches:

```cpp
const Pixel* buf = effect->display_buffer();    // fast path: no per-pixel virtual dispatch
int y = y_base;
for (int i = 0; i < PPS; ++i, y += y_step) {
    frame.packPixel(i, buf[y * width + x_col]);
}
```

**Effect transparency**: Effects are written against the full 288×144 canvas with no per-segment code. Each board clips rendering to its half-width segment band for the current display window (`clip_to_segment`), except stateful effects (`needs_full_frame()` / `persists_pixels()`), which render the full canvas; the ISR then packs this board's LEDs. Every board reseeds the shared `Pcg32` with `hs::epoch_seed(effect index)` at every effect build (epoch 0 is the identity seed `1337` in `platform.h`), so a board's canvas depends only on the beacon-synchronized index — a mid-show joiner renders bit-identically to boards that have been up for hours.

| Parameter | Value (qualified N=4 default unless noted) |
|---|---|
| S (total pixels) | 288 |
| N (segments) | 4 qualified default; 8 compile-tested firmware profile |
| PPS (pixels per segment) | 72 at N=4; 36 at N=8 |
| RPM | 480 (8 rev/s, ~125 ms/rev) |
| Frame rate | 16 FPS (2 frames/rev — one per side; each side draws W/2 = 144 cols per 62.5 ms frame) |
| Column frequency | 2304 Hz |
| Column interval | ~434 µs (= 125 ms / 288 = 62.5 ms / 144) |
| Flywheel wake period | ~54.25 µs (= column interval / `OVERSAMPLE` = 8) |
| ISR duration (N=4 72px pack + DMA trigger) | Read per build from the `HS_ISR_PROFILE` accumulators (`g_flywheel_wake_cycles`, `g_column_pack_cycles`, `g_dma_submit_cycles`) that the `Profile` target dumps. A column-boundary ISR outrunning the wake period coalesces the wakes it overruns; the column index is derived from the cycle counter, so the next wake resumes at the time-correct column |

#### Frame Sync Protocol: 1-Wire Signal Datasheet

Phantasm's boards stay coherent over **one wire**. Segment 0 (the **master**) is the conductor; segments 1 through N−1 (**downstream**) listen. Each board generates its own columns from a local **flywheel timebase** and snaps that timebase to count-coded pulse bursts the master broadcasts on the wire. Full design: `docs/specs/phantasm_frame_sync_spec.md`; host-tested protocol core: `hardware/pov_sync.h`.

The flywheel derives the column index from the free-running CPU cycle counter, never from counting timer interrupts:

```
x = ( x_boundary + (now − epoch) · (W/2) / cycles_per_half_rev )  mod W
                                                    └─ 64-bit intermediate
```

`epoch` is folded forward by exactly one half-revolution at every boundary crossing, so the 32-bit cycle counter's ~7.16 s wrap is structurally unobservable.  An interrupt-masked window (e.g. `FastLED.show()`) cannot drop columns — the ISR that runs after the mask reads the clock and resumes at the *time-correct* column.

**Pin / signal description.**

| Signal | Master (seg 0) | Downstream (segments 1–N−1) | Electrical | Direction |
|---|---|---|---|---|
| `SYNC` | pin 3 (GPIO out) | pin 3 (ext. interrupt in) | 3.3 V CMOS, active-high pulses, idle LOW | master → all |
| `MASTER_EN` | pin 5 (drive LOW) | pin 5 (drive HIGH) | 3.3 V CMOS, gates the external sync-out buffer | per-board strap out |
| `ID` straps | pins 21–23 (ID0–ID2 as required) | pins 21–23 (ID0–ID2 as required) | active-low, internal pull-ups; `ID_STRAPS = log2(N)` read | strap (board identity) |

The ID straps select the board: the build reads `ID_STRAPS = log2(N)` active-low bits and decodes `(~raw) & (N-1)`. N=4 reads ID0/pin 21 and ID1/pin 22; N=8 also reads ID2/pin 23. All-floating selects segment 0/master. `SYNC` is one shared pin 3 — the master drives it and downstream boards receive on its rising edge; `MASTER_EN` (pin 5) gates an external level shifter so only the master drives the shared bus. The former column-clock wire is **deleted** and pin 4 is freed — `SYNC` is the only inter-board connection. It is assumed physically reliable (a hard, soldered line); a severed wire is out of scope (boards free-run and precess apart at crystal rate, a slow smear, never an instant break).

**Signal levels & symbol waveforms.** The wire idles LOW.  A **symbol** is a burst of short active-high pulses at a fixed pitch; **the meaning is the count of rising edges — pulse width carries no information.**  Each pulse is HIGH for one ISR body (pin set HIGH at ISR entry, LOW at exit; tens of µs) and the rising edge is the only timed event.  Pulses are drawn narrow, to scale against the ~868 µs pitch:

```
 HALF — 1 pulse — marks boundary x = W/2 (144)
            ┌┐
 ───────────┘└──────────────────────────────────────────────────  idle LOW
            ▲
            └ boundary instant (x = W/2)

 ZERO — 3 pulses — marks boundary x = 0
            ┌┐      ┌┐      ┌┐
 ───────────┘└──────┘└──────┘└───────────────────────────────────
            ▲   └ 2-col pitch ┘
            └ boundary instant (x = 0)

 ZERO+EPOCH — 5 pulses — marks x = 0 AND advances the playlist
            ┌┐      ┌┐      ┌┐      ┌┐      ┌┐
 ───────────┘└──────┘└──────┘└──────┘└──────┘└───────────────────
            ▲
            └ boundary instant (x = 0)
```

A burst terminates when the wire stays quiet past the **gap timeout** (4 columns).  The consumer counts rising edges and classifies:

| Symbol | Edges | Marks | Carries | Rate |
|---|---|---|---|---|
| `HALF` | **1** | boundary `x = W/2` | half-rev phase + flip | 1 / rev |
| `ZERO` | **3** | boundary `x = 0` | half-rev phase + flip | 1 / rev |
| `ZERO+EPOCH` | **5** | boundary `x = 0` | phase + flip + **playlist advance** | 1 / effect (×R repeats) |
| `BEACON` | 5 base-8 digits @ `x ≈ W/4` | — (data channel) | absolute effect index + rev count, checksummed | rev ≡ 1 (mod 16) + first revs of an effect |
| *invalid* | any **even** count, or > 5 | — | discarded whole: no snap, no flip, no advance | — |

**Why count, not width:** on the i.MX RT each pin has a single latched interrupt flag, so an IRQ-mask window *delays* an edge's ISR but cannot lose the edge unless two edges fall inside one mask window.  With pulse pitch chosen **greater than the worst-case mask window M**, the edge *count* is exact even when `FastLED.show()` masks IRQs mid-symbol (on Phantasm's DMA LED path, M ≈ 0).  The alphabet is **odd-only, distance 2** — a single lost or spurious edge lands on an even (invalid) count and is discarded.  A glitch degrades to a *missed* symbol (covered by the local boundary crossing), **never** a *misclassified* one: *fail to "missed," never to "wrong."*

**AC timing characteristics.** At 480 RPM / 600 MHz / W = 288 (1 column = 434.03 µs = 260,417 cycles):

| Parameter | Symbol | Columns | Time | Cycles | Rule |
|---|---|---|---|---|---|
| Column period | T0 | 1 | 434.0 µs | 260,417 | `cycles_per_half_rev / (W/2)` |
| Boundary pulse pitch | t_PB | 2 | 868.1 µs | 520,833 | **pitch > M** ⇒ no edge lost to the latch |
| Beacon digit pitch | t_PD | 1 | 434.0 µs | 260,417 | checksum tolerates tighter pitch |
| Burst gap timeout | t_GAP | 4 | 1.736 ms | 1,041,667 | **> pitch + M** ⇒ a mask can't split one burst |
| Glitch filter (min edge spacing) | t_GF | — | 100 µs | 60,000 | edges closer than this are EMI — rejected |
| Master late-censor budget | t_LATE | ½ | 217 µs | 130,208 | first pulse later than this ⇒ skip whole symbol |
| ACQUIRE quiet-before guard | t_QB | 16 | 6.94 ms | 4,166,667 | a hard snap requires this much prior silence |
| Beacon interdigit timeout | t_BID | 24 | 10.4 ms | 6,250,000 | stale partial beacon frame dropped after this |
| Half-revolution | — | 144 | 62.5 ms | 37,500,000 | one image / one flip interval |
| Revolution | — | 288 | 125 ms | 75,000,000 | two flips, two boundary symbols |

All bursts are ≪ the 62.5 ms half-rev, so consecutive symbols never overlap. The table is nominal: cycle counts are the exact rational rounded, while `Config::cycles_per_column()` truncates its division (~2.6 ppm low). Only pitches and thresholds derive from it — flywheel position divides by the exact `cycles_per_half_rev`.

**One-revolution signal map.** Where each symbol lands across a single 125 ms revolution (beacon only on scheduled revolutions):

```
 column x →    0           72(W/4)        144(W/2)        216           288 ≡ 0
               │             │              │              │              │
 SYNC wire   ██ZERO     ░░░BEACON░░░      ██HALF                       ██ZERO
             (3 edges)  (5 digits, data)  (1 edge)                     (3 edges)
               │←─────────── half-rev = 62.5 ms ──────────→│
 display     flip A                       flip B                       flip A
 layer 1     snap φ                       snap φ                       snap φ
               │←──────────────────── revolution = 125 ms ────────────────────→│
```

Boundary symbols (`ZERO`/`HALF`) serve **two** layers at once: they snap the flywheel's column phase (Layer 1) *and* act as the exactly-once flip backstop (Layer 2).  The beacon rides the otherwise-quiet stretch at `x ≈ W/4`, separating the timing channel and the data channel **in time** on the same wire.

**The three disciplined layers.** Every layer reads the same flywheel timebase, so one snap corrects all three coherently; each also has an absolute reference on the wire that pulls it back if it drifts:

* **Layer 1 — Column phase.** Boundary symbols snap each flywheel twice per revolution; worst-case inter-snap crystal drift is **~0.006 column** at 40 ppm — far below a visible seam, which is the quantitative justification for deleting the column-clock wire.  In **LOCKED** a symbol is accepted only if its implied correction is **≤ G = 4 columns** and its boundary identity matches the flywheel's prediction (the plausibility gate).
* **Layer 2 — Buffer flip.** The local boundary crossing flips the display buffer; the symbol is a deduplicated backstop.  `try_flip`, keyed on boundary identity (boundaries strictly alternate `ZERO, HALF, …`), makes the flip **exactly-once** even when both the crossing and the symbol fire.  Losing both paths in one half-rev is the only glitch, and it self-heals the next half-rev.
* **Layer 3 — Content.** The playlist is **epoch-counted**, not `millis()`-gated.  The master emits the `EPOCH` mark (plus R = 3 redundancy repeats) when an effect's 960 revolutions elapse; every board counts down to the same **absolute** commit boundary regardless of which copy it heard, constructs the next roster entry during the final K = 2-revolution **construction window** (display black on all boards simultaneously), and all swap to its frame 0 at the same boundary.  The beacon broadcasts the absolute effect index so a board that missed every epoch repeat corrects within ~2 s, and a rebooted board rejoins at the correct effect — **fail-dark, never fail-wrong** (a board with no established identity shows black rather than a guessed effect).

**Index beacon frame format.** The beacon is a **data** symbol (integrity by *rejection*, not by exactness).  Five base-8 digits at 1-column pitch, each digit a burst of `digit + 1` pulses, digits separated by 5 quiet columns (one past the gap timeout, so the decoder reliably terminates each digit):

```
 Frame = [ idx_hi  idx_lo  rev_hi  rev_lo  checksum ]   (5 digits, base-8)
           └── effect index 0–63 ──┘ └ rev mod 64 ┘  └ Σ(i+1)·dᵢ mod 8

 digit Dk transmitted as (Dk+1) pulses @ 1-col pitch, then a 5-col quiet gap:

         D0          D1               D2          …        D4
        ┌┐          ┌┐┌┐┌┐           ┌┐┌┐                 ┌┐┌┐┌┐
 ───────┘└──/ /─────┘└┘└┘└──/ /──────┘└┘└──/ /───────────┘└┘└┘└──────────
        │←Dk+1 pulses→│   │←5-col quiet (terminates digit)→│
        │←──────────── frame ≈ 26 ms worst case (≪ half-rev) ───────────→│
```

Any checksum mismatch, wrong digit count, out-of-range digit, or stale partial frame **drops the whole frame** — the next beacon is ≤ 2 s away.  Schedule: revolution 1 of every 16 (`rev ≡ 1 mod 16` — never rev 0, so a just-powered board meets clean isolated boundary symbols first), plus the first revs of a fresh effect; silent during a pending commit.

**Receiver state machine.** Each downstream board is in one of two states.  The master is born `LOCKED` with identity (effect 0, rev 0) — it *is* the reference and never snaps:

```
                  first accepted snap
   ┌──────────────┐ ──────────────────▶ ┌──────────────┐
   │   ACQUIRE    │                      │    LOCKED    │
   │  (display    │                      │ (disciplined,│
   │   black)     │ ◀────────────────── │  rendering)  │
   └──────────────┘  R = 4 consecutive   └──────────────┘
                     gate rejections
                     (~2 revolutions)

 ACQUIRE : accept any *valid* symbol unconditionally (hard snap), but only
           on a burst preceded by ≥ t_QB (16 col) of wire silence — so a
           beacon digit train can't capture a just-rebooted board mid-frame.
           The train's FIRST digit is preceded by silence exactly as a
           boundary symbol is, so it can still be mistaken once; the
           R-rejection fallback bounds the recovery (§9.1 mis-snap row).
           Renders black until it has BOTH phase (a snap) AND identity
           (epoch/beacon).
 LOCKED  : accept a valid symbol only if implied correction ≤ G (4 col) AND
           boundary identity matches the prediction. Else reject (telemetry,
           no snap, no flip). After R rejections the board concludes its OWN
           timebase is at fault and falls back to ACQUIRE (the escape hatch
           that stops a genuinely-lost board from rejecting good symbols
           forever).
```

**Epoch commit sequence.** `EPOCH` at ZERO boundary **B** schedules an absolute commit at **B + R + K** (R = 3 repeats, K = 2 construction revolutions).  A board hearing any repeat infers its position in the train from its own revolution count and lands on the *same* boundary:

```
 ZERO boundary:   B        B+1      B+2      B+3      B+4      B+5
 master emits:   ●EPOCH    ○rpt     ○rpt     ○rpt      —        —
                 (5 edges) (5)      (5)      (5)
 commit_in_revs:   5        4        3        2        1        0
                 │←──── announce: keep playing OLD effect ────│
                                            │←── construct ──→│ swap → NEW
                                            ░░░ display BLACK ░░░  frame 0
 all boards:     ─────── outgoing effect ──────────░build/dark░── new effect
```

The dark window is identical (K revolutions) on every board because construction can't begin before B+R — only then is the window's start common knowledge regardless of which copy each board heard.  An effect that can't construct inside K revolutions trips `HS_CHECK` (fail-fast).  All boards reseed `hs::random()` with `hs::epoch_seed(effect index)` per effect build (epoch 0 is the identity seed 1337), so each visit gets a fresh stream and the new instance is bit-identical across boards no matter what each board rendered — or whether it even existed — before the epoch.

**Live-takeover join grid.** The epoch commit only aligns a *swap* between running boards; a board with nothing live yet — at boot, or after a reboot — reaches its first constructed effect whenever its own identity arrives, which is later downstream than on the master. It therefore does not take that effect live on arrival: it waits for a ZERO crossing whose revolution-in-effect is a multiple of `join_grid_revs` (4), marked by `TickActions::join_boundary`. The master sits on the same grid, so at boot every board goes live at the *same* crossing with aligned frame counters instead of the master leading by however long downstream identity took; a mid-show rejoin waits ≤ 4 revolutions, well inside the enforced 25-revolution rejoin budget. That budget is a `Config::valid()` relation, not prose: `rejoin_bound_revs()` is the widest beacon-to-beacon gap plus the join-grid wait — beacon period 16 + EPOCH repeats 3 + construction window 2 (beacons are suppressed for the whole commit window) + join grid 4 = 25 revolutions, ~3.1 s at 480 RPM — and `valid()` rejects any configuration whose bound exceeds `rejoin_budget_revs`. The 16-revolution figure is the beacon cadence alone. The grid must divide 64 so a beacon's mod-64 revolution count lands on the master's grid. Where the epoch commit traps on a missing effect, the join is conditional: `EffectHandoff::joinable` also requires the pending build generation to be unconsumed and to match the one the wire advertises, so a visibility lag just joins one grid step later. No join boundary is marked while a commit is pending — the epoch path owns that swap.

**Concurrency & failure modes.** Two ISRs per board, **single-writer** by construction.  The sync-wire RISING ISR is a pure *publisher* — glitch filter, edge count, first-edge timestamp into a small mailbox, nothing else.  The flywheel ISR (waking ~8× per column) is the sole *consumer/owner* of all sync state: it claims terminated bursts, classifies, gates, snaps, flips, and runs epoch scheduling.  The hot path is ~7-of-8 wakes doing one cycle-counter read and a 64-bit position compute (≈1 % CPU at 600 MHz); only a column change packs pixels and submits DMA.

| Event | Layer 1 (column) | Layer 2 (flip) | Layer 3 (content) |
|---|---|---|---|
| Masked-IRQ window (`FastLED.show()`) | resumes at time-correct column | unaffected | unaffected |
| 1 dropped boundary symbol | coasts ≤ 1 rev (~0.01 col); re-snaps next | local crossing still flips | unaffected |
| 1 spurious / EMI edge | even count discarded, or gate rejects | identity dedup no-ops it | epoch refractory + gate guard it |
| Late-emitted symbol | master self-censors; residual gate-rejected | crossing flips on time regardless | unaffected |
| 1 board renders slow (drops a frame) | — | shows prior frame for 1 period | stateless: heals next frame/beacon; stateful: heals next epoch |
| 1 dropped epoch symbol | — | — | R repeats; missed-all-R corrected by next beacon (~2 s) |
| Board reboots mid-show | re-acquires phase from next valid symbol | resumes flipping once LOCKED | rejoins correct effect via beacon, ≤ 25 revs (~3.1 s); dark until then |
| Sync wire severed (out of scope) | free-runs on own crystal; precesses ≥ 1 col in ~10–20 s | keeps flipping locally | holds last effect; slow drift, never an instant break |

The flywheel ISR maintains telemetry counters (symbols accepted / gate-rejected / discarded, beacons ok / rejected, index corrections, epochs refractory-ignored, lock transitions, flips, emissions censored / aborted, longest coast) that the foreground reports behind `hs::debug` at ≤ 1 Hz — so any degradation the protocol absorbs silently is still visible at a glance.

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

### Self-Registering Factory (`effect_registry.h`)

Effects register themselves into a global registry using the `REGISTER_EFFECT(ClassName)` macro placed at the bottom of each effect header. This uses a static initializer pattern — each effect creates a small registrar struct whose static member calls `EffectRegistry::add()` during program initialization, eliminating the need for a hand-maintained factory array. The registry stores resolution-specific fill functions for each supported `<W,H>` pair (96×20 and 288×144).

### Parameter Registration

Effects expose live-adjustable parameters via `register_param()`. These are reflected into the WASM bridge and auto-generate GUI controls in the simulator:

```cpp
register_param("Twist",   &params.twist, -5.0f, 5.0f);        // float slider (min, max)
register_param("Enabled", &params.enabled);                   // boolean toggle (bool* overload takes no range)
register_param("Shape",   &params.shape, SHAPE_NAMES, 4);     // dropdown; float* index over [0, count-1]
register_animated_param("Speed", &params.speed, 0.0f, 2.0f);  // animation-driven slider
register_readonly_param("Particles", &params.active_count, 0.0f, 1024.0f);  // engine-written telemetry
```

The enum overload takes an array of option labels that must outlive the effect (string literals). `register_animated_param` marks the param as written by the animation system, so the GUI renders it as an auto-pausing slider that engages "Pause Animation" when touched; `register_readonly_param` marks it engine-written, so the GUI shows the live value but disables editing. The readonly flag can also be applied to an already-registered param via `mark_readonly(name)`.

The parameter list (`ParamList` — a fixed `std::array<ParamDef, 32>`) is accessible via `getParameters()`, and `updateParameter(name, float)` sets values at runtime. Parameters support both `float*` and `bool*` targets via `std::variant`, with automatic bool threshold at 0.5. The animation system can also write to these parameters, allowing effects to animate their own exposed controls.

### The `EffectConfig` Flags

An effect passes construction-time flags to its base as `Effect(W, H, {.strobe = ..., .persist = ..., .full_frame = ...})`; all default to false. With `{.persist = true}`, `Canvas` copies the previous frame's buffer into the new write buffer before rendering, enabling trail/decay effects without explicit trail storage — each frame partially overwrites the last. When false (the default), the buffer is zeroed each frame. `.strobe` drives the POV column strobe (`strobe_columns()`) and `.full_frame` forces full-canvas rendering under segmented drivers (`needs_full_frame()`).

---

## 9. Effects Reference

All screenshots below were captured from the [live WebAssembly simulator](https://woundedlion.github.io/daydream/) — the Phantasm 288×144 preset for most, and the Holosphere 96×20 preset for RingShower, Dynamo and Thrusters.

The effect registry and tests carry the full 23-effect roster. The simulator sidebar exposes the curated subset for its active resolution (§10.5), omitting three effects at 288×144 and five at 96×20. The Phantasm firmware playlist (`HS_PHANTASM_EFFECT_LIST` in `core/engine/effects.h`) is a 20-effect subset of the full roster, excluding the two Holosphere-96×20-only effects, Dynamo and Thrusters, plus ShaderBall while its 288×144 instantiation exceeds the remaining ITCM budget. Full-cycle Teensy measurements for the firmware playlist are indexed in the [on-device effect profiles](https://github.com/woundedlion/pov/blob/master/docs/profiles/README.md).

### Core Effects (Modern Engine)

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=BZReactionDiffusion" target="_blank"><img src="docs/screenshots/BZReactionDiffusion.png" alt="BZReactionDiffusion" width="280"></a></td>
<td valign="top">

#### BZReactionDiffusion

Simulates the Belousov-Zhabotinsky reaction — a 3-species cyclic competition (A beats B, B beats C, C beats A) producing rotating spiral waves. The simulation runs on a spherical k-nearest-neighbor graph (`ReactionGraph`: 7680 nodes, 6 neighbors each, precomputed Fibonacci lattice) with configurable diffusion rate and time step. Spiral nuclei are seeded once at init; a stochastic nudge to a handful of nodes on every physics substep keeps the dynamics off the closed manifold so the waves sustain.

**Parameters**: Compete (cyclic-competition/predation coefficient), Diff (diffusion rate), Speed (time step)

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=GSReactionDiffusion" target="_blank"><img src="docs/screenshots/GSReactionDiffusion.png" alt="GSReactionDiffusion" width="280"></a></td>
<td valign="top">

#### GSReactionDiffusion

Gray-Scott reaction-diffusion system (U + 2V → 3V, V → P) on a spherical mesh. Produces spots, stripes, and labyrinthine patterns depending on feed/kill rates. A reaction runs until its field has all but stopped moving, then dissolves off the sphere and reseeds at fresh cluster sites, so every cycle grows a different form from the same constants; editing the constants dissolves the current field too.

**Parameters**: Feed, Kill, dA, dB, Speed

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=HopfFibration" target="_blank"><img src="docs/screenshots/HopfFibration.png" alt="HopfFibration" width="280"></a></td>
<td valign="top">

#### HopfFibration

Visualizes the Hopf fibration — a map from S³ to S². Points on S² (the base space) are lifted to fibers on S³ via the quaternion parameterization `q = [cos(η)cos(φ+β), cos(η)sin(φ+β), sin(η)cos(β), sin(η)sin(β)]`, then stereographically projected to R³ and plotted on the sphere. A 4D tumble (R_xw × R_yz rotation) continuously rotates the fibration.

**Parameters**: Flow Spd, Tumble Spd, Folding, Twist, Alpha

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=IslamicStars" target="_blank"><img src="docs/screenshots/IslamicStars.png" alt="IslamicStars" width="280"></a></td>
<td valign="top">

#### IslamicStars

Procedurally generates Islamic geometric patterns using Hankin's method (pentagon-based subdivision of the Archimedean solids). Each face of a rotating solid is decorated with its characteristic star polygon, colored by face topology (triangles, pentagons, hexagons, etc.), with topology classes folded modulo the six-slot `MeshPaletteBank` so a mesh carrying more than six classes aliases two distinct classes onto one color. Shapes carrying a recipe are built on screen op by op: the seed solid segues in, then the lowered Conway chain (hankin, ambo, truncate, snub, chamfer, relax, kis, dual) sweeps it into the finished pattern. Most lowered steps are one animated leg, but the smooth bridges are not: a dual is a three-leg bridge (truncate to ambo, medial slerp, truncate down to the dual), a trailing dual + kis pair — a needle — spans both steps as a five-leg macro (truncate, dual bridge, reconcile onto the authored mesh), and a standalone kis runs eight legs (dual bridge, truncate, dual bridge, reconcile). Each shape then holds still, ripple waves distort the geometry, and it segues out into the next.

**Parameters**: Face Fade Lo, Face Fade Hi, Burst, Ripp Amp, Ripp Decay, Ripp Dur, Trans Speed

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=HankinSolids" target="_blank"><img src="docs/screenshots/HankinSolids.png" alt="HankinSolids" width="280"></a></td>
<td valign="top">

#### HankinSolids

Hankin interlace patterns over the Platonic and Archimedean solids. The interlace angle sweeps continuously over the held solid, then a random walk along the Conway edge graph picks the next one: each leg sweeps the destination solid's own operator parameter, so faces visibly truncate, expand, and twist into it. Exactly one mesh is on screen at all times; faces are colored by topology class from shuffled mesh palettes that crossfade per leg.

**Parameters**: Intensity, Angle

</td></tr></table>



<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=SphericalHarmonics" target="_blank"><img src="docs/screenshots/SphericalHarmonics.png" alt="SphericalHarmonics" width="280"></a></td>
<td valign="top">

#### SphericalHarmonics

Visualizes the real spherical harmonics Yˡₘ(θ, φ) as a colored scalar field over the sphere: the harmonic value drives a perceptual positive/negative palette split with ambient-occlusion shading. Continuously morphs between (l, m) modes.

**Parameters**: Amplitude, Debug BB

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=MobiusGrid" target="_blank"><img src="docs/screenshots/MobiusGrid.png" alt="MobiusGrid" width="280"></a></td>
<td valign="top">

#### MobiusGrid

A latitude-longitude grid that undergoes live Möbius transformation animation via `MobiusWarpCircularTransformer`.

**Parameters**: Rings, Lines, Alpha

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=Voronoi" target="_blank"><img src="docs/screenshots/Voronoi.png" alt="Voronoi" width="280"></a></td>
<td valign="top">

#### Voronoi

Spherical Voronoi diagram with animated seed positions. Cells are always filled with per-site palette colors (blended across the seam between the nearest two sites); an optional black border seam is painted between neighboring cells when **Border Thick** > 0 (off by default).

**Parameters**: Num Sites, Speed, Sharpness, Border Thick

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=PetalFlow" target="_blank"><img src="docs/screenshots/PetalFlow.png" alt="PetalFlow" width="280"></a></td>
<td valign="top">

#### PetalFlow

Polyline rings drift pole-to-pole through an inverse stereographic projection, each wobbled into petal lobes and twisted by an angle that grows with its position; rasterized via Plot.

**Parameters**: Twist, Speed, Alpha, Density

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=DreamBalls" target="_blank"><img src="docs/screenshots/DreamBalls.png" alt="DreamBalls" width="280"></a></td>
<td valign="top">

#### DreamBalls

Draws twisting wireframe knotted structures over a selectable Platonic, Archimedean, or Catalan base mesh. The `Base Mesh` dropdown exposes all 31 of them (`Solids::BaseMesh`), and its selection is stored with the other preset parameters. Edges render as an over/under weave whose crossing graph `Weave Topology` selects: `Automatic` (the default every preset carries) parallel-transports each crossing's outgoing frame to the hidden end of the incoming edge when the solid is four-regular and falls back to the medial graph when it is not, `Medial` forces that medial graph, and `Original with defects` keeps the source mesh's shared-vertex framing. `Weave Gap` is the fraction of each strand that fades out where it tucks under its crossing partner. Mesh vertices are displaced along per-vertex tangent frames to create orbiting knot patterns, and a Möbius warp is applied to the geometry. Multiple copies orbit simultaneously while the whole structure tumbles under a slow Languid random-walk view orientation punctuated by periodic full-sphere spins. Five presets cycle every 320 frames, each carrying its own solid (rhombicuboctahedron, rhombicosidodecahedron, truncated cuboctahedron, icosidodecahedron, snub cube) and displacement settings. Four fixed procedural palettes cover the five: the first two presets share a blood-stream palette composed with an alpha falloff that ramps alpha linearly from full at the palette's near end to zero at its far end, and the last three take rich sunset, lavender lake, and coral blue. The outgoing sprite fades out before the incoming one fades in, so exactly one mesh renders per frame.

**Parameters**: Base Mesh (source solid), Weave Topology (crossing graph), Weave Gap (under-strand fade), Copies (number of knot copies), Radius (displacement), Speed (orbit speed), Warp (Möbius warp scale), Alpha

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=Comets" target="_blank"><img src="docs/screenshots/Comets.png" alt="Comets" width="280"></a></td>
<td valign="top">

#### Comets

A single head traces spherical Lissajous curves, cycling through a dozen configurations, trailed by a long 115-frame orientation tail and periodically wiping the palette to a fresh triadic scheme.

**Parameters**: Alpha, Thickness, Cycle Dur, Debug BB

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=RingSpin" target="_blank"><img src="docs/screenshots/RingSpin.png" alt="RingSpin" width="280"></a></td>
<td valign="top">

#### RingSpin

Four great-circle rings tumble continuously under energetic random-walk rotation, each leaving a fading motion-blur trail of its recent orientations (drawn with `Scan::RingGroup`, which fuses a frame's near-coincident sub-rings into one scan pass; head and tail of the trail thickened). Each ring is colored by a baked vignette palette.

**Parameters**: Alpha, Thickness, Debug BB

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=RingShower&resolution=Holosphere%20(96x20)" target="_blank"><img src="docs/screenshots/RingShower.png" alt="RingShower" width="280"></a></td>
<td valign="top">

#### RingShower

Rings bloom at random orientations and grow their radius from zero, fading in over the first few frames and then holding (no fade-out), colored by a generative circular analogous palette — a continuous shower of expanding rings drawn with `Plot::Ring`. Each ring's radius, fade, and lifetime are pure functions of its age driven directly from a recyclable slot rather than a per-ring `Sprite`.

**Parameters**: Alpha

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=ChaoticStrings" target="_blank"><img src="docs/screenshots/ChaoticStrings.png" alt="ChaoticStrings" width="280"></a></td>
<td valign="top">

#### ChaoticStrings

A head traces a fixed 12:5 spherical Lissajous figure whose long trail is continuously warped by a noise transformer, over a slowly cycling gradient palette.

**Parameters**: Alpha, Cycle Dur, Speed, Jitter Amp, Noise Scale, Scale Factor, Cycle Speed, Duty Cycle

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=MeshFeedback" target="_blank"><img src="docs/screenshots/MeshFeedback.png" alt="MeshFeedback" width="280"></a></td>
<td valign="top">

#### MeshFeedback

A selectable Platonic, Archimedean, or Catalan wireframe rendered with `Plot::Mesh`, given a noise-distorted, feedback-loop appearance via `Filter::Pixel::Feedback`. An orientation random-walk tumbles the solid while a `Presets` cycle hard-cuts both the base mesh and feedback/distortion style parameters.

**Parameters**: Base Mesh, Fade, Distort Amp, Distort Freq, Distort Speed, Noise Scale, Hue Shift, Feedback

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=MindSplatter" target="_blank"><img src="docs/screenshots/MindSplatter.png" alt="MindSplatter" width="280"></a></td>
<td valign="top">

#### MindSplatter

Particles spray from emitters at the vertices of a selectable Platonic solid — each sweeping its own tangent-plane emission angle — and fall toward attractor wells at the vertices of its dual. The tetrahedron is self-dual; cube/octahedron and dodecahedron/icosahedron form the other pairs. Event-horizon kernels punch the particles out around each attractor. A random walk tumbles the view, periodic Möbius warp bursts distort the whole field, and a preset timer transitions the base mesh, friction, well strength, and speeds between eight presets.

**Parameters**: Base Mesh, Friction, Well Str, Init Spd, Ang Spd, Warp, Particles

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=Dynamo&resolution=Holosphere%20(96x20)" target="_blank"><img src="docs/screenshots/Dynamo.png" alt="Dynamo" width="280"></a></td>
<td valign="top">

#### Dynamo

A vertical strand of points — one per latitude row — drifts horizontally around the sphere, each row dragging the next under a gap constraint so the chain wavers like a wind-blown curtain. The strand leaves motion trails, is replicated three times around the sphere, periodically reverses direction, and tumbles under random-axis rotations, while periodic color wipes sweep freshly generated analogous palettes across it.

**Parameters**: Speed, Gap, Trail Len, Trail Cap, Wipe Dur

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=Thrusters&resolution=Holosphere%20(96x20)" target="_blank"><img src="docs/screenshots/Thrusters.png" alt="Thrusters" width="280"></a></td>
<td valign="top">

#### Thrusters

A central distorted ring (`Plot::DistortedRing`) warps and spins; periodic random "fires" kick it onto a new axis and bloom a pair of opposed thrust rings (`Plot::Ring`) that expand from a sub-pixel seed and fade out.

**Parameters**: Radius, Alpha

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=GnomonicStars" target="_blank"><img src="docs/screenshots/GnomonicStars.png" alt="GnomonicStars" width="280"></a></td>
<td valign="top">

#### GnomonicStars

A Fibonacci-spiral field of star-polygon SDFs, continuously deformed by an evolving Möbius warp (built on a gnomonic-projection transformer) and slowly tumbled by a Languid random walk.

**Parameters**: Points, Radius, Sides, Warp Speed, Debug BB

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=Raymarch" target="_blank"><img src="docs/screenshots/Raymarch.png" alt="Raymarch" width="280"></a></td>
<td valign="top">

#### Raymarch

Volumetric raymarcher that renders twisted tori at the 26 vertices of a disdyakis dodecahedron. Each torus is ray-marched with `Scan::Volume::draw` and lit with metallic Blinn-Phong shading (half-Lambert diffuse, specular highlights, Fresnel rim). A random-walk animation drives the camera orientation.

**Parameters**: Pulse Speed, Fill, Max Steps, Diffuse, Specular, Fresnel, Twist, AA Width

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=ShaderBall" target="_blank"><img src="docs/screenshots/ShaderBall.png" alt="ShaderBall" width="280"></a></td>
<td valign="top">

#### ShaderBall

Typed pullback sphere shader (extends `Effect` directly) whose presets compose a source function, sphere projection, surface lens, two planar warp stages, material shaping, coverage, and colorization. It includes the original liquid/flyby vocabulary plus Bonne, Peirce quincuncial, and Airocean (Dymaxion) projections; topology-aware seam metadata; generated triadic and deformation palettes; and continuous preset choreography. GUI edits publish directly to the live authored state, while preset changes use continuous parameter morphs, or — when the topology changes — a through-clear transition that fades the outgoing look to a cleared frame and the incoming one back up.

**Parameters**: the active controls are schema-driven by the selected slots. See the vocabulary and dependency map below.

</td></tr></table>

### ShaderBall Shader Vocabulary

ShaderBall is a fixed typed pipeline, not a free-form node graph. Each dropdown chooses one implementation for a named stage; the sliders below it edit only that stage's parameters. A frame snapshots the selected slots, live parameters, clocks, transforms, and palette resources before the per-pixel shader starts, so the hot loop reads immutable state.

The shader is a *pullback*: it starts at a visible point on the sphere and walks backward through camera, lens, projection, and warps to discover the source coordinate to sample. Material stages then turn that signed source value and the projection/warp metadata into RGBA.

```mermaid
flowchart LR
  V[Sphere sample] --> OC[Outer camera]
  OC --> L[Surface lens]
  L --> PF[Projection frame]
  PF --> P[Projection]
  P --> PL[Projected lookup<br/>coords + weight + seam topology]
  PL --> OW[Outer planar warp]
  OW --> IW[Inner planar warp]
  IW --> F[Source function]
  F --> SW[Signal weight]
  SW --> VT[Value transfer]
  VT --> C[Colorizer]
  C --> RGBA[RGBA]

  PL -. projection weight .-> SW
  PL -. projection weight / edge distance .-> OW
  PL -. projection weight / edge distance .-> IW
  PL -. projection weight / edge distance .-> CV[Coverage]
  VT -. shaped value .-> CV
  CV -. alpha .-> C
  OW -. displacement + path metadata .-> C
  IW -. displacement + path metadata .-> C
```

The authored stage order is `source → inner warp → outer warp → projection`; pullback evaluation reverses it. **Outer Warp** is therefore nearest the projection and **Inner Warp** nearest the source. This positional vocabulary is stable even when either stage is `None`.

| Stage | Options | Produces or controls |
|---|---|---|
| **Function** | Twin Wave, Rings, Spiral, Grid, Coupled / Direct, Noise Contour, Primitive Lattice | A signed scalar field sampled in the final planar coordinates. Function-specific controls replace irrelevant generic sliders. |
| **Projection** | Equirectangular, Stereographic, Gnomonic, Bonne, Peirce Quincuncial, Airocean / Dymaxion | Planar coordinates plus region/component identity, projection weight, boundary traits, stable edge identity, and fade distance. |
| **Projection Frame** | Identity, Spin + Wander | Rotates the sphere before projection. Spin Rate and Projection Wander exist only for Spin + Wander. |
| **Lens** | None, Glitch, Twist, Kaleidoscope, Möbius, Tangent Noise | Distorts a unit-sphere direction before projection. Lens Mix and lens-specific controls exist only for an active lens. |
| **Outer / Inner Warp** | None, Legacy Stereo Noise, Affine Frame, Wave Shear, Vortex, Vector Noise, Curl Flow, Mirror Tile, Polar Chart | Pulls planar coordinates backward and accumulates displacement, deformation, and path length for downstream colorizers. |
| **Signal Weight** | None, Projection | Optionally multiplies the signed source signal by the projection's weight before remapping it to `[0, 1]`. It changes value, not alpha. |
| **Value Transfer** | Linear, Ridge, Iso Contour, Smooth Bands | Shapes the normalized value. Iso controls appear only for Iso Contour; Band Count and Band Phase only for Smooth Bands. |
| **Coverage** | Opaque, Projection Weight, Projection Weight Squared, Value Cutout, Edge Fade | Computes alpha independently from color value. Linear projection weight is softer and broader than the squared form. |
| **Colorizer** | Generated Triadic, ShaderBall Liquid, Deformation Ink | Converts shaped value, coverage, and optional warp metadata into straight-alpha color. |

Selector dependencies are explicit and deterministic:

```mermaid
flowchart TD
  Projection -->|Bonne| Bonne[Hemisphere + standard parallel]
  Projection -->|Peirce| Peirce[Layout; scroll for strip layouts]
  Projection -->|Airocean / Dymaxion| Air[Net layout]
  Projection -->|Gnomonic| Gnomonic[Hemisphere policy]
  Projection --> CommonP[Meridian / scale / pole controls<br/>when meaningful]

  Function --> Source[Function-specific source controls]
  Lens --> LensParams[Lens Mix + selected lens controls]
  OuterWarp[Outer Warp] --> OuterParams[Selected stage controls]
  InnerWarp[Inner Warp] --> InnerParams[Selected stage controls]
  ValueTransfer --> TransferParams[Iso or band controls]
  Coverage --> CoverageParams[Cutout threshold or edge width]
  Colorizer --> ColorParams[Palette / breathe / hue / fade controls]
```

Some combinations are intentionally inadmissible. Legacy stereographic noise selects Stereographic projection; seam-sensitive noise stages do not cross the cut topology of Bonne, Peirce, or Airocean; Polar Chart constrains the compatible source; and the device cost model may clear a sibling stage to stay within the 62.5 ms frame budget. These are canonicalization rules between typed stages, not preset-specific patches.

Projection seams use topology supplied by the projection kernel rather than guessing from planar coordinates. **Edge Fade** treats paired cuts as subduction boundaries: one stable side receives the authored fade width, while its partner gets only a one-pixel feather. Glued and periodic edges remain continuous and do not fade. **Pole Fade** is projection weight; selecting either projection-weight coverage policy carries that attenuation into alpha as well as any separately selected signal weighting.

GUI sliders and dropdowns apply immediately. Automatic preset choreography remains continuous: compatible configurations morph one live state, while incompatible discrete topologies blend complete endpoint colors. Source, warp, projection, breathe, global-walk, and palette clocks keep advancing according to their named rates; **Pause Presets** stops automatic preset selection, not those clocks.

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=DisplacementField" target="_blank"><img src="docs/screenshots/DisplacementField.png" alt="DisplacementField" width="280"></a></td>
<td valign="top">

#### DisplacementField

A stack of evenly spaced soft-stroked rings (`Scan::DistortedRing`) sharing one axis, each vertex displaced along the stack axis by a stack of displacement fields that alternate between two phases. In the ball phase, cap-shaped bumps spawn at the pole on random meridians and fall to the opposite pole at varying speeds, bowing the rings away from each falling ball; once the last ball lands, a two-octave world-space OpenSimplex noise field (octave 1 envelopes octave 2, so perturbations turn sparse wherever the envelope runs near zero) fades in from zero, dwells at full strength, then fades back out into the next ball phase. Ring colors sweep a circular analogous palette across the stack, with each fragment's hue rotated by the local displacement magnitude, and the palette slowly wipes to a freshly generated one every ~11 seconds.

**Parameters**: Alpha, Rings, Thickness, Ball Amp, Noise Amp, Scale 1, Scale 2, Hue Rotate, Flow Speed, Ball Min, Ball Max, Ball Rate, Speed Min, Speed Max

</td></tr></table>

<table border="0"><tr>
<td width="300"><a href="https://woundedlion.github.io/daydream/?effect=ShapeShifter" target="_blank"><img src="docs/screenshots/ShapeShifter.png" alt="ShapeShifter" width="280"></a></td>
<td valign="top">

#### ShapeShifter

Concentric polygon, star, or flower outlines drawn through the `Plot` rasterizer. Dense planar stars use direct sampled edges, with pole-crossing edges routed through the shared rasterizer and the same pre-shaded fragment shader. The rings span the full sphere radius under a selectable spacing law — **Spacing** is either uniform steps in radius or screen-balanced, which redistributes the rings away from the poles (subject to a density floor) so their on-screen spacing stays even — and **Alpha Falloff** picks each ring's alpha profile: a flat half, or full at the poles fading toward the equator. A selectable animated waveform offsets each ring's phase to twist the stack back and forth while a global random walk reorients the stack. A periodic timer steps through the presets, each one snapping the whole parameter set to a fresh arrangement of spherical polygons, flowers, or stars.

**Parameters**: Alpha, Shape, Count, Sides, Function, Amplitude, Speed, Opposite, Alpha Falloff, Spacing

</td></tr></table>

### Legacy Effects (`effects_legacy.h`)

TheMatrix, ChainWiggle, RingRotate, RingTwist, Curves, Kaleidoscope, StarsFade, DotTrails, Burnout, Fire, Spinner, Spiral, WaveTrails, RingTrails — built before the current engine and using an older rendering API. Functional but not representative of current architecture.

---

## 10. The Web Simulator (Daydream)

The [`daydream`](https://github.com/woundedlion/daydream) repo is a static web app that wraps the WASM build from this repo in a Three.js scene. The C++ rendering engine is unchanged — the same effect classes, the same arenas, the same per-frame `Pixel[]` buffer. Daydream's job is to:

1. Drive the WASM engine one frame at a time at a fixed cadence.
2. Map each `(x, y, color)` pixel to a position on a 3D sphere and render it as an instanced dot mesh.
3. Provide a UI for switching effects, tuning parameters, sweeping resolutions, recording video, and exercising the segmented-POV multi-board mode.
4. Host four standalone geometry tools for interactive design work, one of which (`solids.html`) drives the engine's own `MeshOps` through WASM.

### 10.1 Process and Threading Model

```
Main thread                                Web Workers (segment mode only)
─────────────                              ──────────────────────────────
index.html → vendor-importmap.js           segment_worker.js × N
              ↓ (resolves three/lil-gui    each owns its own WASM module
              ↓  to local or CDN)
            bootstrap.js (entry)           engine.setClip(x0,x1,y0,y1)
              ├─ failure overlay +         engine.drawFrame()  → pixel slice
              │  refreshModuleCache()      postMessage(Transfer pixels)
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

`index.html` loads exactly one module, `bootstrap.js`, which dynamically imports `daydream.js` inside a `try`/`catch` — the only handler for a module-graph load failure. On failure it renders the error into the page's `loading-overlay` (as `role="alert"`, with a focused **Reload** button) and falls back to the shared fatal-error banner when no overlay exists. The Reload handler first runs `refreshModuleCache()`, which re-fetches every same-origin `.js` and `.wasm` the page has already loaded with `cache: 'reload'`. That is the remedy for the deploy-skew hazard: a plain browser reload only revalidates the top-level document, so modules cached from an earlier deploy stay stale and keep failing to link against freshly fetched importers — and the WASM binary is bound to its glue by content hash, so a stale binary against fresh glue is the canonical form of the skew.

A normal page load creates one WASM instance on the main thread. The dot mesh has one instance per LED pixel; the per-frame work is `instanceColor.needsUpdate = true` after the WASM buffer view is refreshed. When the user enables Segmented POV (§10.7), `daydream.js` spawns N Web Workers, each holding its own WASM module so the four-Teensy Phantasm layout can be exercised in software.

### 10.2 The WASM Bridge

`wasm.cpp` compiles to `holosphere_wasm.js` + `.wasm` and exposes a single `HolosphereEngine` class. At most one instance may be live per module — its effect and arenas are shared module-global storage — so `delete()` the current engine before constructing another; the constructor traps otherwise.

| Method | Description |
|---|---|
| `setResolution(w, h)` → `ResolutionSetResult` | Switch active resolution (96×20 or 288×144). Returns `Module.ResolutionSetResult.RESIZED` when the switch took — tearing down the current effect, so `setEffect` and any clip must be re-applied — `ALREADY_ACTIVE` for a request matching the active resolution (a pure no-op; nothing is torn down), or `UNSUPPORTED` for a size the build cannot render (ignored, prior state kept). Compare against the enum values — never by truthiness |
| `setEffect(name)` → `EffectSetResult` | Instantiate a new effect by string name; resets all arenas to defaults. Returns `Module.EffectSetResult.INSTALLED` on success, else the rejection reason (`UNKNOWN_EFFECT`, or `UNSUPPORTED_RESOLUTION` when the active resolution has no factory); a rejection keeps the prior effect alive. Compare against the enum values — never by truthiness |
| `drawFrame()` | Advance one frame and copy pixels to the output buffer |
| `getPixels()` | Return a zero-copy `Uint16Array` view into WASM linear memory, spanning the active resolution's prefix of the fixed backing buffer |
| `getBufferLength()` → `int` | Length of the pixel buffer (`W × H × 3`) for sizing the view, and the staleness test for a cached one: a `setResolution` moves this length without detaching the outstanding view |
| `setParameter(name, value)` → `ParamSetResult` | Update a live effect parameter; returns `Module.ParamSetResult.APPLIED` on success, else the rejection reason (`NO_EFFECT`, `UNKNOWN_PARAM`, `READONLY`, or `NON_FINITE`). Compare against the enum values — never by truthiness. An `APPLIED` float may still have been clamped to the param's `[min, max]`; read the effective value back via `getParamValues()`. An `APPLIED` write to an *animated* param also engages the animation pause (the animation would otherwise overwrite the value on the next frame), and that pause survives `setEffect` — check `getAnimationsPaused()` afterwards |
| `setAnimationsPaused(paused)` | Freeze/resume the current effect's animation drivers (the GUI "Pause Animation" toggle) |
| `getAnimationsPaused()` → `bool` | Whether those drivers are currently frozen. The engine is the owner of this state — an `APPLIED` `setParameter` on an animated param engages the pause by itself — so read it back rather than mirroring the rule in JS |
| `setPoleLod(aggressiveness)` | Set near-pole azimuthal shading decimation (the GUI "Pole LOD" slider, `[0, 2]`); non-finite and negative inputs clamp to 0, and the value saturates at 8. The setting is a module-global, so it reaches only the engine instance it was called on — a segmented pool needs it re-sent to every worker (§10.7) |
| `getPoleLod()` → `float` | Current decimation aggressiveness |
| `getParameterDefinitions()` | Return the parameter list; each entry is `{name, value, animated, readonly, preset}`, and float params additionally carry `{min, max}` (bool params omit `min`/`max` and return `value` as a JS boolean). `preset` is a bool, `false` only for a param the effect excluded from preset exports (`mark_global`), so an export tool skips those alongside the readonly ones. Enum params (registered with option labels) also carry `options`, an array of label strings indexed by the param's value, which the GUI renders as a dropdown; an enum registered with export literals carries `exportOptions` as well — the C++ enum literals indexed the same way, which the export formatter emits in place of a numeric literal. `exportOptions` is absent on an enum registered without them, and on every non-enum param |
| `getParamValues()` | Return current parameter values (including animation-driven updates), as raw floats in definition order. A bool param streams as `0.0`/`1.0` here even though `getParameterDefinitions()` reports its `value` as a JS boolean, so a consumer reads the type off the definition and thresholds this stream at 0.5 rather than testing `typeof` on it |
| `getParamGeneration()` → `int` | Generation identifying which loaded-effect or no-effect state the definition and value streams describe. Pin it beside a `getParameterDefinitions()` snapshot and re-read it with each `getParamValues()` call; a changed value means the snapshot is stale (parameter counts repeat across the roster, so a length check alone cannot detect the switch or teardown) |
| `getArenaMetrics()` | Memory usage stats for the three engine arenas, plus the stack high-water mark (see below). Read once per frame by the HUD, so it omits the tooling arenas an engine instance never moves; `MeshOps.getArenaMetrics()` reports all six on demand |
| `getEffectSizes()` | Return `sizeof` for every registered effect at the current resolution |
| `getSupportedResolutions()` → `[[w, h], …]` | *(static)* List the resolutions the build supports, as `[width, height]` pairs |
| `setClip(x0, x1, y0, y1)` → `ClipSetResult` | Restrict rendering to a sub-rectangle (used by segment workers). Returns `Module.ClipSetResult.APPLIED` when the band is installed, `FULL_FRAME_KEPT` when the bounds are accepted but ignored because the effect reports `needs_full_frame()` (§10.7) and keeps the full-canvas clip, else the rejection reason (`NO_EFFECT` or `INVALID_BOUNDS`). Compare against the enum values — never by truthiness. Both `APPLIED` and `FULL_FRAME_KEPT` are successes, and a segment pool needs them apart to tell an N-way parallel speedup from N workers each computing the same full frame. The two rejections want opposite responses: `INVALID_BOUNDS` is a caller bug worth faulting on, while `NO_EFFECT` is the ordinary state between a `setResolution()` (or an `init` carrying no effect name) and the `setEffect()` that follows. A clip is dropped by any `INSTALLED` `setEffect()` or `RESIZED` `setResolution()` (an `ALREADY_ACTIVE` same-resolution call keeps the clip) and must be re-applied |
| `strobeColumns()` → `bool` | Whether the current effect renders as discrete strobed columns (dark inter-column gaps) rather than a continuous smeared band; `false` when no effect is set. Daydream reads it to decide whether to fill the inter-column gap |

The bridge also exposes a `MeshOps` class — used by the `solids.html` geometry tool — with dedicated tooling arenas (an 8 MB persistent arena plus two 4 MB scratch arenas — 16 MB total, separate from the engine's 298 KiB arena) for interactive solid manipulation. `fromSolidName`, `getVertices`, `getFaces`, `classifyFaces` and the operator methods answer a rejected call with `null`; `MeshOps.getLastResult()` then names the reason as a `Module.MeshOpResult` value (`OK`, `UNKNOWN_NAME`, `CONNECTIVITY_OVERFLOW`, `FACE_DEGREE_OVERFLOW`, `ARENA_EXHAUSTED`, `NON_FINITE_ARG`, `ANGLE_OUT_OF_DOMAIN`, `STALE_WRAPPER`, or `ARENA_UNAVAILABLE`). Compare against the enum values — never by truthiness — and read it before the next such call, which overwrites it. The reasons demand opposite responses: an overflow means shrinking the op chain, `ARENA_EXHAUSTED` means calling `clearToolingMemory()`, `STALE_WRAPPER` — a wrapper used after a `clearToolingMemory()` reclaimed its storage — means rebuilding the mesh from its base solid, and `ARENA_UNAVAILABLE` — the 16 MB tooling block itself could not be allocated — means no MeshOps call can run at all, so the tool must stand down rather than retry. That last one is a reject rather than a trap for the same reason as the rest: an allocation failure in a long-lived tab must cost the page a null, not the module. A stale wrapper is rejected rather than trapped, so an interleaved wipe costs the page a null, not the module. Two class functions sit outside that contract as pure table reads — no arenas, no wrapper, no `clearToolingMemory()` pairing: `MeshOps.getRegistry()` lists every registered solid as `{name, category}` for the editor's solid picker, and `MeshOps.getRecipe(name)` returns one entry's authored op chain as `{seed, ops: [{op, param, twist}]}` in engine-native units, answering `null` for an unknown name or for a known entry that carries no recipe.

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
  resolution's length, and a 96×20 view left bound to a 288×144 dot mesh renders
  the frame wrong rather than throwing. Only a length check catches it.

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
| **Picture-in-picture** | A clone of the main camera, tracking its position and orientation each frame, renders the same view into a square 30%-sized bottom-right viewport. Suppressed when `isMobile`, under `navigator.webdriver` (§ headless capture), and while recording. |
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

### 10.5 The Effect Sidebar (`sidebar.js`)

The left-edge effect list is a small custom widget:

- **Persistent button references**: re-sorting by name or size (live `sizeof` from `getEffectSizes()`) re-appends the existing button nodes in the new order without recreating them; `setEffects()` itself rebuilds the list from scratch.
- **Keyboard navigation**: arrow keys move the focused button (wrapping at the ends), Home and End jump to the first and last; Enter or Space selects.
- **Mobile horizontal scroll**: when laid out as a horizontal strip, scroll arrows fade in/out based on scroll position via a `ResizeObserver` + scroll listener.
- **Per-resolution filtering**: each resolution has its own curated effect list, shown in the sidebar. An effect that is not in the active resolution's list — including one hydrated from a `?effect=…` link — is replaced with that list's first effect, so only curated effects load at a given resolution.

### 10.6 GUI Auto-Generation

The effect parameter panel is entirely driven by what C++ registers via `register_param()`. When an effect is loaded, the simulator calls `getParameterDefinitions()` and builds `lil-gui` controls:

```js
params.forEach(p => {
    const controller = gui.add(state, p.name, p.min, p.max);
    controller.onChange(v => wasmEngine.setParameter(p.name, v));
});
```

`getParamValues()` is polled each frame to sync the GUI with parameter values that the animation system has changed autonomously. The sync skips any control the user is currently interacting with to avoid fighting the slider. A per-effect **Reset** rebuilds the GUI from defaults, and **Export** copies the current `{ name, value }` set as a C++-formatted initializer suitable for `Presets<…>` arrays.

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
- **Isolated WASM instances per worker** — each segment has its own arena, its own RNG stream, and its own effect state. The stream is *per effect load*: every `setEffect()` reseeds the shared `Pcg32` from `hs::epoch_seed(effect_loads++)`, mirroring the device's per-epoch reseed (load 0 keeps the identity `1337` stream). Workers therefore agree only because they process the same message sequence and reach the same load count — an emergent property with no cross-check. A pool rebuilt mid-session starts back at load 0 and does *not* match a main-thread engine that has already switched effects N times.
- **`setClip(x0, x1, y0, y1)`** — for a non-stateful effect the WASM engine restricts *rendering* to the worker's segment rectangle: the rasterizer's scanline culling skips out-of-clip rows and columns, so out-of-band pixels are never shaded. The pixel readback in `drawFrame()` still copies the full canvas buffer; `segment_worker.js` then extracts that rectangle with one `extractSegment()` call before transferring the result back, so only the segment crosses the worker boundary. That call lives in `segment_layout.js`, the module both ends share: the worker extracts with it and the main thread composites with its `compositeSegment()` counterpart, so one blit routine defines the segment rectangle for both directions.
- **Per-instance render settings must be re-sent** — `setPoleLod` writes `pole_lod_aggressiveness`, a module-global of the WASM instance it is called on. A worker's instance carries its own copy, so a value set on the main-thread engine does not reach the pool: the controller must forward the setting to every worker (a protocol message of its own, applied like `setAnimationsPaused`) or the composited preview renders undecimated while the slider reads non-zero.
- **Cross-segment stateful effects render full-frame** — an effect whose per-frame state reads pixels *outside* the worker's band (`MeshFeedback`'s feedback warp samples the previous frame at unbounded offsets; `Dynamo` reprojects `World::Trails` under rotation) cannot be band-clipped: a clipped worker would have stale/zero history outside its band, so cross-band trails read as black and seams appear. Those effects report `Effect::needs_full_frame()` (derived from a compile-time `any_crosses_segments` filter-pipeline trait), and `setClip` leaves their clip at the full canvas and reports `FULL_FRAME_KEPT` — every worker computes the bit-identical full frame and `segment_worker.js` slices its segment rectangle from the full readback. This mirrors the device exactly, where each board independently renders the whole canvas; only non-stateful effects keep segmented rendering's clipping win.
- **One-frame pipeline** — frame N's render is dispatched fire-and-forget; frame N-1's results are composited synchronously when they arrive. The stats overlay's `max` row — the slowest worker's own `drawFrame()` — is the comparable number, and is what the multi-Teensy hardware sees. The `round-trip` row below it spans dispatch to last worker response, so it also carries structured-clone, `ArrayBuffer` transfer and main-thread event-loop latency that the hardware has no analogue for.
- **Boundary overlay** — a "Show Boundaries" toggle paints cyan markers on the segment edges in the composite buffer to make the partition visible.
- **Protocol version handshake** — `worker_protocol.js` exports a `PROTOCOL_VERSION` that both ends stamp and check. Each worker posts a `booted` ping carrying it *before* instantiating WASM, and the controller's `init` message carries it back; either side faults on a mismatch — a stale cached worker or glue file against a newer peer — instead of drifting on reshaped message fields.
- **Watchdogs, bounded boot retry, and a latched fault** — a worker that hangs or fails to load without throwing fires no `onerror`, so three deadlines bound the pipeline: the `booted` ping (module fetch + evaluate), pool readiness (WASM instantiate), and render liveness. The render deadline is re-armed on every distinct segment frame, so a slow effect keeps extending it while a true stall still faults. A message-less `error` event before the pool is ready is a transient module-fetch failure and rebuilds the pool a bounded number of times with a short backoff; anything else latches. Latching terminates every worker and halts the pool with no auto-restart, replacing the per-segment stats table with a fault banner naming the segment and the reason — it stays down until a user-driven resolution or segmented-mode change rebuilds the pool.

### 10.8 Vendor Importmap (Local-First / CDN Fallback)

`vendor-importmap.js` is loaded as a regular (non-module) `<script>` by `index.html` and by the three tool pages that import bare specifiers. `palettes.html` imports none — every module it loads is page-relative — so it carries no importmap script at all. At parse time the helper:

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
`index.html` and each of the four tool pages, bounds this on every browser
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

A page-specific local import (e.g. `solids.html` referencing `../solids.js`) is added by setting `window.daydreamExtraImports` to a `{ specifier: url }` map before the helper script.

### 10.9 Video Recording (`recorder.js`)

A `VideoRecorder` wraps `MediaRecorder` over an offscreen capture canvas's `captureStream(0)` — the manual-frame-request mode where frames are taken on demand instead of on wall-clock. On the single-engine path, every simulation tick calls `recorder.captureFrame()`, which blits the source canvas into the offscreen and requests a frame from the stream; recorded video is therefore locked to the effect's simulation rate (16 FPS by default) regardless of how fast the browser actually renders, with byte-perfect repeatability between recordings. The segmented path captures only ticks where `captureReady()` reports that a composite landed, so a pool overrun can drop a recorded frame and void both guarantees. The guarantees also require the captured track to expose `requestFrame`; on browsers lacking it the recorder falls back to a wall-clock timer.

Codec priority is MP4/H.264 → WebM/VP9 → WebM/VP8. Capture always goes through the offscreen canvas: it is either scaled to a target height for size-controlled exports, or pinned to the source's start-time size at native resolution. Either way the recorded track's frame size is fixed for the whole session, so a mid-recording resolution change cannot alter the encoded dimensions.

### 10.10 Resolution Presets

| Name | Width × Height | Notes |
|---|---|---|
| `Holosphere (96x20)` | 96 × 20 | Matches the original Holosphere hardware |
| `Phantasm (288x144)` | 288 × 144 | Matches Phantasm; default in the web simulator |

Switching presets does a full WASM reset: `setResolution(w, h)` updates the active width/height and drops the current effect — the pixel buffer is pre-sized to `MAX_W × MAX_H` and deliberately never resized (a realloc could move its backing store under `ALLOW_MEMORY_GROWTH` and detach every outstanding `getPixels()` view), so `getPixels()` returns a view over just the active prefix. `setEffect(name)` then rebuilds the effect at the new template instantiation. The sidebar swaps to the matching favorites list (§10.5).

### 10.11 Geometry Tools (`daydream/tools/`)

Four standalone HTML pages. Three render with their own Three.js scene; `palettes.html` renders with 2D canvas contexts. Two are backed by the engine's WASM build so their math stays identical to the C++ engine — `solids.html` via the `MeshOps` class and `palettes.html` via `PaletteOps` — and both hard-require it: a failed module load raises a fatal banner instead of falling back. `lissajous.html` and `mobius.html` implement their geometry math directly in JavaScript:

| Tool | What it does |
|---|---|
| `lissajous.html` | Designs spherical Lissajous curves with live frequency / phase sliders; outputs a C++ `LissajousParams` initializer for the engine's Lissajous effects (`ChaoticStrings`, `Comets`). |
| `mobius.html` | Visualizes Möbius transformations on the sphere via the engine's stereographic projection; lets you sweep the four complex coefficients, see the warp on a latitude-longitude grid, and copy a C++ `MobiusParams` initializer. |
| `palettes.html` | Tunes `ProceduralPalette` cosine coefficients and versioned `GenerativePalette` recipes, exports complete canonical C++ recipes, and renders engine-returned LUTs and diagnostics on 2D canvas contexts. |
| `solids.html` | Conway operator playground — chain `truncate`, `kis`, `ambo`, `dual`, etc. on Platonic / Archimedean / Catalan / Islamic-pattern seeds and visualize the result. Backed by the WASM `MeshOps` bridge with dedicated tooling arenas (16 MB, separate from the engine's 298 KiB arena). |

The three Three.js pages reuse `vendor-importmap.js`, so they resolve from the CDN by default or from the local `three.js/` after `npm run importmap:local`. `palettes.html` imports only page-relative modules, so it carries no importmap script and its CSP `script-src` is `'self'` with no CDN origin.

---

## 11. Building

The two repos should be checked out as siblings so the WASM install step can write directly into the simulator tree:

```
work/
├── Holosphere/          (this repo — C++ engine + firmware + WASM build)
└── daydream/            (web simulator — receives WASM artifacts)
```

### Firmware (Arduino / Teensy 4.x) — Holosphere repo

Each hardware target has its own `.ino` entry point in `targets/`:

1. Install [Arduino IDE](https://www.arduino.cc/en/software) with Teensyduino (or use [Visual Micro](https://www.visualmicro.com/) for Visual Studio).
2. Install the `FastLED` library.
3. Open `targets/Holosphere/Holosphere.ino` (or `targets/Phantasm/Phantasm.ino`).
4. Set **Additional Include Directories** to: `../../core;../../effects;../../hardware`
5. Select **Board: Teensy 4.0**, **CPU Speed: 600 MHz**.
6. Upload.

> **Headless size/layout gate — an active CI job, optional locally.** A
> PlatformIO build (`just teensy-size`, needs `pip install platformio`) builds
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
> with the bench build.

Target-specific constants are defined in each `.ino` file (not a global `constants.h`):
```cpp
// targets/Holosphere/Holosphere.ino
static constexpr int NUM_PIXELS = 40;
static constexpr unsigned int RPM = 480;
```

Pin assignments are in `core/render/led.h` (also included by `hardware/pov_single.h`):
```cpp
static constexpr int PIN_DATA   = 11;
static constexpr int PIN_CLOCK  = 13;
static constexpr int PIN_RANDOM = 15;
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
- Source paths: `targets/wasm/wasm.cpp`, `core/engine/memory.cpp`, `core/engine/static_storage.cpp`, `core/engine/reaction_graph.cpp`
- Include paths: project root (for `effects/`, `hardware/`) and `core/` (for engine headers)
- `-sALLOW_MEMORY_GROWTH=1` — WASM heap can grow for large meshes
- `-sMODULARIZE=1 -sEXPORT_ES6=1` — ES6 module output
- `-sSTACK_SIZE` — per build type: 8192 for release (minimal; effects use arena allocation, not deep recursion) and 65536 for debug, where `-O0` disables inlining and stack-slot coalescing and inflates frames past the release budget. Each build-type block sets it exactly once and the shared block never does, so the effective value cannot depend on link-line ordering
- `-O3 -ffast-math -fno-finite-math-only -flto -msimd128` for release, `-O0 -g -sASSERTIONS=1` for debug (`-fno-finite-math-only` must follow `-ffast-math`, which otherwise folds `std::isfinite()` to true and lets the compiler assume no NaN/Inf — the render sink relies on real finite semantics)

The install step also writes `README.md` and `docs/screenshots/` so the daydream repo always serves the same documentation as Holosphere.

### Tests — Holosphere repo

The unit suite is a native (non-WASM) Clang build with asserts enabled, also driven by a preset:

```bash
cmake --preset tests          # configure (cmake/toolchain-native-clang.cmake)
cmake --build --preset tests  # build the run_tests executable
ctest --preset tests          # run the suite (or: just test)
```

The suite must use Clang — the engine relies on GCC/Clang `__attribute__` extensions MSVC rejects. The native toolchain file ([`cmake/toolchain-native-clang.cmake`](https://github.com/woundedlion/pov/blob/master/cmake/toolchain-native-clang.cmake)) locates Clang via `EMSDK` (or a sibling `../emsdk`) and, on Windows, transparently handles the resource compiler and `lld-link` so no Visual Studio Developer Prompt is required. Tests build with `-DHS_TEST_BUILD`, which widens the host-only budgets: the inline type-erased animation slot (the 64-bit host inflates every embedded pointer past the 32-bit device footprint) and, most significantly, `GLOBAL_ARENA_SIZE` — **8 MiB under the flag against the device's 298 KiB**, so the effect smoke harness can render every effect without OOMing mid-run. The firmware/WASM footprint is unchanged: the real budget stays available as `DEVICE_GLOBAL_ARENA_SIZE`, which the device-budget `static_assert`s check even in the host suite. A high-water mark measured in the native suite is therefore *not* a device figure — it is a 64-bit measurement against an inflated ceiling.

Coverage spans the math/geometry/memory core, color, easing/waves, the reaction-diffusion graph integrity, filters, the plot samplers and the Scan/mesh rasterizer, solids-registry invariants, the Conway/Hankin mesh operators, and animation. Beyond those unit checks the suite also runs: an effect smoke harness that constructs and renders every effect with asserts on, plus a cross-run determinism pass that re-renders each effect under a fixed clock and diffs the frames — at the small-aspect 96×20 simulator/test resolution by default (the only firmware image that renders 96×20 is Holosphere — the `holosphere`/`holosphere_dma` PlatformIO envs build `-DCANVAS_W=96 -DCANVAS_H=20` and the sketch shows a single effect; the Phantasm image and every other env are 288×144), and additionally at the production 288×144 alongside a white-box correctness block when `HS_EFFECTS_FULL=1` is set, which CI does on every master push and pull-request update; a death harness that spawns subprocesses to confirm each `HS_CHECK` invariant traps; the Phantasm multi-board sync core (`hardware/pov_sync.h`, spec §12); the HD107S SPI wire-format and color-correction tests; the POV driver tiling proofs (each LED write covers the canvas exactly once); and the WASM param-marshaling coverage (the JS definition/value streams stay index-aligned). `tests/run_tests.cpp` is the driver. Extending it with a `tests/test_<module>.h` takes three edits, each pinned by its own CTest case:

1. `#include` the header in `run_tests.cpp`'s include block. The `unit_module_includes` test balances that block's size against the roster row count and requires every header in `tests/` outside a small non-module list to be included by name — so neither an orphaned include nor a test file nothing compiles survives.
2. Add an `X(name, case_sites, entry_point, min_assertions)` row to `HS_TEST_MODULE_LIST`, the X-macro that expands into `MODULES[]`. The fourth column is a **measured** assertion floor — the minimum over the configurations that move a module's count (the `HS_SMOKE_FRAMES` window, Debug `-O0` vs `RelWithDebInfo -O2`, and any `NDEBUG`-gated cases) — enforced by `end_module()`, so a case defined and never called turns the module red instead of compiling clean. `0` leaves a module unfloored. The floor is a count of *assertions*, which in a loop-amplified module (hundreds of assertion sites, millions of assertions) is too coarse to see one lost case whenever a concurrent edit widens a sweep. The `unit_case_calls` test covers that blind spot by counting *sites*: every `void test_*(` / `void check_*(` definition in `tests/` must be referenced elsewhere in its own header, and the second column pins **exactly** how many such definitions the module's header holds — so a case deleted together with its call, which neither the reference check nor the floor can see, turns that module red. That column is a pin, not a floor: adding a case means bumping it, and the gate's error reports the count it found next to the count it expected. `0` there means the module writes no `test_*`/`check_*` cases at all (`death` drives a case table, `effects_smoke` is one sweep).
3. Add the module name to `_hs_test_modules` in [`tests/CMakeLists.txt`](https://github.com/woundedlion/pov/blob/master/tests/CMakeLists.txt), which generates the one-CTest-test-per-module the CI shards target. `run_tests --check-modules` (the `unit_module_roster` test) fails if the CMake list and the roster diverge either way, so a module added to one but not the other can never run silently.

#### Continuous testing

Three layers run the same suite so a regression can't reach the live demo:

- **Local pre-commit hook** ([`.githooks/pre-commit`](https://github.com/woundedlion/pov/blob/master/.githooks/pre-commit)) — with C++/CMake changes staged it runs three gates: a `clang-format` check over the staged first-party sources, a build + run of the native suite, and the Teensy 4 size/layout gate (`pio run -e holosphere -e phantasm -e holosphere_dma`, enforcing the budgets in `tools/teensy_budgets.json`) — several minutes on a cold tree. The Teensy gate is skipped when PlatformIO is absent, so CI re-runs it as its own job; the format check is blocking unconditionally — an unformatted staged file fails the commit, and so does being unable to judge one: a missing `clang-format`, or one whose major differs from CI's pinned 22 (majors reflow differently, so an off-major verdict can't be trusted either way), fails the commit rather than waving it through. Install the pinned version (`pip install clang-format==22.1.8`) or point `CLANG_FORMAT` at a `clang-format-22` binary. **On by default (opt-out):** configuring the `tests` preset points `core.hooksPath` at `.githooks` automatically. Skip one gate with `HS_SKIP_FORMAT=1` / `HS_SKIP_TEENSY=1`; `HS_SKIP_TESTS=1 git commit …` stands down the native suite *and* the Teensy gate but not the format check, which runs ahead of it — only `--no-verify` bypasses the whole hook. Disable the auto-enable with `-DHS_INSTALL_GIT_HOOKS=OFF`. Doc-only commits skip all three. The effects module runs its QUICK tier here, so a green hook is not authoritative for the full-resolution passes.

  Once the Teensy gate passes, the hook records the three images' section sizes (`.text.itcm`, `.text.code`, `.text.progmem`, `.data`, `.bss`, `.bss.dma`, plus a derived `ram1`), and [`.githooks/post-commit`](https://github.com/woundedlion/pov/blob/master/.githooks/post-commit) stamps them with the new commit and appends them to a **per-commit size trail** — so a later ITCM/RAM1 growth can be attributed to the commit that caused it. The trail is `$(git rev-parse --git-common-dir)/teensy-size-trail.tsv`: **local only** — not tracked, shared by every worktree of the repo, and absent on a fresh clone until commits accumulate. Recording is advisory: a missing ELF, an unparseable image or a missing interpreter prints a warning and the commit proceeds. Query it with [`tools/teensy_size_trail.py`](https://github.com/woundedlion/pov/blob/master/tools/teensy_size_trail.py) (stdlib Python; it reads the ELF section headers directly, so no ARM toolchain is needed):

  ```bash
  python tools/teensy_size_trail.py show --last 20        # trail with per-row deltas
  python tools/teensy_size_trail.py regressions --region itcm --min-delta 256
  python tools/teensy_size_trail.py backfill master~20..master --worktree ../scratch-tree
  ```

  `backfill` links every commit of a range (minutes each) to populate the trail retroactively.
- **Presubmit CI** (`.github/workflows/ci.yml`, Holosphere repo) — on master pushes and pull-request updates (a push to a branch with no open PR triggers nothing), runs the native suite on both Linux (clang-22) and Windows (emsdk Clang, which exercises the `lld-link` / rc.exe toolchain branch from a plain shell), and builds the WASM module. It then **smoke-tests the WASM at runtime** ([`scripts/wasm_smoke.mjs`](https://github.com/woundedlion/pov/blob/master/scripts/wasm_smoke.mjs)) — instantiating the module the way the browser does and driving every registered effect at every enumerated resolution, so a SIMD-codegen fault, an embind signature mismatch, a stack overflow, or an `ALLOW_MEMORY_GROWTH` detachment fails here rather than riding a green build to deploy — and **verifies the install provenance set** (`holosphere_wasm.wasm` + `.js` + `.sha` + `.wasm.sha256`, the same artifacts the daydream deploy gate consumes), asserting the recorded `sha256` of both the binary and the Emscripten glue verifies and a clean checkout records no `-dirty` marker. The native suite there runs with `HS_SMOKE_FRAMES=120` to reach effect-lifecycle transitions the default short run skips, and runs a second time at `-O2` (the `tests` preset pins `Debug`, so UB the optimizer acts on and FP results that move under contraction are invisible to the Debug shards; `NDEBUG` is left undefined there so assertions and the arena guards stay live). The same shard matrix also runs under **ASan + UBSan** with `-fno-sanitize-recover` — the native build is the only one where the arena guards compile in, so this is the sole automated cover for the arena-lifetime UB the death harness can't reach — and the canvas / segmented-POV modules run once more under **TSan** (its own job: TSan cannot share a binary with ASan), which is the only check on the double-buffer handoff that x86-64's strong memory model masks. A `shard-coverage` job asserts every registered CTest matches exactly one shard regex, so a new module cannot fall out of every sanitized and unsanitized shard at once, and an advisory `code-coverage` job publishes an llvm-cov summary with no threshold gate. A `lint` job runs `ruff` over the Python tooling and `eslint` over `scripts/*.mjs` — both configured to defect rules only ([`ruff.toml`](https://github.com/woundedlion/pov/blob/master/ruff.toml), [`eslint.config.mjs`](https://github.com/woundedlion/pov/blob/master/eslint.config.mjs)), with no formatter and no stylistic rule enabled, so the gate reports breakage rather than reflowing the tree.
- **Gated deploy** (`.github/workflows/deploy.yml`, **daydream repo**) — daydream's GitHub Pages source is *GitHub Actions*. On a push to daydream's `master` (or manual dispatch), the engine's native unit suite runs as a **gate** (checking out the engine repo) alongside daydream's own JS suite; `deploy` `needs: [gate, js-tests]`, so only if both pass does the workflow publish the simulator to Pages. The engine's WASM is whatever is committed in daydream (built + installed from Holosphere). If the engine repo is private, add a `POV_TOKEN` secret (a read-access PAT) for the gate's checkout.

The simulator's JavaScript lives in the daydream repo and carries its own suite there: `tests/*.test.js`, run by `npm test` (`node --test`), covering the driver and clock, the sidebar and GUI, the segment workers and layout, param marshaling, color/palette math, and the geometry tools' math modules. Two committed ratchets keep a hollowed-out suite from reporting green: a `pretest` guard (`scripts/require-tests.mjs`) fails the run when the test glob matches fewer files than `package.json`'s `testFileFloor`, so a rename can't empty the suite silently, while `scripts/run-tests.mjs` checks every file against the `{cases, assertions}` minimums in `tests/assertion-floors.json`. Re-measure those per-file floors deliberately with `node scripts/run-tests.mjs --update-floors "tests/*.test.js"`; reductions belong only alongside the corresponding test removal. The suite runs on every daydream pull request (`.github/workflows/js-tests.yml`, alongside `npm run typecheck` and an import-map freshness check) and again as the `js-tests` job in `deploy.yml`.

### Documentation — Holosphere repo

```bash
just docs-check   # validate tracked Markdown (the ci.yml docs-markdown job)
just docs         # docs-check, then build the Doxygen reference into build/docs/html/
```

`just docs-check` runs [`tools/docs_check.py`](https://github.com/woundedlion/pov/blob/master/tools/docs_check.py) and its own unit tests: it checks fence balance, link and anchor targets, and backticked repo paths across every tracked Markdown file. The `effects/` row of the file map above draws no subtree, so the exhaustive-tree gate cannot reach its counts; they get their own assertion instead — the header count against the tracked tree, the effect count against `HS_EFFECT_LIST`'s cardinality. `just docs` needs `doxygen` on `PATH`; it clones the pinned doxygen-awesome theme into `.doxygen-awesome/` on first run and synthesizes `Doxyfile.local` from `Doxyfile` plus [`docs/doxygen-theme.cfg`](https://github.com/woundedlion/pov/blob/master/docs/doxygen-theme.cfg) — the same combination `.github/workflows/docs.yml` publishes to <https://woundedlion.github.io/pov/>.

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

**Live demo.** The `master` branch of daydream is published to <https://woundedlion.github.io/daydream/> via GitHub Pages. The CDN-fallback path is what powers it.

---

## License

This project is split-licensed: the rendering engine and the visual effects carry different terms.

**Engine — non-commercial.** The core infrastructure — the rendering engine, math, scan/raster, hardware drivers, and test harness, which in the Holosphere repository is everything outside `effects/` — is licensed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/) (see [`LICENSE`](LICENSE)). You may use, modify, and distribute it for any non-commercial purpose; commercial use is not granted.

**Effects — proprietary.** The visual effects — the Holosphere repository's `effects/` sources, and their compiled form in any distributed build artifact, including the `holosphere_wasm.wasm` module daydream ships — are Copyright 2025 Gabriel Levy. All rights reserved. They are not covered by the PolyForm license — no rights to use, copy, modify, or distribute them are granted.

**Third-party.** The engine vendors [FastNoiseLite](https://github.com/Auburn/FastNoiseLite) 1.1.1 as `core/vendor/FastNoiseLite.h` under the MIT License (Auburn / Jordan Peck), patched in tree as recorded in `core/vendor/FastNoiseLite_config.h` (first-party). The simulator vendors one file: `daydream/tools/tailwind.css`, a prebuilt [Tailwind CSS](https://tailwindcss.com) 3.4.17 utility sheet (MIT, Tailwind Labs) served same-origin to the four tool pages, carrying its upstream MIT banner; its preflight reset derives from [modern-normalize](https://github.com/sindresorhus/modern-normalize) (MIT, Sindre Sorhus), itself derived from normalize.css (MIT, Nicolas Gallagher and Jonathan Neal). Everything else the simulator uses loads at runtime: [three.js](https://github.com/mrdoob/three.js) (MIT, three.js authors) and [lil-gui](https://github.com/georgealways/lil-gui) (MIT, George Michael Brower) come from the jsdelivr CDN at the versions pinned in `daydream/package.json` (currently three 0.183.1, lil-gui 0.21.0). The optional self-hosted fonts under `daydream/vendor/fonts/` (Inter and JetBrains Mono, both SIL OFL 1.1) are gitignored and distributed by neither repo.
