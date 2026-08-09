/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Hand-written declarations for app_lifecycle.js, the composition root's frame
 * and teardown wiring. That module sits outside the segment pipeline's typed
 * scope — its collaborators are injected and typed as bare `Object` — so it is
 * never type-checked (tests/tsconfig_roster.test.js), and this file is what the
 * typecheck sees for the module. It covers only the surface the pipeline
 * imports.
 */

/**
 * Whether either display alias (Three.js instanceColor or driver.pixels) has
 * stopped referencing the engine's pixel view.
 */
export function displayAliasesDiverged(driver: Object, view: Uint16Array): boolean;
