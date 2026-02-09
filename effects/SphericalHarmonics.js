/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { TWO_PI } from "../3dmath.js";
import { gui } from "../gui.js";
import { Daydream } from "../driver.js";
import { Scan, SDF } from "../scan.js";
import { quinticKernel } from "../filters.js";

import { Palettes } from "../palettes.js";
import {
    Timeline,
    Rotation,
    Orientation
} from "../animation.js";
import { easeMid } from "../easing.js";
import { quaternionPool } from "../memory.js"; // vectorPool removed (using local scratch)
import { createRenderPipeline } from "../filters.js";
import { smoothstep } from "../util.js";

const factorial = (n) => {
    if (n <= 1) return 1;
    let result = 1;
    for (let i = 2; i <= n; i++) result *= i;
    return result;
}

const associatedLegendre = (l, m, x) => {
    let pmm = 1.0;
    if (m > 0) {
        const somx2 = Math.sqrt((1.0 - x) * (1.0 + x));
        let fact = 1.0;
        for (let i = 1; i <= m; i++) {
            pmm *= -fact * somx2;
            fact += 2.0;
        }
    }
    if (l === m) return pmm;

    let pmmp1 = x * (2.0 * m + 1.0) * pmm;
    if (l === m + 1) return pmmp1;

    let pll = 0;
    for (let ll = m + 2; ll <= l; ll++) {
        pll = ((2.0 * ll - 1.0) * x * pmmp1 - (ll + m - 1.0) * pmm) / (ll - m);
        pmm = pmmp1;
        pmmp1 = pll;
    }
    return pll;
}

const sphericalHarmonic = (l, m, theta, phi) => {
    let absM = Math.abs(m);
    const N = Math.sqrt(((2 * l + 1) / (2 * TWO_PI)) * (factorial(l - absM) / factorial(l + absM)));
    const P = associatedLegendre(l, absM, Math.cos(phi));

    if (m > 0) {
        return Math.sqrt(2) * N * P * Math.cos(m * theta);
    } else if (m < 0) {
        return Math.sqrt(2) * N * P * Math.sin(absM * theta);
    } else {
        return N * P;
    }
}

export class SphericalHarmonics {
    constructor() {
        this.params = {
            mode: 6,
            amplitude: 3.2
        };
        this.pipeline = createRenderPipeline();

        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.params, 'amplitude', 0, 5).name('Gain');
        this.gui.add(this.params, 'mode', 0, 120).step(1).name('Harmonic Mode');

        this.timeline = new Timeline();
        this.orientation = new Orientation();

        const axis = new THREE.Vector3(0.5, 1, 0.2).normalize();
        this.timeline.add(0, new Rotation(this.orientation, axis, TWO_PI * 100, 10000, easeMid, true));
    }

    drawFrame() {
        this.timeline.step();

        const idx = Math.floor(this.params.mode);
        const l = Math.floor(Math.sqrt(idx));
        const m = idx - l * l - l;
        const absM = Math.abs(m);

        // 1. Pre-calculate N (Optimization)
        const N = Math.sqrt(((2 * l + 1) / (2 * TWO_PI)) * (factorial(l - absM) / factorial(l + absM)));

        const fastHarmonic = (l, m, theta, phi) => {
            const P = associatedLegendre(l, absM, Math.cos(phi));
            if (m > 0) return Math.sqrt(2) * N * P * Math.cos(m * theta);
            if (m < 0) return Math.sqrt(2) * N * P * Math.sin(absM * theta);
            return N * P;
        };

        // 2. Create the Blob
        const blob = new SDF.HarmonicBlob(
            l,
            m,
            this.params.amplitude,
            this.orientation.get(),
            fastHarmonic
        );

        // 3. "Digital Twin" Fragment Shader
        // out.rawDist contains the signed harmonic value (-Infinity to +Infinity)
        const fragmentShader = (pos, frag) => {
            const val = frag.rawDist; // The raw math value
            const absVal = Math.abs(val);
            const t = frag.v0;

            // A. Dual-Tone Coloring
            // Use standard sunset for Positive Lobes, Synthesize "Ice" for Negative
            let base;
            if (val >= 0) {
                base = Palettes.richSunset.get(t); // Gold/Red
            } else {
                // Swap channels to create a complementary Ice/Blue palette
                const p = Palettes.richSunset.get(t);
                base = color4Pool.acquire();
                base.color.setRGB(p.color.b, p.color.g * 0.8, p.color.r); // Blue-ish
                base.alpha = p.alpha;
            }

            // B. Ambient Occlusion (The "Pretty Darkening")
            // Darken the "valleys" where the shape is close to the unit sphere (val ~ 0).
            // This creates deep shadows between the lobes.
            const shadow = smoothstep(0.0, 0.4, absVal * this.params.amplitude);
            const occlusion = 0.15 + 0.85 * shadow;

            // Apply shadow
            base.color.multiplyScalar(occlusion);

            // C. Highlight Tips
            // Add a specular pop to the very tips of the lobes
            if (t > 0.9) {
                base.color.addScalar(0.15 * (t - 0.9) * 10);
            }

            frag.color = base;
        };

        Scan.rasterize(this.pipeline, blob, fragmentShader);
    }

    getLabels() {
        const idx = Math.floor(this.params.mode);
        const l = Math.floor(Math.sqrt(idx));
        const m = idx - l * l - l;
        return [
            { position: new THREE.Vector3(0, 1.2, 0), content: `Y_{${l}}^{${m}}` },
            { position: new THREE.Vector3(0, 1.1, 0), content: `l=${l}, m=${m}` }
        ];
    }
}
