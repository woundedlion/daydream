import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, angleBetween, sinWave
} from "../geometry.js";
import {
    drawRing, plotDots, drawFn, fnPoint
} from "../draw.js";
import {
    ProceduralPalette
} from "../color.js";
import {
    Timeline, easeMid, Sprite, Transition, RandomTimer, MutableNumber, Rotation, easeOutExpo, easeInSin, easeOutSin, Mutation
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias
} from "../filters.js";
import { StaticCircularBuffer } from "../StaticCircularBuffer.js";

class ThrusterContext {
    constructor() {
        this.orientation = new Orientation();
        this.point = new THREE.Vector3();
        this.radius = new MutableNumber(0);
        this.motion = new Transition(this.radius, 0.3, 8, easeMid);
    }

    reset(orientation, point) {
        // Snapshot the current orientation (deep copy the quaternion)
        this.orientation.set(orientation.get().clone());
        this.point.copy(point);
        this.radius.set(0);
        // Reset/Recreate the transition
        this.motion = new Transition(this.radius, 0.3, 8, easeMid);
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
        this.thrusters = new StaticCircularBuffer(16);
        this.amplitude = new MutableNumber(0);
        this.warpPhase = 0;
        this.radius = new MutableNumber(1);

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
        let dots = drawRing(ctx.orientation.get(), ctx.point, ctx.radius.get(),
            (v, t) => new THREE.Color(0xffffff).multiplyScalar(opacity));
        plotDots(null, this.filters, dots, 0, opacity * this.alpha);
    }

    onFireThruster() {
        this.warpPhase = Math.random() * 2 * Math.PI;
        let thrustPoint = fnPoint(
            this.ringFn.bind(this), this.ring, 1, this.warpPhase);
        let thrustOpp = fnPoint(
            this.ringFn.bind(this), this.ring, 1, (this.warpPhase + Math.PI));

        // warp ring
        if (!(this.warp === undefined || this.warp.done())) {
            this.warp.cancel();
        }
        this.warp = new Mutation(
            this.amplitude, (t) => 0.7 * Math.exp(-2 * t), 32, easeMid);
        this.timeline.add(1 / 16,
            this.warp
        );

        // Spin ring
        let thrustAxis = new THREE.Vector3().crossVectors(
            this.orientation.orient(thrustPoint),
            this.orientation.orient(this.ring))
            .normalize();
        this.timeline.add(0,
            new Rotation(this.orientation, thrustAxis, 2 * Math.PI, 8 * 16, easeOutExpo)
        );

        // show thrusters
        this.spawnThruster(thrustPoint);
        this.spawnThruster(thrustOpp);
    }

    spawnThruster(point) {
        const ctx = new ThrusterContext();
        this.thrusters.push(ctx);
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
        return sinWave(-1, 1, 2, this.warpPhase)(t) // ring
            * sinWave(-1, 1, 3, 0)((this.t % 32) / 32) // oscillation
            * this.amplitude.get();
    }

    drawRing(opacity) {
        let dots = drawFn(this.orientation.get(), this.ring, this.radius.get(),
            this.ringFn.bind(this),
            (v, t) => {
                let z = this.orientation.orient(Daydream.X_AXIS);
                return this.palette.get(angleBetween(z, v) / Math.PI);
            }
        );
        plotDots(null, this.filters, dots, 0, this.alpha * opacity);
    }

    drawFrame() {
        this.orientation.collapse();
        this.timeline.step();
        this.t++;
    }
}