
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation
} from "../geometry.js";
import {
    Timeline, easeInOutSin, Rotation, PeriodicTimer
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrient
} from "../filters.js";
import { Reaction } from "./Reaction.js";

export class GSReactionDiffusion {
    constructor() {
        this.pixels = new Map();
        this.alpha = 0.3;

        // Graph Parameters
        this.N = 4096;
        this.nodes = [];
        this.neighbors = [];
        this.weights = [];
        this.scales = [];

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
            new Rotation(this.orientation, Daydream.Y_AXIS, Math.PI / 2, 200, easeInOutSin, true)
        );
        this.spawn();
        this.timeline.add(0, new PeriodicTimer(96, () => this.spawn(), true));

        this.setupGui();
    }

    spawn() {
        // Create new reaction
        // 10s alive + 2s fade = 12s = 192 frames.
        // Fadeout 2s = 32 frames.
        let r = new Reaction(this, 192, 32);
        r.seed();
        this.timeline.add(0, r);
    }

    setupGui() {
        if (this.gui) this.gui.destroy();
        this.gui = new gui.GUI();
        this.gui.add(this, 'alpha', 0, 1).step(0.01).name('Alpha');
    }

    // Graph Build Logic
    buildGraph() {
        // Fibonacci Sphere (Uniform Isotropy)

        this.N = 4096; // Adjust for density

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

        // 2. Build K=6 Neighbors (Hexagonal Topology)
        const K = 6;
        for (let i = 0; i < this.N; i++) {
            let p1 = this.nodes[i];
            let bestIndices = [];
            let bestDists = [];

            for (let j = 0; j < this.N; j++) {
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
            this.neighbors.push(bestIndices);
            this.weights.push(new Array(K).fill(1.0));
            this.scales.push(1.0);
        }
        console.log("Graph built (Fibonacci Hex Sphere). Nodes:", this.N);
    }

    drawFrame() {
        this.pixels.clear();
        this.timeline.step();
        return this.pixels;
    }
}
