/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import * as THREE from "three";
import { Daydream, pixelKey } from "../driver.js";
import {
    pixelToVector
} from "../geometry.js";
import { vectorPool } from "../memory.js";
import {
    Palettes
} from "../palettes.js";
import { gui } from "../gui.js";

/**
 * Metaballs Effect (V5: Smooth Orbital Physics)
 * * Uses a central gravity force for smooth, "soft" containment
 * * instead of a jerky "hard" bounce.
 */
export class MetaballEffect {
    constructor() {
        this.palette = Palettes.richSunset;
        this.t = 0;

        // --- Tunable Knobs ---
        this.maxInfluence = 10.0;
        this.gravity = 0.005;
        this.numBalls = 16;
        this.radiusScale = 1.0;
        this.velocityScale = 1.0;

        this.balls = [];

        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'maxInfluence', 1.0, 50.0).name('Influence Falloff');
        this.gui.add(this, 'gravity', 0.0001, 0.05).name('Gravity');
        this.gui.add(this, 'numBalls', 1, 50).step(1).name('Ball Count').onChange(() => this.initBalls());
        this.gui.add(this, 'radiusScale', 0.1, 3.0).name('Size Scale').onChange(() => this.initBalls());
        this.gui.add(this, 'velocityScale', 0.1, 5.0).name('Speed Scale').onChange(() => this.initBalls());

        this.initBalls();
    }

    initBalls() {
        this.balls = [];
        for (let i = 0; i < this.numBalls; i++) {
            const rand = (min, max) => Math.random() * (max - min) + min;

            this.balls.push({
                p: new THREE.Vector3(
                    rand(-0.5, 0.5),
                    rand(-0.5, 0.5),
                    rand(-0.5, 0.5)
                ),
                r: rand(0.5, 0.8) * this.radiusScale,
                v: new THREE.Vector3(
                    rand(-0.02, 0.08) * this.velocityScale,
                    rand(-0.02, 0.08) * this.velocityScale,
                    rand(-0.02, 0.08) * this.velocityScale
                )
            });
        }
    }

    drawFrame() {
        this.t++;

        // 1. Animate the balls
        // 1. Animate the balls
        for (const ball of this.balls) {
            const F = vectorPool.acquire().copy(ball.p).multiplyScalar(-this.gravity);
            ball.v.add(F);
            ball.p.add(ball.v);
        }

        // 2. Iterate *every single pixel* on the sphere's surface
        for (let x = 0; x < Daydream.W; x++) {
            for (let y = 0; y < Daydream.H; y++) {

                // Get the 3D position of this pixel
                const v = Daydream.pixelPositions[y * Daydream.W + x];

                let sum = 0.0;

                // 3. Sum the influence from all 16 balls
                for (const ball of this.balls) {
                    // Get squared distance (faster, no sqrt) from pixel to ball
                    const distSq = v.distanceToSquared(ball.p);

                    // The metaball function: r^2 / d^2
                    sum += (ball.r * ball.r) / distSq;
                }

                // 4. Map the total influence to a palette coordinate
                const palette_t = Math.min(1.0, sum / this.maxInfluence);

                // 5. Get the color and plot the dot
                const color = this.palette.get(palette_t); //

                // Write directly to global buffer
                // TODO: Optimization - precalc index
                // Write directly to global buffer
                // TODO: Optimization - precalc index
                let index = (y * Daydream.W + x) * 3;
                Daydream.pixels[index] = color.color.r;
                Daydream.pixels[index + 1] = color.color.g;
                Daydream.pixels[index + 2] = color.color.b;
            }
        }
    }
}

