
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

        // We do not use DecayBuffer or standard Filters here because we are manually sampling
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
        this.gui.add(this, 'alpha', 0, 1).step(0.01).name('Brightness');
        this.gui.add(this, 'thickness', 0.01, 0.5).step(0.01).name('Comet Size');

        this.debugBB = false;
        this.gui.add(this, 'debugBB').name('Show Bounding Boxes');
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
            new Motion(node.orientation, node.path, this.cycleDuration, true)
        );
    }

    drawFrame() {
        for (const node of this.nodes) {
            node.orientation.collapse(this.trailLength);
        }
        this.orientation.collapse();
        this.timeline.step();

        // 1. Pre-calculate "Points" in space (Head + Trail)
        const points = [];
        for (const node of this.nodes) {
            const len = node.orientation.length();
            for (let i = 0; i < len; i++) {
                // age: 0 (newest) -> 1 (oldest)
                const age = len > 1 ? (len - 1 - i) / (len - 1) : 0;

                // Get orientation from history
                const q = node.orientation.get(i);

                // Position of the comet point
                // Note: The global this.orientation (RandomWalk) also affects the entire scene
                // So we should apply node orientation AND global orientation?
                // In Comets.js:
                // node.orientation handles the path following.
                // FilterOrient(this.orientation) handles the global wobble.
                // Since FieldSample manually iterates pixels, we must apply FilterOrient logic manually
                // OR we can bake it into the points.

                // Let's resolve the point:
                // Node local: Y_AXIS
                // Node motion: apply(q)
                // Global wobble: apply(this.orientation.get(0)) (using latest global orient)

                const v = node.v.clone().applyQuaternion(q);

                // Apply global orientation (current frame)
                // Note: Comets.js draws trails via DecayBuffer, and DecayBuffer uses FilterOrient.
                // FilterOrient tweens global orientation matching the age of the dot?
                // Actually DecayBuffer assumes 'age' for filters is current frame time diff.
                // (or implies the entire path wobbles together).
                if (this.orientation.length() > 0) {
                    v.applyQuaternion(this.orientation.get());
                }

                const c = this.palette.get(age);
                const color = c.color || c;
                let alpha = c.alpha * this.alpha * quinticKernel(1 - age);

                if (alpha > 0.01) {
                    points.push({ pos: v, color: color, alpha: alpha });
                }
            }
        }

        // 2. Field Splatting
        // Optimization: Iterating over points instead of pixels
        const cosThreshold = Math.cos(this.thickness);

        // Pre-calculate constants for pixel mapping
        // From geometry.js: y = (phi * (H - 1)) / PI
        // So dy/dphi = (H-1)/PI. 
        // rad_y = thickness * (H-1)/PI
        const radY = this.thickness * (Daydream.H - 1) / Math.PI;

        for (const pt of points) {
            // Convert point to pixel coordinates (center of influence)
            const center = vectorToPixel(pt.pos);
            const cy = center.y;
            const cx = center.x;

            // Get phi from y (approximation is fine for bounds)
            // y = phi * (H-1) / PI  -> phi = y * PI / (H-1)
            const phi = cy * Math.PI / (Daydream.H - 1);

            // Horizontal radius depends on latitude (phi)
            const sinPhi = Math.sin(phi);
            let radX;
            // Handle poles: if too close to pole, check full width
            if (Math.abs(sinPhi) < 0.05) {
                radX = Daydream.W; // Full width
            } else {
                radX = (this.thickness * Daydream.W) / (2 * Math.PI * sinPhi);
            }

            const yMin = Math.max(0, Math.ceil(cy - radY));
            const yMax = Math.min(Daydream.H - 1, Math.floor(cy + radY));

            const xMin = Math.ceil(cx - radX);
            const xMax = Math.floor(cx + radX);

            for (let y = yMin; y <= yMax; y++) {
                const rowOffset = Daydream.rowOffsets[y];
                for (let x = xMin; x <= xMax; x++) {
                    // Wrap x
                    const wx = wrap(x, Daydream.W);
                    const i = rowOffset + wx;

                    // Debug Visualization
                    if (this.debugBB) {
                        const outColor = Daydream.pixels[i];
                        outColor.r += 0.05;
                        outColor.g += 0.05;
                        outColor.b += 0.05;
                    }

                    const p = Daydream.pixelPositions[i];
                    // Dot product check
                    const dot = p.dot(pt.pos);

                    if (dot > cosThreshold) {
                        // Distance on sphere in radians
                        const dist = Math.acos(Math.min(1, Math.max(-1, dot)));

                        // Falloff
                        const t = dist / this.thickness;
                        const alpha = quinticKernel(1 - t) * pt.alpha;

                        // Alpha Blending
                        const outColor = Daydream.pixels[i];
                        blendAlpha(outColor, pt.color, alpha, outColor);
                    }
                }
            }
        }
    }
}
