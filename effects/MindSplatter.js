/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    MeshOps, mobiusTransform, angleBetween, makeBasis, G
} from "../geometry.js";
import { vectorPool } from "../memory.js";
import { GenerativePalette, AlphaFalloffPalette } from "../color.js";
import { Palettes } from "../palettes.js";
import {
    Timeline, Animation, Orientation
} from "../animation.js";
import { createRenderPipeline, Filter, quinticKernel } from "../filters.js";
import { Plot } from "../plot.js";
import { MobiusParams } from "../3dmath.js";
import { Solids, AllSolids } from "../solids.js";

export class MindSplatter {
    constructor() {
        this.friction = 0.85;
        this.wellStrength = 1.0;
        this.initialSpeed = 0.025;
        this.angularSpeed = 0.2;
        this.maxSpeed = 0;
        this.batchSize = Daydream.W;
        this.warpScale = 0.6;
        this.warpScale = 0.6;
        this.trailLength = 25;
        this.solidName = 'dodecahedron';

        this.orientation = new Orientation();
        this.mobius = new MobiusParams();
        this.pipeline = createRenderPipeline(new Filter.World.Orient(this.orientation), new Filter.Screen.AntiAlias());

        this.timeline = new Timeline();
        this.timeline = new Timeline();
        this.particleSystem = new Animation.ParticleSystem(2048, this.friction, 0.001, this.trailLength);
        this.particleSystem.resolutionScale = 2;

        this.timeline.add(0, this.particleSystem);
        this.timeline.add(0, new Animation.Sprite((opacity) => this.drawParticles(opacity), -1));
        this.timeline.add(0, new Animation.RandomWalk(this.orientation, Daydream.UP));

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
        this.gui.add(this, 'solidName', AllSolids).name("Solid").onChange(() => this.rebuild());
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
        this.warpTimer = new Animation.RandomTimer(180, 300, () => this.performWarp());
        this.timeline.add(0, this.warpTimer);
    }

    performWarp() {
        this.warpAnim = new Animation.MobiusWarp(this.mobius, 160, this.warpScale, false);
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


        let emitters = Solids.get(this.solidName);
        this.emitCounters = [];
        for (let i = 0; i < emitters.vertices.length; i++) {
            this.emitCounters.push(0);
        }
        let attractors = MeshOps.dual(emitters);

        for (const v of attractors.vertices) {
            this.particleSystem.addAttractor(v, this.wellStrength, killRadius, eventHorizon);
        }

        const identityQ = new THREE.Quaternion();
        this.emitterHues = [];
        for (let i = 0; i < emitters.vertices.length; i++) {
            this.emitterHues.push(Math.random());
        }

        for (let i = 0; i < emitters.vertices.length; i++) {
            this.particleSystem.addEmitter((system) => {
                const axis = emitters.vertices[i];
                const angle = this.emitCounters[i]++ * this.angularSpeed;
                const { u, w } = makeBasis(identityQ, axis);
                const vel = vectorPool.acquire();
                vel.copy(u).multiplyScalar(Math.cos(angle))
                    .addScaledVector(w, Math.sin(angle))
                    .multiplyScalar(this.initialSpeed);

                const currentHue = this.emitterHues[i];
                this.emitterHues[i] = (this.emitterHues[i] + G * 0.1) % 1;

                const palette = new AlphaFalloffPalette((t) => t,
                    new GenerativePalette('straight', 'complementary', 'flat', 'mid', currentHue));
                const life = 160;
                this.particleSystem.spawn(axis, vel, palette, life);
            });
        }
    }

    drawParticles(opacity) {
        const fragmentShader = (v, frag) => {
            const alpha = Math.min(frag.v0, frag.v3);
            const particle = this.particleSystem.particles[Math.floor(frag.v2)];
            const c = particle.palette.get(frag.v0);
            c.alpha *= alpha * opacity;
            frag.color = c;
        }

        const vertexShader = (frag) => {
            let holeAlpha = 1.0;
            const point = frag.pos;
            for (const attr of this.particleSystem.attractors) {
                const dist = angleBetween(point, attr.position);
                if (dist < attr.eventHorizon) {
                    holeAlpha *= quinticKernel(dist / attr.eventHorizon);
                }
            }

            mobiusTransform(frag.pos, this.mobius, frag.pos);
            this.orientation.orient(frag.pos, undefined, frag.pos);
            frag.v3 *= holeAlpha;
        }

        Plot.ParticleSystem.draw(
            this.pipeline,
            this.particleSystem,
            fragmentShader,
            vertexShader
        );
    }

    drawFrame() {
        this.timeline.step();
    }
}

