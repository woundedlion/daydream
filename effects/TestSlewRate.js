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
import {
    createRenderPipeline,
    Filter,
} from "../filters.js";

export class TestSlewRate {
    constructor() {
        // Setup Timeline and Orientation
        this.timeline = new Timeline();
        this.orientation = new Orientation();
        this.timeline.add(0, new RandomWalk(this.orientation, Daydream.UP));

        // Palette Setup
        this.palette = new AnimatedPalette(
            new CircularPalette(
                Palettes.richSunset));

        this.modifier = new PaletteAnimation(PaletteBehaviors.Cycle(0.02));
        this.palette.add(this.modifier);
        this.timeline.add(0, this.modifier);

        // Parameter Storage
        this.params = {
            mode: 'exponential',
            rise: 1.0,
            fall: 0.03,
            speed: 0.05,
            lightSize: 0.15
        };

        this.t = 0;

        // Setup Pipeline
        this.filterSlew = new Filter.Screen.Slew(this.params.rise, this.params.fall, 500000);
        this.filterSlew.mode = this.params.mode;
        this.filterOrient = new Filter.World.Orient(this.orientation);
        this.filterAA = new Filter.Screen.AntiAlias();

        this.filters = createRenderPipeline(
            this.filterOrient,
            this.filterSlew,
            this.filterAA,
        );

        // Load Mesh
        this.solidName = 'icosahedron';
        this.mesh = Solids[this.solidName]();

        this.setupGui();
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });

        this.gui.add(this, 'solidName', Object.keys(Solids)).name('Solid').onChange(v => {
            this.mesh = Solids[v]();
        });

        const folder = this.gui.addFolder('Slew Rate Settings');

        folder.add(this.params, 'mode', ['linear', 'exponential']).name('Decay Mode').onChange(v => {
            this.filterSlew.mode = v;
        });

        folder.add(this.params, 'rise', 0, 1.0, 0.001).name('Rise Rate').onChange(v => {
            this.filterSlew.rise = v;
        });

        folder.add(this.params, 'fall', 0, 1.0, 0.001).name('Fall Rate').onChange(v => {
            this.filterSlew.fall = v;
        });

        folder.add(this.params, 'speed', 0, 0.2).name('Light Speed');
        folder.add(this.params, 'lightSize', 0.01, 1.0).name('Light Size');

        folder.open();
    }

    drawFrame() {
        this.timeline.step();
        this.t += 1;
        const colors = this.palette;
        const p = this.params;

        Plot.Mesh.draw(this.filters, this.mesh, (v, frag) => {
            // Base Color
            const baseColor = colors.get((v.y + 1) * 0.5);

            // Pulsing Light / Moving Band
            let phase = (this.t * p.speed) % 1.0;
            if (phase < 0) phase += 1.0;

            // Calculate distance to the "light band"
            let dist = Math.abs(frag.v1 - phase);
            if (dist > 0.5) dist = 1.0 - dist;

            const width = p.lightSize;
            let intensity = 0.0;

            if (dist < width) {
                // Smooth falloff
                let r = 1.0 - (dist / width)
                intensity = r * r;
            }
            baseColor.lerp(new Color4(1, 1, 1, 1), intensity);
            frag.color = baseColor;
        });

        this.filters.flush(null, 1.0);
    }
}
