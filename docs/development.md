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
stable independently of the source-module layout. `styles/` holds simulator CSS
and Tailwind input; the tool stylesheets sit beside their HTML pages.

Holosphere installs engine assets into `generated/`. Embind emits method and enum
declarations; authored object schemas and loader extensions live in the engine
checkout. The install generates browser FPS and numeric enum contracts from the
bound module. Segment geometry is compiled from the firmware header to a small
standalone JavaScript module. These installed outputs are ignored.
See [deployment](deployment.md) for installing and verifying an engine package.

Composed parameter definitions carry `group: {name, title, order}` from C++.
The panel groups unfamiliar display labels by that metadata.

`src/app/daydream.js` injects the statistics view into the segment controller.
The controller publishes `SegmentStatsState` without constructing DOM views.
Application and workbench URL writes use `src/shared/url.js`.

## Shader state

Shader authoring opens `ShaderChain`. The engine facade supplies effect lifecycle,
parameter controls and buffers; authoring operations use a short-lived
`getShaderChainBindings()` handle. Release each handle after the call. Handles
expire when the effect or geometry is replaced or the engine/module is destroyed.

`getSnapshot()` and `restoreSnapshot()` carry the ordered instance/operator chain,
accepted named parameters, typed per-instance runtime, palette state and animation
pause. Workbench links use `#shader=v2` with their document and typed snapshot.
URL persistence stores the snapshot in `fx.__chainSnapshot`;
resolution rollback and segment-worker initialization use the same snapshot. Worker
protocol carries `chainSnapshot`.

Snapshot schema version 3 requires `chain: [{instance, operator}]`,
`parameters: [{name, value}]`, and `modulation: [{instance, recipe}]`, with one
recipe per colorize instance. Colorize modulation fields travel in `modulation`,
not `parameters`. `runtime` and `paletteBank` are optional. Runtime entries identify their instance and stable
state kind. Omit runtime to initialize fresh state; when present, it must include
every stateful instance exactly once. `ChainRuntimeState` in the module declarations
defines the walk, source, noise, affine, phase, ring and color state shapes.
The engine validates a replacement before applying it, so refusal commits no
snapshot state. Caller-accessor side effects during WASM payload cloning are
not rolled back.

## Validation

After `npm ci` and an engine install, run `npm run lint`, `npm run typecheck`, and
`npm test`. Test suites live in `tests/`, reusable support code in
`tests/helpers/`, and fixture inputs in `tests/fixtures/`.

A local green run can include skipped checks. Engine source checks search
`engine`, `../Holosphere`, and `../pov` relative to this checkout; set
`HOLOSPHERE_ENGINE_DIR` (also checkout-relative) for another location. They skip
when no checkout exists unless `HOLOSPHERE_ENGINE_REQUIRED=1`. Hook tests can
skip when no supported shell is available unless `DAYDREAM_HOOK_SH_REQUIRED=1`.
CI sets both required flags and installs the selected engine bundle; inspect
the test summary for skips when comparing a local run with CI.

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

The installed `generated/engine_contract.mjs` exports canonical effect IDs,
display labels and legacy aliases from the compiled engine. Curated resolution
lists retain their display names and order; the app resolves those names to
canonical IDs for engine selection and URL state. Sidebar labels, size and
preset metadata retain the engine's display names.

Legacy curated root links open the simulator. Canonical document root links
open the authoring page. Simulator shares for those documents include
`view=simulator`; the dedicated `tools/shader.html` route accepts either name
form and removes simulator context when constructing an authoring URL.
Parameter keys remain in the `fx` namespace.
