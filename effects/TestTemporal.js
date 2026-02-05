
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
    FilterTemporal,
} from "../filters.js";

export class TestTemporal {
    constructor() {
        // Setup Timeline and Orientation
        this.timeline = new Timeline();
        this.orientation = new Orientation();
        this.timeline.add(0, new RandomWalk(this.orientation, new THREE.Vector3(0, 1, 0)));

        // Setup Temporal Parameters
        this.delayBase = 8;
        this.delayAmp = 4;
        this.delayFreq = 0.3;
        this.delaySpeed = 0.01;
        this.windowSize = 2;

        this.temporalEnabled = true;

        this.t = 0;

        // Setup Pipeline
        this.filterTemporal = new FilterTemporal(this.delayFn.bind(this), this.windowSize, 10);

        this.filterOrient = new FilterOrient(this.orientation);
        this.filterAA = new FilterAntiAlias();

        this.filters = createRenderPipeline(
            this.filterOrient,
            this.filterTemporal,
            this.filterAA
        );

        // Load Mesh
        this.solidName = 'icosahedron';
        this.mesh = Solids[this.solidName]();

        this.setupGui();
    }

    delayFn(x, y) {
        if (!this.temporalEnabled) return 0;
        const phase = y * this.delayFreq + this.t * this.delaySpeed;
        return Math.max(0, this.delayBase + Math.sin(phase) * this.delayAmp);
    }

    updateBlur() {
        this.filterBlur.update(this.blurEnabled ? this.blurStrength : 0);
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });

        this.gui.add(this, 'solidName', Object.keys(Solids)).name('Solid').onChange(v => {
            this.mesh = Solids[v]();
        });

        const folder = this.gui.addFolder('Temporal Settings');
        folder.add(this, 'temporalEnabled').name('Enable Temporal Displacement');
        folder.add(this, 'delayBase', 0, 60).name('Base Delay');
        folder.add(this, 'delayAmp', 0, 60).name('Amplitude');
        folder.add(this, 'delayFreq', 0, 0.5).name('Frequency');
        folder.add(this, 'delaySpeed', 0, 0.2).name('Speed');
        folder.add(this, 'windowSize', 1, 8).name('Window Size').onChange(v => {
            this.filterTemporal.windowSize = v;
        });
        folder.open();

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

