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

export class RingSpinFieldSample {
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
        this.trailLength = 20;
        this.trailLengthMutable = new MutableNumber(this.trailLength);
        this.thickness = 2 * Math.PI / Daydream.W;
        this.palettes = [iceMelt, underSea, mangoPeel, richSunset];
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
        this.rings.unshift(ring);
        this.timeline.add(0, new RandomWalk(ring.orientation, ring.normal, this.trailLengthMutable));
    }

    drawFrame() {
        this.timeline.step();
        const planes = [];
        for (let r = this.rings.length - 1; r >= 0; r--) {
            const ring = this.rings[r];
            const len = ring.orientation.length();
            for (let i = 0; i < len; i++) {
                const age = len > 1 ? (len - 1 - i) / (len - 1) : 0;
                const q = ring.orientation.get(i);
                const n = ring.normal.clone().applyQuaternion(q);
                const c = ring.palette.get(age);
                const alpha = c.alpha * this.alpha;
                if (alpha > 0.01) {
                    planes.push({ normal: n, color: c.color, alpha: alpha });
                }
            }
        }
        this.sampler.drawPlanes(planes, this.thickness);
    }
}