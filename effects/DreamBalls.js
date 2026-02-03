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
        this.currentPreset = Object.keys(DreamBalls.presets)[0];
        this.mobiusParams = new MobiusParams();

        // Filters
        this.sliceFilter = new FilterOrientSlice(this.orientations, this.hemisphereAxis);
        this.sliceFilter.enabled = this.enableSlice;
        this.filters = createRenderPipeline(
            this.sliceFilter,
            new FilterAntiAlias()
        );

        this.timeline.add(9, new RandomWalk(this.globalOrientation, Daydream.UP));
        this.timeline.add(0, new PeriodicTimer(160, () => this.spinSlices(), true));
        this.startWarp();
        this.nextPreset();
        this.setupGui();
    }

    loadSolid(name) {
        this.baseMesh = Solids[name]();

        // Pre-allocate the reusable displaced mesh to avoid GC
        this.displacedMesh = {
            faces: this.baseMesh.faces,
            vertices: this.baseMesh.vertices.map(v => new THREE.Vector3())
        };

        // Pre-compute tangents (u, vBasis) for every vertex
        this.tangents = this.baseMesh.vertices.map(p => {
            const axis = (Math.abs(p.y) > 0.99) ? Daydream.X_AXIS : Daydream.Y_AXIS;
            const u = new THREE.Vector3().crossVectors(p, axis).normalize();
            const vBasis = new THREE.Vector3().crossVectors(p, u).normalize();
            return { u, v: vBasis };
        });
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
        this.loadSolid(params.solidName);
        const baseMesh = this.baseMesh;
        const tangents = this.tangents;
        const spriteMesh = this.displacedMesh;

        const mobiusParams = new MobiusParams();
        const warpAnim = new MobiusWarp(mobiusParams, 200, params.warpScale, true);

        const drawFn = (opacity) => {
            warpAnim.step();
            this.drawScene(params, opacity, baseMesh, spriteMesh, tangents, mobiusParams);
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
        this.paramFolder.add(this, 'currentPreset', [...Object.keys(DreamBalls.presets), 'Custom']).name('Preset').listen().onChange(v => {
            if (v !== 'Custom') {
                Object.assign(this.params, DreamBalls.presets[v]);
                this.loadSolid(this.params.solidName);
                if (this.warpAnim) this.warpAnim.scale = this.params.warpScale;
            }
        });

        const manualChange = () => { this.currentPreset = 'Custom'; };

        this.paramFolder.add(this.params, 'alpha').min(0).max(1).step(0.01).onChange(manualChange);
        this.paramFolder.add(this.params, 'offsetRadius', 0.0, 0.2).listen().onChange(manualChange);
        this.paramFolder.add(this.params, 'offsetSpeed', 0.0, 5.0).listen().onChange(manualChange);
        this.paramFolder.add(this.params, 'numCopies', 1, 10, 1).listen().onChange(manualChange);
        this.paramFolder.add(this.params, 'solidName', Object.keys(Solids)).onChange((v) => {
            this.loadSolid(v);
            manualChange();
        });
        this.paramFolder.add(this.params, 'warpScale', 0.1, 5.0).onChange(v => {
            if (this.warpAnim) this.warpAnim.scale = v;
            manualChange();
        });
        this.paramFolder.open();
        if (this.runPresets) this.paramFolder.domElement.style.display = 'none';
    }

    drawScene(params, opacity, baseMesh, targetMesh, tangents, mobiusParams) {
        const transform = (p) => this.globalOrientation.orient(mobiusTransform(p, mobiusParams));
        const palette = params.palette;
        const colorFn = (v, t) => {
            const val = (t.v0 !== undefined) ? t.v0 : t;
            const c = palette.get(val);
            c.alpha *= params.alpha * opacity;
            return c;
        };

        for (let i = 0; i < params.numCopies; i++) {
            const offset = (i / params.numCopies) * TWO_PI;
            this.updateDisplacedMesh(baseMesh, targetMesh, tangents, params, offset);
            Plot.Mesh.draw(this.filters, targetMesh, colorFn, 0, transform);
        }
    }

    updateDisplacedMesh(base, target, tangents, params, angleOffset) {
        const count = base.vertices.length;
        const r = params.offsetRadius;
        const speed = params.offsetSpeed;

        for (let i = 0; i < count; i++) {
            const v = base.vertices[i];
            const t = tangents[i];

            // Phase calculation
            const phase = i * 0.1;
            const angle = this.t * speed * TWO_PI + phase + angleOffset;

            // Math: P = v + u*cos + v*sin
            const cosA = Math.cos(angle);
            const sinA = Math.sin(angle);

            // Update target vertex in place
            const out = target.vertices[i];
            out.x = v.x + (t.u.x * cosA + t.v.x * sinA) * r;
            out.y = v.y + (t.u.y * cosA + t.v.y * sinA) * r;
            out.z = v.z + (t.u.z * cosA + t.v.z * sinA) * r;
            out.normalize();
        }
    }

    drawFrame() {
        this.timeline.step();
        this.t += 0.01;

        if (!this.runPresets) {
            this.warpAnim.step();
            this.drawScene(this.params, 1.0, this.baseMesh, this.displacedMesh, this.tangents, this.mobiusParams);
        }
    }

    spinSlices() {
        let axis = randomVector().clone();
        this.hemisphereAxis.copy(axis);
        for (let i = 0; i < this.orientations.length; i++) {
            const direction = (i % 2 === 0) ? 1 : -1;
            this.timeline.add(0, new Rotation(this.orientations[i], axis, direction * TWO_PI, 80, easeInOutSin, false));
        }
    }
}