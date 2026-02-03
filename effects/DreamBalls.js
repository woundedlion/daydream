
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Timeline, Rotation, PeriodicTimer, MobiusWarp, Orientation,
    RandomWalk, Sprite
} from "../animation.js";
import { easeMid, easeInOutSin } from "../easing.js";
import {
    createRenderPipeline, FilterAntiAlias, FilterOrientSlice
} from "../filters.js";
import { AlphaFalloffPalette } from "../color.js";
import { Solids } from "../solids.js";
import { MobiusParams, TWO_PI } from "../3dmath.js";
import { vectorPool } from "../memory.js";
import { mobiusTransform, randomVector } from "../geometry.js";
import { Plot } from "../plot.js";
import { Palettes } from "../palettes.js";

export class DreamBalls {

    static presets = {
        netBall: {
            solidName: 'rhombicosidodecahedron',
            numCopies: 6,
            offsetRadius: 0.05,
            offsetSpeed: 1.0,
            warpScale: 1.8,
            palette: new AlphaFalloffPalette((t) => 1.0 - t, Palettes.bloodStream),
            alpha: 0.7,
        },

        elvenMachinery: {
            solidName: 'truncatedCuboctahedron',
            numCopies: 6,
            offsetRadius: 0.16,
            offsetSpeed: 1.0,
            warpScale: 2.0,
            palette: Palettes.richSunset,
            alpha: 0.3,
        },

        globeKnot: {
            solidName: 'icosidodecahedron',
            numCopies: 10,
            offsetRadius: 0.16,
            offsetSpeed: 1.0,
            warpScale: 0.5,
            palette: Palettes.lavenderLake,
            alpha: 0.3,
        }
    }


    constructor() {
        this.presets = Object.values(DreamBalls.presets);
        this.presetIndex = 0;

        // Keep params for potential GUI use or debugging, initialized to first preset
        this.params = { ...this.presets[0] };

        this.globalOrientation = new Orientation();
        this.orientations = [];
        const numSlices = 2;
        for (let i = 0; i < numSlices; i++) {
            this.orientations.push(new Orientation());
        }

        this.hemisphereAxis = new THREE.Vector3(0, 1, 0);
        this.timeline = new Timeline();

        this.enableSlice = false;
        this.t = 0;

        // Manual mode state
        this.runPresets = true;
        this.currentPreset = Object.keys(DreamBalls.presets)[0]; // Default selection
        this.mobiusParams = new MobiusParams();
        this.baseMesh = Solids[this.params.solidName]();
        this.startWarp();

        this.sliceFilter = new FilterOrientSlice(this.orientations, this.hemisphereAxis);
        this.sliceFilter.enabled = this.enableSlice;
        this.filters = createRenderPipeline(
            this.sliceFilter,
            new FilterAntiAlias()
        );

        // Animations
        this.timeline.add(9, new RandomWalk(this.globalOrientation, Daydream.UP));
        this.timeline.add(0, new PeriodicTimer(160, () => this.spinSlices(), true));
        this.nextPreset();
        this.setupGui();
    }

    startWarp() {
        if (this.warpAnim) this.warpAnim.cancel();
        this.warpAnim = new MobiusWarp(this.mobiusParams, 200, this.params.warpScale, true);
    }

    nextPreset() {
        if (!this.runPresets) return;
        const preset = this.presets[this.presetIndex];
        this.presetIndex = (this.presetIndex + 1) % this.presets.length;
        this.spawnSprite(preset);
    }

    spawnSprite(params) {
        const baseMesh = Solids[params.solidName]();
        const mobiusParams = new MobiusParams();
        const warpAnim = new MobiusWarp(mobiusParams, 200, params.warpScale, true);
        const palette = params.palette;

        const drawFn = (opacity) => {
            warpAnim.step();
            this.drawScene(params, opacity, baseMesh, mobiusParams);
        };
        this.timeline.add(0, new Sprite(drawFn, 320, 32, easeMid, 32, easeMid));
        this.timeline.add(320 - 32, new PeriodicTimer(0, () => this.nextPreset(), false));
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'runPresets').name('Run Presets').onChange(v => {
            if (v) {
                this.paramFolder.domElement.style.display = 'none';
                this.nextPreset();
            } else {
                this.paramFolder.domElement.style.display = '';
                this.startWarp();
            }
        });
        this.gui.add(this, 'enableSlice').name('Slice').onChange(v => {
            this.sliceFilter.enabled = v;
        });

