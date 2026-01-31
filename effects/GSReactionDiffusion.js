/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation
} from "../geometry.js";
import { vectorPool } from "../memory.js";
import {
    Timeline, Rotation, PeriodicTimer, Sprite
} from "../animation.js";
import { easeInOutSin, easeMid } from "../easing.js";
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

        // Buffers for Sorting
        this.zValues = new Float32Array(this.N);
        this.drawIndices = new Int32Array(this.N);

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
        // Pre-calculate Depth and filter active nodes
        let count = 0;
        const q = this.rd.orientation.get();

        for (let i = 0; i < this.N; i++) {
            if (this.B[i] > 0.05) { // Lower threshold slightly for smoother fade
                // Calculate View Space Z
                // We only need Z, so we can inline dot product: v' = v.applyQuaternion(q)
                // z' = v.x * q.... applyQuaternion is heavy.
                // Use vectorPool for simplicity and correctness first.
                const v = vectorPool.acquire().copy(this.rd.nodes[i]).applyQuaternion(q);
                this.zValues[i] = v.z;
                this.drawIndices[count++] = i;
            }
        }

        // Sort Indices by Z (Ascending: Far to Near) -> Standard Painter's
        // Camera is at +Z. Far is -Z. Near is +Z.
        // We want to draw Far first. So Lowest Z first. Ascending.
        const zRef = this.zValues;
        const indices = this.drawIndices.subarray(0, count);
        indices.sort((a, b) => zRef[a] - zRef[b]);

        for (let k = 0; k < count; k++) {
            const i = indices[k];
            let b = this.B[i];

            // Re-check threshold inside render logic if needed, but we filtered.
            // Just apply mapping.
            let t = Math.max(0, Math.min(1, (b - 0.15) * 4.0));
            // Ensure min opacity for soft edges
            if (t <= 0) t = 0.01;

            let c = this.palette.get(t);
            // Alpha scaling
            let alpha = currentAlpha * this.rd.alpha * c.alpha;

            this.rd.filters.plot(this.rd.nodes[i], c.color, 0, alpha);
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
        this.N = Daydream.W * Daydream.H * 2;

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
        this.orientation.collapse();
        this.timeline.step();
    }
}


