/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, randomVector, angleBetween
} from "../geometry.js";
import { Plot, rasterize } from "../draw.js";
import {
    GenerativePalette
} from "../color.js";
import {
    Timeline, easeMid, Sprite, Transition, RandomTimer, MutableNumber
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias
} from "../filters.js";

export class RingShower {

    static Ring = class {
        constructor(filters) {
            this.normal = randomVector().clone();
            this.duration = 8 + Math.random() * 72;
            this.radius = new MutableNumber(0);
            this.lastRadius = this.radius.get();
            this.palette = new GenerativePalette('circular', 'analogous', 'flat');
            this.phase = new MutableNumber(0);
        }
    }

    constructor() {
        this.rings = [];
        this.numRings = 16;
        this.alpha = 0.2;

        this.palette = new GenerativePalette();
        this.orientation = new Orientation();
        this.filters = createRenderPipeline(
            new FilterAntiAlias()
        );

        this.timeline = new Timeline();
        this.timeline.add(0,
            new RandomTimer(4, 48,
                () => this.spawnRing(),
                true
            )
        );

        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
    }

    spawnRing() {
        let ring = new RingShower.Ring(this.filters);
        this.rings.unshift(ring);

        this.timeline.add(0,
            new Sprite((opacity) => this.drawRing(opacity, ring),
                ring.duration,
                4, easeMid,
                0, easeMid
            ).then(() => {
                this.rings.pop();
            }));

        this.timeline.add(0,
            new Transition(ring.radius, 2, ring.duration, easeMid)
        );
    }

    drawRing(opacity, ring) {
        Plot.Ring.draw(this.filters, this.orientation.get(), ring.normal, ring.radius.get(),
            1.0, // thickness (was missing or incorrect?) Scan.Ring.draw takes thickness. Plot.Ring.draw might act as alias
            // Wait, Plot.Ring.draw was updated to: draw(pipeline, orientation, normal, radius, thickness, materialFn, ...)
            // Let's check draw.js definition again for Plot.Ring.draw specific signature.
            // Assuming it maps to Scan.Ring.draw or similar.
            // Scan.Ring.draw(pipeline, normal, radius, thickness, materialFn, ...)
            // Plot.Ring.draw usually adds orientation/transform support?
            // I need to check draw.js to be sure about Plot.Ring signature.
            // Just in case, I will look at draw.js first.


            drawFrame() {
            this.timeline.step();
            this.t++;
        }
}
