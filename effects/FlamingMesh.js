/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { Daydream } from "../driver.js";
import { BasicEffect } from "./BasicEffect.js";
import { Solids } from "../solids.js";
import { Palettes } from "../palettes.js";
import { Plot } from "../plot.js";
import {
    createRenderPipeline,
    Filter,
} from "../filters.js";
import FastNoiseLite from "../FastNoiseLite.js";
import { gui } from "gui";

export class FlamingMesh extends BasicEffect {
    constructor() {
        super();

        this.params = {
            temporalEnabled: true,
            windowSize: 8,
            delayBase: 10,
            delayAmp: 10,
            speed: 1.0,
            noiseFreq: 0.125
        };

        this.filterTemporal = new Filter.Screen.Temporal((x, y) => this.delayNoiseWarp(x, y), this.params.windowSize);
        this.filters = createRenderPipeline(
            new Filter.World.Orient(this.orientation),
            this.filterTemporal,
            new Filter.Screen.AntiAlias(),
        );
        this.mesh = Solids.get('dodecahedron');
        this.palette = Palettes.richSunset;

        this.noise = new FastNoiseLite();
        this.noise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
        this.noise.SetFrequency(this.params.noiseFreq);

        this.setupGui();

        this.spawnEntity();
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });
        const folder = this.gui.addFolder('Temporal Settings');
        folder.add(this.params, 'temporalEnabled').name('Enable Delay');
        folder.add(this.params, 'windowSize', 1, Daydream.W / 2, 1).name('Window Size').onChange(v => {
            this.filterTemporal.windowSize = v;
        });
        folder.add(this.params, 'delayBase', 0, 10).name('Delay Base');
        folder.add(this.params, 'delayAmp', 0, 5).name('Delay Amp');
        folder.add(this.params, 'speed', 0, 5).name('Speed');
        folder.add(this.params, 'noiseFreq', 0.001, 1).name('Noise Freq').onChange(v => {
            this.noise.SetFrequency(v);
        });
        folder.open();
    }

    delayNoiseWarp(x, y) {
        if (!this.params.temporalEnabled) return 0;
        const noiseVal = this.noise.GetNoise(x, y, this.timeline.t * this.params.speed);
        return Math.max(0, this.params.delayBase + (noiseVal * 0.5 + 0.5) * this.params.delayAmp);
    }

    drawEntity(entity, opacity) {
        const fragmentShader = (v, frag) => {
            const c = this.palette.get(v.y * 0.5 + 0.5);
            frag.color = c;
            frag.color.alpha = 1;
        }
        Plot.Mesh.draw(this.filters, this.mesh, fragmentShader);
    }
}
