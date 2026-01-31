/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    randomVector, fibSpiral
} from "../geometry.js";
import { vectorPool, color4Pool } from "../memory.js";
import {
    richSunset, rainbow, lavenderLake
} from "../color.js";
import {
    Timeline, ParticleSystem, Sprite, PARTICLE_BASE
} from "../animation.js";
import { createRenderPipeline, FilterScreenTrails, FilterAntiAlias } from "../filters.js";
import { Plot } from "../plot.js";
import { tween } from "../animation.js";


export class TestParticles {
    constructor() {
        this.timeline = new Timeline();
        this.pipeline = createRenderPipeline(new FilterScreenTrails(15, 500000), new FilterAntiAlias());

        this.particleSystem = new ParticleSystem(0.95, 0.001);
        this.timeline.add(0, this.particleSystem);
        this.timeline.add(0, new Sprite((opacity) => this.drawParticles(opacity), -1));

        this.wellStrength = 1.0;

        this.maxSpeed = 0;
        this.rebuild();
        this.setupGUI();
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.particleSystem, 'friction').min(0.8).max(1.0).step(0.001).name("Friction");
        this.gui.add(this.particleSystem, 'gravityScale').min(0.0001).max(0.01).step(0.0001).name("Gravity Scale");
        this.gui.add(this, 'wellStrength').min(0).max(10).step(0.1).name("Attractor Strength").onChange((v) => {
            for (const a of this.particleSystem.attractors) {
                a.strength = v;
            }
        });
        this.gui.add(this, 'numParticles').min(1).max(10000).step(1).name("# Particles");
        this.gui.add(this, 'maxSpeed').name("Max Speed").listen();
        this.gui.add(this, 'rebuild').name("Respawn");
    }

    rebuild() {
        this.numParticles = 1000; // Restore higher count for spiral visibility
        this.particleSystem.reset(0.95, 0.001);

        const killRadius = 0.05;

        // 4 Equatorial Attractors
        this.particleSystem.addAttractor(new THREE.Vector3(1, 0, 0), this.wellStrength, killRadius);
        this.particleSystem.addAttractor(new THREE.Vector3(0, 0, 1), this.wellStrength, killRadius);
        this.particleSystem.addAttractor(new THREE.Vector3(-1, 0, 0), this.wellStrength, killRadius);
        this.particleSystem.addAttractor(new THREE.Vector3(0, 0, -1), this.wellStrength, killRadius);
    }

    drawFrame() {
        this.timeline.step();

        // Monitor Speed
        let maxSq = 0;
        for (const p of this.particleSystem.particles) {
            const sq = p.velocity.lengthSq();
            if (sq > maxSq) maxSq = sq;
        }
        this.maxSpeed = Math.sqrt(maxSq).toFixed(3);

        // Replenish
        if (this.particleSystem.particles.length < this.numParticles) {
            const v = Daydream.Y_AXIS.clone();
            const vel = randomVector().cross(v).normalize().multiplyScalar(0.05);
            const c = color4Pool.acquire().set(0, 0, 0, 1);
            const gravity = 1.0;
            this.particleSystem.spawn(v, vel, c, gravity);
        }

        // Draw Trails
        this.pipeline.trail((x, y, t) => {
            if (Number.isNaN(t)) return lavenderLake.get(0);
            return lavenderLake.get(t);
        }, 0.2);
    }

    drawParticles(alpha) {
        for (const p of this.particleSystem.particles) {
            tween(p.orientation, (q, t) => {
                let v = vectorPool.acquire().copy(p.position).applyQuaternion(q);
                const c = lavenderLake.get(0);
                Plot.Point.draw(this.pipeline, v, (pos, _t) => {
                    return { color: c.color, alpha: c.alpha * alpha * t };
                });
            });
        }

    }
}