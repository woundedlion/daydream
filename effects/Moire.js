/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * LICENSE: ALL RIGHTS RESERVED. No redistribution or use without explicit permission.
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
                (v, t) => {
                    const val = (t.v0 !== undefined) ? t.v0 : t;
                    const c = palette.get(val);
                    return color4Pool.acquire().set(c.color, c.alpha * this.alpha);
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
