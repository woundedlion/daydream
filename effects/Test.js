/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    sinWave
} from "../geometry.js";
import { Plot } from "../plot.js";
import { Scan } from "../scan.js";
import { makeBasis } from "../geometry.js";

import { TWO_PI } from "../3dmath.js";
import {
    GenerativePalette
} from "../color.js";
import {
    Timeline, Sprite, RandomWalk, Mutation, Orientation
} from "../animation.js";
import { easeMid } from "../easing.js";
import {
    createRenderPipeline, FilterAntiAlias
} from "../filters.js";

export class Test {

    constructor() {
        this.alpha = 0.3;
        this.ringPalette = new GenerativePalette("circular", "split-complementary", "flat");
        this.polyPalette = new GenerativePalette("circular", "analagous", "cup");
        this.normal = Daydream.X_AXIS.clone();
        this.orientation = new Orientation();
        this.timeline = new Timeline();
        this.filters = createRenderPipeline(
            new FilterAntiAlias()
        );

        this.amplitude = 0;
        this.amplitudeRange = 0.3;
        this.numRings = 1;
        this.debugBB = false;
        this.thickness = 4 * TWO_PI / Daydream.W;

        this.timeline.add(0,
            new Sprite((opacity) => this.drawFn(opacity), -1, 48, easeMid, 0, easeMid)
        );

        this.timeline.add(0,
            new RandomWalk(this.orientation, this.normal, { speed: 0.01, pivotStrength: 0.05 }) // Very smooth for test
        );

        this.timeline.add(0,
            new Mutation(this, 'amplitude',
                sinWave(-this.amplitudeRange, this.amplitudeRange, 1, 0), 32, easeMid, true)
        );

        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
        this.gui.add(this, 'debugBB').name('Show Bounding Boxes');
        this.gui.add(this, 'thickness').min(0.01).max(0.2).step(0.001);
    }

    drawFn(opacity) {
        for (let i = 0; i < this.numRings; ++i) {
            // Verify Scan.DistortedRing
            const radius = 2 / (this.numRings + 1) * (i + 1);
            const shiftFn = (t) => sinWave(this.amplitude, -this.amplitude, 4, 0)(t);
            const amplitude = this.amplitudeRange;

            const basis = makeBasis(this.orientation.get(), this.normal);

            Scan.DistortedRing.draw(this.filters, basis, radius, this.thickness,
                shiftFn, amplitude,
                (p, frag) => {
                    const t = frag.v0;
                    const c = this.ringPalette.get(t); // t is normalized azimuth (0..1)
                    frag.color.copy(c.color);
                    frag.color.alpha = c.alpha * opacity * this.alpha;
                },
                0, // phase
                this.debugBB // debugBB
            );
        }
    }

    drawFrame() {
        this.timeline.step();
    }
}

