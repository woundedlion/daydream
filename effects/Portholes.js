
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, randomVector, vectorPool
} from "../geometry.js";
import { Solids } from "../solids.js";
import { TWO_PI } from "../3dmath.js";
import { Plot } from "../plot.js";

import {
    GenerativePalette
} from "../color.js";
import {
    Timeline, easeMid, Rotation, PeriodicTimer, ColorWipe, easeInOutSin
} from "../animation.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrientSlice
} from "../filters.js";

export class Portholes {
    constructor() {
        this.alpha = 0.3;

        this.basePalette = new GenerativePalette("circular", "analogous", "bell", "vibrant");
        this.interferencePalette = new GenerativePalette("circular", "analogous", "cup", "vibrant");

        this.orientations = [];
        const numSlices = 2;
        for (let i = 0; i < numSlices; i++) {
            this.orientations.push(new Orientation());
        }
        this.baseMesh = Solids.dodecahedron();
        this.hemisphereAxis = new THREE.Vector3(0, 1, 0);
        this.timeline = new Timeline();

        // Parameters
        this.offsetRadius = 5 / Daydream.W;
        this.offsetSpeed = 2.0;
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
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
        this.gui.add(this, 'offsetRadius', 0.0, 0.2).name('Offset Radius').listen();
        this.gui.add(this, 'offsetSpeed', 0.0, 5.0).name('Offset Speed').listen();
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

    // Helper to apply offset to vertices for the interference layer
    getInterferenceMesh() {
        const vertices = this.baseMesh.vertices.map((v, i) => {
            const p = vectorPool.acquire().copy(v);

            // Create basis for tangent plane
            const axis = (Math.abs(p.y) > 0.99) ? Daydream.X_AXIS : Daydream.Y_AXIS;
            let u = vectorPool.acquire().crossVectors(p, axis).normalize();
            let vBasis = vectorPool.acquire().crossVectors(p, u).normalize();

            // Time based offset in tangent plane
            const phase = i * 0.1;
            const angle = this.t * this.offsetSpeed * TWO_PI + phase;
            const r = this.offsetRadius;
            const offset = vectorPool.acquire().copy(u).multiplyScalar(Math.cos(angle)).addScaledVector(vBasis, Math.sin(angle)).multiplyScalar(r);
            return p.add(offset).normalize();
        });

        return { vertices, faces: this.baseMesh.faces };
    }

    drawFrame() {
        this.timeline.step();
        this.t += 0.01; // Global time

        // Color functions
        const baseColorFn = (v, t) => {
            const c = this.basePalette.get(t);
            c.alpha *= this.alpha;
            return c;
        };

        const interferenceColorFn = (v, t) => {
            const c = this.interferencePalette.get(t);
            c.alpha *= this.alpha;
            return c;
        };

        // Draw Base Mesh
        Plot.Mesh.draw(this.filters, this.baseMesh, baseColorFn);

        // Draw Interference Mesh
        const interferenceMesh = this.getInterferenceMesh();
        Plot.Mesh.draw(this.filters, interferenceMesh, interferenceColorFn);
    }

    spinSlices() {
        let axis = randomVector().clone();
        this.hemisphereAxis.copy(axis);

        // Spin alternating directions over 5 seconds (80 frames)
        for (let i = 0; i < this.orientations.length; i++) {
            const direction = (i % 2 === 0) ? 1 : -1;
            this.timeline.add(0, new Rotation(this.orientations[i], axis, direction * TWO_PI, 80, easeInOutSin, false));
        }
    }
}

