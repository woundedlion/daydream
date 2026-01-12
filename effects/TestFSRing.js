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
    Timeline, Sprite, RandomWalk, MutableNumber
} from "../animation.js";
import { Scan } from "../draw.js";
import { createRenderPipeline } from "../filters.js";

export class TestFSRing {
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
        this.radius = 1.0;
        this.debugBB = false;

        for (let i = 0; i < this.numRings; ++i) {
            this.spawnRing(Daydream.X_AXIS, this.palettes[i]);
        }

        this.setupGUI();
        this.renderPlanes = [];
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01).name("Brightness");
        this.gui.add(this, 'thickness').min(0.01).max(0.5).step(0.01).name("Brush Size");
        this.gui.add(this, 'radius').min(0).max(2).step(0.01).name("Radius");
        this.gui.add(this, 'debugBB').name('Show Bounding Boxes'); // Restored
    }

    spawnRing(normal, palette) {
        let ring = new TestFSRing.Ring(normal, palette);
        this.rings.push(ring);
        this.timeline.add(0, new RandomWalk(ring.orientation, ring.normal));
    }

    drawFrame() {
        this.timeline.step();

        const pipeline = createRenderPipeline();

        for (const ring of this.rings) {
            const colorFn = () => {
                return ring.palette.get(0.5);
            }
            Scan.Ring.draw(pipeline, ring.orientation.orient(ring.normal), this.radius, this.thickness, colorFn, 0, 2 * Math.PI, { debugBB: this.debugBB });
        }
    }
}