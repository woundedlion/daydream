
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation
} from "../geometry.js";
import {
    Timeline, easeInOutSin, Rotation, PeriodicTimer, Sprite, easeMid
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrient
} from "../filters.js";
import { GenerativePalette } from "../color.js";


export class GSReaction extends Sprite {
    constructor(rd, duration = 192, fadeOut = 32, fadeIn = 32) {
        // 16 FPS. 10s exist + 2s fade = 12s total (192 frames).
        super((alpha) => this.render(alpha), duration, fadeIn, easeMid, fadeOut, easeMid);

        this.rd = rd;
        this.N = rd.N;

        // RD State
        this.A = new Float32Array(this.N).fill(1.0);
        this.B = new Float32Array(this.N).fill(0.0);
        this.nextA = new Float32Array(this.N);
        this.nextB = new Float32Array(this.N);

        // Params (Brain Coral)
        this.feed = 0.0545;
        this.k = 0.062;
        // Fibonacci Mode diffusion
        this.dA = 0.15;
        this.dB = 0.075;
        this.dt = 1.0;

        // Palette (Instantiate new one)
        this.palette = new GenerativePalette("straight", "split-complementary", "ascending", "vibrant");
    }

    seed() {
        // Seed random spots
        for (let i = 0; i < 5; i++) {
            let idx = Math.floor(Math.random() * this.N);
            let nbs = this.rd.neighbors[idx];
            this.B[idx] = 1.0;
            for (let j of nbs) { // Check if nbs is iterable (it is array of indices)
                this.B[j] = 1.0;
            }
        }
    }

    render(currentAlpha) {
        // 1. Simulate (12 steps per frame)
        for (let k = 0; k < 12; k++) {
            this.updatePhysics();
        }

        // 2. Draw
        for (let i = 0; i < this.N; i++) {
            let b = this.B[i];
            if (b > 0.1) {
                let t = Math.max(0, Math.min(1, (b - 0.15) * 4.0));
                let c = this.palette.get(t);
                this.rd.filters.plot(null, this.rd.nodes[i], c.color, 0, currentAlpha * this.rd.alpha * c.alpha);
            }
        }
    }

    updatePhysics() {
        // Brain Coral Regime (Phase Eta)
        // Gray-Scott on Graph

        let nodes = this.rd.nodes;
        let neighbors = this.rd.neighbors;
        let weights = this.rd.weights;
        let scales = this.rd.scales;

        for (let i = 0; i < this.N; i++) {
            let a = this.A[i];
            let b = this.B[i];

            let lapA = 0;
            let lapB = 0;
            let nbs = neighbors[i];
            let ws = weights[i];
            let degree = nbs.length;

            for (let k = 0; k < degree; k++) {
                let j = nbs[k];
                let w = ws[k];
                lapA += (this.A[j] - a) * w;
                lapB += (this.B[j] - b) * w;
            }

            // Apply Physical Scale Correction
            let s = scales[i];
            lapA *= s;
            lapB *= s;

            // Reaction
            let reaction = a * b * b;
            let feed = this.feed * (1 - a);
            let kill = (this.k + this.feed) * b;

            this.nextA[i] = a + (this.dA * lapA - reaction + feed) * this.dt;
            this.nextB[i] = b + (this.dB * lapB + reaction - kill) * this.dt;

            // Clamp
            this.nextA[i] = Math.max(0, Math.min(1, this.nextA[i]));
            this.nextB[i] = Math.max(0, Math.min(1, this.nextB[i]));
        }

        // Swap
        let tempA = this.A; this.A = this.nextA; this.nextA = tempA;
        let tempB = this.B; this.B = this.nextB; this.nextB = tempB;
    }
}

