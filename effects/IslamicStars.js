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
            run: true,
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
        this.shapeIndex = -1;

        this.setupGUI();
        this.nextShape();
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.params, 'solid', this.solidsList).name("Solid").listen().onChange((value) => {
            const index = this.solidsList.indexOf(value);
            if (index >= 0) {
                this.shapeIndex = index;
                if (this.nextShapeTimer) {
                    this.nextShapeTimer.cancel();
                }
                this.spawnShape(value);
            }
        });
        this.gui.add(this.params, 'run').name("Run");
        this.gui.add(this.params, 'opacity', 0.1, 1.0).name("Opacity");
        this.gui.add(this.params, 'debugBB').name("Debug BB");
    }

    drawFrame() {
        this.timeline.step();
    }

    nextShape() {
        if (this.params.run) {
            this.shapeIndex = (this.shapeIndex + 1) % this.solidsList.length;
        }
        if (this.shapeIndex < 0) this.shapeIndex = 0;

        const solidName = this.solidsList[this.shapeIndex];
        this.params.solid = solidName;
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

        // Randomize palette mapping for this shape
        const availablePalettes = [
            Palettes.embers,
            Palettes.richSunset,
            Palettes.brightSunrise,
            Palettes.bruisedMoss,
            Palettes.lavenderLake
        ];

        // Fisher-Yates shuffle
        for (let i = availablePalettes.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [availablePalettes[i], availablePalettes[j]] = [availablePalettes[j], availablePalettes[i]];
        }

        // The sprite's draw callback closes over the mesh, topology indices, AND the specific palette mapping
        const sprite = new Animation.Sprite(
            (opacity) => this.drawMesh(mesh, opacity, faceColorIndices, availablePalettes),
            duration,
            fade, easeMid,
            fade, easeMid
        );

        this.timeline.add(0, sprite);

        // Schedule next shape
        this.nextShapeTimer = new Animation.PeriodicTimer(0, () => this.nextShape(), false);
        this.timeline.add(nextDelay, this.nextShapeTimer);
    }

    drawMesh(mesh, spriteOpacity, faceTopologyIndices, currentPalettes) {
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

            const palette = currentPalettes[topologyIndex % currentPalettes.length];

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
