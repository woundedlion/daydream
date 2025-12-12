
import * as THREE from "three";
import { Daydream } from "../driver.js";
import FastNoiseLite from "../FastNoiseLite.js";
import {
    randomVector, Dot
} from "../geometry.js";
import {
    DecayBuffer
} from "../draw.js";
import {
    GenerativePalette
} from "../color.js";
import {
    Timeline, easeMid, PeriodicTimer, ColorWipe
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias
} from "../filters.js";

/**
 * FlowField Effect
 * * This effect simulates a particle system where each particle is pushed
 * across the sphere's surface by an evolving 4D Perlin noise field.
 * A gentle gravity-like force, similar to the one in your MetaballEffect,
 * keeps the particles from flying off, ensuring smooth, orbital motion.
 */
export class FlowField {

    // A simple class to hold particle state
    static Particle = class {
        constructor() {
            this.pos = randomVector();
            this.vel = new THREE.Vector3(0, 0, 0);
        }
    }

    constructor() {
        this.pixels = new Map();
        this.timeline = new Timeline();

        // --- Configuration ---
        this.NUM_PARTICLES = 250;      // Total number of particles (Was 1000)
        this.NOISE_SCALE = 1.5;
        this.TIME_SCALE = 0.01;
        this.FORCE_SCALE = 0.002;
        this.GRAVITY = 0.001;
        this.MAX_SPEED = 0.05;
        this.TRAIL_LENGTH = 12; // Length of the trail (Was 8)

        // --- Palette ---
        this.palette = new GenerativePalette("straight", "analogous", "ascending");

        // --- State ---
        this.particles = [];
        this.noise = new FastNoiseLite();
        this.noise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
        this.t = 0;

        // --- Filters ---
        this.trails = new DecayBuffer(this.TRAIL_LENGTH);
        this.filters = createRenderPipeline(
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
        this.pixels.clear();
        this.timeline.step();
        this.t += this.TIME_SCALE;

        const dots = [];

        for (const p of this.particles) {
            // 1. Calculate Noise Force (Flow Field)
            // We sample 4D noise using the particle's 3D position and time.
            // We need 3 components for the force vector.
            const fx = this.noise.GetNoise(p.pos.x * this.NOISE_SCALE, p.pos.y * this.NOISE_SCALE, p.pos.z * this.NOISE_SCALE + this.t) * this.FORCE_SCALE;
            const fy = this.noise.GetNoise(p.pos.x * this.NOISE_SCALE + 100, p.pos.y * this.NOISE_SCALE, p.pos.z * this.NOISE_SCALE + this.t) * this.FORCE_SCALE;
            const fz = this.noise.GetNoise(p.pos.x * this.NOISE_SCALE + 200, p.pos.y * this.NOISE_SCALE, p.pos.z * this.NOISE_SCALE + this.t) * this.FORCE_SCALE;
            const force = new THREE.Vector3(fx, fy, fz);

            // 2. Apply Gravity (Keep on Sphere)
            // Pull towards the center to counteract the noise pushing it off.
            const gravity = p.pos.clone().multiplyScalar(-this.GRAVITY);
            force.add(gravity);

            // 3. Update Velocity
            p.vel.add(force);
            p.vel.clampLength(0, this.MAX_SPEED); // Limit speed

            // 4. Update Position
            p.pos.add(p.vel);
            p.pos.normalize(); // Snap back to sphere surface exactly

            // 5. Create Dot for Rendering
            // Color based on velocity direction or position? Let's use position for a nice gradient.
            // We can map the position to a 0-1 value for the palette.
            // Let's use the Y coordinate (poles) for variation.
            const paletteT = (p.pos.y + 1) / 2;
            dots.push(new Dot(p.pos.clone(), this.palette.get(paletteT)));
        }

        // 6. Render with Trails
        this.trails.recordDots(dots, 0, 0.8); // 0.8 opacity
        this.trails.render(this.pixels, this.filters, (v, t) => this.palette.get(t)); // Color decay

        return this.pixels;
    }
}
