/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {EngineHost} from '../engine/engine_host.js';
import {repointDisplayAliases} from '../engine/display_aliases.js';
/** @typedef {import('./app_context.js').ReadyDisplay} ReadyDisplay */
/** @typedef {import('./app_context.js').LoadedHost} LoadedHost */

/** @param {Pick<import('./app_context.js').PageContext, 'createDriver'>} deps */
export function createAppInstances({createDriver}) {
  const daydream = createDriver();
  /** Display callbacks run after updateResolution() creates its color attribute. */
  const display = /** @type {ReadyDisplay} */ (daydream);
  const host = new EngineHost((view) => repointDisplayAliases(display, view));
  /** Engine callbacks run after the module-ready handler installs both members. */
  const loaded = /** @type {LoadedHost} */ (host);

  return {daydream, display, host, loaded};
}
