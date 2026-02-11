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
        this.timeline
            .add(0, new Animation.RandomWalk(this.orientation, Daydream.UP))
            .add(0, new Animation.Sprite((opacity) => this.draw(), -1, 4, easeMid, 0, easeMid));

        this.transformedVertices = [];
        this.solidsList = IslamicStarPatterns;

        this.setupGUI();
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.params, 'solid', this.solidsList).name("Solid");
        this.gui.add(this.params, 'opacity', 0.1, 1.0).name("Opacity");
        this.gui.add(this.params, 'debugBB').name("Debug BB");
    }

    drawFrame() {
        this.timeline.step();
    }

    draw() {
        const solidName = this.params.solid;
        if (!Solids.get(solidName)) return;

        // Cache the solid mesh to avoid reconstruction every frame if it hasn't changed
        if (!this.cachedSolid || this.cachedSolidName !== solidName) {
            this.cachedSolid = Solids.get(solidName);
            this.cachedSolidName = solidName;

            // Analyze Topology
            const { faceColorIndices } = MeshOps.classifyFacesByTopology(this.cachedSolid);
            this.faceTopologyIndices = faceColorIndices;
        }

        const mesh = this.cachedSolid;
        if (!mesh || mesh.vertices.length === 0) return;

        while (this.transformedVertices.length < mesh.vertices.length) {
            this.transformedVertices.push(new THREE.Vector3());
        }

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
            const topologyIndex = this.faceTopologyIndices[i] || 0;

            let palette;
            switch (topologyIndex % 4) {
                case 0: palette = Palettes.embers; break;
                case 1: palette = Palettes.richSunset; break;
                case 2: palette = Palettes.emeraldForest; break;
                case 3: palette = Palettes.lavenderLake; break;
                default: palette = Palettes.embers;
            }

            const distFromEdge = -frag.v1;
            const size = frag.size || 1;

            const intensity = Math.min(1, Math.max(0, (distFromEdge / size)));
            const res = palette.get(intensity);
            res.alpha *= this.params.opacity;
            frag.color = res;
        };

        Scan.Mesh.draw(this.pipeline, drawnMesh, scanShader, this.params.debugBB);
    }
}
