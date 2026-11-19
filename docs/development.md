# Frontend development

The shared [README](https://github.com/woundedlion/pov/blob/master/README.md) describes Holosphere and daydream together.
Holosphere owns that file and mirrors it into this checkout.

## Source layout

- `src/app/` starts the simulator and owns application state and lifecycle.
- `src/engine/` wraps the installed WASM engine and its display buffers.
- `src/renderer/` renders the sphere through Three.js.
- `src/effects/` manages effect selection, parameters, and persistence.
- `src/segments/` runs the segmented worker pool and composites its output.
- `src/recording/` manages recording and its controls.
- `src/ui/` builds simulator panels, navigation, and statistics views.
- `src/shared/` contains browser utilities used across pages.
- `src/workbench/` contains the design tools, grouped by tool.
- `src/types/` declares browser APIs missing from the standard type library.

`index.html` and `tools/*.html` are the public entry points. Their URLs remain
stable independently of the source-module layout. `styles/` holds the simulator stylesheet (also loaded by the shader page),
the self-hosted font faces shared by tool pages, and the Tailwind input.
Page-specific tool stylesheets sit beside their HTML pages.

Holosphere installs engine assets into `generated/`. Embind emits method and enum
declarations; authored object schemas and loader extensions live in the engine
checkout. The install generates browser FPS and numeric enum contracts from the
bound module. Segment geometry is compiled from the firmware header to a small
standalone JavaScript module. These installed outputs are ignored.
See [deployment](deployment.md) for installing and verifying an engine package.

Composed parameter definitions carry `group: {name, title, order}` from C++.
The panel groups unfamiliar display labels by that metadata.

`src/app/app_segments.js` injects `SegmentStatsView` into the segment controller.
The controller publishes `SegmentStatsState` without constructing DOM views.
Application and workbench URL writes use `src/shared/url.js`.

## Shader state

Shader authoring opens `ShaderChain`. The engine facade supplies effect lifecycle,
parameter controls and buffers; authoring operations use a short-lived
`getShaderChainBindings()` handle. Release each handle after the call. Handles
expire when the effect or geometry is replaced or the engine/module is destroyed.

`getSnapshot()` and `restoreSnapshot()` carry the ordered instance/operator chain,
accepted named parameters, typed per-instance runtime, palette state and animation
pause. Workbench links use `#shader=v3` with their document and typed snapshot.
The reader also accepts `#shader=v2` links. URL persistence stores the snapshot
in `fx.__chainSnapshot`;
resolution rollback and segment-worker initialization use the same snapshot. Worker
protocol carries `chainSnapshot`.

Snapshot schema version 6 requires `chain: [{instance, operator}]`,
`parameters: [{name, value}]`, `animationsPaused` (boolean), and
`modulation: [{instance, recipe}]`, with one recipe per `color.modulate.v1`
instance. Modulation fields travel in `modulation`, not `parameters`.
The reader also accepts version 5 snapshots. Planar sources store separate Grid,
Twin Wave and projected-noise clocks in the `planar-source-clock-v1` runtime entry.
The Color carrier container follows the permanent Palette card and presents modulation
stages with add, remove, enable and header drag controls. Clicking a stage
opens or closes its parameter panel; dragging its header reorders it within Color.
A band's add button inserts its sole legal stage directly; multiple choices open
a selector.
The Source selector groups planar and spherical sources by their catalog input
carrier. A spherical source replaces the projection, planar warps and planar
source in one undoable edit. The strip hides the skipped Plane band and
Projection selector. Choosing a planar route restores its projection and source
with catalog defaults; undo restores the previous route and its authored values.
Within a planar route, filling the Source socket with a different kind updates
the active preset. The preset rail edits order, dwell and transitions. Next plays
one edge, Show loops the rail and the scrubber previews an edge frame.
An interpreter morph sends the two authored source endpoints with each frame's
parameter writes. The source blends their sampled fields at column time. A scrub
uses the requested morph position across the frame, and live slider readouts
still show the evaluated parameter values.
Numeric controls follow each declaration's interpolation kind. `LOG_POSITIVE`
sliders use logarithmic positions and multiplicative arrow nudges; their numeric
readouts and accessible value text show parameter values. Live admission limits
bound both representations without replacing the controls.
Parity requires the compiled descriptor and preset-bank digests to match.
An edit that changes either digest returns the preview to the interpreter and
disarms parity. A slider keeps its mounted control through the drag and refreshes
its parameter panel on commit.
Each layer owns its recipe and source clock; displacement is one of the available
sources. The Palette header selects the palette family; mapping, brightness
and opacity belong to its parameter panel. Legacy embedded hue shift
and spatial recipes migrate into independent layers, retaining their clocks.
`runtime` and `paletteBank` are optional. Runtime entries identify their instance and stable
state kind. Omit runtime to initialize fresh state; when present, it must include
every stateful instance exactly once. `ChainRuntimeState` in the module declarations
defines the supported state shapes.
The engine validates a replacement before applying it, so refusal commits no
snapshot state. Caller-accessor side effects during WASM payload cloning are
not rolled back.

## Page behaviour

Saved solids back up rejected cards before replacing the primary list. A refused
backup retains those cards in the primary data for recovery on reload. Malformed
backup JSON is replaced by the current rejected entries.
If access to browser storage itself throws, the solids page uses an isolated
in-memory store and displays that changes last for the current session.
Every served page loads the classic module-load guard before its entry module.
Module resource failures and syntax errors show a reload notice even when the
application's module graph cannot initialize its normal error reporting.
Returning custom palette hue keys to a harmony resolves the base against the
selected harmony and spread, keeping its first anchor on the first custom key.
The effect list supports buffered, case-insensitive name-prefix navigation.
Repeated initials cycle matches; a pause of more than 500 ms starts a new query.
Typing moves focus without loading an effect; Enter or an unbuffered Space selects it.
Solid registry exports pair an authored `Recipe` with its `generate_recipe`
instantiation. A saved star-pattern base can be flattened through Copy registry
C++; the callable-seed recipe export refuses such bases.
Saved-solid card DOM is built by `solid_saved_cards.js` with injected document
and action handlers; the page owns registry collision detection and list order.

## Validation

After `npm ci` and an engine install, run `npm run lint`, `npm run typecheck`, and
`npm test`. Test suites live in `tests/`, reusable support code in
`tests/helpers/`, and fixture inputs in `tests/fixtures/`.

The application composition root, renderer, and GUI wrapper are part of the
checked source roster. TypeScript resolves the installed lil-gui declarations
and the exact Three.js type package pinned in `package-lock.json`. Engine calls
use the declarations from the installed engine bundle. The `loaded` and `display` casts in `src/app/app_instances.js`, typed by
`LoadedHost` and `ReadyDisplay` in `src/app/app_context.js`, describe callbacks
that run after engine installation and mesh allocation; the host's early lifecycle
state stays nullable.

A local green run can include skipped checks. Engine source checks search
`engine`, `../Holosphere`, and `../pov` relative to this checkout; set
`HOLOSPHERE_ENGINE_DIR` (also checkout-relative) for another location. They skip
when no checkout exists unless `HOLOSPHERE_ENGINE_REQUIRED=1`. Hook tests can
skip when no supported shell is available unless `DAYDREAM_HOOK_SH_REQUIRED=1`.
The generated-recipe format check skips when `clang-format` is unavailable unless
`CLANG_FORMAT_REQUIRED=1`. CI sets all three required flags and installs the
selected engine bundle. The test runner rejects any CI run with skipped or todo
tests; inspect the summary when comparing a local run with CI.

Run `node scripts/browser-smoke.mjs` to exercise the simulator and every tool
page. The other `scripts/*-probe.mjs` commands exercise tool interactions and
the simulator's effect panel. These scripts require Chrome, Chromium, or Edge;
set `CHROME_PATH` if the browser is outside the standard installation paths.

When adding or moving a runtime module, update its imports, HTML references,
`site_manifest.txt`, typecheck roster, and tests. Worker URLs and module-relative
asset fetches must resolve from their new locations. The publication manifest
and test-discovery checks validate these references and module coverage.
Update the daydream source-tree row in Holosphere README §9.2 too. The exhaustive
module inventory is validated with `just docs-check` against the daydream revision
pinned in Holosphere `tools/build_pins.py`: land the daydream change first, then
advance the pin and update the row in one Holosphere commit.

After changing Tailwind classes in HTML or browser source, run
`npm run generate:tailwind` and commit `tools/tailwind.css` with the source change.

Before landing a refactor, search for retired identifiers and words describing
the old behavior with `rg -n -F -- '<retired term>' src tests docs tools styles`.
Inspect each match in context, update stale comments and maintained documentation
in the same commit, then repeat the search. Include behavior terms even when
the refactor leaves identifiers unchanged.

For every new or strengthened behavioral test, identify a concrete production
mutation that would make it fail. Exercise that mutation when practical, verify
that the intended assertion fails, restore production code, and run the affected
suite. Record the mutation and result with validation evidence; if it cannot be
exercised, record that limitation. Observe the action under test before calling
helpers that can perform that action themselves.

## Display geometry

Effect changes hard-swap the entire sphere once a complete replacement frame is
available. The POV sweep and visual-response history are reseeded from that frame,
so outgoing and incoming effects never occupy different hemispheres. Segmented
rendering holds the outgoing image until all replacement segments are composited.

The **POV fidelity (16 Hz)** control displays an approximate visual response to
opposing columns emitted at their sweep times. Each opposing column pair emits
for one column interval. The causal response integrates captured emissions in
linear RGB16, independently of browser repaint rate. Emissions before fidelity
starts are black; enabling it midway through a sweep records only the remaining
portion. Fidelity off renders every column at one instant for the ordinary
full-frame preview; fidelity on enables per-column temporal sampling in the main
engine and segmented workers. Changing fidelity while paused draws one replacement
engine frame and leaves playback paused. Worker frames computed for the old setting
are discarded before publishing the replacement.

When rendering falls behind, fidelity mode advances one engine frame and drops
overdue whole intervals while keeping the fractional sweep time. The ordinary
preview keeps its bounded frame backlog. The response clock follows simulated
sweeps; dropped wall-clock backlog is not integrated. Pausing freezes response
time. Changing the response scale reintegrates captured samples; paused parameter
changes do not rewrite those emissions. Source colors enter the history when
simulation advances.

**Response timescale** multiplies the sustained response's time constant from
0.5 to 2, defaulting to the published reference value at 1. Larger values slow
the response. The control is enabled when fidelity is on and persists as
`view.povResponseScale`. Fidelity always uses visual response; obsolete
`view.povPresentation` and `view.povExposureMs` parameters are removed from old
links. See [the model and research basis](#visual-response-model) for its scope.

**Show arm positions** marks the next opposing columns in magenta when POV
fidelity is enabled. It defaults off and persists as `view.showSweepBoundary`
in shared URLs. Only the current opposing pair is shown, applied after response
integration. These markers rotate with the arms and do not identify a fixed
longitude seam. The marker changes only the displayed image.

This simulator control leaves the physical device's temporal sampling enabled.
The preview uses an idealized nonstrobed column-dwell model with an approximate
sustained visual response, not a calibrated human appearance model.

The global **Top cap (%)** and **Bottom cap (%)** controls adjust the missing
north-to-south arc independently, from 0% to 25% each. Both default to 0% for full
coverage; use 2% each to preview the provisional physical device calibration.
The controls persist as `view.topCap` and `view.bottomCap` in shared URLs.

Daydream applies the percentages to the engine and every segmented worker with
`setDisplayCaps`, then reads `getDisplayNorthPhi` and `getDisplaySouthPhi` for
LED placement. Changes preserve effect configuration and reconstruct geometry-dependent
caches. Ordinary effects restart their animation and simulation history;
`ShaderChain` restores its complete executable snapshot, including its program,
parameters, typed runtime, palette state, clocks and seeds. Settings survive effect
and resolution changes, and update the preview while paused. Firmware retains its
compiled physical profile.

## Visual response model

This is a visualization of one sustained visual-channel signal under fixed
viewing geometry. It is not a calibrated rendering of conscious appearance or a
prediction that a seam or flicker will be invisible. The selected kernel starts
at zero, rises gradually, and decays smoothly; it avoids the rectangular
shutter's abrupt inclusion and removal of light samples.

### Reference filter and integration

The reference is the sustained channel from
[Stigliani, Jeska and Grill-Spector (2017)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5754759/),
which adopts a gamma-cascade parameter set from Watson's temporal model:

```text
h(t) = (t/tau)^8 * exp(-t/tau) / (tau * 8!),  t >= 0
h(t) = 0,                                   t < 0
tau  = 4.94 ms * responseScale
```

At scale 1, the peak is 39.52 ms and the mean delay is 44.46 ms. These are derived
properties of the reference kernel, not an asserted universal persistence time.
The paper also models a separate biphasic transient channel and nonlinear
processing; neither is combined into the RGB preview. The parameter set was
used to predict neural responses, not validated as a complete appearance model
for this device.

For a column emitting constant linear RGB during `[a,b]`, its contribution at
time `t` is its color multiplied by `G(t-a)-G(t-b)`, where `G` is the integral
of `h`. The implementation evaluates the equivalent gamma survival-function
difference analytically. It clips intervals at the beginning of captured
history and excludes future emission. It integrates every column interval,
independently of browser repaint cadence, and does not blend completed display
frames. Paused preview edits do not rewrite captured emissions.

The kernel has unit area. A fixed column-duty compensation preserves mean
brightness; weights are never normalized separately for each
column or sweep phase. Such normalization would artificially suppress physical
modulation. RGB output clips to the display range, so bright response peaks can
saturate. Black prehistory makes startup fade in rather than inventing samples.

History covers at least 40 time constants at the maximum scale. The omitted gamma-tail integral is below `8.6e-10`.
At 16 half-turns per second this requires eight source snapshots. These bounds
and the response to finite pulses are checked numerically.

### Evidence and limits

| Evidence | Consequence for this preview |
| --- | --- |
| [Stromeyer and Martini (2003)](https://pubmed.ncbi.nlm.nih.gov/12535987/) measured changes in temporal response with stimulus contrast, alongside the known dependence on mean luminance. [Stockman et al. (2006)](https://discovery.ucl.ac.uk/id/eprint/10216972/) measured human adaptation over a wide intensity range. | The timescale control explores model sensitivity. It is not an automatic brightness or adaptation calibration; relative engine RGB does not supply retinal illuminance. |
| [Shinomori and Werner (2003)](https://pmc.ncbi.nlm.nih.gov/articles/PMC2774211/) found substantial observer variation in inferred temporal responses. | The reference does not describe every observer. A positive sustained filter omits inhibitory and transient responses. |
| [Kang et al. (2023)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10354087/) studied phantom-array visibility during saccades and its dependence on eye movement. | Sphere-coordinate histories assume fixed viewing geometry. Camera orbiting does not simulate a retinal gaze trajectory, smooth pursuit, or saccadic suppression. |
| [castleCSF (2024)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10996938/) models contrast sensitivity across spatial and temporal frequency, color, luminance, eccentricity, and area. [elaTCSF (2024)](https://arxiv.org/html/2503.16759v1) specifically addresses temporal sensitivity and low-persistence displays. | A threshold model needs viewing-condition inputs and is not interchangeable with a color appearance filter. No detection threshold is inferred from this preview. |
| [ColorVideoVDP (2024)](https://achapiro.github.io/Man24/man24.pdf) predicts differences between reference and test videos using spatial and temporal processing. | A full-reference quality metric is a possible later validation tool, not a replacement image renderer. It also has explicit limits concerning eye motion. |

Applying the same filter to R, G, and B is an engineering approximation that
preserves preview color relationships. It is not a cone, opponent-color, rod,
or mesopic model. The current column-dwell emission model also omits measured
LED strobe duty, transport delays, angular emission footprint, and radiometric
calibration.

At 288 columns, the idealized two-arm device schedules 2304 column pairs per
second, but revisits each spatial location only 16 times per second. Its narrow
pulses contain that fundamental and higher harmonics. For this sustained filter,
the derived sinusoidal gain at 16 Hz is about 0.371 at scale 1; remaining
modulation is expected and is not a reason to widen the reference filter until
an artifact disappears. A desktop monitor cannot reproduce the submillisecond
emission pulses. Its display response and the viewer's visual system further
filter the already processed visualization.

### Validation and calibration

Numerical checks cover independent pulse quadrature, causal onset, frequency
response, full-cycle mean brightness below clipping, both arms, sweep endpoints,
history truncation, repaint independence, and preservation of source samples.
GridSpace checks exercise the installed engine's actual emitted colors, rather
than only synthetic patterns. Smooth response at a moving front is distinct
from either a flat spatial image or proof of perceptual invisibility.

Device validation still requires measured pulse timing and duty, light output,
viewing distance and angular size, background illumination, and fixed-gaze versus
tracking observations. Known-shutter photographs alone cannot validate a
human-perception model. Observer comparisons
should include static patterns, moving bars and GridSpace at multiple speeds
and brightnesses, with held-out effects to detect tuning to one example.

## Effect identities

The installed `generated/engine_contract.mjs` exports each effect's canonical ID
and display label from the compiled engine. `canonicalEffectId` accepts either,
so display-name (legacy) links resolve to the canonical ID. Curated resolution
lists retain their display names and order; the app resolves those names to
canonical IDs for engine selection and URL state. Registered effects that no
curated list names are appended to every resolution's list. Sidebar labels, size and
preset metadata retain the engine's display names.

Legacy curated root links open the simulator. Canonical document root links
open the authoring page. Simulator shares for those documents include
`view=simulator`; the dedicated `tools/shader.html` route accepts either name
form and removes simulator context when constructing an authoring URL.
Parameter keys remain in the `fx` namespace.

## Module inventory additions

| Module | Responsibility |
| --- | --- |
| `src/app/app_boot.js` | Module-ready startup, render adapter and recorder creation, and initial state application |
| `src/app/app_context.js` | Shared types for successive stages of page assembly |
| `src/app/app_controls.js` | Playback shortcuts, Test All, and view, segment and recording control wiring |
| `src/app/app_effects.js` | Effect panel, parameter and preset wiring, and effect and resolution transactions |
| `src/app/app_engine_controls.js` | Main-engine parameter writes, animation pause across engines, and snapshot capability checks |
| `src/app/app_frame_loop.js` | Guarded render and recording ticks |
| `src/app/app_instances.js` | Renderer and engine host creation, with display-buffer alias wiring |
| `src/app/app_route_state.js` | URL hydration, resolution and effect validation, and route synchronization |
| `src/app/app_segments.js` | Segment controller, buffer aliases, statistics, and recording abort on faults |
| `src/app/app_shader_documents.js` | Shader document controller and effect panel wiring for the workbench |
| `src/app/app_shell.js` | View panel and effect sidebar mounting, and supported resolution selection |
| `src/app/app_teardown.js` | App resource disposal and page lifecycle listener cleanup |
| `src/app/frame_loop_guard.js` | Per-frame error reporting, recovery and terminal module release |
| `src/app/module_load.js` | WASM startup deadline, load completion and disposal guards |
| `src/app/render_adapter.js` | Per-frame engine and worker integration, display aliases and capture readiness |
| `src/effects/effect_apply_helpers.js` | Engine effect selection, strobe layout and sidebar metrics |
| `src/renderer/dot_detail.js` | Sphere tessellation detail from display pixel count |
| `src/renderer/driver_capture.js` | Frame statistics and recording capture scheduling |
| `src/renderer/driver_context.js` | WebGL context loss and restoration, including the reload prompt |
| `src/renderer/driver_dots.js` | Instanced sphere dot geometry and material setup |
| `src/renderer/driver_input.js` | Keyboard orbit, view reset, and playback and preset shortcuts |
| `src/renderer/driver_labels.js` | Camera-facing axis label selection and refresh |
| `src/renderer/driver_pov.js` | POV sweep lifecycle, reset scheduling, and strobe mode |
| `src/renderer/driver_views.js` | Main and picture-in-picture rendering, with capture and label passes |
| `src/renderer/label_pool.js` | Reusable projected-label elements and their lifetimes |
| `src/shared/aria_description.js` | Adds and removes a widget's ARIA description references |
| `src/shared/dom.js` | Type-checked DOM lookup by ID |
| `src/ui/effect_action_feedback.js` | Effect action labels, clipboard results and accessible feedback |
| `src/ui/effect_param_controllers.js` | Engine parameter controller creation, order and value synchronization |
| `src/ui/lil_gui_adapter.js` | Panel collapse state and forced updates to read-only number controls |
| `src/workbench/palettes/hue_key_handles.js` | Editable hue wheel handles and keyboard nudging |
| `src/workbench/palettes/palette_controls/math.js` | Hue wrapping and axis endpoint conversions |
| `src/workbench/palettes/palette_controls/model.js` | V4 palette recipe schema and enumerants |
| `src/workbench/palettes/palette_controls/recipe.js` | V4 control mappings, availability rules and preset recipes |
| `src/workbench/palettes/palette_controls/view.js` | Palette tabs, strip viewport gestures and accessible view state |
| `src/workbench/palettes/strip_copy_feedback.js` | Palette strip color copying, feedback and timer cleanup |
| `src/workbench/shader/chain_chip_drag.js` | Stage chip drag tracking, drop targets and reorder feedback |
| `src/workbench/shader/chain_document_edits.js` | Validated chain structure and preset edits |
| `src/workbench/shader/chain_document_history.js` | Chain snapshots, undo and redo, and coalescing parameter edits |
| `src/workbench/shader/chain_document_legality.js` | Operator replacement and span legality |
| `src/workbench/shader/chain_row_controls.js` | Inline enum, slider and numeric controls for stage parameters |
| `src/workbench/shader/chain_selection.js` | Active, focused and pinned stage selection |
| `src/workbench/shader/chain_viewport.js` | Chain strip scroll and focus geometry |
| `src/workbench/shader/shader_document_edits.js` | Preset application and stage parameter routing for compiled and editable builds |
| `src/workbench/shader/shader_document_loader.js` | Shader document adoption, build selection and toolbar restoration |
| `src/workbench/shader/shader_document_persistence.js` | Saving, downloading and copying shader documents |
| `src/workbench/shader/shader_document_state.js` | Active document, chain editor, catalogs and controller state |
| `src/workbench/solids/solids_state.js` | Typed page state, operation revisions, validator and commit queue |
| `src/workbench/solids/solids_engine.js` | Engine lifecycle, arena metrics and mesh recomputation |
| `src/workbench/solids/solids_scene.js` | Preview materials, scene lifecycle, view toggles and label projection |
| `src/workbench/solids/solids_ops_controller.js` | Queued operation edits, parameter changes and row rendering |
| `src/workbench/solids/solids_row_drag.js` | Operation drag gestures, drop validation and insertion preview |
| `src/workbench/solids/solids_op_gate_view.js` | Operation availability and status feedback |
| `src/workbench/solids/solids_saved_controller.js` | Saved-solid cards, storage, restore and code export |
| `src/workbench/solids/solids_base_picker.js` | Base-solid thumbnails, keyboard navigation and selection |
| `src/workbench/shader/chain_strip_context.js` | Shared strip collaborators and view state |
| `src/workbench/shader/chain_strip_commands.js` | DOM-free strip commands and parameter edit commits |
| `src/workbench/shader/chain_chip_element.js` | Stage chips, keyboard controls and band add buttons |
| `src/workbench/shader/chain_strip_history.js` | Strip undo/redo actions and history controls |
| `src/ui/url_params.js` | URL parameter reads, debounced writes and reset |
| `src/ui/url_hydration.js` | Pure URL control hydration, numeric snapping and enum resolution |
| `src/ui/deep_link_keys.js` | Deep-link namespaces and stable folder key segments |
| `tests/url_hydration.test.js` | Table tests for numeric, boolean and enum hydration |
| `tests/deep_link_keys.test.js` | Table tests for namespaces and duplicate folder paths |
| `tests/solids_scene.test.js` | Scene teardown, label projection, thumbnail lifecycle and engine halt tests |
