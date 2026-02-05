
import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { Timeline, Orientation, RandomWalk } from "../animation.js";
import { Plot } from "../plot.js";
import { Solids } from "../solids.js";
import { Palettes } from "../palettes.js";
import {
    createRenderPipeline,
    FilterAntiAlias,
    FilterOrient,
    TemporalFilter,
    FilterGaussianBlur
} from "../filters.js";

export class TestTemporal {
    constructor() {
        // Setup Timeline and Orientation
        this.timeline = new Timeline();
        this.orientation = new Orientation();
        this.timeline.add(0, new RandomWalk(this.orientation, new THREE.Vector3(0, 1, 0)));

        // Setup Temporal Parameters
        this.delayBase = 10;
        this.delayAmp = 20;
        this.delayFreq = 0.05;
        this.delaySpeed = 0.02;
        this.delayNoise = 2;

        this.temporalEnabled = true;

        this.noiseEnabled = true;

        this.blurEnabled = true;
        this.blurStrength = 0.25;

        this.t = 0;

        // Setup Pipeline
        this.temporalFilter = new TemporalFilter(this.delayFn.bind(this));

        this.filterOrient = new FilterOrient(this.orientation);
        this.filterAA = new FilterAntiAlias();
        this.filterBlur = new FilterGaussianBlur(this.blurEnabled ? this.blurStrength : 0);

        this.filters = createRenderPipeline(
            this.filterOrient,
            this.temporalFilter,
            this.filterBlur,
            this.filterAA
        );

        // Load Mesh
        this.mesh = Solids.rhombicuboctahedron();

        this.setupGui();
    }

    delayFn(x, y) {
        if (!this.temporalEnabled) return 0;
        const phase = y * this.delayFreq + this.t * this.delaySpeed;
        const noise = this.noiseEnabled ? (Math.random() - 0.5) * this.delayNoise : 0;
        return Math.max(0, this.delayBase + Math.sin(phase) * this.delayAmp + noise);
    }

    updateBlur() {
        this.filterBlur.update(this.blurEnabled ? this.blurStrength : 0);
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });

        const folder = this.gui.addFolder('Temporal Settings');
        folder.add(this, 'temporalEnabled').name('Enable Delay');
        folder.add(this, 'delayBase', 0, 60).name('Base Delay');
        folder.add(this, 'delayAmp', 0, 60).name('Amplitude');
        folder.add(this, 'delayFreq', 0, 0.5).name('Frequency');
        folder.add(this, 'delaySpeed', 0, 0.2).name('Speed');
        folder.open();

        const noiseFolder = this.gui.addFolder('Noise Settings');
        noiseFolder.add(this, 'noiseEnabled').name('Enable Noise');
        noiseFolder.add(this, 'delayNoise', 0, 20).name('Noise Level');
        noiseFolder.open();

        const blurFolder = this.gui.addFolder('Blur Settings');
        blurFolder.add(this, 'blurEnabled').name('Enable Blur').onChange(() => this.updateBlur());
        blurFolder.add(this, 'blurStrength', 0, 1).name('Blur Strength').onChange(() => this.updateBlur());
        blurFolder.open();
    }

    drawFrame() {
        this.timeline.step();
        this.t += 1;
        const colors = Palettes.richSunset;
        const renderMesh = (v, t) => {
            return colors.get(t);
        };

        Plot.Mesh.draw(this.filters, this.mesh, (v) => {
            // Use vertex Y for color
            return colors.get((v.y + 1) * 0.5);
        });

        this.filters.flush(null, 1.0);
    }
}
