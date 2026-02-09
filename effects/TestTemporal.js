/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { Timeline, Orientation, Rotation, RandomWalk, PaletteAnimation, PaletteBehaviors } from "../animation.js";
import { Plot } from "../plot.js";
import { Solids } from "../solids.js";
import { Palettes } from "../palettes.js";
import { Color4, AnimatedPalette, CircularPalette } from "../color.js";
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

        // Palette Setup
        this.palette = new AnimatedPalette(new CircularPalette(Palettes.richSunset));
        this.modifier = new PaletteAnimation(PaletteBehaviors.Cycle(0.02));
        this.palette.add(this.modifier);
        this.timeline.add(0, this.modifier);

        // Parameter Storage
        this.params = {
            Global: {
                temporalEnabled: true,
                windowSize: 2,
                speed: 0.01,
                lightSpeed: 0.05,
                lightAlpha: 1.0,
            },
            'Vertical Wave': { delayBase: 10, delayAmp: 5, frequency: 0.3 },
            'Diagonal Spiral': { delayBase: 12, delayAmp: 6, xSpirals: 2.0, yFreq: 0.3 },
            'Liquid Time': { delayBase: 12, delayAmp: 25, noiseFreq: 0.015, timeScale: 1.0, rippleFreq: 0.06 },
            'Quantum Tunnel': { delayBase: 5, delayAmp: 20, spiralTightness: 10.0, spiralAngle: 5.0 },
            'Datamosh': { delayBase: 20, delayAmp: 15, flowSpeed: 0.05, glitchScale: 25.0 }
        };

        this.modeDefaults = {
            'Vertical Wave': { windowSize: 2.0, speed: 0.01 },
            'Diagonal Spiral': { windowSize: 3.0, speed: 0.01 },
            'Liquid Time': { windowSize: 6.0, speed: 0.02 },
            'Quantum Tunnel': { windowSize: 4.0, speed: 0.03 },
            'Datamosh': { windowSize: 12.0, speed: 0.0 }
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

        // 1. Radial Ripples (Water surface)
        const cx = Daydream.W * 0.5;
        const cy = Daydream.H * 0.5;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

        const ripple = Math.sin(dist * ep.rippleFreq - this.t * ep.timeScale * 5.0);

        // 2. Noise (Turbulence/Organic feel)
        const noiseVal = this.noise.GetNoise(x, y, this.t * ep.timeScale);

        // Combine: Strong ripples disrupted by noise
        const combined = ripple + (noiseVal * 0.5);

        return Math.max(0, ep.delayBase + combined * ep.delayAmp);
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

                // Apply Defaults
                const defs = this.modeDefaults[v];
                if (defs) {
                    if (defs.windowSize !== undefined) this.globalCtrls.windowSize.setValue(defs.windowSize);
                    if (defs.speed !== undefined) this.globalCtrls.speed.setValue(defs.speed);
                }
            });

        this.globalCtrls = {};

        this.globalCtrls.windowSize = globalFolder.add(this.params.Global, 'windowSize', 1, 8).name('Window Size').onChange(v => {
            this.filterTemporal.windowSize = v;
        });

        this.globalCtrls.speed = globalFolder.add(this.params.Global, 'speed', 0, 0.2).name('Master Speed');
        this.globalCtrls.lightSpeed = globalFolder.add(this.params.Global, 'lightSpeed', -0.2, 0.2).name('Light Speed');
        this.globalCtrls.lightAlpha = globalFolder.add(this.params.Global, 'lightAlpha', 0, 1.0).name('Light Alpha');

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
        const colors = this.palette;
        const p = this.params.Global;

        Plot.Mesh.draw(this.filters, this.mesh, (v, frag) => {
            // Base Color
            const baseColor = colors.get((v.y + 1) * 0.5).clone();

            let phase = (this.t * p.lightSpeed) % 1.0;
            if (phase < 0) phase += 1.0;
            let dist = Math.abs(frag.v1 - phase);
            if (dist > 0.5) dist = 1.0 - dist;

            const width = 0.15;
            if (dist < width) {
                const strength = Math.pow(1.0 - (dist / width), 2);
                baseColor.lerp(new Color4(1, 1, 1, 1), strength * p.lightAlpha);
            }

            frag.color.copy(baseColor);
        });

        this.filters.flush(null, 1.0);
    }
}


