/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Timeline, Rotation, PeriodicTimer, ColorWipe, Transition, Mutation, RandomTimer, Orientation
} from "../animation.js";
import { sinWave, makeBasis } from "../geometry.js";
import { vectorPool, quaternionPool, color4Pool } from "../memory.js";
import { Plot } from "../plot.js";
import { Scan } from "../scan.js";
import { GenerativePalette } from "../color.js";
import { easeMid } from "../easing.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrient
} from "../filters.js";
import { TWO_PI } from "../3dmath.js";


export class Moire {
    constructor() {
        this.alpha = 0.2;
        this.basePalette = new GenerativePalette("circular", "analagous", "bell");
        this.interferencePalette = new GenerativePalette("circular", "analagous", "cup");

        this.density = Daydream.W <= 96 ? 10 : 45;
        this.rotation = 0;
        this.amp = 0;
        this.cameraOrientation = new Orientation();
        this.layer1Orientation = new Orientation();
        this.layer2Orientation = new Orientation();

        this.timeline = new Timeline();

        this.filters = createRenderPipeline(
            new FilterOrient(this.cameraOrientation),
            new FilterAntiAlias()
        );

        const rotationAxis1 = Daydream.X_AXIS;
        const rotationAxis2 = Daydream.X_AXIS.clone().negate();

        this.timeline
            .add(0, new PeriodicTimer(80, () => this.colorWipe()))
            .add(0, new Rotation(this.cameraOrientation, Daydream.Y_AXIS, TWO_PI, 300, easeMid, true))
            .add(0, new Rotation(this.layer1Orientation, rotationAxis1, TWO_PI, 300, easeMid, true))
            //            .add(0, new Rotation(this.layer2Orientation, rotationAxis2, TWO_PI, 300, easeMid, true))
            .add(0,
                new Transition(this, 'rotation', TWO_PI, 160, easeMid, false, true)
                    .then(() => this.rotation = 0))
            .add(0,
                new Mutation(this, 'amp', sinWave(0.1, 0.5, 1, 0), 160, easeMid, true));
        this.setupGui();
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
        this.gui.add(this, 'density', 5, 50).name('density').listen();
        this.gui.add(this, 'amp', -1, 1).name('amplitude').step(0.01).listen();
    }

    colorWipe() {
        this.nextBasePalette = new GenerativePalette("circular", "analagous", "bell");
        this.nextInterferencePalette = new GenerativePalette("circular", "analagous", "cup");
        this.timeline.add(0,
            new ColorWipe(this.basePalette, this.nextBasePalette, 80, easeMid)
        );
        this.timeline.add(0,
            new ColorWipe(this.interferencePalette, this.nextInterferencePalette, 80, easeMid)
        );
    }

    drawLayer(pipeline, palette, orientation) {
        const count = Math.ceil(this.density);
        const basis = makeBasis(orientation.get(), Daydream.Z_AXIS);
        for (let i = 0; i <= count; i++) {
            const t = i / count;
            const r = t * 2.0;
            Plot.DistortedRing.draw(this.filters, basis, r,
                sinWave(-this.amp, this.amp, 4, 0),
                (v, frag) => {
                    const val = (frag.v0 !== undefined) ? frag.v0 : frag; // Adapt to what DistortedRing puts in v0. Wait, distRing puts t in v0?
                    // DistortedRing passes basis, r, thickness, shader, ...
                    // Scan.Ring.draw calls shader(p, scratch)
                    // scratch.v0 is set to sampleResult.t
                    // varying.v0 IS t.
                    // So frag.v0 is correct.
                    // Old code: (v, t) => ... t.v0 ...
                    // It seems old code expected 't' to be the fragment object?
                    // Yes, scan.js passed _scanScratch as 2nd arg.
                    // So old code was (v, frag) actually?
                    // scan.js old: fragmentShaderFn(p, _scanScratch)
                    // Moire.js old: (v, t) => { ... t.v0 ... }
                    // So 't' WAS 'frag'.
                    // New code: (v, frag) => ...

                    const c = palette.get(frag.v0);
                    c.alpha *= this.alpha;
                    frag.color = c;
                },
                this.rotation);
        }
    }


    drawFrame() {
        this.cameraOrientation.collapse();
        this.timeline.step();

        this.drawLayer(this.filters, this.basePalette, this.layer1Orientation); // Base layer
        this.drawLayer(this.filters, this.interferencePalette, this.layer2Orientation);  // Interference layer
    }
}

