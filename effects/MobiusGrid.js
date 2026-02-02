/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { stereo, invStereo, mobius, MobiusParams, TWO_PI } from "../3dmath.js";
import {
    Orientation, sinWave
} from "../geometry.js";
import { vectorPool, quaternionPool } from "../memory.js";
import {
    Plot
} from "../plot.js";
import {
    makeBasis
} from "../geometry.js";

import {
    GenerativePalette
} from "../color.js";
import { color4Pool } from "../memory.js";
import {
    Timeline, Rotation, PeriodicTimer, ColorWipe, MobiusWarp, Mutation
} from "../animation.js";
import { easeMid } from "../easing.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrient, FilterHole, FilterMobius
} from "../filters.js";
import { wrap } from "../util.js";

export class MobiusGrid {
    constructor() {
        this.alpha = 0.2;
        this.numRings = 0;
        this.numLines = 0;
        this.palette = new GenerativePalette("circular", "split-complementary", "flat");
        this.orientation = new Orientation();
        this.timeline = new Timeline();
        this.holeN = new FilterHole(new THREE.Vector3(0, 0, 1), 1.2);
        this.holeS = new FilterHole(new THREE.Vector3(0, 0, -1), 1.2);
        this.filters = createRenderPipeline(
            this.holeN,
            this.holeS,
            new FilterOrient(this.orientation),
            new FilterAntiAlias()
        );
        this.params = new MobiusParams(1, 0, 0, 0, 0, 0, 1, 0);

        this.warpAnim = new MobiusWarp(this.params, 160, 1.0, true);
        this.timeline.add(0, this.warpAnim);
        this.timeline.add(0, new Rotation(this.orientation, Daydream.Y_AXIS, TWO_PI, 400, easeMid, true));
        this.timeline.add(0, new PeriodicTimer(120, () => this.wipePalette(), true));
        this.timeline.add(0,
            new Mutation(this, 'numRings', (t) => sinWave(12, 1, 1, 0)(t), 320, easeMid, true)
        )
        this.timeline.add(160,
            new Mutation(this, 'numLines', (t) => sinWave(12, 1, 1, 0)(t), 320, easeMid, true)
        )

        this.setupGui();
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
        const folder = this.gui.addFolder('Mobius Params');
        folder.open();
        folder.add(this.params, 'aRe').name('aRe').min(-2).max(2).step(0.01).listen();
        folder.add(this.params, 'aIm').name('aIm').min(-2).max(2).step(0.01).listen();
        folder.add(this.params, 'bRe').name('bRe').min(-2).max(2).step(0.01).listen();
        folder.add(this.params, 'bIm').name('bIm').min(-2).max(2).step(0.01).listen();
        folder.add(this.params, 'cRe').name('cRe').min(-2).max(2).step(0.01).listen();
        folder.add(this.params, 'cIm').name('cIm').min(-2).max(2).step(0.01).listen();
        folder.add(this.params, 'dRe').name('dRe').min(-2).max(2).step(0.01).listen();
        folder.add(this.params, 'dIm').name('dIm').min(-2).max(2).step(0.01).listen();
    }

    wipePalette() {
        this.nextPalette = new GenerativePalette("circular", "split-complementary", "flat");
        this.timeline.add(0, new ColorWipe(this.palette, this.nextPalette, 60, easeMid));
    }

