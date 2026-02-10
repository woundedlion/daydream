/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Timeline, Rotation, PeriodicTimer, Sprite, tween, Orientation
} from "../animation.js";
import { vectorToPixel } from "../geometry.js";
import { easeInOutSin, easeMid } from "../easing.js";
import {
    createRenderPipeline, Filter
} from "../filters.js";
import { GenerativePalette } from "../color.js";
import { GSReaction } from "./GSReactionDiffusion.js";
import { TWO_PI } from "../3dmath.js";

// Reusable scratch vectors to avoid Garbage Collection in the render loop
const _rotVec = new THREE.Vector3();
const _zAxis = new THREE.Vector3();

export class BZReaction extends GSReaction {
    constructor(rd, duration = 192, fadeOut = 32) {
        super(rd, duration, fadeOut);

        // 3rd Chemical Species
        this.C = new Float32Array(this.N).fill(0.0);

        // Sorting Buffers
        this.zValues = new Float32Array(this.N);
        this.drawIndices = new Int32Array(this.N);

        this.nextC = new Float32Array(this.N);

        // Params for Cyclic Competition
        this.alpha = 1.2; // Predation rate
        this.beta = 0.1;  // Decay rate
        this.D = 0.08;    // Diffusion

        this.seed();

        this.palette = new GenerativePalette('straight', 'triadic', 'descending', 'vibrant');
    }

    seed() {
        this.A.fill(0.0);
        this.B.fill(0.0);
        this.C.fill(0.0);

        // Use optimized neighbor arrays if available
        const neighbors = this.rd.neighbors;

        for (let k = 0; k < 50; k++) {
            let center = Math.floor(Math.random() * this.N);
            let r = Math.random();
            let nbs = neighbors[center];

            let target = (r < 0.33) ? this.A : (r < 0.66) ? this.B : this.C;
            target[center] = 1.0;
            for (let j of nbs) target[j] = 1.0;
        }
    }

    updatePhysics() {
        // Direct local access vars for speed
        const N = this.N;
        const A = this.A;
        const B = this.B;
        const C = this.C;
        const nextA = this.nextA;
        const nextB = this.nextB;
        const nextC = this.nextC;

        // OPTIMIZATION: Use flattened arrays for contiguous memory access (Cache Locality)
        const flatNeighbors = this.rd.flatNeighbors;
        const offsets = this.rd.neighborOffsets;

        const bz = this.rd.bzParams;
        const dt = bz ? bz.dt : 0.2;
        const D = bz ? bz.D : 0.03;
        const alpha = bz ? bz.alpha : 1.6;

        for (let i = 0; i < N; i++) {
            const a = A[i];
            const b = B[i];
            const c = C[i];

            let sumA = 0, sumB = 0, sumC = 0;

            // Loop over flattened neighbor list
            const start = offsets[i];
            const end = offsets[i + 1];

            for (let k = start; k < end; k++) {
                const j = flatNeighbors[k];
                sumA += A[j];
                sumB += B[j];
                sumC += C[j];
            }

            // Standard Laplacian: sum(neighbors) - degree * self
            const degree = end - start;
            const lapA = sumA - degree * a;
            const lapB = sumB - degree * b;
            const lapC = sumC - degree * c;

            // Reaction: Cyclic Competition
            const da = a * (1 - a - alpha * c);
            const db = b * (1 - b - alpha * a);
            const dc = c * (1 - c - alpha * b);

            const valA = a + (D * lapA + da) * dt;
            const valB = b + (D * lapB + db) * dt;
            const valC = c + (D * lapC + dc) * dt;

            // Fast clamp
            nextA[i] = valA < 0 ? 0 : (valA > 1 ? 1 : valA);
            nextB[i] = valB < 0 ? 0 : (valB > 1 ? 1 : valB);
            nextC[i] = valC < 0 ? 0 : (valC > 1 ? 1 : valC);
        }

        // Pointer swap (Zero allocation)
        this.A = nextA; this.nextA = A;
        this.B = nextB; this.nextB = B;
        this.C = nextC; this.nextC = C;
    }

