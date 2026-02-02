/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, MeshOps
} from "../geometry.js";
import { vectorPool, color4Pool } from "../memory.js";
import {
    richSunset, rainbow, lavenderLake, GenerativePalette
} from "../color.js";
import {
    Timeline, ParticleSystem, Sprite, PARTICLE_BASE
} from "../animation.js";
import { createRenderPipeline, FilterWorldTrails, FilterOrient, FilterAntiAlias, FilterMobius } from "../filters.js";
import { Plot } from "../plot.js";
import { RandomWalk, MobiusWarp, tween } from "../animation.js";
import { Solids } from "../solids.js";

export class TestParticles {
    constructor() {
        this.orientation = new Orientation();
        this.mobius = new FilterMobius();
        this.pipeline = createRenderPipeline(new FilterWorldTrails(25, 500000), this.mobius, new FilterOrient(this.orientation), new FilterAntiAlias());

        this.timeline = new Timeline();
        this.particleSystem = new ParticleSystem(this.friction, 0.001);
        this.particleSystem.resolutionScale = 2;
        this.timeline.add(0, this.particleSystem);
        this.timeline.add(0, new Sprite((opacity) => this.drawParticles(opacity), -1));
        this.timeline.add(0, new RandomWalk(this.orientation, Daydream.UP));

        this.enableWarp = false;
        if (this.enableWarp) this.startWarp(); // Default false

        this.friction = 0.85;
        this.wellStrength = 1.0;
        this.initialSpeed = 0.025;
        this.angularSpeed = 0.2;
        this.maxSpeed = 0;
        this.batchSize = Daydream.W;
        this.warpScale = 0.6;

        this.rebuild();
        this.setupGUI();
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.particleSystem, 'friction').min(0.8).max(1.0).step(0.001).name("Friction");
        this.gui.add(this.particleSystem, 'gravityScale').min(0.0001).max(0.01).step(0.0001).name("Gravity Scale");
        this.gui.add(this, 'initialSpeed').min(0.001).max(0.2).step(0.001).name("Initial Speed");
        this.gui.add(this, 'angularSpeed').min(0.001).max(1).step(0.001).name("Angular Speed");

        // Time Scale Slider
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
        if (this.warpAnim) this.warpAnim.cancel();
        this.warpAnim = new MobiusWarp(this.mobius, 160, this.warpScale, true);
        this.timeline.add(0, this.warpAnim);
    }

    stopWarp() {
        if (this.warpAnim) this.warpAnim.cancel();
        this.mobius.aRe = 1; this.mobius.aIm = 0;
        this.mobius.bRe = 0; this.mobius.bIm = 0;
        this.mobius.cRe = 0; this.mobius.cIm = 0;
        this.mobius.dRe = 1; this.mobius.dIm = 0;
    }

    rebuild() {
        this.spawnIndex = 0;
        this.particleSystem.reset(this.friction, 0.001);

        const killRadius = 0.05;

        let emitters = Solids.cube();
        this.emitCounters = [];
        for (let i = 0; i < emitters.vertices.length; i++) {
            this.emitCounters.push(0);
        }
        let attractors = MeshOps.dual(emitters);

        for (const v of attractors.vertices) {
            this.particleSystem.addAttractor(v, this.wellStrength, killRadius);
        }

        for (let i = 0; i < emitters.vertices.length; i++) {
            this.particleSystem.addEmitter(() => {
                const axis = emitters.vertices[i];
                const angle = this.emitCounters[i]++ * this.angularSpeed;
                const vel = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(this.initialSpeed);
                const palette = new GenerativePalette('straight', 'complementary', 'descending', 'mid');
                const life = 160;
                return new ParticleSystem.Particle(axis, vel, palette, life);
            });
        }
    }

    evaluateColor(particle, t) {
        const c = particle.palette.get(t);
        c.alpha *= (1.0 - t);
        return c;
    }

    drawFrame() {
        this.timeline.step();

        // Monitor Speed
        let maxSq = 0;
        for (const p of this.particleSystem.particles) {
            const sq = p.velocity.lengthSq();
            if (sq > maxSq) maxSq = sq;
        }
        this.maxSpeed = Math.sqrt(maxSq);

        // Draw Trails
        this.pipeline.trail((v, t, particle) => {
            return this.evaluateColor(particle, t);
        }, 0.2);
    }

    drawParticles(alpha) {
        for (const p of this.particleSystem.particles) {
            const steps = p.orientation.length();

            // Age in Physics Steps
            const particleAgeSteps = p.maxLife - p.life;

            tween(p.orientation, (q, t) => {
                let v = vectorPool.acquire().copy(p.position).applyQuaternion(q);
                const c = this.evaluateColor(p, t);
                c.alpha *= alpha;
                Plot.Point.draw(this.pipeline, v, (pos, _t) => {
                    return { color: c.color, alpha: c.alpha, tag: p.tag };
                }, t);
            });
            p.orientation.collapse();
        }
    }
}