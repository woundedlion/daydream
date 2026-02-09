import * as THREE from "three";
import { GUI } from "gui";
import { Daydream } from "../driver.js";
import { MobiusParams } from "../3dmath.js";
import { Timeline, MobiusGenerate, Orientation, RandomWalk } from "../animation.js";
import { createRenderPipeline } from "../filters.js";
import { Scan } from "../scan.js";
import { gnomonicMobiusTransform, fibSpiral, makeBasis } from "../geometry.js";
import { Palettes } from "../palettes.js";

export class GnomonicStars {
    constructor() {
        this.params = new MobiusParams(1, 0, 0, 0, 0, 0, 1, 0);
        this.timeline = new Timeline();
        this.orientation = new Orientation();

        // Generate Animation (Chaos)
        this.genParams = {
            scale: 0.5,
            speed: 0.05
        };
        this.generator = new MobiusGenerate(this.params, this.genParams.scale, this.genParams.speed);
        this.timeline.add(0, this.generator);
        this.timeline.add(0, new RandomWalk(this.orientation, Daydream.UP, RandomWalk.Brisk));

        // Spiral parameters
        this.spiralParams = {
            points: 600,
            starRadius: 0.02,
            starSides: 4,
        };

        this.filters = createRenderPipeline();
        this.setupGui();
    }

    setupGui() {
        this.gui = new GUI({ autoPlace: false });

        this.params.enableTransform = true;

        const f1 = this.gui.addFolder('Poincare / Mobius');
        f1.add(this.params, 'enableTransform').name('Enable Transform');
        f1.add(this.genParams, 'scale', 0, 2).name('Chaos Scale').onChange(v => this.generator.scale = v);
        f1.add(this.genParams, 'speed', 0, 0.2).name('Chaos Speed').onChange(v => this.generator.speed = v);

        f1.add(this.params, 'aRe').min(-2).max(2).step(0.01).listen();
        f1.add(this.params, 'aIm').min(-2).max(2).step(0.01).listen();
        f1.add(this.params, 'bRe').min(-2).max(2).step(0.01).listen();
        f1.add(this.params, 'bIm').min(-2).max(2).step(0.01).listen();
        f1.add(this.params, 'cRe').min(-2).max(2).step(0.01).listen();
        f1.add(this.params, 'cIm').min(-2).max(2).step(0.01).listen();
        f1.add(this.params, 'dRe').min(-2).max(2).step(0.01).listen();
        f1.add(this.params, 'dIm').min(-2).max(2).step(0.01).listen();
        f1.open();

        const f2 = this.gui.addFolder('Spiral (Stars)');
        f2.add(this.spiralParams, 'points').min(10).max(1000).step(10);
        f2.add(this.spiralParams, 'starRadius').min(0.01).max(0.5).step(0.01);
        f2.add(this.spiralParams, 'starSides').min(3).max(12).step(1);
        f2.open();
    }

    drawFrame() {
        this.timeline.step();

        const fragmentShader = (p, frag) => {
            const t = (p.y + 1) * 0.5; // Map [-1, 1] to [0, 1]
            const c = Palettes.mangoPeel.get(t);
            frag.color.copy(c);
        };

        const points = this.spiralParams.points;
        const identity = new THREE.Quaternion().identity();

        for (let i = 0; i < points; i++) {
            const v = fibSpiral(points, 0, i);

            if (this.params.enableTransform) {
                gnomonicMobiusTransform(v, this.params, v);
            }

            this.orientation.orient(v, 0, v);
            const basis = makeBasis(identity, v);
            Scan.Star.draw(
                this.filters,
                basis,
                this.spiralParams.starRadius,
                this.spiralParams.starSides,
                fragmentShader
            );
        }
    }
}
