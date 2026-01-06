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
import { wrap } from "../util.js";
import {
    VignettePalette, richSunset, mangoPeel, underSea, iceMelt,
    TransparentVignette, blendAlpha, color4Pool
} from "../color.js";
import {
    Timeline, Sprite, RandomWalk, MutableNumber
} from "../animation.js";
import { FieldSampler } from "../FieldSampler.js";
import { tween } from "../draw.js";

export class RingSpinFieldSample {
    static Ring = class {
        constructor(normal, palette) {
            this.normal = normal;
            this.palette = new TransparentVignette(palette);
            this.orientation = new Orientation();

            // Pre-allocated Ring Buffer
            this.historyCapacity = 19;
            this.history = new Array(this.historyCapacity);
            for (let i = 0; i < this.historyCapacity; i++) {
                this.history[i] = new Orientation();
            }
            this.head = 0;
            this.count = 0;
        }
    }

    constructor() {
        this.rings = [];
        this.alpha = 0.5;
        this.trailLength = 19;
        this.thickness = 2 * Math.PI / Daydream.W;
        this.palettes = [iceMelt, underSea, mangoPeel, richSunset]
        this.numRings = 4;
        this.timeline = new Timeline();
        this.sampler = new FieldSampler();

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
        this.gui.add(this.sampler, 'debugBB').name('Show Bounding Boxes');
    }

    spawnRing(normal, palette) {
        let ring = new RingSpinFieldSample.Ring(normal, palette);
        this.rings.push(ring);
        this.timeline.add(0, new RandomWalk(ring.orientation, ring.normal));
    }

    drawFrame() {
        this.timeline.step();
        this.renderPlanes.length = 0;

        for (const ring of this.rings) {
            const snapshot = ring.history[ring.head];
            const src = ring.orientation.orientations;
            if (snapshot.orientations.length < src.length) {
                while (snapshot.orientations.length < src.length) snapshot.orientations.push(new THREE.Quaternion());
            }
            for (let k = 0; k < src.length; k++) {
                snapshot.orientations[k].copy(src[k]);
            }

            ring.head = (ring.head + 1) % ring.historyCapacity;
            if (ring.count < ring.historyCapacity) ring.count++;

            for (let i = 0; i < ring.count; i++) {
                const idx = (ring.head - 1 - i + ring.historyCapacity) % ring.historyCapacity;
                const orientationSnapshot = ring.history[idx];

                tween(orientationSnapshot, (q, t) => {
                    const globalT = i / this.trailLength; // 0 to 1
                    if (globalT > 1.0) return;

                    const c = ring.palette.get(globalT);
                    c.alpha = c.alpha * this.alpha;

                    this.renderPlanes.push({
                        normal: vectorPool.acquire().copy(ring.normal).applyQuaternion(q),
                        color: c
                    });
                });
            }
        }
        this.sampler.drawPlanes(this.renderPlanes, this.thickness);
    }
}