/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {SegmentController} from '../segments/segment_controller.js';
import {SegmentStatsView} from '../ui/segment_stats_view.js';
import {resolutionPresets} from '../effects/effect_roster.js';
import {createDriverAliasGuard} from '../engine/display_aliases.js';

/** @param {import('./app_context.js').AppContext} deps */
export function createAppSegments({doc, appState, host, display}) {
  const segments = new SegmentController({
    resolutionPresets,
    appState,
    driver: display,
    getWasmEngine: () => host.engine,
    refreshPixelView: () => host.refresh(),
    getMemoryView: () => host.view(),
    aliasGuard: createDriverAliasGuard(display, 'SegmentCompositor.composite'),
    statsView: new SegmentStatsView(doc),
    onFault: () => host.recorder?.abort(
      'the segmented rendering engine failed.'),
  });

  return segments;
}
