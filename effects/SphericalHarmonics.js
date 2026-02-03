/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { TWO_PI } from "../3dmath.js";
import { gui } from "../gui.js";
import { Daydream } from "../driver.js";
import { Scan } from "../scan.js";

import { Palettes } from "../palettes.js";
import {
    Timeline,
    OrientationTrail,
    Rotation,
    Orientation
} from "../animation.js";
import { easeMid, easeInOutSin } from "../easing.js";
import { quaternionPool, vectorPool } from "../memory.js";
import { createRenderPipeline } from "../filters.js";

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

        const invQ = quaternionPool.acquire().copy(this.orientation.get()).invert();

        const pipeline = createRenderPipeline();

        Scan.Field.draw(pipeline, (p) => {
            const v = vectorPool.acquire().copy(p).applyQuaternion(invQ);
            const phi = Math.acos(Math.max(-1, Math.min(1, v.y)));
            const theta = Math.atan2(v.z, v.x);
            let val = sphericalHarmonic(l, m, theta, phi);
            val = Math.abs(val) * this.params.amplitude;
            const t = Math.tanh(val);
            const colorResult = Palettes.richSunset.get(t);
            colorResult.alpha = Math.min(1, val * 2);
            return colorResult;
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
