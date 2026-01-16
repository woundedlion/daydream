/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { GenerativePalette } from "../color.js";
import { Timeline, MutableNumber, Mutation, easeMid } from "../animation.js";

export class MobiusGradient {
    constructor() {
        this.palette = new GenerativePalette("straight", "split-complementary", "descending");
        this.timeline = new Timeline();

        // The "offset" represents the position of the sphere relative to the plane
        // as it moves.
        this.offset = new MutableNumber(0);
        this.animationSpeed = 0.01;

        // Animate offset continuously
        this.timeline.add(0,
            new Mutation(this.offset, (t, current) => current + this.animationSpeed, -1, easeMid, true)
        );

        this.setupGui();
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'animationSpeed', -0.1, 0.1).name('Speed');
        this.gui.add(this.offset, 'n').name('Warp Offset').step(0.01).listen();
    }

    // Transform t (0..1) using a stereographic translation logic.
    // This creates a "fast-slow-fast" movement effect as the texture slides across the sphere.
    warp(t, offset) {
        // 1. Map t [0, 1] to the infinite line [-Inf, Inf] via tan()
        // This corresponds to a Stereographic Projection from the sphere to a line.
        // t=0 (North) -> -Inf, t=0.5 (Equator) -> 0, t=1 (South) -> +Inf
        const z = Math.tan(t * Math.PI - Math.PI / 2);

        // 2. Apply Translation in the projected space
        // We use tan(offset) to map the linear offset to a non-linear shift,
        // ensuring the animation loops visually as offset cycles.
        const cyclicShift = Math.tan(offset);
        const z_prime = z + cyclicShift;

        // 3. Map back to t [0, 1]
        return (Math.atan(z_prime) / Math.PI) + 0.5;
    }

    drawFrame() {
        this.timeline.step();

        const offset = this.offset.get();
        const count = Daydream.pixelPositions.length;

        for (let i = 0; i < count; i++) {
            const p = Daydream.pixelPositions[i];

            // 1. Calculate base N-S gradient t [0, 1]
            // Map y from [1, -1] to t [0, 1]
            const baseT = 1.0 - ((p.y + 1) / 2);

            // 2. Warp t to simulate movement
            const warpedT = this.warp(baseT, offset);

            // 3. Sample Palette
            const c = this.palette.get(warpedT);

            const stride = i * 3;
            Daydream.pixels[stride] = c.color.r;
            Daydream.pixels[stride + 1] = c.color.g;
            Daydream.pixels[stride + 2] = c.color.b;
        }
    }
}