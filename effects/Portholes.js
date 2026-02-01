
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, randomVector
} from "../geometry.js";
import { vectorPool } from "../memory.js";
import { Solids } from "../solids.js";
import { TWO_PI, MobiusParams, mobius, stereo, invStereo } from "../3dmath.js";
import { Plot } from "../plot.js";

import {
    GenerativePalette
} from "../color.js";
import {
    Timeline, Rotation, PeriodicTimer, ColorWipe, MobiusWarp
} from "../animation.js";
import { easeMid, easeInOutSin } from "../easing.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrientSlice
} from "../filters.js";

export class Portholes {
    constructor() {
        this.alpha = 0.3;
        this.numCopies = 3;

        this.palettes = [];
        for (let i = 0; i < 10; i++) {
            this.palettes.push(new GenerativePalette("circular", "triadic", "bell", "vibrant"));
        }

        this.orientations = [];
        const numSlices = 2;
        for (let i = 0; i < numSlices; i++) {
            this.orientations.push(new Orientation());
        }
        this.baseMesh = Solids.snubCube();
        this.hemisphereAxis = new THREE.Vector3(0, 1, 0);
        this.timeline = new Timeline();

        // Parameters
        this.offsetRadius = 50 / Daydream.W;
        this.offsetSpeed = 1.0;
        this.t = 0;

        this.mobiusParams = new MobiusParams();

        this.filters = createRenderPipeline(
            new FilterOrientSlice(this.orientations, this.hemisphereAxis),
            new FilterAntiAlias()
        );

        // Animations
        this.timeline.add(0, new PeriodicTimer(48, () => this.colorWipe()));
        this.timeline.add(0, new PeriodicTimer(160, () => this.spinSlices(), true));
        this.timeline.add(0, new MobiusWarp(this.mobiusParams, 160, true));

        this.setupGui();
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
        this.gui.add(this, 'offsetRadius', 0.0, 0.2).name('Offset Radius').listen();
        this.gui.add(this, 'offsetSpeed', 0.0, 5.0).name('Offset Speed').listen();
        this.gui.add(this, 'numCopies', 1, 10, 1).name('Num Copies').listen();
    }

    colorWipe() {
        for (let i = 0; i < this.palettes.length; i++) {
            const nextPalette = new GenerativePalette("straight", "triadic", "ascending");
            this.timeline.add(0,
                new ColorWipe(this.palettes[i], nextPalette, 80, easeMid)
            );
        }
    }

    // Helper to apply offset to vertices
    getDisplacedMesh(angleOffset) {
        const vertices = this.baseMesh.vertices.map((v, i) => {
            const p = vectorPool.acquire().copy(v);

            // Create basis for tangent plane
            const axis = (Math.abs(p.y) > 0.99) ? Daydream.X_AXIS : Daydream.Y_AXIS;
            let u = vectorPool.acquire().crossVectors(p, axis).normalize();
            let vBasis = vectorPool.acquire().crossVectors(p, u).normalize();

            // Time based offset in tangent plane
            const phase = i * 0.1;
            const angle = this.t * this.offsetSpeed * TWO_PI + phase + angleOffset;
            const r = this.offsetRadius;
            const offset = vectorPool.acquire().copy(u).multiplyScalar(Math.cos(angle)).addScaledVector(vBasis, Math.sin(angle)).multiplyScalar(r);
            return p.add(offset).normalize();
        });

        return { vertices, faces: this.baseMesh.faces };
    }

    drawFrame() {
        this.timeline.step();
        this.t += 0.01; // Global time

        const transform = (p) => {
            const z = stereo(p);
            const w = mobius(z, this.mobiusParams);
            return invStereo(w, vectorPool.acquire());
        };

        for (let i = 0; i < this.numCopies; i++) {
            const offset = (i / this.numCopies) * TWO_PI;
            const mesh = this.getDisplacedMesh(offset);
            const edges = Plot.Mesh.sample(mesh, 10);

            const palette = this.palettes[i % this.palettes.length];
            const colorFn = (v, t) => {
                const c = palette.get(t);
                c.alpha *= this.alpha;
                return c;
            };

            for (const edge of edges) {
                const transformed = edge.map(transform);
                Plot.rasterize(this.filters, transformed, colorFn);
            }
        }
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

