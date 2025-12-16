
import * as THREE from "three";
import { gui } from "gui";
import { Daydream, labels } from "../driver.js";
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
        this.timeline = new Timeline();
        this.numNodes = 1;
        this.spacing = 48;
        this.resolution = 32;
        this.cycleDuration = 80;
        this.trailLength = this.cycleDuration;
        this.alpha = 0.5;
        this.orientation = new Orientation();
        this.path = new Path(Daydream.Y_AXIS);
        this.functions = [
            { m1: 1.06, m2: 1.06, a: 0, domain: 5.909 },
            { m1: 6.06, m2: 1, a: 0, domain: 2 * Math.PI },
            { m1: 6.02, m2: 4.01, a: 0, domain: 3.132 },
            { m1: 46.62, m2: 62.16, a: 0, domain: 0.404 },
            { m1: 46.26, m2: 69.39, a: 0, domain: 0.272 },
            { m1: 19.44, m2: 9.72, a: 0, domain: 0.646 },
            { m1: 8.51, m2: 17.01, a: 0, domain: 0.739 },
            { m1: 7.66, m2: 6.38, a: 0, domain: 4.924 },
            { m1: 8.75, m2: 5, a: 0, domain: 5.027 },
            { m1: 11.67, m2: 14.58, a: 0, domain: 2.154 },
            { m1: 11.67, m2: 8.75, a: 0, domain: 2.154 },
            { m1: 10.94, m2: 8.75, a: 0, domain: 2.872 }
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

        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'resolution', 10, 200).step(1).onChange(() => {
            this.updatePath();
        });
    }

    /*
        getLabels() {
            if (!this.path || !this.path.points) return [];
            return this.path.points.map((p, i) => ({
                position: this.orientation.orient(p),
                content: i.toString()
            }));
        }
    */
    updatePath() {
        const config = this.functions[this.curFunction];
        const { m1, m2, a, domain } = config;
        const maxSpeed = Math.sqrt(m1 * m1 + m2 * m2);
        const length = domain * maxSpeed;
        const samples = Math.max(128, Math.ceil(length * this.resolution));
        this.path.collapse();
        this.path.appendSegment((t) => lissajous(m1, m2, a, t), domain, samples, easeMid);
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
        this.timeline.step();
        this.trails.render(null, this.filters, (v, t) => this.palette.get(1 - t));
    }
}
