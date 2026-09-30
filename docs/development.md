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

Holosphere installs engine assets into `generated/`. Handwritten module
declarations beside those outputs are tracked; the runtime outputs are ignored.
See [deployment](deployment.md) for installing and verifying an engine package.
Legacy shader fixtures and their digest migration table are frontend source in
`src/workbench/shader/patterns/`.

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

When moving a runtime module, update its imports, HTML references,
`site_manifest.txt`, typecheck roster, and tests. Worker URLs and module-relative
asset fetches must resolve from their new locations. The publication manifest
and test-discovery checks validate these references and module coverage.

After changing Tailwind classes in HTML or browser source, run
`npm run generate:tailwind` and commit `tools/tailwind.css` with the source change.

## Display geometry

The global **Top cap (%)** and **Bottom cap (%)** controls adjust the missing
north-to-south arc independently, from 0% to 25% each. Both default to 0% for full
coverage; use 2% each to preview the provisional physical device calibration.
The controls persist as `view.topCap` and `view.bottomCap` in shared URLs.

Daydream applies the percentages to the engine and every segmented worker with
`setDisplayCaps`, then reads `getDisplayNorthPhi` and `getDisplaySouthPhi` for
LED placement. Changes preserve effect configuration and reset geometry-dependent
simulation history. Settings survive effect and resolution changes, and update
the preview while paused. Firmware retains its compiled physical profile.