        this.paramFolder = this.gui.addFolder('Manual Params');
        const presetNames = Object.keys(DreamBalls.presets);
        this.paramFolder.add(this, 'currentPreset', [...presetNames, 'Custom']).name('Preset').listen().onChange(v => {
            if (v !== 'Custom') {
                Object.assign(this.params, p);
                this.baseMesh = Solids[this.params.solidName]();
                if (this.warpAnim) this.warpAnim.scale = this.params.warpScale;
            }
        });

        const manualChange = () => {
            this.currentPreset = 'Custom';
        };

        this.paramFolder.add(this.params, 'alpha').min(0).max(1).step(0.01).onChange(manualChange);
        this.paramFolder.add(this.params, 'offsetRadius', 0.0, 0.2).name('Offset Radius').listen().onChange(manualChange);
        this.paramFolder.add(this.params, 'offsetSpeed', 0.0, 5.0).name('Offset Speed').listen().onChange(manualChange);
        this.paramFolder.add(this.params, 'numCopies', 1, 10, 1).name('Num Copies').listen().onChange(manualChange);
        this.paramFolder.add(this.params, 'solidName', Object.keys(Solids)).name("Solid").onChange((v) => {
            this.baseMesh = Solids[v]();
            manualChange();
        });
        this.paramFolder.add(this.params, 'warpScale', 0.1, 5.0).name('Warp Scale').onChange(v => {
            if (this.warpAnim) this.warpAnim.scale = v;
            manualChange();
        });

        this.paramFolder.open();

        if (this.runPresets) {
            this.paramFolder.domElement.style.display = 'none';
        }
    }

    drawScene(params, opacity, baseMesh, mobiusParams) {
        const transform = (p) => this.globalOrientation.orient(mobiusTransform(p, mobiusParams));
        const palette = params.palette;
        const colorFn = (v, t) => {
            const c = palette.get(t);
            c.alpha *= params.alpha * opacity;
            return c;
        };

        for (let i = 0; i < params.numCopies; i++) {
            const offset = (i / params.numCopies) * TWO_PI;
            const mesh = this.getDisplacedMesh(baseMesh, params, offset);
            Plot.Mesh.draw(this.filters, mesh, colorFn, 0, transform);
        }
    }



    // Helper to apply offset to vertices
    getDisplacedMesh(baseMesh, params, angleOffset) {
        const vertices = baseMesh.vertices.map((v, i) => {
            const p = vectorPool.acquire().copy(v);

            // Create basis for tangent plane
            const axis = (Math.abs(p.y) > 0.99) ? Daydream.X_AXIS : Daydream.Y_AXIS;
            let u = vectorPool.acquire().crossVectors(p, axis).normalize();
            let vBasis = vectorPool.acquire().crossVectors(p, u).normalize();

            // Time based offset in tangent plane
            const phase = i * 0.1;
            const angle = this.t * params.offsetSpeed * TWO_PI + phase + angleOffset;
            const r = params.offsetRadius;
            const offset = vectorPool.acquire().copy(u).multiplyScalar(Math.cos(angle)).addScaledVector(vBasis, Math.sin(angle)).multiplyScalar(r);
            return p.add(offset).normalize();
        });

        return { vertices, faces: baseMesh.faces };
    }

    drawFrame() {
        this.timeline.step();
        this.t += 0.01; // Global time

        if (!this.runPresets) {
            this.warpAnim.step();
            this.drawScene(this.params, 1.0, this.baseMesh, this.mobiusParams);
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

