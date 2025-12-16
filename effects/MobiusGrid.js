
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { stereo, invStereo, mobius, MobiusParams } from "../3dmath.js";
import {
    Orientation, sinWave
} from "../geometry.js";
import {
    sampleRing, rasterize, plotDots
} from "../draw.js";
import {
    GenerativePalette
} from "../color.js";
import {
    Timeline, easeMid, Rotation, MutableNumber, PeriodicTimer, ColorWipe, MobiusWarp, Mutation
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrient, FilterHole
} from "../filters.js";
import { wrap } from "../util.js";

export class MobiusGrid {
    constructor() {
        this.alpha = 0.2;
        this.numRings = new MutableNumber(0);
        this.numLines = new MutableNumber(0);
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

        this.timeline.add(0, new MobiusWarp(this.params, this.numRings, 160, true));
        this.timeline.add(0, new Rotation(this.orientation, Daydream.Y_AXIS, 2 * Math.PI, 400, easeMid, true));
        this.timeline.add(0, new PeriodicTimer(120, () => this.wipePalette(), true));
        this.timeline.add(0,
            new Mutation(this.numRings, (t) => sinWave(12, 1, 1, 0)(t), 320, easeMid, true)
        )
        this.timeline.add(160,
            new Mutation(this.numLines, (t) => sinWave(12, 1, 1, 0)(t), 320, easeMid, true)
        )

        this.setupGui();
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
        const folder = this.gui.addFolder('Mobius Params');
        folder.open();
        folder.add(this.params.aRe, 'n').name('aRe').min(-2).max(2).step(0.01).listen();
        folder.add(this.params.aIm, 'n').name('aIm').min(-2).max(2).step(0.01).listen();
        folder.add(this.params.bRe, 'n').name('bRe').min(-2).max(2).step(0.01).listen();
        folder.add(this.params.bIm, 'n').name('bIm').min(-2).max(2).step(0.01).listen();
        folder.add(this.params.cRe, 'n').name('cRe').min(-2).max(2).step(0.01).listen();
        folder.add(this.params.cIm, 'n').name('cIm').min(-2).max(2).step(0.01).listen();
        folder.add(this.params.dRe, 'n').name('dRe').min(-2).max(2).step(0.01).listen();
        folder.add(this.params.dIm, 'n').name('dIm').min(-2).max(2).step(0.01).listen();
    }

    wipePalette() {
        this.nextPalette = new GenerativePalette("circular", "split-complementary", "flat");
        this.timeline.add(0, new ColorWipe(this.palette, this.nextPalette, 60, easeMid));
    }

    drawAxisRings(normal, numRings, mobiusParams, axisComponent, phase = 0) {
        let dots = [];
        const logMin = -2.5;
        const logMax = 2.5;
        const range = logMax - logMin;
        const count = Math.ceil(numRings);
        for (let i = 0; i < count; i++) {
            let t = wrap(i / numRings + phase, 1.0);
            const logR = logMin + t * range;
            const R = Math.exp(logR);
            const radius = (4 / Math.PI) * Math.atan(1 / R);
            const points = sampleRing(new THREE.Quaternion(), normal, radius);
            const transformedPoints = points.map(p => {
                const z = stereo(p);
                const w = mobius(z, mobiusParams);
                return invStereo(w);
            });

            const opacity = Math.min(1.0, Math.max(0.0, numRings - i));
            dots.push(...rasterize(transformedPoints, (p) => {
                const res = this.palette.get(i / numRings);
                return { color: res.color, alpha: res.alpha * opacity };
            }, true));
        }
        return dots;
    }

    drawLongitudes(numLines, mobiusParams, axisComponent, phase = 0) {
        let dots = [];
        const count = Math.ceil(numLines);

        for (let i = 0; i < count; i++) {
            const theta = (i / numLines) * Math.PI;
            const normal = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0);
            const radius = 1.0;
            const points = sampleRing(new THREE.Quaternion(), normal, radius);

            const transformedPoints = points.map(p => {
                const z = stereo(p);
                const w = mobius(z, mobiusParams);
                return invStereo(w);
            });

            const opacity = Math.min(1.0, Math.max(0.0, numLines - i));
            dots.push(...rasterize(transformedPoints, (p, tLine) => {
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
                return { color: res.color, alpha: res.alpha * opacity };
            }, true));
        }
        return dots;
    }

    drawFrame() {
        this.timeline.step();
        const phase = ((this.timeline.t || 0) % 120) / 120;
        let dots = [];

        dots.push(...this.drawAxisRings(Daydream.Z_AXIS.clone(), this.numRings.get(), this.params, 'y', phase));
        dots.push(...this.drawLongitudes(this.numLines.get(), this.params, 'x', phase));

        // Calculate stabilizing counter-rotation
        const nIn = Daydream.Z_AXIS.clone();
        const nTrans = invStereo(mobius(stereo(nIn), this.params));
        const sIn = Daydream.Z_AXIS.clone().negate();
        const sTrans = invStereo(mobius(stereo(sIn), this.params));
        const mid = new THREE.Vector3().addVectors(nTrans, sTrans).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(mid, Daydream.Z_AXIS);

        // Apply counter-rotation to dots and holes
        dots.forEach(d => d.position.applyQuaternion(q));
        this.holeN.origin.copy(nTrans).applyQuaternion(q);
        this.holeS.origin.copy(sTrans).applyQuaternion(q);

        plotDots(null, this.filters, dots, 0, this.alpha);
    }
}
