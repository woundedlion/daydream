/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    vectorPool, randomVector
} from "../geometry.js";
import {
    richSunset, rainbow, color4Pool
} from "../color.js";
import {
    Timeline, ParticleSystem, Sprite
} from "../animation.js";
import { createRenderPipeline, FilterAntiAlias } from "../filters.js";
import { Scan } from "../scan.js";
import { makeBasis } from "../geometry.js";
import { tween } from "../animation.js";


export class TestParticles {
    constructor() {
        this.timeline = new Timeline();
        this.pipeline = createRenderPipeline(new FilterAntiAlias());

        this.particleSystem = new ParticleSystem();
        this.timeline.add(0, this.particleSystem);
        this.timeline.add(0, new Sprite((opacity) => this.drawParticles(opacity), -1));

        this.setupGUI();
        this.rebuild();
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.particleSystem, 'friction').min(0.8).max(1.0).step(0.001).name("Friction");
        this.gui.add(this.particleSystem, 'gravityConstant').min(0.001).max(0.1).step(0.001).name("Gravity Scale");
        this.gui.add(this, 'rebuild').name("Respawn");
    }

    rebuild() {
        this.particleSystem.particles = [];
        this.particleSystem.attractors = [];
        this.particleSystem.friction = 0.99;

        // 4 Gravity Wells on Equator
        const wellStrength = 0.0001;
        const killRadius = 0.1;

        const wells = [
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(0, 0, 1),
            new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, 0, -1)
        ];

        for (let w of wells) {
            w.normalize(); // Keep on surface (r=1)
            this.particleSystem.addAttractor(w, wellStrength, killRadius);
        }
    }

    drawFrame() {
        // Continuous Spawning: 1 particle per frame
        if (this.particleSystem.particles.length < 500) {
            const v = randomVector();;
            const vel = randomVector().cross(v).normalize().multiplyScalar(0.005);
            const c = color4Pool.acquire().set(0, 0, 0, 1);
            const gravity = 1.0;
            this.particleSystem.spawn(v, vel, c, gravity);
        }

        this.timeline.step();
    }

    drawParticles(alpha) {
        for (const p of this.particleSystem.particles) {
            tween(p.orientation, (q, t) => {
                let v = vectorPool.acquire().copy(p.p).applyQuaternion(q);
                const c = rainbow.get((v.y + 1.0) / 2.0);
                this.pipeline.plot(v, c.color, 0, c.alpha * alpha);
            });
        }
    }
}
