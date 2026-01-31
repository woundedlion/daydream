/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import * as THREE from "three";
import { Daydream } from "../driver.js";
import FastNoiseLite from "../FastNoiseLite.js";
import {
    randomVector, Dot
} from "../geometry.js";
import { vectorPool } from "../memory.js";
import {
    GenerativePalette
} from "../color.js";
import {
    Timeline, PeriodicTimer, ColorWipe
} from "../animation.js";
import { easeMid } from "../easing.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterWorldTrails
} from "../filters.js";

/**
 * FlowField Effect
 * * This effect simulates a particle system where each particle is pushed
 * across the sphere's surface by an evolving 4D Perlin noise field.
 */
export class FlowField {

    // A simple class to hold particle state
    static Particle = class {
        constructor() {
            this.pos = new THREE.Vector3().copy(randomVector());
            this.vel = new THREE.Vector3(0, 0, 0);
        }
    }

    constructor() {
        this.timeline = new Timeline();

        // --- Configuration ---
        this.NUM_PARTICLES = 600;      // Increased for better density
        this.NOISE_SCALE = 2.0;       // Higher frequency for more swirls
        this.TIME_SCALE = 0.005;      // Slower evolution
        this.FORCE_SCALE = 0.005;     // Stronger force to counteract friction
        this.MAX_SPEED = 0.03;        // Controlled speed
        this.TRAIL_LENGTH = 14;

        // --- Palette ---
        this.palette = new GenerativePalette("straight", "analogous", "ascending");

        // --- State ---
        this.particles = [];
        this.noise = new FastNoiseLite();
        this.noise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
        this.t = 0;

        // --- Filters ---
        this.filters = createRenderPipeline(
            new FilterWorldTrails(this.TRAIL_LENGTH),
            new FilterAntiAlias()
        );

        // --- Initialize Particles ---
        for (let i = 0; i < this.NUM_PARTICLES; i++) {
            this.particles.push(new FlowField.Particle());
        }

        // --- Animation: Periodically change the palette ---
        this.timeline.add(0,
            new PeriodicTimer(200, () => {
                this.updatePalette();
            }, true)
        );
    }

    updatePalette() {
        this.nextPalette = new GenerativePalette("straight", "analogous", "ascending");
        this.timeline.add(0,
            new ColorWipe(this.palette, this.nextPalette, 48, easeMid)
        );
    }

    drawFrame() {
        this.timeline.step();
        this.t += this.TIME_SCALE;

        for (const p of this.particles) {
            // 1. Calculate Noise Force (Flow Field)
            // 4D noise: x, y, z, t
            const fx = this.noise.GetNoise(p.pos.x * this.NOISE_SCALE, p.pos.y * this.NOISE_SCALE, p.pos.z * this.NOISE_SCALE + this.t) * this.FORCE_SCALE;
            const fy = this.noise.GetNoise(p.pos.x * this.NOISE_SCALE + 100, p.pos.y * this.NOISE_SCALE, p.pos.z * this.NOISE_SCALE + this.t) * this.FORCE_SCALE;
            const fz = this.noise.GetNoise(p.pos.x * this.NOISE_SCALE + 200, p.pos.y * this.NOISE_SCALE, p.pos.z * this.NOISE_SCALE + this.t) * this.FORCE_SCALE;
            const force = vectorPool.acquire().set(fx, fy, fz);

            // 2. Update Velocity with Damping (Friction)
            p.vel.add(force);
            p.vel.multiplyScalar(0.96); // Friction prevents runaway speed
            p.vel.clampLength(0, this.MAX_SPEED);

            // 3. Update Position
            p.pos.add(p.vel);
            p.pos.normalize(); // Snap back to sphere

            // 4. Respawn Logic (Prevent sinks/clumping)
            if (Math.random() < 0.005) {
                p.pos.copy(randomVector());
                p.vel.set(0, 0, 0);
            }

            // 5. Create Dot
            // Map Y (-1 to 1) to (0 to 1) for palette
            const paletteT = (p.pos.y + 1) / 2;
            const color = this.palette.get(paletteT);

            // 6. Draw directly to pipeline (Head)
            this.filters.plot(p.pos, color, 0, 0.8);
        }

        // 7. Draw Trails
        this.filters.trail((v, t) => this.palette.get(t));
    }
}
