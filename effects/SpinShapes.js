/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Timeline, Sprite, Rotation, Orientation
} from "../animation.js";
import { easeMid } from "../easing.js";
import { Scan } from "../scan.js";
import { makeBasis, fibSpiral } from "../geometry.js";
import { color4Pool } from "../memory.js";
import { richSunset } from "../color.js";
import { TWO_PI } from "../3dmath.js";

import { createRenderPipeline } from "../filters.js";

export class SpinShapes {
    static Shape = class {
        constructor(normal, layer) {
            this.normal = normal.clone();
            this.orientation = new Orientation();
            this.layer = layer; // 0 or 1
        }
    }

    constructor() {
        this.shapes = [];
        this.sides = 3;
        this.radius = 0.2;
        this.count = 40;
        this.timeline = new Timeline();
        this.pipeline = createRenderPipeline();

        this.setupGUI();
        this.rebuild();
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'sides').min(3).max(8).step(1).name("Sides").onChange(() => this.rebuild());
        this.gui.add(this, 'count').min(10).max(100).step(1).name("Count").onChange(() => this.rebuild());
    }

    rebuild() {
        this.shapes = [];
        this.timeline = new Timeline();

        for (let i = 0; i < this.count; i++) {
            const normal = fibSpiral(this.count, 0, i);

            // Layer 1
            const s1 = new SpinShapes.Shape(normal, 0);
            this.shapes.push(s1);
            this.timeline.add(0, new Rotation(s1.orientation, s1.normal, TWO_PI, 300 + i * 2, easeMid, true, "Local"));
            this.timeline.add(0, new Sprite((alpha) => this.drawShape(s1, alpha), -1));

            // Layer 2
            const s2 = new SpinShapes.Shape(normal, 1);
            this.shapes.push(s2);
            this.timeline.add(0, new Rotation(s2.orientation, s2.normal, -TWO_PI, 300 + i * 2, easeMid, true, "Local"));
            this.timeline.add(0, new Sprite((alpha) => this.drawShape(s2, alpha), -1));
        }
    }

    drawShape(shape, alpha) {
        const t = (shape.normal.y + 1) / 2;
        const c = richSunset.get(t);

        const colorFn = (p, t, dist) => {
            return color4Pool.acquire().set(c.color, 0.6 * alpha);
        }

        const basis = makeBasis(shape.orientation.get(), shape.normal);
        const phase = (shape.layer === 0) ? 0 : Math.PI / this.sides;
        Scan.Polygon.draw(this.pipeline, basis, this.radius, this.sides, colorFn, phase);
    }

    drawFrame() {
        this.timeline.step();
    }
}
