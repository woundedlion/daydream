
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation
} from "../geometry.js";
import {
    sampleRing, rasterize, plotDots, tween
} from "../draw.js";
import {
    VignettePalette, richSunset, mangoPeel, underSea, iceMelt, TransparentVignette
} from "../color.js";
import {
    Timeline, easeMid, Sprite, RandomWalk, MutableNumber
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterDecay
} from "../filters.js";

export class RingSpin {
    static Ring = class {
        constructor(normal, palette, trailLength) {
            this.normal = normal;
            this.palette = new TransparentVignette(palette);
            this.filters = createRenderPipeline(
                new FilterDecay(trailLength),
                new FilterAntiAlias()
            );
            this.orientation = new Orientation();
        }
    }

    constructor() {
        this.rings = [];
        this.alpha = 0.2;
        this.trailLength = new MutableNumber(20);
        this.palettes = [iceMelt, underSea, mangoPeel, richSunset];
        this.numRings = 4;
        this.timeline = new Timeline();

        for (let i = 0; i < this.numRings; ++i) {
            this.spawnRing(Daydream.X_AXIS, this.palettes[i]);
        }

        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
    }

    spawnRing(normal, palette) {
        let ring = new RingSpin.Ring(normal, palette, this.trailLength.get());
        ring.basePoints = sampleRing(new THREE.Quaternion(), ring.normal, 1);
        this.rings.unshift(ring);

        this.timeline.add(0,
            new Sprite((opacity) => this.drawRing(opacity, ring),
                -1,
                4, easeMid,
                0, easeMid
            ));
        this.timeline.add(0,
            new RandomWalk(ring.orientation, ring.normal));
    }

    drawRing(opacity, ring) {
        tween(ring.orientation, (q, t) => {
            let points = ring.basePoints.map(p => p.clone().applyQuaternion(q));
            let dots = rasterize(points, (v, t) => ring.palette.get(0), true);
            plotDots(null, ring.filters, dots, 0, this.alpha);
        });
        ring.orientation.collapse();
        ring.filters.trail((x, y, t) => ring.palette.get(t), this.alpha);
    }

    drawFrame() {
        this.timeline.step();
    }
}
