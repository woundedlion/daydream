
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, sinWave
} from "../geometry.js";
import {
    sampleFn, rasterize, plotDots
} from "../draw.js";
import {
    GenerativePalette
} from "../color.js";
import {
    Timeline, easeMid, Rotation, MutableNumber, PeriodicTimer, ColorWipe, Transition, Mutation, RandomTimer
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrient
} from "../filters.js";

export class Moire {
    constructor() {
        Daydream.W = 96;
        this.alpha = 0.2;
        this.basePalette = new GenerativePalette("circular", "split-complementary", "bell");
        this.interferencePalette = new GenerativePalette("circular", "split-complementary", "cup");

        this.density = new MutableNumber(10);
        this.scale = new MutableNumber(1.0);
        this.rotation = new MutableNumber(0);
        this.amp = new MutableNumber(0);
        this.orientation = new Orientation();
        this.timeline = new Timeline();

        this.filters = createRenderPipeline(
            new FilterOrient(this.orientation),
            new FilterAntiAlias()
        );

        this.timeline
            .add(0, new PeriodicTimer(80, () => this.colorWipe()))
            //      .add(0, new RandomTimer(48, 48, () => this.deRes(), false))
            .add(0, new Rotation(this.orientation, Daydream.Y_AXIS, 2 * Math.PI, 300, easeMid, true))
            .add(0,
                new Transition(this.rotation, 2 * Math.PI, 160, easeMid, false, true)
                    .then(() => this.rotation.set(0)))
            .add(0,
                new Mutation(this.amp, sinWave(0.1, 0.5, 1, 0), 160, easeMid, true));
        this.setupGui();
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
        this.gui.add(this.density, 'n', 5, 50).name('density').listen();
        this.gui.add(this.amp, 'n', -1, 1).name('amplitude').step(0.01).listen();
        this.gui.add(this.scale, 'n', 0.8, 1.2).name('scale');
        this.gui.add(this.rotation, 'n', 0, Math.PI).name('rotation');
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

    deRes() {
        this.timeline.add(0,
            new Transition(this.density, 5, 6, easeMid, true, false)
                .then(() => this.timeline.add(0, new RandomTimer(48, 48, () => this.res(), false)))
        );
    }

    res() {
        this.timeline.add(0,
            new Transition(this.density, 11, 6, easeMid, true, false)
                .then(() => this.timeline.add(0, new RandomTimer(48, 48, () => this.deRes(), false)))
        );
    }

    drawLayer(transform, palette) {
        let dots = [];
        const count = Math.ceil(this.density.get());
        for (let i = 0; i <= count; i++) {
            const t = i / count;
            const r = t * 2.0;
            const normal = Daydream.Z_AXIS;
            const points = sampleFn(new THREE.Quaternion(), normal, r, sinWave(-this.amp.get(), this.amp.get(), 4, 0));
            const transformedPoints = points.map(p => transform(p));
            dots.push(...rasterize(transformedPoints, (p) => palette.get(t), true));
        }
        return dots;
    }

    rotate(p, axis) {
        let q = new THREE.Quaternion().setFromAxisAngle(axis, this.rotation.get());
        return p.applyQuaternion(q);
    }

    transform(p) {
        p = this.rotate(p, Daydream.Z_AXIS);
        p = this.rotate(p, Daydream.X_AXIS);
        return p;
    }

    invTransform(p) {
        p = this.rotate(p, Daydream.X_AXIS.clone().negate());
        p = this.rotate(p, Daydream.Z_AXIS.clone().negate());
        return p;
    }

    drawFrame() {
        this.timeline.step();

        let dots = [];
        dots.push(...this.drawLayer((p) => this.invTransform(p), this.basePalette)); // Base layer
        dots.push(...this.drawLayer((p) => this.transform(p), this.interferencePalette));  // Interference layer

        plotDots(null, this.filters, dots, 0, this.alpha);
    }
}
