import * as THREE from "three";
import { GUI } from "gui";
import { Daydream } from "../driver.js";
import { MobiusParams } from "../3dmath.js";
import { Timeline, Mutation } from "../animation.js";
import { createRenderPipeline } from "../filters.js"; // No FilterAntiAlias
import { Scan } from "../scan.js";
import { poincareTransform, fibSpiral, makeBasis } from "../geometry.js";
import { vectorPool } from "../memory.js";
import { easeMid } from "../easing.js";
import { sinWave } from "../geometry.js";
import { Palettes } from "../palettes.js";

export class TestPoincare {
    constructor() {
        this.params = new MobiusParams(1, 0, 0, 0, 0, 0, 1, 0);
        this.timeline = new Timeline();

        // Spiral parameters
        this.spiralParams = {
            points: 200,
            starRadius: 0.05,
            starSides: 5,
        };

        // Filters - No AntiAlias as requested
        this.filters = createRenderPipeline();

        this.setupGui();
    }

    setupGui() {
        this.gui = new GUI({ autoPlace: false });

        this.params.enableTransform = true;

        const f1 = this.gui.addFolder('Poincare / Mobius');
        f1.add(this.params, 'enableTransform').name('Enable Transform');
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
            // Use lavenderLake palette based on y-coordinate (or some measure)
            const t = (p.y + 1) * 0.5; // Map [-1, 1] to [0, 1]
            const c = Palettes.lavenderLake.get(t);
            frag.color.copy(c);
        };

        const points = this.spiralParams.points;
        const identity = new THREE.Quaternion().identity();

        for (let i = 0; i < points; i++) {
            const v = fibSpiral(points, 0, i);

            // Apply Poincare Transform (Gnomonic -> Mobius -> InvGnomonic)
            if (this.params.enableTransform) {
                // We use v as both input and target.
                // Note: v is from a pool inside fibSpiral? No, fibSpiral returns a pooled vector.
                // We should be careful not to mutate it if it's reused... 
                // Wait, fibSpiral acquires a NEW vector from pool. So safe to mutate.
                poincareTransform(v, this.params, v);
            }

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
