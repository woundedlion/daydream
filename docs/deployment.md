# Automatic deployment pairing

A push to daydream master, a manual deployment, or a `holosphere-engine-ready`
repository dispatch resolves the current master commits of daydream and
Holosphere. A schedule requests reconciliation every five minutes without a
cross-repository dispatch credential. GitHub may delay or drop scheduled runs;
engine-only pushes have no guaranteed deployment latency. A manual deployment
or configured repository dispatch requests an immediate run. Identical successful
pairs are skipped.
Old queued workflows also skip when their own source commit differs from the
selected daydream commit.

Every selected pair is recorded before its gates run. Scheduled reconciliations
skip pairs already attempted, including failed or interrupted attempts. A manual
deployment or repository dispatch can retry a failed pair.

The engine gate waits up to 55 minutes for the complete Holosphere CI workflow
at that exact commit to succeed. It downloads its checksummed engine artifact,
validates the package's source pin and owned paths, and overlays it on the
selected daydream checkout. Unit tests, source parity, browser probes and Pages
all consume that same package. PR checks use the PR merge checkout and resolve
Holosphere master once in their engine gate.

Generated WASM glue, binary, provenance files and engine catalog are ignored
local build outputs. A fresh checkout needs an engine install before running
the simulator or the full test suite. Build Holosphere's `wasm-release-install`
preset from its sibling checkout, or install a verified package with
`node scripts/install-engine-bundle.mjs <bundle> .`.
Neither a push nor deployment requires committing generated outputs. The local
push hook checks source lint, types, import-map freshness and workflow helpers; CI is the required
runtime compatibility gate. `npm test` and the browser probe scripts remain
available for local validation after installing an engine package.

Pages deployments are serialized. Immediately before publishing, the workflow
checks that both selected commits are still master. A superseded pair is skipped
and a later trigger reconciles the new pair. The deployed site includes
`deployment-pair.json`; a successful `daydream-pair` GitHub deployment record
stores the same two commits after the Pages and MIME checks pass.

Site staging keeps committed daydream files byte-for-byte and adds only engine
assets verified against the selected package. Removed engine patterns and
screenshots are omitted, and newly added verified assets are served without a
consumer commit. Modified frontend files and provenance mismatches fail staging.

Manual deployments accept `force` to republish an unchanged successful pair.
The pre-push hook checks each pushed commit in a temporary checkout; unrelated
working-tree edits do not substitute for the source being pushed.

## Installed engine assets

The engine bundle installs runtime binaries, provenance, the segment map, and
shader modules and patterns under `generated/`. Its WASM checksum manifest uses
filenames relative to that directory. Handwritten TypeScript declarations are
tracked beside their generated modules for module resolution; runtime files are
ignored. Legacy shader fixtures and digest migrations remain consumer-owned.
The engine still mirrors `README.md` and `docs/screenshots/` at their public paths.

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
