
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, lissajous, randomVector, vectorToPixel
} from "../geometry.js";
import {
    Path
} from "../draw.js";
import {
    GenerativePalette, blendAlpha
} from "../color.js";
import {
    Timeline, easeMid, Sprite, Motion, RandomWalk, PeriodicTimer, ColorWipe
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrient, quinticKernel
} from "../filters.js";
import { randomBetween, wrap } from "../util.js";
import { FieldSampler } from "../FieldSampler.js";

export class CometsFieldSample {
    static Node = class {
        constructor(path) {
            this.orientation = new Orientation();
            this.v = Daydream.Y_AXIS.clone();
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
        this.thickness = 2.1 * 2 * Math.PI / Daydream.W;
        this.orientation = new Orientation();
        this.path = new Path(Daydream.Y_AXIS);
        this.sampler = new FieldSampler();
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
        this.palette = new GenerativePalette("straight", "triadic", "descending");
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

        this.setupGUI();

    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha', 0, 1).step(0.01).name('Brightness');
        this.gui.add(this, 'thickness', 0.01, 0.5).step(0.01).name('Brush Size');
        this.gui.add(this.sampler, 'debugBB').name('Show Bounding Boxes');
    }

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
        let node = new CometsFieldSample.Node(path);
        this.nodes.push(node);
        this.timeline.add(i * this.spacing,
            new Motion(node.orientation, node.path, this.cycleDuration, true, this.trailLength)
        );
    }

    drawFrame() {
        this.timeline.step();

        const points = [];
        for (const node of this.nodes) {
            const len = node.orientation.length();
            for (let i = 0; i < len; i++) {
                const age = len > 1 ? (len - 1 - i) / (len - 1) : 0;
                const q = node.orientation.get(i);
                const v = node.v.clone().applyQuaternion(q);
                v.applyQuaternion(this.orientation.get());
                const color4 = this.palette.get(age);
                let alpha = color4.alpha * this.alpha * quinticKernel(1 - age);
                if (alpha > 0.01) {
                    points.push({ pos: v, color: color4.color, alpha: alpha });
                }
            }
        }
        this.sampler.drawPoints(points, this.thickness);
    }
}
