
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, randomVector
} from "../geometry.js";
import {
    drawRing, plotDots
} from "../draw.js";
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
            this.normal = randomVector();
            this.duration = 8 + Math.random() * 72;
            this.radius = new MutableNumber(0);
            this.lastRadius = this.radius.get();
            this.palette = new GenerativePalette('circular', 'analogous', 'flat');
            this.phase = new MutableNumber(0);
        }
    }

    constructor() {
        Daydream.W = 96;
        this.pixels = new Map();
        this.rings = [];
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

        this.gui = new gui.GUI();
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
        let step = 1 / Daydream.W;
        let dots = drawRing(this.orientation.get(), ring.normal, ring.radius.get(),
            (v, t) => ring.palette.get(t), ring.phase.get());
        plotDots(this.pixels, this.filters, dots, 0, opacity * this.alpha);
        ring.lastRadius = ring.radius.get();
    }

    drawFrame() {
        this.pixels.clear();
        this.timeline.step();
        return this.pixels;
    }
}
