import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { stereo, invStereo, mobius, MobiusParams } from "../3dmath.js";
import { Orientation } from "../geometry.js";
import { rasterize, plotDots, sampleFn } from "../draw.js";
import { GenerativePalette, ProceduralPalette } from "../color.js";
import { createRenderPipeline, FilterAntiAlias, FilterOrient } from "../filters.js";
import { wrap } from "../util.js";
import { Rotation, MutableNumber, Timeline, easeMid } from "../animation.js";

export class PetalFlow {
    constructor() {
        Daydream.W = 96;
        this.alpha = 0.2;
        this.spacing = new MutableNumber(0.5);
        this.twistFactor = Math.PI / 10;
        this.speed = 40.0;

        this.palette = new ProceduralPalette(
            [0.029, 0.029, 0.029], // A
            [0.500, 0.500, 0.500], // B
            [0.461, 0.461, 0.461], // C
            [0.539, 0.701, 0.809]  // D
        );

        this.orientation = new Orientation();
        this.timeline = new Timeline();
        this.filters = createRenderPipeline(
            new FilterOrient(this.orientation),
            new FilterAntiAlias()
        );
        this.params = new MobiusParams(1, 0, 0, 0, 0, 0, 1, 0);

        this.setupGui();

        //        this.timeline.add(0, new Rotation(this.orientation, Daydream.Y_AXIS, Math.PI / 2, 64, easeMid, true));
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
        this.gui.add(this, 'twistFactor').min(0).max(2 * Math.PI).step(0.01);
        this.gui.add(this, 'speed').min(1).max(200).step(1).name('Flow Speed');

        const folder = this.gui.addFolder('Mobius Params');
        folder.open();
        folder.add(this.params.aRe, 'n').name('aRe').listen();
        folder.add(this.params.dRe, 'n').name('dRe').listen();
    }

    drawPetals(loopCount, loopT) {
        let dots = [];
        const logMin = -3.75;
        const logMax = 3.75;

        // Expand range to ensure smooth entry/exit
        const minK = Math.floor(logMin / this.spacing.get()) - 1;
        const maxK = Math.ceil(logMax / this.spacing.get()) + 1;

        const petalShift = (t) => {
            return this.spacing.get() * Math.abs(Math.sin(3 * Math.PI * t));
        };

        const progress = loopT / this.spacing.get();

        for (let k = minK; k <= maxK; k++) {
            const logR = k * this.spacing.get();

            // 1. CALCULATE VISUAL POSITION
            // Instead of separating "Static Grid" + "Mobius Zoom",
            // we combine them into one effective position.
            const effectiveLogR = logR + loopT;
            const dist = Math.abs(effectiveLogR);

            // Opacity Fade
            let opacity = 1.0;
            if (dist > 2.5) {
                opacity = Math.max(0, 1.0 - (dist - 2.5) / 1.0);
            }
            if (opacity <= 0.01) continue;

            // 2. GENERATE GEOMETRY AT VISUAL POSITION
            // This prevents the "Magnified Wiggle" artifact.
            const R = Math.exp(effectiveLogR);

            // 3. CONTINUOUS TWIST
            // Twist based on the continuous index (k + progress)
            // This ensures 30deg rotation per spacing unit, interpolated smoothly.
            const twistAngle = (k + progress) * this.twistFactor;
            const twist = new THREE.Quaternion().setFromAxisAngle(Daydream.Z_AXIS, twistAngle);

            // Generate points
            const sphereRadius = (4 / Math.PI) * Math.atan(1 / R);
            const points = sampleFn(twist, Daydream.Z_AXIS, sphereRadius, petalShift);

            // Apply Mobius (Static / User defined only)
            const transformedPoints = points.map(p => {
                const z = stereo(p);
                const w = mobius(z, this.params); // params are now Identity (or user tweaked)
                return invStereo(w);
            });

            // 4. COLOR STABILITY
            const colorIndex = (k - loopCount) + 10000;
            const hue = wrap(colorIndex * 0.13, 1.0);

            dots.push(...rasterize(transformedPoints, (p, drawProgress) => {
                const res = this.palette.get(hue);
                return { color: res.color, alpha: res.alpha * opacity };
            }, true));
        }

        return dots;
    }

    drawFrame() {
        this.timeline.step();
        const time = (performance.now() / 1000.0) * (this.speed * 0.015);
        const loopCount = Math.floor(time / this.spacing.get());
        const loopT = time % this.spacing.get();

        // RESET MOBIUS TO IDENTITY
        // We are handling the flow manually in drawPetals.
        // This ensures no double-counting or shape distortion.
        this.params.aRe.set(1);
        this.params.aIm.set(0);
        this.params.dRe.set(1);
        this.params.dIm.set(0);

        let dots = this.drawPetals(loopCount, loopT);
        plotDots(null, this.filters, dots, 0, this.alpha);
    }
}