export class GSReactionDiffusion {
    constructor() {
        this.alpha = 0.3;

        // Graph Parameters
        this.N = 4096;
        this.nodes = [];
        this.neighbors = [];
        this.weights = [];
        this.scales = [];
        this.quarterSpinDuration = 64;

        // Build Graph (Fibonacci Hex)
        this.buildGraph();

        // Visualization
        this.orientation = new Orientation();
        this.filters = createRenderPipeline(
            new FilterOrient(this.orientation),
            new FilterAntiAlias()
        );

        this.timeline = new Timeline();
        this.timeline.add(0,
            new Rotation(this.orientation, Daydream.Y_AXIS, Math.PI / 2, this.quarterSpinDuration, easeMid, true)
        );
        this.spawn();
        this.timeline.add(0, new PeriodicTimer(96, () => this.spawn(), true));

        this.setupGui();
    }

    spawn() {
        // Create new reaction
        // 10s alive + 2s fade = 12s = 192 frames.
        // Fadeout 2s = 32 frames.
        let r = new GSReaction(this, 192, 32);
        r.seed();
        this.timeline.add(0, r);
    }

    setupGui() {
        if (this.gui) this.gui.destroy();
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha', 0, 1).step(0.01).name('Alpha');
    }

    // Graph Build Logic
    buildGraph() {
        // Fibonacci Sphere (Uniform Isotropy)
        this.N = Daydream.W * Daydream.H;

        this.nodes = [];
        this.neighbors = [];
        this.weights = [];
        this.scales = [];

        // 1. Generate Nodes (Fibonacci Spiral)
        const phi = Math.PI * (3 - Math.sqrt(5)); // Golden Angle

        for (let i = 0; i < this.N; i++) {
            let y = 1 - (i / (this.N - 1)) * 2; // y goes from 1 to -1
            let radius = Math.sqrt(1 - y * y);
            let theta = phi * i;
            let x = Math.cos(theta) * radius;
            let z = Math.sin(theta) * radius;
            this.nodes.push(new THREE.Vector3(x, y, z));
        }

        // 2. Build Neighbors using Spatial Hashing (Grid Optimization)
        const K = 6;

        // Grid setup
        const gridSize = 20; // 20x20x20 grid
        const cellSize = 2.0 / gridSize; // Domain is [-1, 1], size 2
        const grid = new Map();

        const getKey = (p) => {
            const gx = Math.floor((p.x + 1) / cellSize);
            const gy = Math.floor((p.y + 1) / cellSize);
            const gz = Math.floor((p.z + 1) / cellSize);
            return `${gx},${gy},${gz}`;
        };

        // Bin points
        for (let i = 0; i < this.N; i++) {
            const key = getKey(this.nodes[i]);
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(i);
        }

        // Neighbor search
        for (let i = 0; i < this.N; i++) {
            let p1 = this.nodes[i];
            let bestIndices = [];
            let bestDists = [];

            // Search local and adjacent cells
            const gx = Math.floor((p1.x + 1) / cellSize);
            const gy = Math.floor((p1.y + 1) / cellSize);
            const gz = Math.floor((p1.z + 1) / cellSize);

            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    for (let z = -1; z <= 1; z++) {
                        const key = `${gx + x},${gy + y},${gz + z}`;
                        const cell = grid.get(key);
                        if (!cell) continue;

                        for (let j of cell) {
                            if (i === j) continue;
                            let d2 = p1.distanceToSquared(this.nodes[j]);

                            let len = bestDists.length;
                            if (len < K || d2 < bestDists[len - 1]) {
                                let pos = len;
                                while (pos > 0 && d2 < bestDists[pos - 1]) { pos--; }
                                bestDists.splice(pos, 0, d2);
                                bestIndices.splice(pos, 0, j);
                                if (bestDists.length > K) { bestDists.pop(); bestIndices.pop(); }
                            }
                        }
                    }
                }
            }
            this.neighbors.push(bestIndices);
            this.weights.push(new Array(K).fill(1.0));
            this.scales.push(1.0);
        }
    }

    drawFrame() {
        this.timeline.step();
    }
}

