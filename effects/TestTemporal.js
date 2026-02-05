/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * LICENSE: ALL RIGHTS RESERVED. No redistribution or use without explicit permission.
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { Timeline, Orientation, Rotation, RandomWalk } from "../animation.js";
import { Plot } from "../plot.js";
import { Solids } from "../solids.js";
import { Palettes } from "../palettes.js";
import FastNoiseLite from "../FastNoiseLite.js";
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
        this.timeline.add(0, new RandomWalk(this.orientation, Daydream.UP));

        // Parameter Storage
        this.params = {
            Global: {
                temporalEnabled: true,
                windowSize: 2,
                speed: 0.01,
            },
            'Vertical Wave': { delayBase: 8, delayAmp: 4, frequency: 0.3 },
            'Diagonal Spiral': { delayBase: 8, delayAmp: 4, xSpirals: 2.0, yFreq: 0.3 },
            'Liquid Time': { delayBase: 8, delayAmp: 4, noiseFreq: 0.03, timeScale: 2.0 },
            'Quantum Tunnel': { delayBase: 8, delayAmp: 4, spiralTightness: 10.0, spiralAngle: 5.0 },
            'Datamosh': { delayBase: 8, delayAmp: 4, flowSpeed: 0.1, glitchScale: 15.0 }
        };

        this.t = 0;

        // Noise for Liquid Time
        this.noise = new FastNoiseLite();
        this.noise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
        this.noise.SetFrequency(this.params['Liquid Time'].noiseFreq);

        // Setup PipelineModes
        this.delayModes = {
            'Vertical Wave': this.delayVerticalWave.bind(this),
            'Diagonal Spiral': this.delayDiagonalSpiral.bind(this),
            'Liquid Time': this.delayLiquidTime.bind(this),
            'Quantum Tunnel': this.delayQuantumTunnel.bind(this),
            'Datamosh': this.delayDatamosh.bind(this)
        };
        this.currentDelayMode = 'Vertical Wave';

        this.filterTemporal = new FilterTemporal(this.delayModes[this.currentDelayMode], this.params.Global.windowSize, 200);

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

    delayVerticalWave(x, y) {
        const p = this.params.Global;
        if (!p.temporalEnabled) return 0;
        const ep = this.params['Vertical Wave'];

        const phase = y * ep.frequency + this.t * p.speed;
        return Math.max(0, ep.delayBase + Math.sin(phase) * ep.delayAmp);
    }

    delayDiagonalSpiral(x, y) {
        const p = this.params.Global;
        if (!p.temporalEnabled) return 0;
        const ep = this.params['Diagonal Spiral'];

        // Create a diagonal phase by adding X and Y
        const xPhase = (x / Daydream.W) * Math.PI * 2 * ep.xSpirals;
        const yPhase = y * ep.yFreq;

        const phase = xPhase + yPhase + this.t * p.speed;
        return Math.max(0, ep.delayBase + Math.sin(phase) * ep.delayAmp);
    }

    delayLiquidTime(x, y) {
        const p = this.params.Global;
        if (!p.temporalEnabled) return 0;
        const ep = this.params['Liquid Time'];

        // 3D Noise: X, Y, and Time
        const noiseVal = this.noise.GetNoise(x, y, this.t * ep.timeScale);

        return ep.delayBase + (noiseVal + 1.0) * 0.5 * ep.delayAmp;
    }

    delayQuantumTunnel(x, y) {
        const p = this.params.Global;
        if (!p.temporalEnabled) return 0;
        const ep = this.params['Quantum Tunnel'];

        // Normalize coordinates to -1..1
        const u = (x / Daydream.W) * 2 - 1;
        const v = (y / Daydream.H) * 2 - 1;

        // Polar coordinates
        const radius = Math.sqrt(u * u + v * v);
        const angle = Math.atan2(v, u);

        const spiral = Math.sin(radius * ep.spiralTightness - angle * ep.spiralAngle + this.t * p.speed);

        return Math.max(0, ep.delayBase + (spiral + 1) * ep.delayAmp);
    }

    delayDatamosh(x, y) {
        const p = this.params.Global;
        if (!p.temporalEnabled) return 0;
        const ep = this.params['Datamosh'];

        // 1. Base smooth wave (vertical flow)
        const flow = Math.sin(y * ep.flowSpeed + this.t * 0.05); // Keep t multiplier static or add param? Keeping static for glitch feel

        // 2. Column Glitch
        const blockSize = 8;
        const column = Math.floor(x / blockSize);
        const glitchOffset = Math.sin(column * 12.9898) * ep.glitchScale;

        // Combine
        const total = flow * 10.0 + glitchOffset;

        return Math.max(0, ep.delayBase + Math.abs(total) % ep.delayAmp);
    }

    updateBlur() {
        this.filterBlur.update(this.blurEnabled ? this.blurStrength : 0);
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });

        this.gui.add(this, 'solidName', Object.keys(Solids)).name('Solid').onChange(v => {
            this.mesh = Solids[v]();
        });

        // 1. Selector and Global Params
        const globalFolder = this.gui.addFolder('Temporal Settings');

        globalFolder.add(this.params.Global, 'temporalEnabled').name('Enable Delay');

        globalFolder.add(this, 'currentDelayMode', Object.keys(this.delayModes))
            .name('Delay Mode')
            .onChange(v => {
                this.filterTemporal.ttlFn = this.delayModes[v];
                this.refreshEffectParams();
            });

        globalFolder.add(this.params.Global, 'windowSize', 1, 8).name('Window Size').onChange(v => {
            this.filterTemporal.windowSize = v;
        });

        globalFolder.add(this.params.Global, 'speed', 0, 0.2).name('Master Speed');

        globalFolder.open();

        // 2. Dynamic Effect Params Folder
        this.effectFolder = this.gui.addFolder('Effect Params');
        this.effectParamsControllers = [];
        this.refreshEffectParams();
        this.effectFolder.open();
    }

    refreshEffectParams() {
        // Clear existing controllers
        for (const c of this.effectParamsControllers) {
            this.effectFolder.remove(c);
        }
        this.effectParamsControllers = [];

        const mode = this.currentDelayMode;
        const params = this.params[mode];

        if (!params) return;

        // Add controllers based on the current mode's parameters
        const keys = Object.keys(params);
        for (const key of keys) {
            let c;
            // Heuristic range setting
            if (key.includes('Freq') || key.includes('flow')) {
                c = this.effectFolder.add(params, key, 0, 1.0);
            } else if (key.includes('Amp') || key.includes('Base') || key.includes('Scale') || key.includes('Tightness') || key.includes('Angle')) {
                c = this.effectFolder.add(params, key, 0, 60);
            } else if (key.includes('Spirals')) {
                c = this.effectFolder.add(params, key, 0, 10);
            } else {
                c = this.effectFolder.add(params, key);
            }
            c.name(key);

            // Special case updates
            if (key === 'noiseFreq') {
                c.onChange(v => this.noise.SetFrequency(v));
            }

            this.effectParamsControllers.push(c);
        }
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

