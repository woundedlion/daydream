/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "../gui.js";
import { Daydream } from "../driver.js";
import { Scan } from "../draw.js";
import { richSunset } from "../color.js";
import {
    Timeline,
    OrientationTrail,
    Rotation,
    Transition,
    MutableNumber,
    easeMid,
    easeInOutSin
} from "../animation.js";
import { Orientation } from "../geometry.js";
import { createRenderPipeline } from "../filters.js";

// --- Math Helpers ---

const factorial = (n) => {
    if (n <= 1) return 1;
    let result = 1;
    for (let i = 2; i <= n; i++) result *= i;
    return result;
}

const associatedLegendre = (l, m, x) => {
    // P_l^m(x) implementation
    // m must be non-negative here for standard recurrence relations
    // We handle negative m in the main function
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
    // theta: azimuth [0, 2PI] (using phi in physics convention)
    // phi: polar angle [0, PI] (theta in physics convention)
    // Three.js spherical: theta = equator angle, phi = pole angle
    // Standard SH: Y_l^m(theta, phi). theta [0, PI], phi [0, 2PI]
    // Mapping:
    // Physics theta (polar) <-> Three phi
    // Physics phi (azimuth) <-> Three theta

    // We only need the real form (tesseral spherical harmonics) for visualization
    // Y_{lm} = N * P_l^m(cos(theta)) * { cos(m*phi) if m>0, 1 if m=0, sin(|m|*phi) if m<0 }

    let absM = Math.abs(m);
    // Normalization constant
    const N = Math.sqrt(((2 * l + 1) / (4 * Math.PI)) * (factorial(l - absM) / factorial(l + absM)));

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
            mode: 6, // Start at l=2, m=0 -> index = 4 + 2 = 6
            amplitude: 3.2
        };

        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.params, 'amplitude', 0, 5).name('Gain');
        // Max mode for l=10 is (10+1)^2 - 1 = 120
        this.gui.add(this.params, 'mode', 0, 120).step(1).name('Harmonic Mode');

        // Setup Animation
        this.timeline = new Timeline();
        this.orientation = new Orientation();

        // 1. Rotate Camera continuously
        const axis = new THREE.Vector3(0.5, 1, 0.2).normalize();
        this.timeline.add(0, new Rotation(this.orientation, axis, Math.PI * 2 * 100, 10000, easeMid, true));
    }

    drawFrame() {
        this.timeline.step();

        // Map mode index to (l, m)
        // Shell l starts at index l^2
        // Length of shell is 2l + 1
        const idx = Math.floor(this.params.mode);
        const l = Math.floor(Math.sqrt(idx));
        const m = idx - l * l - l;

        // Inverse rotation for "Camera" effect
        const invQ = this.orientation.get().clone().invert();

        const pipeline = createRenderPipeline();

        Scan.Field.draw(pipeline, Daydream.pixels, (p) => {
            // 1. Rotate domain
            const v = p.clone().applyQuaternion(invQ);

            // 2. Convert to spherical
            const r = 1; // unit sphere
            const phi = Math.acos(Math.max(-1, Math.min(1, v.y))); // 0 to PI
            const theta = Math.atan2(v.z, v.x); // -PI to PI

            // 3. Compute Value
            let val = sphericalHarmonic(l, m, theta, phi);

            val = Math.abs(val) * this.params.amplitude;

            // 4. Map to color
            // Use value as palette index (0 to 1)
            // Normalize roughly? SH values can be > 1.
            // Tanh mapping for soft clamp
            const t = Math.tanh(val);

            const colorResult = richSunset.get(t);
            // Apply alpha based on value magnitude to hide "nodes" (zeros)
            return {
                color: colorResult.color,
                alpha: Math.min(1, val * 2)
            };
        });
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
