/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { TWO_PI } from "../3dmath.js";
import {
    Orientation, angleBetween, sinWave, vectorPool, quaternionPool
} from "../geometry.js";
import {
    Plot
} from "../plot.js";
import {
    makeBasis
} from "../geometry.js";

import {
    ProceduralPalette, colorPool, color4Pool
} from "../color.js";
import {
    Timeline, Sprite, Transition, RandomTimer, Rotation, Mutation
} from "../animation.js";
import { easeMid, easeOutExpo, easeInSin, easeOutSin } from "../easing.js";
import {
    createRenderPipeline, FilterAntiAlias
} from "../filters.js";
import { StaticPool } from "../StaticPool.js";

class ThrusterContext {
    constructor() {
        this.orientation = new Orientation();
        this.point = new THREE.Vector3();
        this.radius = 0;
        this.motion = new Transition(this, 'radius', 0.3, 8, easeMid);
    }

    reset(orientation, point) {
        this.orientation.set(orientation.get().clone());
        this.point.copy(point);
        this.radius = 0;
        this.motion = new Transition(this, 'radius', 0.3, 8, easeMid);
    }
}

export class Thrusters {
    constructor() {
        // Palettes
        this.palette = new ProceduralPalette(
            [0.5, 0.5, 0.5],
            [0.5, 0.5, 0.5],
            [0.3, 0.3, 0.3],
            [0.0, 0.2, 0.6]
        );

        // Output Filters
        this.filters = createRenderPipeline(new FilterAntiAlias())

        // State
        this.t = 0;
        this.alpha = 0.2;
        this.ring = new THREE.Vector3(0.5, 0.5, 0.5).normalize();
        this.orientation = new Orientation();
        this.poolSize = 16;
        this.thrusterPool = new StaticPool(ThrusterContext, this.poolSize);

        this.amplitude = 0;
        this.warpPhase = 0;
        this.radius = 1;

        // GUI
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);

        // Animations
        this.timeline = new Timeline();
        this.timeline.add(0,
            new Sprite(this.drawRing.bind(this), -1,
                16, easeInSin,
                16, easeOutSin)
        );
        this.timeline.add(0, new RandomTimer(16, 48,
            () => this.onFireThruster(), true)
        );
    }

    drawThruster(ctx, opacity) {
        const basis = makeBasis(ctx.orientation.get(), ctx.point);
        Plot.Ring.draw(this.filters, basis, ctx.radius,
            (v, t) => {
                let c = colorPool.acquire().setHex(0xffffff).multiplyScalar(opacity);
                return color4Pool.acquire().set(c, opacity * this.alpha);
            });
    }

    onFireThruster() {
        this.warpPhase = Math.random() * TWO_PI;
        const identity = quaternionPool.acquire().identity();
        const basis = makeBasis(identity, this.ring);

        let thrustPoint = Plot.DistortedRing.point(
            this.ringFn.bind(this), basis, 1, this.warpPhase);
        let thrustOpp = Plot.DistortedRing.point(
            this.ringFn.bind(this), basis, 1, (this.warpPhase + Math.PI));


        // warp ring
        if (!(this.warp === undefined || this.warp.done())) {
            this.warp.cancel();
        }
        this.warp = new Mutation(
            this, 'amplitude', (t) => 0.7 * Math.exp(-2 * t), 32, easeMid);
        this.timeline.add(1 / 16,
            this.warp
        );

        // Spin ring
        let thrustAxis = new THREE.Vector3().crossVectors(
            this.orientation.orient(thrustPoint),
            this.orientation.orient(this.ring))
            .normalize();
        this.timeline.add(0,
            new Rotation(this.orientation, thrustAxis, TWO_PI, 8 * 16, easeOutExpo, false)
        );

        // show thrusters
        this.spawnThruster(thrustPoint);
        this.spawnThruster(thrustOpp);
    }

    spawnThruster(point) {
        if (this.thrusterPool.cursor >= this.thrusterPool.capacity) {
            this.thrusterPool.reset();
        }
        const ctx = this.thrusterPool.acquire();

        ctx.reset(this.orientation, point);

        this.timeline.add(0,
            new Sprite(
                (opacity) => {
                    ctx.motion.step();
                    this.drawThruster(ctx, opacity);
                },
                16, 0, easeMid, 16, easeOutExpo
            )
        );
    }

    ringFn(t) {
        return sinWave(-1, 1, 2, this.warpPhase)(t)
            * sinWave(-1, 1, 3, 0)((this.t % 32) / 32)
            * this.amplitude;
    }

    drawRing(opacity) {
        const basis = makeBasis(this.orientation.get(), this.ring);
        Plot.DistortedRing.draw(this.filters, basis, this.radius,
            this.ringFn.bind(this),
            (v, t) => {
                let z = this.orientation.orient(Daydream.X_AXIS);
                const c = this.palette.get(angleBetween(z, v) / Math.PI);
                c.alpha *= this.alpha * opacity;
                return c;
            }
        );
    }

    drawFrame() {
        this.timeline.step();
        this.t++;
    }
}
