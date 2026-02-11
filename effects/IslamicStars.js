/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { MeshOps } from "../geometry.js";
import { Timeline, Animation, Orientation } from "../animation.js";
import { Solids, IslamicStarPatterns } from "../solids.js";
import { Plot } from "../plot.js";
import { Scan } from "../scan.js";
import { createRenderPipeline, Filter } from "../filters.js";
import { Palettes } from "../palettes.js";
import { Daydream } from "../driver.js";
import { color4Pool } from "../memory.js";
import { easeMid } from "../easing.js";

export class IslamicStars {
    constructor() {
        this.params = {
            solid: IslamicStarPatterns[0],
            plot: true,
            scan: true,
            opacity: 1.0,
            debugBB: false
        };

        this.orientation = new Orientation();
        this.pipeline = createRenderPipeline(new Filter.Screen.AntiAlias());
        this.timeline = new Timeline();
        this.timeline.add(0, new Animation.RandomWalk(this.orientation, Daydream.UP));

        this.transformedVertices = [];
        this.solidsList = IslamicStarPatterns;
        this.shapeIndex = 0;

        this.setupGUI();
        this.nextShape();
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.params, 'solid', this.solidsList).name("Solid").onChange((value) => {
            const index = this.solidsList.indexOf(value);
            if (index >= 0) {
                this.shapeIndex = index;
                if (this.nextShapeTimer) {
                    this.nextShapeTimer.cancel();
                }
                this.spawnShape(value);
            }
        });
        this.gui.add(this.params, 'opacity', 0.1, 1.0).name("Opacity");
        this.gui.add(this.params, 'debugBB').name("Debug BB");
    }

    drawFrame() {
        this.timeline.step();
    }

    nextShape() {
        const solidName = this.solidsList[this.shapeIndex];
        this.shapeIndex = (this.shapeIndex + 1) % this.solidsList.length;
        this.spawnShape(solidName);
    }

    spawnShape(solidName) {
        const duration = 96;
        const fade = 32;
        const overlap = fade;
        const nextDelay = duration - overlap;

        const mesh = Solids.get(solidName);
        if (!mesh) {
            // Fallback or skip if solid load failed
            this.timeline.add(1, new Animation.PeriodicTimer(0, () => this.nextShape(), false));
            return;
        }

        // Pre-calculate topology for this specific mesh instance
        const { faceColorIndices } = MeshOps.classifyFacesByTopology(mesh);

        // Ensure vertex buffer capacity
        while (this.transformedVertices.length < mesh.vertices.length) {
            this.transformedVertices.push(new THREE.Vector3());
        }

        // The sprite's draw callback closes over the mesh and topology indices
        const sprite = new Animation.Sprite(
            (opacity) => this.drawMesh(mesh, opacity, faceColorIndices),
            duration,
            fade, easeMid,
            fade, easeMid
        );

        this.timeline.add(0, sprite);

        // Schedule next shape
        this.nextShapeTimer = new Animation.PeriodicTimer(0, () => this.nextShape(), false);
        this.timeline.add(nextDelay, this.nextShapeTimer);
    }

    drawMesh(mesh, spriteOpacity, faceTopologyIndices) {
        const count = mesh.vertices.length;

        for (let i = 0; i < count; i++) {
            this.transformedVertices[i].copy(this.orientation.orient(mesh.vertices[i]));
        }

        const drawnMesh = {
            vertices: this.transformedVertices.slice(0, count),
            faces: mesh.faces
        };

        const scanShader = (p, frag) => {
            const i = Math.round(frag.v2);
            const topologyIndex = faceTopologyIndices[i] || 0;

            let palette;
            switch (topologyIndex % 5) {
                case 0: palette = Palettes.embers; break;
                case 1: palette = Palettes.richSunset; break;
                case 2: palette = Palettes.brightSunrise; break;
                case 3: palette = Palettes.bruisedMoss; break;
                case 4: palette = Palettes.lavenderLake; break;
                default: palette = Palettes.embers;
            }

            const distFromEdge = -frag.v1;
            const size = frag.size || 1;

            const intensity = Math.min(1, Math.max(0, (distFromEdge / size)));
            const res = palette.get(intensity);
            res.alpha *= this.params.opacity * spriteOpacity;
            frag.color = res;
        };

        Scan.Mesh.draw(this.pipeline, drawnMesh, scanShader, this.params.debugBB);
    }
}
