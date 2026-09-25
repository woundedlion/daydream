# Automatic deployment pairing

A push to daydream master, a manual deployment, or a `holosphere-engine-ready`
repository dispatch resolves the current master commits of daydream and
Holosphere. A five-minute schedule reconciles engine-only pushes without a
cross-repository dispatch credential. Identical successful pairs are skipped.
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

Generated engine assets in git are a local development snapshot. Neither a push
nor deployment requires committing refreshed copies. The local push hook checks
source lint, types, import-map freshness and workflow helpers; CI is the required
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
