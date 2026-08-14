/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// index.html's entry module: the one place the simulator is started. bootstrap.js
// stays importable — daydream.js pulls its failure overlay — and importing it
// must not stand up a second WebGL context, URLSync and engine.
import { bootstrap } from './bootstrap.js';

void bootstrap();
