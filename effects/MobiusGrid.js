/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { MobiusParams, TWO_PI } from "../3dmath.js";
import {
    Timeline, Rotation, PeriodicTimer, ColorWipe, MobiusWarpCircular, Mutation, Orientation
} from "../animation.js";
import { easeMid } from "../easing.js";
import {
    createRenderPipeline, Filter
} from "../filters.js";
import { wrap } from "../util.js";
import { GenerativePalette } from "../color.js";
import { Plot } from "../plot.js";
import { vectorPool, quaternionPool } from "../memory.js";
import { makeBasis, mobiusTransform, sinWave } from "../geometry.js";

export class MobiusGrid {
    constructor() {
        this.alpha = 0.2;
        this.numRings = 0;
        this.numLines = 0;
        this.palette = new GenerativePalette("circular", "split-complementary", "flat");
        this.orientation = new Orientation();
        this.timeline = new Timeline();
        this.holeN = new Filter.World.Hole(new THREE.Vector3(0, 0, 1), 1.2);
        this.holeS = new Filter.World.Hole(new THREE.Vector3(0, 0, -1), 1.2);
        this.filters = createRenderPipeline(
            this.holeN,
            this.holeS,
            new Filter.World.Orient(this.orientation),
            new Filter.Screen.AntiAlias()
        );
        this.params = new MobiusParams(1, 0, 0, 0, 0, 0, 1, 0);

        this.warpAnim = new MobiusWarpCircular(this.params, 160, 1.0, true);
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
        const count = Math.ceil(numRings);
        const q = quaternionPool.acquire(); // default identity
        for (let i = 0; i < count; i++) {
            let t = wrap(i / numRings + phase, 1.0);
            const logMin = -2.5;
            const logMax = 2.5;
            const range = logMax - logMin;
            const logR = logMin + t * range;
            const R = Math.exp(logR);
            const radius = (4 / Math.PI) * Math.atan(1 / R);
            const basis = makeBasis(q, normal);

            const opacity = Math.min(1.0, Math.max(0.0, numRings - i));

            const fragmentShader = (pTransformed, frag) => {
                const t = frag.v0; // t matches previous logic (i/numRings + phase) which determines geometry, but color logic depended on i/numRings.
                // Wait, drawAxisRings iterates i. 
                // The shader uses 'i' from closure? Yes.
                // "const res = this.palette.get(i / numRings);"
                // So 'tPoly' was unused in original code?
                // Original: (pTransformed, tPoly) => ...
                // It ignored tPoly.

                const res = this.palette.get(i / numRings);
                res.alpha *= opacity * this.alpha;
                frag.color = res;
            };

            const vertexShaderFn = (frag) => {
                const finalP = mobiusTransform(frag.pos, mobiusParams, vectorPool.acquire());
                if (rotationQ) finalP.applyQuaternion(rotationQ);
                frag.pos.copy(finalP);
            };

            Plot.SphericalPolygon.draw(pipeline, basis, radius, Daydream.W / 4, fragmentShader, 0, 0, vertexShaderFn);
        }
    }

    drawLongitudes(pipeline, numLines, mobiusParams, axisComponent, phase = 0, rotationQ) {
        const count = Math.ceil(numLines);
        const q = quaternionPool.acquire();
        for (let i = 0; i < count; i++) {
            const theta = (i / numLines) * Math.PI;
            const normal = vectorPool.acquire().set(Math.cos(theta), Math.sin(theta), 0);
            const radius = 1.0;

            // Stable basis for longitude at theta
            const v = normal;
            const w = vectorPool.acquire().set(0, 0, 1);
            const u = vectorPool.acquire().crossVectors(v, w).normalize();
            const basis = { u, v, w };

            const opacity = Math.min(1.0, Math.max(0.0, numLines - i));

            const fragmentShader = (pTransformed, frag) => {
                const angle = frag.v0 * TWO_PI;
                const z = Math.sin(angle);
                const R = Math.sqrt((1 + z) / (1 - z));
                const logR = Math.log(R);
                const logMin = -2.5;
                const logMax = 2.5;
                const range = logMax - logMin;
                const tParam = (logR - logMin) / range;
                const res = this.palette.get(wrap(tParam - phase, 1.0));
                res.alpha *= opacity * this.alpha;
                frag.color = res;
            };

            const vertexShader = (frag) => {
                const finalP = mobiusTransform(frag.pos, mobiusParams, vectorPool.acquire());
                if (rotationQ) finalP.applyQuaternion(rotationQ);
                frag.pos.copy(finalP);
            };

            Plot.SphericalPolygon.draw(pipeline, basis, radius, Daydream.W / 4, fragmentShader, 0, 0, vertexShader);
        }
    }

    drawFrame() {
        this.timeline.step();
        const phase = ((this.timeline.t || 0) % 120) / 120;

        // Calculate stabilizing counter-rotation
        const nIn = vectorPool.acquire().copy(Daydream.Z_AXIS);
        const nTrans = mobiusTransform(nIn, this.params, vectorPool.acquire());

        const sIn = vectorPool.acquire().copy(Daydream.Z_AXIS).negate();
        const sTrans = mobiusTransform(sIn, this.params, vectorPool.acquire());

        const mid = vectorPool.acquire().addVectors(nTrans, sTrans);
        const q = quaternionPool.acquire(); // identity

        if (mid.lengthSq() > 0.001) {
            mid.normalize();
            q.setFromUnitVectors(mid, Daydream.Z_AXIS);
        }

        // Apply counter-rotation to holes
        this.holeN.origin.copy(nTrans).applyQuaternion(q);
        this.holeS.origin.copy(sTrans).applyQuaternion(q);

        // Draw directly with rotation
        this.drawAxisRings(this.filters, Daydream.Z_AXIS, this.numRings, this.params, 'y', phase, q);
        this.drawLongitudes(this.filters, this.numLines, this.params, 'x', phase, q);
    }
}

