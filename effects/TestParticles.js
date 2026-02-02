/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    MeshOps, mobiusTransform, angleBetween
} from "../geometry.js";
import { vectorPool, color4Pool } from "../memory.js";
import {
    richSunset, rainbow, lavenderLake, GenerativePalette
} from "../color.js";
import {
    Timeline, ParticleSystem, Sprite, RandomWalk, MobiusWarp, Orientation, RandomTimer
} from "../animation.js";
import { createRenderPipeline, FilterOrient, FilterAntiAlias, quinticKernel } from "../filters.js";
import { Plot } from "../plot.js";
import { MobiusParams } from "../3dmath.js";
import { Solids } from "../solids.js";

export class TestParticles {
    constructor() {
        this.friction = 0.85;
        this.wellStrength = 1.0;
        this.initialSpeed = 0.025;
        this.angularSpeed = 0.2;
        this.maxSpeed = 0;
        this.batchSize = Daydream.W;
        this.warpScale = 0.6;
        this.trailLength = 25;

        this.orientation = new Orientation();
        this.mobius = new MobiusParams();
        this.pipeline = createRenderPipeline(new FilterOrient(this.orientation), new FilterAntiAlias());

        this.timeline = new Timeline();
        this.timeline = new Timeline();
        this.particleSystem = new ParticleSystem(2000, this.friction, 0.001, this.trailLength);
        this.particleSystem.resolutionScale = 2;
        this.holeAlphasBuffer = [];
        this.timeline.add(0, this.particleSystem);
        this.timeline.add(0, new Sprite((opacity) => this.drawParticles(opacity), -1));
        this.timeline.add(0, new RandomWalk(this.orientation, Daydream.UP));

        this.enableWarp = true;
        if (this.enableWarp) this.startWarp();
        this.rebuild();
        this.setupGUI();
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.particleSystem, 'friction').min(0.8).max(1.0).step(0.001).name("Friction");
        this.gui.add(this.particleSystem, 'gravityScale').min(0.0001).max(0.01).step(0.0001).name("Gravity Scale");
        this.gui.add(this, 'initialSpeed').min(0.001).max(0.2).step(0.001).name("Initial Speed");
        this.gui.add(this, 'angularSpeed').min(0.001).max(1).step(0.001).name("Angular Speed");
        this.gui.add(this, 'trailLength').min(0).max(100).step(1).name("Trail Length");
        this.gui.add(this.particleSystem, 'timeScale').min(0.0).max(10.0).step(1).name("Time Scale");
        this.gui.add(this, 'wellStrength').min(0).max(10).step(0.1).name("Attractor Strength").onChange((v) => {
            for (const a of this.particleSystem.attractors) {
                a.strength = v;
            }
        });
        this.gui.add(this, 'maxSpeed').name("Max Speed").listen();
        this.gui.add(this, 'rebuild').name("Respawn");
        this.gui.add(this, 'enableWarp').name('Enable Warp').onChange(v => {
            if (v) this.startWarp(); else this.stopWarp();
        });
        this.gui.add(this, 'warpScale').min(0).max(5.0).step(0.1).name("Warp Intensity").onChange(v => {
            if (this.warpAnim) this.warpAnim.scale = v;
        });
    }

    startWarp() {
        this.stopWarp();
        this.scheduleWarp();
    }

    scheduleWarp() {
        this.warpTimer = new RandomTimer(180, 300, () => this.performWarp());
        this.timeline.add(0, this.warpTimer);
    }

    performWarp() {
        this.warpAnim = new MobiusWarp(this.mobius, 160, this.warpScale, false);
        this.warpAnim.then(() => this.scheduleWarp());
        this.timeline.add(0, this.warpAnim);
    }

    stopWarp() {
        if (this.warpAnim) this.warpAnim.cancel();
        if (this.warpTimer) this.warpTimer.cancel();
        this.mobius.reset();
    }

    rebuild() {
        this.spawnIndex = 0;
        this.particleSystem.reset(this.friction, 0.001, this.trailLength);

        const killRadius = 0.003;
        const eventHorizon = 0.2;

        let emitters = Solids.cube();
        this.emitCounters = [];
        for (let i = 0; i < emitters.vertices.length; i++) {
            this.emitCounters.push(0);
        }
        let attractors = MeshOps.dual(emitters);

        for (const v of attractors.vertices) {
            this.particleSystem.addAttractor(v, this.wellStrength, killRadius, eventHorizon);
        }

        for (let i = 0; i < emitters.vertices.length; i++) {
            this.particleSystem.addEmitter((system) => {
                const axis = emitters.vertices[i];
                const angle = this.emitCounters[i]++ * this.angularSpeed;
                const vel = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(this.initialSpeed);
                const palette = new GenerativePalette('straight', 'complementary', 'descending', 'mid');
                const life = 160;
                system.spawn(axis, vel, palette, life);
            });
        }
    }

    particleColor(p, t, holeAlphas) {
        const c = p.palette.get(t);
        let age = t * this.particleSystem.trailLength;
        let particleAgeAlpha = (Math.max(0, p.life) + age) / p.maxLife;
        let trailAgeAlpha = 1.0 - t;

        let holeAlpha = 1.0;
        if (holeAlphas) {
            const idx = t * (holeAlphas.length - 1);
            const i = Math.floor(idx);
            const f = idx - i;
            const a1 = holeAlphas[Math.min(i, holeAlphas.length - 1)];
            const a2 = holeAlphas[Math.min(i + 1, holeAlphas.length - 1)];
            holeAlpha = a1 * (1 - f) + a2 * f;
        }

        c.alpha *= trailAgeAlpha * particleAgeAlpha * holeAlpha;
        return c;
    }

    drawParticles(opacity) {
        Plot.ParticleSystem.forEachTrail(this.particleSystem, (points, particle) => {
            // 1. Calculate hole alphas in geometry space
            // Note: points array is reused, so we must be careful if we needed original points later (we don't here)
            this.holeAlphasBuffer.length = 0;
            const holeAlphas = this.holeAlphasBuffer;
            const attractors = this.particleSystem.attractors; // Hoist this if optimizing further, but it's fine here

            for (let i = 0; i < points.length; i++) {
                let alpha = 1.0;
                for (const attr of attractors) {
                    const dist = angleBetween(points[i], attr.position);
                    if (dist < attr.eventHorizon) {
                        let t = dist / attr.eventHorizon;
                        t = quinticKernel(t);
                        alpha *= t;
                    }
                }
                holeAlphas.push(alpha);
            }

            // 2. Transform positions
            for (let i = 0; i < points.length; i++) {
                points[i] = this.orientation.orient(mobiusTransform(points[i], this.mobius));
            }

            // 3. Rasterize with interpolation
            Plot.rasterize(this.pipeline, points, (pos, t) => {
                const c = this.particleColor(particle, t, holeAlphas);
                c.alpha *= opacity;
                return c;
            }, false, 0);
        });
    }

    monitorSpeed() {
        let maxSq = 0;
        const count = this.particleSystem.activeCount;
        const pool = this.particleSystem.particles;
        for (let i = 0; i < count; i++) {
            const p = pool[i];
            const sq = p.velocity.lengthSq();
            if (sq > maxSq) maxSq = sq;
        }
        this.maxSpeed = Math.sqrt(maxSq);
    }

    drawFrame() {
        this.timeline.step();
        this.monitorSpeed();
    }
}
