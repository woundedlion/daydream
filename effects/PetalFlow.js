/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * LICENSE: ALL RIGHTS RESERVED. No redistribution or use without explicit permission.
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { sinWave } from "../geometry.js";
import { Mutation, Rotation, Timeline, Orientation } from "../animation.js";
import { easeMid } from "../easing.js";
import { ProceduralPalette } from "../color.js";
import { createRenderPipeline, FilterOrient, FilterAntiAlias } from "../filters.js";
import { Plot } from "../plot.js";
import { invStereo, TWO_PI } from "../3dmath.js";
import { wrap } from "../util.js";
import { fragmentPool, color4Pool } from "../memory.js";

export class PetalFlow {
    constructor() {
        this.alpha = 0.2;
        this.spacing = 0.3;
        this.twistFactor = 2.15;
        this.speed = 8.0;

        this.palette = new ProceduralPalette(
            [0.029, 0.029, 0.029],
            [0.500, 0.500, 0.500],
            [0.461, 0.461, 0.461],
            [0.539, 0.701, 0.809]
        );

        this.orientation = new Orientation();
        this.filters = createRenderPipeline(
            new FilterOrient(this.orientation),
            new FilterAntiAlias()
        );
        this.timeline = new Timeline();
        this.timeline.add(0, new Rotation(this.orientation, Daydream.Y_AXIS, Math.PI / 4, 160, easeMid, true));
        this.timeline.add(0, new Mutation(this, 'twistFactor', sinWave(2.0, 2.5, 1, 0), 160, easeMid, true));
        this.setupGui();
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
        this.gui.add(this, 'speed').min(1).max(200).step(1).name('Flow Speed');
    }

    drawPetals(loopCount, loopT) {
        const logMin = -3.75;
        const logMax = 3.75;
        const currentSpacing = this.spacing;

        const minK = Math.floor(logMin / currentSpacing) - 1;
        const maxK = Math.ceil(logMax / currentSpacing) + 1;
        const progress = loopT / currentSpacing;

        const getShift = (angleNormal) => {
            return 0.6 * Math.abs(Math.sin(3 * Math.PI * angleNormal));
        };

        const numSamples = Daydream.W;
        const step = TWO_PI / numSamples;

        for (let k = minK; k <= maxK; k++) {
            const logR = k * currentSpacing;
            const effectiveLogR = logR + loopT;

            const dist = Math.abs(effectiveLogR);
            let opacity = 1.0;
            if (dist > 2.5) opacity = Math.max(0, 1.0 - (dist - 2.5) / 1.0);
            if (opacity <= 0.01) continue;

            const twistAngle = (k + progress) * this.twistFactor;

            // Rasterize & Color
            const colorIndex = (k - loopCount) + 10000;
            const hue = wrap(colorIndex * 0.13, 1.0);
            const color = this.palette.get(hue).color;

            const points = [];
            let prevPos = null;

            // Generate Ring directly in Complex Plane
            for (let i = 0; i < numSamples; i++) {
                const t = i / numSamples;
                const theta = i * step;

                // Apply Petal Wiggle to the Radius (rho)
                const rho = effectiveLogR + getShift(t);
                const finalTheta = theta + twistAngle;

                // Convert to Complex Number z = e^(rho + i*theta)
                const R = Math.exp(rho);
                const z = {
                    re: R * Math.cos(finalTheta),
                    im: R * Math.sin(finalTheta)
                };
                const pos = this.orientation.orient(invStereo(z));
                const frag = fragmentPool.acquire();
                frag.pos.copy(pos);
                frag.v0 = t;

                if (i > 0) {
                    Plot.rasterize(this.filters, [prevPos, frag], (p, f) => {
                        const alpha = this.alpha * opacity;
                        return color4Pool.acquire().set(color, alpha);
                    }, false);
                } else {
                    this.filters.plot(pos, color, 0, this.alpha * opacity);
                }
                prevPos = frag;
            }
        }
    }

    drawFrame() {
        this.timeline.step();
        const time = (performance.now() / 1000.0) * (this.speed * 0.015);
        const loopCount = Math.floor(time / this.spacing);
        const loopT = time % this.spacing;
        this.drawPetals(loopCount, loopT);
    }
}