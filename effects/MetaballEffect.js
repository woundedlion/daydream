
import * as THREE from "three";
import { Daydream, pixelKey } from "../driver.js";
import {
    pixelToVector
} from "../geometry.js";
import {
    richSunset
} from "../color.js";

/**
 * Metaballs Effect (V5: Smooth Orbital Physics)
 * * Uses a central gravity force for smooth, "soft" containment
 * * instead of a jerky "hard" bounce.
 */
export class MetaballEffect {
    constructor() {
        this.pixels = new Map();
        this.palette = richSunset;
        this.t = 0;

        // --- Tunable Knobs ---
        this.maxInfluence = 10.0;
        this.gravity = 0.005; // New knob: How strong is the pull to the center?

        // --- Define our 16 Metaballs ---
        this.balls = [];
        const NUM_BALLS = 16;

        for (let i = 0; i < NUM_BALLS; i++) {
            const rand = (min, max) => Math.random() * (max - min) + min;

            this.balls.push({
                p: new THREE.Vector3(
                    rand(-0.5, 0.5), // Random start position
                    rand(-0.5, 0.5),
                    rand(-0.5, 0.5)
                ),
                r: rand(0.5, 0.8), // Bigger radius
                v: new THREE.Vector3(
                    rand(-0.02, 0.08), // Slightly faster velocity
                    rand(-0.02, 0.08),
                    rand(-0.02, 0.08)
                )
            });
        }
    }

    drawFrame() {
        this.pixels.clear();
        this.t++;

        // 1. Animate the balls
        for (const ball of this.balls) {

            // --- THIS IS THE NEW LOGIC ---
            // 1. Apply a "gravity" force pulling the ball toward the center (0,0,0)
            //    We do this by adding a tiny, inverted copy of its position to its velocity.
            ball.v.add(ball.p.clone().multiplyScalar(-this.gravity));

            // 2. Apply the (now gravity-affected) velocity to the position
            ball.p.add(ball.v); //

        }

        // 2. Iterate *every single pixel* on the sphere's surface
        for (let x = 0; x < Daydream.W; x++) {
            for (let y = 0; y < Daydream.H; y++) {

                // Get the 3D position of this pixel
                const v = pixelToVector(x, y); //

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
                this.pixels.set(pixelKey(x, y), color); //
            }
        }

        return this.pixels;
    }
}
