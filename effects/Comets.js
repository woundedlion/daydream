
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, lissajous, randomVector
} from "../geometry.js";
import {
    Path, drawVector, DecayBuffer, tween
} from "../draw.js";
import {
    GenerativePalette
} from "../color.js";
import {
    Timeline, easeMid, Sprite, Motion, RandomWalk, PeriodicTimer, ColorWipe
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrient
} from "../filters.js";
import { randomBetween } from "../util.js";

export class Comets {
    static Node = class {
        constructor(path) {
            this.orientation = new Orientation();
            this.v = Daydream.Y_AXIS;
            this.path = path;
        }
    }
    constructor() {
        this.pixels = new Map();
        this.timeline = new Timeline();
        this.numNodes = 1;
        this.spacing = 48;
        this.cycleDuration = 80;
        this.trailLength = this.cycleDuration;
        this.alpha = 0.5;
        this.orientation = new Orientation();
        this.path = new Path(Daydream.Y_AXIS);
        this.functions = [
            [(t) => lissajous(1.06, 1.06, 0, t), 5.909],
            [(t) => lissajous(6.06, 1, 0, t), 2 * Math.PI],
            [(t) => lissajous(6.02, 4.01, 0, t), 3.132],
            [(t) => lissajous(46.62, 62.16, 0, t), 0.404],
            [(t) => lissajous(46.26, 69.39, 0, t), 0.272],
            [(t) => lissajous(19.44, 9.72, 0, t), 0.646],
            [(t) => lissajous(8.51, 17.01, 0, t), 0.739],
            [(t) => lissajous(7.66, 6.38, 0, t), 4.924],
            [(t) => lissajous(8.75, 5, 0, t), 5.027],
            [(t) => lissajous(11.67, 14.58, 0, t), 2.154],
            [(t) => lissajous(11.67, 8.75, 0, t), 2.154],
            [(t) => lissajous(10.94, 8.75, 0, t), 2.872]
        ]
        this.curFunction = 0;
        this.updatePath();
        this.palette = new GenerativePalette("straight", "triadic", "ascending");
        this.trails = new DecayBuffer(this.trailLength);

        this.filters = createRenderPipeline(
            new FilterOrient(this.orientation),
            new FilterAntiAlias()
        );
        this.nodes = [];

        for (let i = 0; i < this.numNodes; ++i) {
            this.spawnNode(this.path);
        }

        this.timeline.add(0,
            new PeriodicTimer(2 * this.cycleDuration, () => {
                this.curFunction = Math.floor(randomBetween(0, this.functions.length));
                this.updatePath();
                this.updatePalette();
            }, true)
        );
        this.timeline.add(0, new RandomWalk(this.orientation, randomVector()));
    }

    updatePath() {
        let f = this.functions[this.curFunction][0];
        let domain = this.functions[this.curFunction][1];
        this.path.collapse();
        this.path.appendSegment(f, domain, 1024, easeMid);
    }

    updatePalette() {
        this.nextPalette = new GenerativePalette("straight", "triadic", "ascending");
        this.timeline.add(0,
            new ColorWipe(this.palette, this.nextPalette, 48, easeMid)
        );
    }

    spawnNode(path) {
        let i = this.nodes.length;
        this.nodes.push(new Comets.Node(path));
        this.timeline.add(0,
            new Sprite((opacity) => this.drawNode(opacity, i), -1, 16, easeMid, 0, easeMid)
        );
        this.timeline.add(i * this.spacing,
            new Motion(this.nodes[i].orientation, this.nodes[i].path, this.cycleDuration, true)
        );

    }

    drawNode(opacity, i) {
        let node = this.nodes[i];
        tween(node.orientation, (q, t) => {
            let dots = [];
            let v = node.v.clone().applyQuaternion(q).normalize();
            dots.push(...drawVector(v,
                (v, t) => this.palette.get(t)));
            this.trails.recordDots(dots, t, opacity * this.alpha);
        });
        node.orientation.collapse();
    }

    drawFrame() {
        this.pixels.clear();
        this.timeline.step();
        this.trails.render(this.pixels, this.filters, (v, t) => this.palette.get(1 - t));
        return this.pixels;
    }
}