export class BZReaction extends GSReaction {
    constructor(rd, duration = 192, fadeOut = 32) {
        super(rd, duration, fadeOut);

        // 3rd Chemical Species
        this.C = new Float32Array(this.N).fill(0.0);
        this.nextC = new Float32Array(this.N);

        // Params for Cyclic Competition
        // A eats B, B eats C, C eats A
        this.alpha = 1.2; // Predation rate
        this.beta = 0.1;  // Decay rate
        this.D = 0.08;    // Diffusion

        this.seed();

        this.palette = new GenerativePalette('straight', 'triadic', 'descending', 'vibrant');
    }

    seed() {
        // Sparse Seeding for Spirals (Droplets)
        this.A.fill(0.0);
        this.B.fill(0.0);
        this.C.fill(0.0);

        // Seed random droplets
        for (let k = 0; k < 50; k++) {
            let center = Math.floor(Math.random() * this.N);
            let r = Math.random();
            // Set a small neighborhood
            let nbs = this.rd.neighbors[center];

            let target = (r < 0.33) ? this.A : (r < 0.66) ? this.B : this.C;
            target[center] = 1.0;
            for (let j of nbs) target[j] = 1.0;
        }
    }

    updatePhysics() {
        // 3-Species Cyclic Model (Rock-Paper-Scissors)

        let nodes = this.rd.nodes;
        let neighbors = this.rd.neighbors;
        let weights = this.rd.weights;

        // Use parameters from BZReactionDiffusion GUI if available
        let dt = this.rd.bzParams ? this.rd.bzParams.dt : 0.2;
        let D = this.rd.bzParams ? this.rd.bzParams.D : 0.03;
        this.alpha = this.rd.bzParams ? this.rd.bzParams.alpha : 1.6;

        for (let i = 0; i < this.N; i++) {
            let a = this.A[i];
            let b = this.B[i];
            let c = this.C[i];

            let lapA = 0, lapB = 0, lapC = 0;
            let nbs = neighbors[i];
            let degree = nbs.length;

            for (let k = 0; k < degree; k++) {
                let j = nbs[k];
                lapA += (this.A[j] - a);
                lapB += (this.B[j] - b);
                lapC += (this.C[j] - c);
            }

            let da = a * (1 - a - this.alpha * c);
            let db = b * (1 - b - this.alpha * a);
            let dc = c * (1 - c - this.alpha * b);

            this.nextA[i] = a + (D * lapA + da) * dt;
            this.nextB[i] = b + (D * lapB + db) * dt;
            this.nextC[i] = c + (D * lapC + dc) * dt;

            // Clamp
            this.nextA[i] = Math.max(0, Math.min(1, this.nextA[i]));
            this.nextB[i] = Math.max(0, Math.min(1, this.nextB[i]));
            this.nextC[i] = Math.max(0, Math.min(1, this.nextC[i]));
        }

        // Swap
        let temp;
        temp = this.A; this.A = this.nextA; this.nextA = temp;
        temp = this.B; this.B = this.nextB; this.nextB = temp;
        temp = this.C; this.C = this.nextC; this.nextC = temp;
    }

    render(currentAlpha) {
        let ca = this.palette.get(0);
        let cb = this.palette.get(0.5);
        let cc = this.palette.get(1);

        // 1. Simulate
        for (let k = 0; k < 2; k++) {
            this.updatePhysics();
        }

        // 2. Draw
        let color = new THREE.Color();
        let hsl = { h: 0, s: 0, l: 0 };

        for (let i = 0; i < this.N; i++) {
            let a = this.A[i];
            let b = this.B[i];
            let c = this.C[i];
            let sum = a + b + c;
            if (sum > 0.01) {
                // Alpha Blending (Layered: A first, then B, then C)
                color.setRGB(0, 0, 0);
                color.lerp(ca, a);
                color.lerp(cb, b);
                color.lerp(cc, c);
                hsl = color.getHSL(hsl);
                color.setHSL(hsl.h, 1.0, hsl.l);

                this.rd.filters.plot(null, this.rd.nodes[i], color, 0, currentAlpha * this.rd.alpha);
            }
        }
    }
}
