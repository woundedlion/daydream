/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Timeline, RandomWalk, Mutation, MeshMorph, Sprite, Orientation } from "../animation.js";
import { MeshOps, sinWave } from "../geometry.js";
import { color4Pool } from "../memory.js";
import { Solids, PlatonicSolids, ArchimedeanSolids } from "../solids.js";
import { Plot } from "../plot.js";
import { Scan } from "../scan.js";
import { createRenderPipeline, Filter } from "../filters.js";
import { Palettes } from "../palettes.js";
import { easeInOutSin, easeMid } from "../easing.js";
import { Daydream } from "../driver.js";



const PALETTES = {
    3: Palettes.lavenderLake,
    4: Palettes.lavenderLake,
    5: Palettes.lavenderLake,
    6: Palettes.emeraldForest,
    8: Palettes.lavenderLake,
    10: Palettes.lavenderLake
};

export class IslamicStars {
    constructor() {
        this.orientation = new THREE.Quaternion();
        this.transformedVertices = [];
        this.pipeline = createRenderPipeline(new Filter.Screen.AntiAlias());

        this.params = {
            solid: 'dodecahedron',
            plot: true,
            scan: true,
            rotationSpeed: 0.5,
            opacity: 1.0,
            debugBB: false,
            intensity: 1.2,
            dual: false,
            hankin: true,
            hankinAngle: Math.PI / 4
        };

        this.solidsList = [...PlatonicSolids, ...ArchimedeanSolids];
        this.solidIndex = this.solidsList.indexOf(this.params.solid);
        if (this.solidIndex === -1) {
            this.solidIndex = 0;
            this.params.solid = this.solidsList[0];
        }

        this.scanSolid = Solids[this.params.solid]();
        this.renderMesh = null;

        this.timeline = new Timeline();

        this.orientation = new Orientation();

        this.startRotation();
        this.startHankin();

        this.setupGUI();
    }

    startRotation() {
        this.timeline.add(0, new RandomWalk(this.orientation, Daydream.UP));
    }

    startHankin() {
        this.scanSolid = Solids[this.params.solid]();
        if (this.params.dual) this.scanSolid = MeshOps.dual(this.scanSolid);

        if (this.params.hankin) {
            this.compiledHankin = MeshOps.compileHankin(this.scanSolid);
        } else {
            this.compiledHankin = null;
        }

        this.timeline.add(0, new Mutation(
            this.params, 'hankinAngle', sinWave(0, Math.PI / 2, 1, 0), 64, easeMid, false)
            .then(() => this.startMorph()));

        this.timeline.add(0, new Sprite((opacity) => {
            let mesh = this.scanSolid;

            if (this.params.hankin) {
                if (!this.compiledHankin) {
                    this.compiledHankin = MeshOps.compileHankin(this.scanSolid);
                }
                mesh = MeshOps.updateHankin(this.compiledHankin, this.params.hankinAngle);
            }

            this.drawMesh(mesh, opacity);
        }, 64));
    }

    startMorph() {
        // Source Mesh - Reuse current state
        let startMesh = this.scanSolid;
        if (this.params.hankin) {
            if (!this.compiledHankin) {
                this.compiledHankin = MeshOps.compileHankin(this.scanSolid);
            }
            startMesh = MeshOps.updateHankin(this.compiledHankin, this.params.hankinAngle);
        }
        this.renderMesh = startMesh;

        // Destination Mesh
        this.solidIndex = (this.solidIndex + 1) % this.solidsList.length;
        const nextName = this.solidsList[this.solidIndex];

        console.log(`Morphing: ${this.params.solid} -> ${nextName}`);

        this.params.solid = nextName;
        let nextSolid = Solids[nextName]();
        if (this.params.dual) nextSolid = MeshOps.dual(nextSolid);

        let nextMesh = nextSolid;
        if (this.params.hankin) {
            // Compile destination too
            const nextCompiled = MeshOps.compileHankin(nextSolid);
            nextMesh = MeshOps.updateHankin(nextCompiled, this.params.hankinAngle);
        }

        // Start Morph
        const morphParams = { ...this.params, target: nextName };
        this.currentMorph = new MeshMorph(this.renderMesh, nextMesh, 16, false, easeInOutSin, morphParams);
        this.timeline.add(0, this.currentMorph.then(() => {
            this.currentMorph = null;
            this.startHankin();
        }));

        // Draw outgoing mesh
        this.timeline.add(0, new Sprite((opacity) => {
            this.drawMesh(this.renderMesh, opacity);
        }, 16, 0, easeMid, 16, easeMid));

        // Draw incoming mesh
        this.timeline.add(0, new Sprite((opacity) => {
            if (this.currentMorph && this.currentMorph.destMesh) {
                this.drawMesh(this.currentMorph.destMesh, opacity);
            }
        }, 16, 16, easeMid, 0, easeMid));
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.params, 'solid', this.solidsList).name("Solid").listen();
        this.gui.add(this.params, 'dual').name("Show Dual");
        this.gui.add(this.params, 'hankin').name("Hankin Mode");
        this.gui.add(this.params, 'hankinAngle', 0, Math.PI / 2).name("Hankin Angle");
        this.gui.add(this.params, 'plot').name("Plot");
        this.gui.add(this.params, 'scan').name("Scan");
        this.gui.add(this.params, 'intensity', 1.0, 50.0).name("Intensity");
        this.gui.add(this.params, 'opacity', 0.1, 1.0).name("Opacity");
        this.gui.add(this.params, 'debugBB').name("Debug BB");
    }

    drawFrame() {
        this.timeline.step();
    }

    drawMesh(mesh, opacity) {
        const baseOpacity = this.params.opacity;
        const op = opacity * baseOpacity;

        if (op < 0.01) return;
        if (!mesh || mesh.faces.length === 0) return;

        while (this.transformedVertices.length < mesh.vertices.length) {
            this.transformedVertices.push(new THREE.Vector3());
        }
        const q = this.orientation.get();
        const count = mesh.vertices.length;

        for (let i = 0; i < count; i++) {
            this.transformedVertices[i].copy(mesh.vertices[i]).applyQuaternion(q);
        }

        const drawnMesh = {
            vertices: this.transformedVertices,
            faces: mesh.faces
        };

        const colorFaceShader = (p, frag) => {
            const i = Math.round(frag.v2);
            const face = mesh.faces[i];
            const n = face ? face.length : 0;
            const palette = PALETTES[n] || Palettes.richSunset;

            const distFromEdge = -frag.v1;
            const size = frag.size || 1;

            const intensity = Math.min(1, Math.max(0, (distFromEdge / size) * this.params.intensity));
            const res = palette.get(intensity);
            res.alpha = op;
            frag.color = res;
        };

        const colorWhite = (v, frag) => {
            let c = color4Pool.acquire();
            c.set(1, 1, 1, op);
            frag.color = c;
        }; //#003c3e

        if (this.params.scan) Scan.Mesh.draw(this.pipeline, drawnMesh, colorFaceShader, this.params.debugBB);
        if (this.params.plot) Plot.Mesh.draw(this.pipeline, drawnMesh, colorWhite);
    }
}