    render(currentAlpha) {
        const ca = this.palette.get(0).color;
        const cb = this.palette.get(0.5).color;
        const cc = this.palette.get(1).color;

        // Run physics multiple times per frame for speed
        for (let k = 0; k < 2; k++) {
            this.updatePhysics();
        }

        const nodes = this.rd.nodes;
        const N = this.N;

        // --- Z-Sorting ---
        // 1. Get the current global orientation
        const qCurrent = this.rd.orientation.get();

        // 2. Calculate the World-Space Z-Axis
        // We take the local vector (0,0,1) and apply the rotation. 
        // This vector tells us which direction is "forward" for depth sorting.
        _zAxis.set(0, 0, 1).applyQuaternion(qCurrent);

        let count = 0;
        for (let i = 0; i < N; i++) {
            const a = this.A[i];
            const b = this.B[i];
            const c = this.C[i];
            const sum = a + b + c;

            // Simple culling
            if (sum > 0.05) {
                // Depth = Dot product of position and camera-facing axis
                this.zValues[i] = nodes[i].dot(_zAxis);
                this.drawIndices[count++] = i;
            }
        }

        const zRef = this.zValues;
        const indices = this.drawIndices.subarray(0, count);
        indices.sort((a, b) => zRef[a] - zRef[b]);

        const color = new THREE.Color();
        const effectiveAlpha = currentAlpha * this.rd.alpha;
        const filters = this.rd.filters;

        // --- Outer Loop: Draw Trails (Tween Orientation) ---
        // We hoist the loop here to avoid creating closures per particle.
        tween(this.rd.orientation, (q, t) => {

            // --- Inner Loop: Draw Particles ---
            for (let k = 0; k < count; k++) {
                const i = indices[k];
                const a = this.A[i];
                const b = this.B[i];
                const c = this.C[i];

                color.setRGB(0, 0, 0);
                color.lerp(ca, a);
                color.lerp(cb, b);
                color.lerp(cc, c);

                // 1. Copy & Rotate
                // We use the scratch vector `_rotVec` to avoid allocations.
                // We use standard applyQuaternion as requested.
                _rotVec.copy(nodes[i]).applyQuaternion(q);

                // 2. Project
                // geometry.js handles the spherical mapping logic
                const p = vectorToPixel(_rotVec);

                // 3. Draw
                filters.plot2D(p.x, p.y, color, 1.0 - t, effectiveAlpha);
            }
        });
    }
}

export class BZReactionDiffusion {
    constructor() {
        this.alpha = 0.3;

        this.N = 4096;
        this.nodes = [];
        this.neighbors = [];
        this.weights = [];
        this.scales = [];

        // Optimized flattened storage
        this.flatNeighbors = null;
        this.neighborOffsets = null;

        this.bzParams = {
            alpha: 1.6,
            D: 0.03,
            dt: 0.2
        };
        this.quarterSpinDuration = 600;

        this.buildGraph();

        this.orientation = new Orientation();

        this.filters = createRenderPipeline(
            new Filter.Screen.AntiAlias()
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
        let r = new BZReaction(this, 192, 32);
        this.timeline.add(0, r);
    }

    setupGui() {
        if (this.gui) this.gui.destroy();
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha', 0, 1).step(0.01).name('Alpha');

        const folder = this.gui.addFolder('Mobius Params');
        folder.open();
        folder.add(this.bzParams, 'alpha', 0.5, 2.0).name('Predation (α)');
        folder.add(this.bzParams, 'D', 0.001, 0.1).name('Diffusion');
        folder.add(this.bzParams, 'dt', 0.01, 0.5).name('Time Step');
        folder.open();
    }

    buildGraph() {
        this.N = Daydream.W * Daydream.H * 2;

        this.nodes = [];
        this.neighbors = [];
        this.weights = [];
        this.scales = [];

        const phi = Math.PI * (3 - Math.sqrt(5));

        for (let i = 0; i < this.N; i++) {
            let y = 1 - (i / (this.N - 1)) * 2;
            let radius = Math.sqrt(1 - y * y);
            let theta = phi * i;
            let x = Math.cos(theta) * radius;
            let z = Math.sin(theta) * radius;
            this.nodes.push(new THREE.Vector3(x, y, z));
        }

        const K = 6;

        const gridSize = 20;
        const cellSize = 2.0 / gridSize;
        const grid = new Map();

        const getKey = (p) => {
            const gx = Math.floor((p.x + 1) / cellSize);
            const gy = Math.floor((p.y + 1) / cellSize);
            const gz = Math.floor((p.z + 1) / cellSize);
            return `${gx},${gy},${gz}`;
        };

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

        // OPTIMIZATION: Flatten neighbors for contiguous memory access
        let totalLinks = 0;
        for (let nbs of this.neighbors) {
            totalLinks += nbs.length;
        }

        this.flatNeighbors = new Int32Array(totalLinks);
        this.neighborOffsets = new Int32Array(this.N + 1);

        let offset = 0;
        for (let i = 0; i < this.N; i++) {
            this.neighborOffsets[i] = offset;
            const nbs = this.neighbors[i];
            const count = nbs.length;
            for (let j = 0; j < count; j++) {
                this.flatNeighbors[offset++] = nbs[j];
            }
        }
        this.neighborOffsets[this.N] = offset;
    }

    drawFrame() {
        this.orientation.collapse();
        this.timeline.step();
    }
}