    drawAxisRings(pipeline, normal, numRings, mobiusParams, axisComponent, phase = 0, rotationQ) {
        const { a, b, c, d } = mobiusParams;
        const logMin = -2.5;
        const logMax = 2.5;
        const range = logMax - logMin;
        const count = Math.ceil(numRings);
        const q = quaternionPool.acquire(); // default identity
        for (let i = 0; i < count; i++) {
            let t = wrap(i / numRings + phase, 1.0);
            const logR = logMin + t * range;
            const R = Math.exp(logR);
            const radius = (4 / Math.PI) * Math.atan(1 / R);
            const basis = makeBasis(q, normal);
            const points = Plot.Polygon.sample(basis, radius, Daydream.W / 4);

            const transformedPoints = points.map(p => {
                const z = stereo(p);
                const w = mobius(z, mobiusParams);
                // Inline invStereo to usage vectorPool
                const r2 = w.re * w.re + w.im * w.im;
                const finalP = vectorPool.acquire().set(
                    2 * w.re / (r2 + 1),
                    2 * w.im / (r2 + 1),
                    (r2 - 1) / (r2 + 1)
                );

                if (rotationQ) finalP.applyQuaternion(rotationQ);
                return finalP;
            });

            const opacity = Math.min(1.0, Math.max(0.0, numRings - i));
            Plot.rasterize(pipeline, transformedPoints, (p) => {
                const res = this.palette.get(i / numRings);
                res.alpha *= opacity * this.alpha;
                return res;
            }, true);
        }
    }

    drawLongitudes(pipeline, numLines, mobiusParams, axisComponent, phase = 0, rotationQ) {
        const { a, b, c, d } = mobiusParams;
        const count = Math.ceil(numLines);
        const q = quaternionPool.acquire();
        for (let i = 0; i < count; i++) {
            const theta = (i / numLines) * Math.PI;
            const normal = vectorPool.acquire().set(Math.cos(theta), Math.sin(theta), 0);
            const radius = 1.0;
            const basis = makeBasis(q, normal);
            const points = Plot.Polygon.sample(basis, radius, Daydream.W / 4);

            const transformedPoints = points.map(p => {
                let mp = mobius(stereo(p), mobiusParams);
                const r2 = mp.re * mp.re + mp.im * mp.im;
                const finalP = vectorPool.acquire().set(
                    2 * mp.re / (r2 + 1),
                    2 * mp.im / (r2 + 1),
                    (r2 - 1) / (r2 + 1)
                );
                if (rotationQ) finalP.applyQuaternion(rotationQ);
                return finalP;
            });

            const opacity = Math.min(1.0, Math.max(0.0, numLines - i));
            Plot.rasterize(pipeline, transformedPoints, (p, tLine) => {
                // Interpolate unwarped points to get Z
                const idx = tLine * points.length;
                const i1 = Math.floor(idx) % points.length;
                const i2 = (i1 + 1) % points.length;
                const f = idx - Math.floor(idx);
                const z = points[i1].z * (1 - f) + points[i2].z * f;
                const R = Math.sqrt((1 + z) / (1 - z));
                const logR = Math.log(R);
                const logMin = -2.5;
                const logMax = 2.5;
                const range = logMax - logMin;
                const t = (logR - logMin) / range;

                const res = this.palette.get(wrap(t - phase, 1.0));
                res.alpha *= opacity * this.alpha;
                return res;
            }, true);
        }
    }

    drawFrame() {
        this.timeline.step();
        const phase = ((this.timeline.t || 0) % 120) / 120;

        // Calculate stabilizing counter-rotation
        const nIn = vectorPool.acquire().copy(Daydream.Z_AXIS);

        const transform = (v) => {
            const z = stereo(v);
            const w = mobius(z, this.params);
            const r2 = w.re * w.re + w.im * w.im;
            return vectorPool.acquire().set(
                2 * w.re / (r2 + 1),
                2 * w.im / (r2 + 1),
                (r2 - 1) / (r2 + 1)
            );
        };

        const nTrans = transform(nIn);
        const sIn = vectorPool.acquire().copy(Daydream.Z_AXIS).negate();
        const sTrans = transform(sIn);

        const mid = vectorPool.acquire().addVectors(nTrans, sTrans).normalize();
        const q = quaternionPool.acquire().setFromUnitVectors(mid, Daydream.Z_AXIS);

        // Apply counter-rotation to holes
        this.holeN.origin.copy(nTrans).applyQuaternion(q);
        this.holeS.origin.copy(sTrans).applyQuaternion(q);

        // Draw directly with rotation
        this.drawAxisRings(this.filters, vectorPool.acquire().copy(Daydream.Z_AXIS), this.numRings, this.params, 'y', phase, q);
        this.drawLongitudes(this.filters, this.numLines, this.params, 'x', phase, q);
    }
}
