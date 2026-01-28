/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { MeshOps, vectorPool, quaternionPool, sinWave } from "../geometry.js";
import { Solids } from "../solids.js";
import { Plot, Scan } from "../draw.js";
import { createRenderPipeline, FilterAntiAlias, FilterOrient } from "../filters.js";
import { color4Pool, richSunset, g3 } from "../color.js";
import { Timeline, Rotation, easeInOutSin, Mutation, easeMid, MeshMorph, PeriodicTimer } from "../animation.js";
import { Daydream } from "../driver.js";
import { TWO_PI } from "../3dmath.js";

export class TestSolids {
    constructor() {
        this.orientation = new THREE.Quaternion();
        this.pipeline = createRenderPipeline(new FilterAntiAlias());

        // Parameters
        this.params = {
            solid: 'dodecahedron',
            plot: true,
            scan: true,
            rotationSpeed: 0.5,
            opacity: 1.0,
            debugBB: false,
            showLabels: false,
            intensity: 5.0,
            dual: false,
            hankin: true,
            hankinAngle: Math.PI / 4
        };

        // Solid Management
        this.solidsList = Object.keys(Solids).filter(k => typeof Solids[k] === 'function' && k !== 'normalize');
        this.solidIndex = this.solidsList.indexOf(this.params.solid);
        if (this.solidIndex === -1) {
            this.solidIndex = 0;
            this.params.solid = this.solidsList[0];
        }

        // State Machine
        // 'HANKIN': Animating Hankin Angle, Base is Solid, Render applies Hankin
        // 'MORPH': Animating Shape, Base is Hankin Mesh, Render draws Base directly
        this.state = 'HANKIN';

        // The underlying solid definition (used in HANKIN mode)
        this.scanSolid = Solids[this.params.solid]();


        // The mesh currently being rendered/morphed (used in MORPH mode)
        this.renderMesh = null;

        this.timeline = new Timeline();
        // Rotation
        this.rotation = new THREE.Quaternion();
        this.axis = new THREE.Vector3(0, 1, 0).normalize();

        this.startHankinCycle();
        this.setupGUI();
    }

    startHankinCycle() {
        this.state = 'HANKIN';
        // Ensure scanSolid is up to date with CURRENT params
        this.scanSolid = Solids[this.params.solid]();
        if (this.params.dual) this.scanSolid = MeshOps.dual(this.scanSolid);


        // Animate Angle
        this.timeline.add(0, new Mutation(
            this.params, 'hankinAngle', sinWave(0, Math.PI / 2, 1, 0), 64, easeMid, false)
            .then(() => this.startMorphCycle()));
    }

    startMorphCycle() {
        this.state = 'MORPH';

        // 1. Prepare Start Mesh (Frozen Hankin of Current Solid)
        let startMesh = this.scanSolid; // Already Dualed/Normalized if needed

        // Always apply Hankin for the morph target if mode is active
        if (this.params.hankin) {
            // Re-clone just in case scanSolid was mutated? No, MeshOps returns new.
            // But dual returns new. 
            // Wait, we need to apply Hankin to a fresh copy if scanSolid is reused?
            // scanSolid is refreshed in startHankinCycle.
            // But let's be safe.
            startMesh = {
                vertices: this.scanSolid.vertices.map(v => v.clone()),
                faces: this.scanSolid.faces
            };
            startMesh = MeshOps.hankin(startMesh, this.params.hankinAngle);

        }

        // Set as current render mesh (Mutated by Morph)
        this.renderMesh = startMesh;

        // 2. Prepare Target Mesh (Frozen Hankin of Next Solid)
        this.solidIndex = (this.solidIndex + 1) % this.solidsList.length;
        const nextName = this.solidsList[this.solidIndex];

        console.log(`Morphing: ${this.params.solid} -> ${nextName}`);

        this.params.solid = nextName;

        // Base geometry
        let nextSolid = Solids[nextName]();
        if (this.params.dual) nextSolid = MeshOps.dual(nextSolid);


        // Actual target mesh (might be Hankin)
        let nextMesh = nextSolid;
        if (this.params.hankin) {
            // Must clone/use fresh for Hankin generation, but nextSolid is fresh
            nextMesh = MeshOps.hankin(nextSolid, this.params.hankinAngle);

        }

        // 3. Start Morph
        // Pass params so MeshMorph can reconstruct the target geometry for Dual-Pass
        const morphParams = { ...this.params, target: nextName };
        this.currentMorph = new MeshMorph(this.renderMesh, nextMesh, 16, false, easeInOutSin, morphParams);
        this.timeline.add(0, this.currentMorph.then(() => {
            this.currentMorph = null;
            this.startHankinCycle();
        }));
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
        this.gui.add(this.params, 'rotationSpeed', 0.0, 5.0).name("Rot Speed");
        this.gui.add(this.params, 'opacity', 0.1, 1.0).name("Opacity");
        this.gui.add(this.params, 'debugBB').name("Debug BB");
        this.gui.add(this.params, 'showLabels').name("Show Labels");
    }



