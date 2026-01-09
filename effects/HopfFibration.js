
import * as THREE from "three";
import { gui } from "../gui.js";
import { Daydream } from "../driver.js";
import { vectorPool } from "../geometry.js";
import { rasterize, plotDots } from "../draw.js";
import { stereo } from "../3dmath.js";
import { createRenderPipeline, FilterAntiAlias, FilterDecay } from "../filters.js";
import { richSunset } from "../color.js";
import { fibSpiral } from "../geometry.js";

export class HopfFibration {
    constructor() {
        this.numFibers = 200; // User requested: 12

        // Speeds
        this.flowSpeed = 10.0; // User requested: 20
        this.tumbleSpeed = 4;

        this.alpha = 0.4;
        this.scale = 1.4;

        // 4D Rotation params
        this.flowOffset = 0;
        this.tumbleAngleX = 0;
        this.tumbleAngleY = 0;
        this.twist = 0;

        // Initialize reusable arrays
        this.fibers = [];

        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'numFibers', 1, 400).step(1).name('Fiber Count').onChange(() => this.initFibers());
        this.gui.add(this, 'flowSpeed', -20, 20).name('Flow Speed');
        this.gui.add(this, 'tumbleSpeed', 0, 5).name('Tumble Speed');
        this.gui.add(this, 'twist', 0, Math.PI * 4).name('Twist');
        this.gui.add(this, 'scale', 0.1, 5).name('Scale');
        this.gui.add(this, 'alpha', 0, 1).name('Opacity');

        // Add Color Cycle control
        this.colorRepeat = 3.0; // Multiple cycles per ring
        this.gui.add(this, 'colorRepeat', 1, 20).step(0.5).name('Color Cycles');

        // Use a longer lifespan for trails
        // Increase capacity to handle high fiber counts (200000 points)
        this.pipeline = createRenderPipeline(
            new FilterDecay(40, 200000),
            new FilterAntiAlias()
        );

        // Ensure fibers are initialized immediately
        this.initFibers();
    }

    initFibers() {
        this.fibers = [];

        // Use a grid-based approach instead of fibSpiral to align fibers
        // We map S2 (base space) using latitude (theta) and longitude (phi)

        // Determine grid dimensions based on numFibers approximation
        const side = Math.ceil(Math.sqrt(this.numFibers));
        const rings = side;
        const perRing = Math.ceil(this.numFibers / rings);

        for (let i = 0; i < rings; i++) {
            // Latitude from 0 to PI 
            // Using offset to avoid poles where fibers might degenerate or overlap perfectly
            const theta = Math.PI * (i + 0.5) / rings;

            // Y-UP Convention for Init
            const y = Math.cos(theta); // Up axis
            const r = Math.sin(theta); // Radius of ring at this latitude

            for (let j = 0; j < perRing; j++) {
                const phi = 2 * Math.PI * j / perRing;

                const x = r * Math.cos(phi);
                const z = r * Math.sin(phi);

                // Use new THREE.Vector3 instead of vectorPool for persistent storage
                const v = new THREE.Vector3(x, y, z);
                this.fibers.push(v);
            }
        }
    }

    drawFrame(pixels) {
        // Render Trails first
        this.pipeline.trail((x, y, t) => {
            // t goes 0 (new) -> 1 (old) in FilterDecay (based on implementation reading?)
            // Wait, Implementation: t = 1.0 - (ttl / lifespan)
            // age=0 -> ttl=lifespan -> t=0.
            // ttl=0 -> t=1.
            // Let's fade alpha and shift color
            const c = richSunset.get(t);
            c.a *= (1 - t); // Fade out as it gets older
            return c;
        }, this.alpha);

        // Advance time parameters
        this.flowOffset += 0.02 * this.flowSpeed * 0.2; // Adjusted speed for dots

        // Tumble rotation
        this.tumbleAngleX += 0.003 * this.tumbleSpeed;
        this.tumbleAngleY += 0.005 * this.tumbleSpeed;

        const allPoints = [];

        // Precompute tumble rotation terms
        const cx = Math.cos(this.tumbleAngleX);
        const sx = Math.sin(this.tumbleAngleX);
        const cy = Math.cos(this.tumbleAngleY);
        const sy = Math.sin(this.tumbleAngleY);

        // Folding animation base
        const foldBase = Math.sin(this.tumbleAngleX * 0.5) * 0.5;

        for (let i = 0; i < this.fibers.length; i++) {
            const base = this.fibers[i];

            // Hopf fiber parameters
            // S2 base coordinates
            // Y is up-axis
            const theta = Math.acos(base.y);
            let phi = Math.atan2(base.z, base.x);

            // Folding/Breathing
            let eta = theta / 2;
            const folding = Math.sin(phi * 2 + this.tumbleAngleY + foldBase) * 0.1 * this.tumbleSpeed;
            eta += folding;

            // Apply Twist
            phi += eta * this.twist;

            // DOT GENERATION: Only one point per fiber
            // beta travels along the fiber loop
            const phase = i * (Math.PI / this.fibers.length);
            const beta = this.flowOffset + phase;

            // 1. Construct point on S3 (Hopf inverse)
            // z0 = cos(eta) * e^(i(phi+beta))
            // z1 = sin(eta) * e^(i(beta))
            let q0 = Math.cos(eta) * Math.cos(phi + beta);
            let q1 = Math.cos(eta) * Math.sin(phi + beta);
            let q2 = Math.sin(eta) * Math.cos(beta);
            let q3 = Math.sin(eta) * Math.sin(beta);

            // 2. Apply Tumble (Global 4D Rotation)
            // R_xw
            const q0_r = q0 * cx - q3 * sx;
            const q3_r = q0 * sx + q3 * cx;
            q0 = q0_r; q3 = q3_r;

            // R_yz
            const q1_r = q1 * cy - q2 * sy;
            const q2_r = q1 * sy + q2 * cy;
            q1 = q1_r; q2 = q2_r;

            // 3. Stereographic Projection S3 -> R3
            const div = 1.001 - q3;
            const factor = 1 / div;
            const x = q0 * factor;
            const y = q1 * factor;
            const z = q2 * factor;

            const v = vectorPool.acquire();
            v.set(x, y, z).multiplyScalar(this.scale);

            // Set Color for key point
            const c = richSunset.get(0);
            c.a = this.alpha;

            // DRAW LINE from previous position if available (Continuous Trail)
            if (this.prevPositions && this.prevPositions[i]) {
                const prev = this.prevPositions[i];
                // Check if jump is too large (wrapping)? Usually S3 flows smoothly.
                // Just draw line.
                // We utilize rasterize to draw the segment with proper interpolation if needed,
                // or just straight line dots. 
                // Using rasterize with 2 points creates a line.

                const segmentPoints = [prev, v];
                const segmentDots = rasterize(segmentPoints, (p, t) => {
                    return c;
                }, false);
                allPoints.push(...segmentDots);
            } else {
                // First frame or reset, just draw dot
                allPoints.push({
                    position: v,
                    color: c,
                    alpha: 1.0
                });
            }

            // Store current position for next frame
            if (!this.prevPositions) this.prevPositions = [];

            // MUST CLONE because v is from vectorPool and will be recycled
            if (this.prevPositions[i]) {
                this.prevPositions[i].copy(v);
            } else {
                this.prevPositions[i] = v.clone();
            }
        }

        plotDots(pixels, this.pipeline, allPoints, 0, 1);
    }
}
