/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, vectorPool
} from "../geometry.js";
import {
    VignettePalette, richSunset, mangoPeel, underSea, iceMelt,
    TransparentVignette, blendAlpha, color4Pool
} from "../color.js";
import {
    Timeline, RandomWalk, Rotation, easeMid, ComposedRotation
} from "../animation.js";
import { Plot } from "../draw.js";
import { createRenderPipeline, FilterAntiAlias } from "../filters.js";

export class TestPlotPolygon {
    static Ring = class {
        constructor(normal, palette) {
            this.normal = normal;
            this.palette = new TransparentVignette(palette);
            this.orientation = new Orientation();
        }
    }

    constructor() {
        this.rings = [];
        this.alpha = 0.5;
        this.thickness = 2 * 2 * Math.PI / Daydream.W;
        this.palettes = [iceMelt, underSea, mangoPeel, richSunset]
        this.numRings = 1;
        this.timeline = new Timeline();
        this.radius = 0.4;
        this.sides = 5;
        this.pipeline = createRenderPipeline(new FilterAntiAlias());

        for (let i = 0; i < this.numRings; ++i) {
            this.spawnRing(Daydream.Z_AXIS, this.palettes[i], 1);
            this.spawnRing(Daydream.Z_AXIS, this.palettes[i], -1);
        }

        this.setupGUI();
        this.renderPlanes = [];
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01).name("Brightness");
        this.gui.add(this, 'thickness').min(0.01).max(0.5).step(0.01).name("Brush Size"); // Not really used for Plot line thickness yet unless passed, Plot usually draws single pixel or thick lines
        this.gui.add(this, 'radius').min(0).max(2).step(0.01).name("Radius");
        this.gui.add(this, 'sides').min(3).max(12).step(1).name("Sides");
    }

    spawnRing(normal, palette, direction) {
        let ring = new TestPlotPolygon.Ring(normal, palette);
        this.rings.push(ring);
        this.timeline.add(0, new ComposedRotation(ring.orientation, 48, true)
            .rotate(Daydream.Y_AXIS, 2 * Math.PI, easeMid)
            .rotate(normal, direction * 2 * Math.PI, easeMid)
        );
    }

    drawFrame() {
        this.timeline.step();
        for (const ring of this.rings) {
            const colorFn = (p, t) => {
                return ring.palette.get(0.5);
            }
            Plot.Polygon.draw(this.pipeline, ring.orientation.get(), ring.normal, this.radius, this.sides, colorFn);
        }
    }
}
