import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation
} from "../geometry.js";
import { wrap } from "../util.js";
import {
    VignettePalette, richSunset, mangoPeel, underSea, iceMelt,
    TransparentVignette, blendAlpha
} from "../color.js";
import {
    Timeline, Sprite, RandomWalk, MutableNumber
} from "../animation.js";
import { quinticKernel } from "../filters.js";
import { FieldSampler } from "../FieldSampler.js";
import { tween } from "../draw.js";

export class RingSpinFieldSample {
    static Ring = class {
        constructor(normal, palette) {
            this.normal = normal;
            this.palette = new TransparentVignette(palette);
            this.orientation = new Orientation();
            this.history = [];
        }
    }

    constructor() {
        this.rings = [];
        this.alpha = 0.5;
        this.trailLength = 19;
        this.trailLengthMutable = new MutableNumber(this.trailLength);
        this.thickness = 2 * Math.PI / Daydream.W;
        this.palettes = [iceMelt, underSea, mangoPeel, richSunset]
        this.numRings = 4;
        this.timeline = new Timeline();
        this.sampler = new FieldSampler();

        for (let i = 0; i < this.numRings; ++i) {
            this.spawnRing(Daydream.X_AXIS, this.palettes[i]);
        }

        this.setupGUI();
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01).name("Brightness");
        this.gui.add(this, 'thickness').min(0.01).max(0.5).step(0.01).name("Brush Size");
        this.gui.add(this, 'trailLength').min(1).max(200).step(1).name("Trail Length").onChange(v => this.trailLengthMutable.set(v));
        this.gui.add(this.sampler, 'debugBB').name('Show Bounding Boxes');
    }

    spawnRing(normal, palette) {
        let ring = new RingSpinFieldSample.Ring(normal, palette);
        this.rings.push(ring);
        this.timeline.add(0, new RandomWalk(ring.orientation, ring.normal));
    }

    drawFrame() {
        this.timeline.step();
        const planes = [];
        for (const ring of this.rings) {
            // Update history
            const snapshot = new Orientation();
            snapshot.orientations = ring.orientation.orientations.map(q => q.clone());
            ring.history.unshift(snapshot);
            if (ring.history.length > this.trailLength) {
                ring.history.pop();
            }

            // Draw full history
            for (let i = 0; i < ring.history.length; i++) {
                tween(ring.history[i], (q, t) => {
                    const globalT = (i + t) / this.trailLength;
                    const c = ring.palette.get(globalT);
                    planes.push({
                        normal: ring.normal.clone().applyQuaternion(q),
                        color: c.color,
                        alpha: c.alpha * this.alpha * (1 - globalT)
                    });
                });
            }
        }
        this.sampler.drawPlanes(planes, this.thickness);
    }
}