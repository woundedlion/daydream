/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { Timeline, Orientation, Animation, PaletteBehaviors } from "../animation.js";
import { Plot } from "../plot.js";
import { Solids, AllSolids } from "../solids.js";
import { Palettes } from "../palettes.js";
import { Color4, AnimatedPalette, CircularPalette } from "../color.js";
import {
    createRenderPipeline,
    Filter,
} from "../filters.js";

export class TestPalettes {
    constructor() {
        // Setup Timeline and Orientation
        this.timeline = new Timeline();
        this.orientation = new Orientation();
        this.timeline.add(0, new Animation.RandomWalk(this.orientation, Daydream.UP));

        // Parameter Storage
        this.params = {
            palette: 'richSunset',
            modifier: 'Cycle',
            speed: 0.02,
            circular: true,
            solidName: 'icosahedron'
        };

        // Palette Setup
        this.updateBasePalette();
        this.palette = new AnimatedPalette(this.basePalette);

        this.updateModifier();

        this.t = 0;

        // Setup Pipeline
        this.filterOrient = new Filter.World.Orient(this.orientation);
        this.filterAA = new Filter.Screen.AntiAlias();

        this.filters = createRenderPipeline(
            this.filterOrient,
            this.filterAA,
        );

        // Load Mesh
        this.mesh = Solids.get(this.params.solidName);

        this.setupGui();
    }

    updateBasePalette() {
        const source = Palettes[this.params.palette];
        this.basePalette = this.params.circular ? new CircularPalette(source) : source;
        if (this.palette) {
            this.palette.setSource(this.basePalette);
        }
    }

    updateModifier() {
        // Clear existing modifiers
        this.palette.modifiers = [];

        const behaviorFactory = PaletteBehaviors[this.params.modifier];

        if (behaviorFactory && typeof behaviorFactory === 'function') {
            // Instantiate with speed. 
            // Note: Breathe takes (freq, amp), Cycle takes (speed). 
            // We'll pass speed as the first argument to all for now.
            const behavior = behaviorFactory(this.params.speed);

            this.modifier = new Animation.PaletteAnimation(behavior);
            this.palette.add(this.modifier);

            // Re-add to timeline to ensure it's stepped
            this.timeline.add(0, this.modifier);
        }
    }

    setupGui() {
        this.gui = new gui.GUI({ autoPlace: false });

        this.gui.add(this.params, 'solidName', AllSolids).name('Solid').onChange(v => {
            this.mesh = Solids.get(v);
        });

        const folder = this.gui.addFolder('Palette Settings');

        folder.add(this.params, 'palette', Object.keys(Palettes)).name('Palette').onChange(v => {
            this.updateBasePalette();
        });

        folder.add(this.params, 'circular').name('Circular').onChange(v => {
            this.updateBasePalette();
        });

        // Filter out 'Mutate' as it requires a function argument, not a speed/number
        const availableModifiers = Object.keys(PaletteBehaviors).filter(k => k !== 'Mutate');

        folder.add(this.params, 'modifier', availableModifiers).name('Modifier').onChange(v => {
            this.updateModifier();
        });

        folder.add(this.params, 'speed', 0.001, 0.2).name('Speed').onChange(v => {
            this.updateModifier();
        });



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
            frag.color = baseColor;
        });

        this.filters.flush(null, 1.0);
    }
}
