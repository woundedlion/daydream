/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, sinWave, quaternionPool, vectorPool
} from "../geometry.js";
import {
    rasterize, Plot, Scan, makeBasis
} from "../draw.js";
import {
    GenerativePalette
} from "../color.js";
import {
    Timeline, easeMid, Rotation, MutableNumber, PeriodicTimer, ColorWipe, Transition, Mutation, RandomTimer
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrient
} from "../filters.js";

export class Moire {
    constructor() {
        this.alpha = 0.2;
        this.basePalette = new GenerativePalette("circular", "analagous", "bell");
        this.interferencePalette = new GenerativePalette("circular", "analagous", "cup");

        this.density = Daydream.W <= 96 ? 10 : 45;
        this.scale = new MutableNumber(1.0);
        this.rotation = new MutableNumber(0);
        this.amp = new MutableNumber(0);
        this.cameraOrientation = new Orientation();
        this.layer1Orientation = new Orientation();
        this.layer2Orientation = new Orientation();

        this.timeline = new Timeline();

        this.filters = createRenderPipeline(
            new FilterOrient(this.cameraOrientation),
            new FilterAntiAlias()
        );

        const rotationAxis1 = new THREE.Vector3(1, 0, 1).normalize();
        const rotationAxis2 = rotationAxis1.clone().negate();

        this.timeline
            .add(0, new PeriodicTimer(80, () => this.colorWipe()))
            .add(0, new Rotation(this.cameraOrientation, Daydream.Y_AXIS, 2 * Math.PI, 300, easeMid, true))
            .add(0, new Rotation(this.layer1Orientation, rotationAxis1, 2 * Math.PI, 300, easeMid, true))
            .add(0, new Rotation(this.layer2Orientation, rotationAxis2, 2 * Math.PI, 300, easeMid, true))
            .add(0,
                new Transition(this.rotation, 2 * Math.PI, 160, easeMid, false, true)
                    .then(() => this.rotation.set(0)))
            .add(0,
                new Mutation(this.amp, sinWave(0.1, 0.5, 1, 0), 160, easeMid, true));
        this.setupGui();
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
        this.gui.add(this, 'density', 5, 50).name('density').listen();
        this.gui.add(this.amp, 'n', -1, 1).name('amplitude').step(0.01).listen();
        this.gui.add(this.scale, 'n', 0.8, 1.2).name('scale');
        this.gui.add(this.rotation, 'n', 0, Math.PI).name('rotation');
    }

    colorWipe() {
        this.nextBasePalette = new GenerativePalette("straight", "triadic", "ascending");
        this.nextInterferencePalette = new GenerativePalette("straight", "triadic", "ascending");
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
                sinWave(-this.amp.get(), this.amp.get(), 4, 0), (v, t) => palette.get(t), this.rotation.get());
        }
    }


    drawFrame() {
        this.cameraOrientation.collapse();
        this.timeline.step();

        this.drawLayer(this.filters, this.basePalette, this.layer1Orientation); // Base layer
        this.drawLayer(this.filters, this.interferencePalette, this.layer2Orientation);  // Interference layer
    }
}