    drawFrame() {
        this.timeline.step();

        // Update Rotation
        const dt = 0.016;
        const rotStep = this.params.rotationSpeed * dt;
        const axis = vectorPool.acquire().set(0.5, 1, 0.2).normalize();
        const qInc = quaternionPool.acquire().setFromAxisAngle(axis, rotStep);
        this.rotation.multiply(qInc);

        const meshesToDraw = [];

        if (this.state === 'HANKIN') {
            // Generate frame based on dynamic parameters
            let mesh = {
                vertices: this.scanSolid.vertices.map(v => v.clone()),
                faces: this.scanSolid.faces
            };

            if (this.params.hankin) {
                mesh = MeshOps.hankin(mesh, this.params.hankinAngle);

            }
            meshesToDraw.push({ mesh: mesh, opacity: 1.0 });

        } else {
            // MORPH Mode
            // 1. Primary Mesh (Collapsing Source)
            // Opacity fades from 1 -> 0
            const alpha = this.currentMorph ? (this.currentMorph.alpha || 0) : 0;
            const primaryOpacity = 1.0 - alpha;

            // Clone for display transforms
            meshesToDraw.push({
                mesh: {
                    vertices: this.renderMesh.vertices.map(v => v.clone()),
                    faces: this.renderMesh.faces
                },
                opacity: primaryOpacity
            });

            // 2. Secondary Mesh (Emerging Dest)
            // Opacity fades from 0 -> 1
            if (this.currentMorph && this.currentMorph.destMesh) {
                meshesToDraw.push({
                    mesh: {
                        vertices: this.currentMorph.destMesh.vertices.map(v => v.clone()),
                        faces: this.currentMorph.destMesh.faces
                    },
                    opacity: alpha
                });
            }
        }

        // Render Loop
        // Shared Color/Plot Callbacks
        const baseOpacity = this.params.opacity;

        for (const item of meshesToDraw) {
            const m = item.mesh;
            const op = item.opacity * baseOpacity;

            if (op < 0.01) continue;
            if (m.faces.length === 0) continue; // Skip empty meshes

            // Apply Transforms
            for (const v of m.vertices) {
                v.applyQuaternion(this.rotation);
            }

            const colorFace = (v, t, d, i) => {
                const distFromEdge = -d;
                const intensity = Math.min(1, Math.max(0, distFromEdge * this.params.intensity));
                const c = richSunset.get(intensity).color;
                return color4Pool.acquire().set(c, op);
            };
            const colorWhite = (v) => color4Pool.acquire().set(1, 1, 1, op);

            if (this.params.scan) Scan.Mesh.draw(this.pipeline, m, colorFace, this.params.debugBB);
            if (this.params.plot) Plot.Mesh.draw(this.pipeline, m, colorWhite);
        }
    }

    getLabels() {
        if (!this.params.showLabels) return [];
        const labels = [];
        // Determine which mesh to label based on state
        const mesh = (this.state === 'MORPH' && this.renderMesh) ? this.renderMesh : this.scanSolid;

        if (!mesh || !mesh.faces) return labels;

        for (let i = 0; i < mesh.faces.length; i++) {
            const face = mesh.faces[i];
            const centroid = new THREE.Vector3();

            // Calculate centroid
            for (const idx of face) {
                centroid.add(mesh.vertices[idx]);
            }
            centroid.divideScalar(face.length);

            // Apply rotation to match the visual orientation
            // Note: We apply rotation even if the draw loop has it commented out, 
            // assuming the user wants to track the logical orientation.
            centroid.applyQuaternion(this.rotation);

            // Normalize to project onto the sphere surface (as expected by driver.js)
            centroid.normalize();

            labels.push({
                position: centroid,
                content: i.toString()
            });
        }
        return labels;
    }
}
