
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, fibSpiral, randomVector
} from "../geometry.js";
import {
    drawRing, plotDots
} from "../draw.js";
import {
    GenerativePalette
} from "../color.js";
import {
    Timeline, easeMid, Rotation, MutableNumber, PeriodicTimer, ColorWipe, easeInOutSin
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrientSlice
} from "../filters.js";

export class Portholes {
    constructor() {
        Daydream.W = 96;
        this.pixels = new Map();
        this.alpha = 0.3; // Default alpha

        this.basePalette = new GenerativePalette("circular", "analogous", "bell", "vibrant");
        this.interferencePalette = new GenerativePalette("circular", "analogous", "cup", "vibrant");

        this.orientations = [];
        const numSlices = 2;
        for (let i = 0; i < numSlices; i++) {
            this.orientations.push(new Orientation());
        }
        this.hemisphereAxis = new THREE.Vector3(0, 1, 0);
        this.timeline = new Timeline();

        // Parameters
        this.numPoints = new MutableNumber(20);
        this.circleRadius = new MutableNumber(0.27);
        this.offsetRadius = new MutableNumber(5 / Daydream.W);
        this.offsetSpeed = new MutableNumber(2.0);
        this.t = 0;

        this.filters = createRenderPipeline(
            new FilterOrientSlice(this.orientations, this.hemisphereAxis),
            new FilterAntiAlias()
        );

        // Animations
        this.timeline.add(0, new PeriodicTimer(48, () => this.colorWipe()));
        this.timeline.add(0, new PeriodicTimer(160, () => this.spinSlices(), true));

        this.setupGui();
    }

    setupGui() {
        this.gui = new gui.GUI();
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
        this.gui.add(this.numPoints, 'n', 10, 200).name('Num Points').step(1).listen();
        this.gui.add(this.circleRadius, 'n', 0.005, 0.5).name('Circle Radius').listen();
        this.gui.add(this.offsetRadius, 'n', 0.0, 0.2).name('Offset Radius').listen();
        this.gui.add(this.offsetSpeed, 'n', 0.0, 5.0).name('Offset Speed').listen();
    }

    colorWipe() {
        this.nextBasePalette = new GenerativePalette("straight", "triadic", "ascending");
        this.nextInterferencePalette = new GenerativePalette("straight", "triadic", "ascending");
        this.timeline.add(0,
            new ColorWipe(this.basePalette, this.nextBasePalette, 80, easeMid)
        );
        this.timeline.add(0,
            new ColorWipe(this.interferencePalette, this.nextInterferencePalette, 80, easeMid)
        );
    }

    drawLayer(isInterference) {
        let dots = [];
        const n = Math.floor(this.numPoints.get());

        // Generate Fibonacci points
        for (let i = 0; i < n; i++) {
            let p = fibSpiral(n, 0.3, i);

            if (isInterference) {
                // Create basis for tangent plane
                const axis = (Math.abs(p.y) > 0.99) ? Daydream.X_AXIS : Daydream.Y_AXIS;
                let u = new THREE.Vector3().crossVectors(p, axis).normalize();
                let v = new THREE.Vector3().crossVectors(p, u).normalize();

                // Time based offset in tangent plane
                const phase = i * 0.1;
                const angle = this.t * this.offsetSpeed.get() * 2 * Math.PI + phase;
                const r = this.offsetRadius.get();

                // Calculate offset vector
                const offset = u.clone().multiplyScalar(Math.cos(angle)).add(v.clone().multiplyScalar(Math.sin(angle))).multiplyScalar(r);

                // Apply offset to normal (approximate, spherical surface constraint handled by normalization)
                p.add(offset).normalize();
            }

            // Draw ring
            let ring = drawRing(new THREE.Quaternion(), p, this.circleRadius.get(), (v, t) => {
                const palette = isInterference ? this.interferencePalette : this.basePalette;
                return palette.get(t);
            });
            dots.push(...ring);
        }
        return dots;
    }

    drawFrame() {
        this.pixels.clear();
        this.timeline.step();
        this.t += 0.01; // Global time

        let dots = [];
        dots.push(...this.drawLayer(true));  // Interference
        dots.push(...this.drawLayer(false)); // Base

        plotDots(this.pixels, this.filters, dots, 0, this.alpha);
        return this.pixels;
    }

    spinSlices() {
        let axis = randomVector();
        this.hemisphereAxis.copy(axis);

        // Spin alternating directions over 5 seconds (80 frames)
        for (let i = 0; i < this.orientations.length; i++) {
            const direction = (i % 2 === 0) ? 1 : -1;
            this.timeline.add(0, new Rotation(this.orientations[i], axis, direction * 2 * Math.PI, 80, easeInOutSin, false));
        }
    }
}
