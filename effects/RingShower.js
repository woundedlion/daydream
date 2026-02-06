/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Timeline, Sprite, Transition, RandomTimer, Orientation
} from "../animation.js";
import { easeMid } from "../easing.js";
import {
    createRenderPipeline, FilterAntiAlias
} from "../filters.js";
import { GenerativePalette } from "../color.js";
import { Plot } from "../plot.js";
import { makeBasis, angleBetween, randomVector } from "../geometry.js";

export class RingShower {

    static Ring = class {
        constructor(filters) {
            this.normal = randomVector().clone();
            this.duration = 8 + Math.random() * 72;
            this.radius = 0;
            this.lastRadius = this.radius;
            this.palette = new GenerativePalette('circular', 'analogous', 'flat');
            this.phase = 0;
        }
    }

    constructor() {
        this.rings = [];
        this.numRings = 16;
        this.alpha = 0.2;
        this.t = 0;

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
            new Transition(ring, 'radius', 2, ring.duration, easeMid)
        );
    }

    drawRing(opacity, ring) {
        const basis = makeBasis(this.orientation.get(), ring.normal);
        Plot.Ring.draw(this.filters, basis, ring.radius,
            (v, t) => {
                let z = this.orientation.orient(Daydream.X_AXIS);
                const c = ring.palette.get(angleBetween(z, v) / Math.PI);
                return { color: c.color, alpha: c.alpha * this.alpha * opacity };
            }
        );
    }

    drawFrame() {
        this.timeline.step();
        this.t++;
    }
}

