
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
        this.numFibers = 12; // User requested: 12
        this.pointsPerFiber = 80;

        // Speeds
        this.flowSpeed = 20.0; // User requested: 20
        this.tumbleSpeed = 4;

        this.alpha = 0.6;
        this.scale = 1.4;

        // 4D Rotation params
        this.flowOffset = 0;
        this.tumbleAngleX = 0;
        this.tumbleAngleY = 0;
        this.twist = 0;

        // Initialize reusable arrays
        this.fibers = [];

        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'numFibers', 1, 200).step(1).name('Fiber Count').onChange(() => this.initFibers());
        this.gui.add(this, 'pointsPerFiber', 3, 200).step(1).name('Res / Fiber');
        this.gui.add(this, 'flowSpeed', -20, 20).name('Flow Speed');
        this.gui.add(this, 'tumbleSpeed', 0, 5).name('Tumble Speed');
        this.gui.add(this, 'twist', 0, Math.PI * 4).name('Twist');
        this.gui.add(this, 'scale', 0.1, 5).name('Scale');
        this.gui.add(this, 'alpha', 0, 1).name('Opacity');

        // Add Color Cycle control
        this.colorRepeat = 3.0;
        this.gui.add(this, 'colorRepeat', 1, 20).step(0.5).name('Color Cycles');

        this.pipeline = createRenderPipeline(
            new FilterDecay(),
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
        // Advance time parameters
        this.flowOffset += 0.01 * this.flowSpeed;

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

            // Folding/Breathing: Modulate eta (aperture)
            // Reduced amplitude to default to "aligned" look
            let eta = theta / 2;
            const folding = Math.sin(phi * 2 + this.tumbleAngleY + foldBase) * 0.1 * this.tumbleSpeed;
            // Only apply folding if we want it? For now, keep it subtle.
            eta += folding;

            // Apply Twist: Rotate fiber identity (phi) based on latitude
            phi += eta * this.twist;

            const fiberPhase = i * 0.1;
            const fiberPoints = [];

            // Normalize flow for coloring
            const flowT = (this.flowOffset / (2 * Math.PI));

            const step = (2 * Math.PI) / this.pointsPerFiber;

            for (let j = 0; j < this.pointsPerFiber; j++) {
                // beta travels along the fiber loop
                const phase = i * (Math.PI / this.fibers.length);
                const beta = j * step + this.flowOffset + phase;

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

                // We do NOT store _t here anymore because rasterize() does not preserve it.
                fiberPoints.push(v);
            }

            // Rasterize this fiber
            // colorFn receives (point, t_interp) where t_interp is 0..1 along the fiber path
            const colorFn = (p, t_interp) => {
                // t_interp corresponds to the position along the fiber [0, 1]

                // MULTIPLIER: Creates multiple "runs" of the palette per ring
                // OFFSET: Re-adding flowOffset causes the pattern to slide/drip along the ring
                // even as the physical ring rotates.
                const stretch = t_interp + Math.sin(t_interp * Math.PI * 2) * 0.1;
                // Add flowOffset * 0.2 to create the drift/drip effect
                const tRaw = stretch * this.colorRepeat + this.flowOffset * 0.2 + i * 0.1;

                let t = tRaw % 1;
                if (t < 0) t += 1;

                const c = richSunset.get(t);
                c.a = this.alpha;
                return c;
            };

            const dots = rasterize(fiberPoints, colorFn, true);
            allPoints.push(...dots);
        }

        plotDots(pixels, this.pipeline, allPoints, 0, 1);
    }
}
