/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Solids, MeshOps, vectorPool, quaternionPool } from "../geometry.js";
import { Plot, Scan } from "../draw.js";
import { createRenderPipeline, FilterAntiAlias, FilterOrient } from "../filters.js";
import { color4Pool, richSunset, darkRainbow, rainbow, g3 } from "../color.js";
import { Timeline, Rotation, easeMid } from "../animation.js";
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
            scan: true, // Enabled scan by default to see the effect
            scale: 1.0,
            rotationSpeed: 0.5,
            opacity: 1.0,
            debugBB: false,
            faceScale: 5.0, // New parameter for gradient scaling
            dual: false,
            hankin: false,
            hankinAngle: Math.PI / 4
        };

        this.timeline = new Timeline();
        this.timeline.add(0, new Rotation(this.orientation, Daydream.UP, TWO_PI, 160, easeMid, true, "World"));

        // Rotation state
        this.rotation = new THREE.Quaternion();
        this.axis = new THREE.Vector3(0, 1, 0).normalize();

        this.setupGUI();
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });

        // Solid Selection
        // Filter out helper methods like 'normalize' from Solids object
        const solids = Object.keys(Solids).filter(k => typeof Solids[k] === 'function' && k !== 'normalize');
        this.gui.add(this.params, 'solid', solids).name("Solid");
        this.gui.add(this.params, 'dual').name("Show Dual");
        this.gui.add(this.params, 'hankin').name("Hankin Mode");
        this.gui.add(this.params, 'hankinAngle', 0, Math.PI / 2).name("Hankin Angle (Rad)");

        this.gui.add(this.params, 'plot').name("Plot (Wireframe)");
        this.gui.add(this.params, 'scan').name("Scan (Solid)");
        this.gui.add(this.params, 'scale', 0.1, 2.0).name("Scale");
        this.gui.add(this.params, 'faceScale', 1.0, 50.0).name("Color Intensity");
        this.gui.add(this.params, 'rotationSpeed', 0.0, 5.0).name("Rotation Speed");
        this.gui.add(this.params, 'opacity', 0.1, 1.0).name("Opacity");
        this.gui.add(this.params, 'debugBB').name("Show Bounding Box");
    }

    drawFrame() {
        // Update Rotation
        const dt = 0.016; // Approx 60fps
        const rotStep = this.params.rotationSpeed * dt;
        // Rotate around an arbitrary axis for interest (e.g., slowly shifting axis)
        const axis = vectorPool.acquire().set(0.5, 1, 0.2).normalize();
        const qInc = quaternionPool.acquire().setFromAxisAngle(axis, rotStep);
        this.rotation.multiply(qInc);

        // Get Mesh
        // Generate fresh mesh (Solids returns new objects)
        let mesh = Solids[this.params.solid]();

        // Apply Dual if requested
        if (this.params.dual) {
            // Need to ensure MeshOps is available. 
            // I'll assume 'MeshOps' is exported.
            mesh = MeshOps.dual(mesh);
            Solids.normalize(mesh);
        }

        if (this.params.hankin) {
            // Ensure normals exist for rotation
            Solids.normalize(mesh);

            // if (Math.random() < 0.01) console.log("TestSolids Hankin Angle:", this.params.hankinAngle);

            // Use Radians directly
            mesh = MeshOps.hankin(mesh, this.params.hankinAngle);
            Solids.normalize(mesh);
        }

        // Apply Transform (Scale + Rotation)
        // We modify vertices in place since they are fresh
        for (const v of mesh.vertices) {
            if (this.params.scale !== 1.0) v.multiplyScalar(this.params.scale);
            v.applyQuaternion(this.rotation);
        }

        // Updated Color Function
        const colorFace = (v, t, d, i) => {
            // 1. Invert distance (d is negative inside face, 0 at edge)
            const distFromEdge = -d;

            // 2. Scale and Clamp (0 at edge, 1 at center)
            const intensity = Math.min(1, Math.max(0, distFromEdge * this.params.faceScale));

            // 3. Pick base color from g3 palette (Yellow-Blue-Black)
            const c = g3.get(intensity).color;

            // 4. Modulate color brightness by intensity
            return color4Pool.acquire().set(
                c,
                this.params.opacity
            );
        };

        const colorWhite = (v) => color4Pool.acquire().set(1, 1, 1, this.params.opacity);

        if (this.params.scan) {
            Scan.Mesh.draw(this.pipeline, mesh, colorFace, this.params.debugBB);
        }

        if (this.params.plot) {
            Plot.Mesh.draw(this.pipeline, mesh, colorWhite);
        }
    }

    getLabels() {
        return [];
    }
}