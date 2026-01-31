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
import { createRenderPipeline, FilterScreenTrails } from "../filters.js";
import { Scan } from "../scan.js";
import { tween } from "../animation.js";


export class TestParticles {
    constructor() {
        this.timeline = new Timeline();
        this.pipeline = createRenderPipeline(new FilterScreenTrails(15, 500000));
        this.brushSize = 3;

        this.particleSystem = new ParticleSystem();
        this.timeline.add(0, this.particleSystem);
        this.timeline.add(0, new Sprite((opacity) => this.drawParticles(opacity), -1));

        this.rebuild();
        this.setupGUI();
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.particleSystem, 'friction').min(0.8).max(1.0).step(0.001).name("Friction");
        this.gui.add(this.particleSystem, 'gravityConstant').min(0.0001).max(0.01).step(0.0001).name("Gravity Scale");
        this.gui.add(this, 'numParticles').min(1).max(10000).step(1).name("# Particles");
        this.gui.add(this, 'brushSize').min(1).max(50).step(1).name("Brush Size");
        this.gui.add(this, 'rebuild').name("Respawn");
    }

    rebuild() {
        this.numParticles = 1000; // Restore higher count for spiral visibility
        this.particleSystem.particles = [];
        this.particleSystem.attractors = [];
        this.particleSystem.friction = 0.995;
        this.particleSystem.gravityConstant = 0.0005; // Lower gravity for uncapped velocity

        // Single South Pole Attractor (-Y)
        const wellStrength = 2.0;
        const killRadius = 0.05;
        this.particleSystem.addAttractor(new THREE.Vector3(0, -1, 0), wellStrength, killRadius);

    }

    drawFrame() {
        this.timeline.step();

        // Replenish
        if (this.particleSystem.particles.length < this.numParticles) {
            const v = Daydream.Y_AXIS.clone();
            const vel = randomVector().cross(v).normalize().multiplyScalar(0.00005);
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
        // Calculate angular thickness from pixel brush size
        const pixelAngle = (2 * Math.PI) / Daydream.W;
        const thickness = (this.brushSize / 2) * pixelAngle;

        for (const p of this.particleSystem.particles) {
            tween(p.orientation, (q, t) => {
                let v = vectorPool.acquire().copy(p.position).applyQuaternion(q);
                const c = lavenderLake.get(0);
                Scan.Point.draw(this.pipeline, v, thickness, (pos, _t, dist) => {
                    return { color: c.color, alpha: c.alpha * alpha * t };
                }, { debugBB: false });
            });
        }

    }
}