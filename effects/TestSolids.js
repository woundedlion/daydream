/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Solids, vectorPool, quaternionPool } from "../geometry.js";
import { Plot, Scan } from "../draw.js";
import { createRenderPipeline, FilterAntiAlias, FilterOrient } from "../filters.js";
import { color4Pool, rainbow } from "../color.js";
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
            scan: false,
            scale: 1.0,
            rotationSpeed: 0.5,
            opacity: 1.0,
            debugBB: false
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

        this.gui.add(this.params, 'plot').name("Plot (Wireframe)");
        this.gui.add(this.params, 'scan').name("Scan (Solid)");
        this.gui.add(this.params, 'scale', 0.1, 2.0).name("Scale");
        this.gui.add(this.params, 'rotationSpeed', 0.0, 5.0).name("Rotation Speed");
        this.gui.add(this.params, 'opacity', 0.1, 1.0).name("Opacity");
        this.gui.add(this.params, 'debugBB').name("Show Bounding Box");
    }

    drawFrame() {
        // Update Rotation
        const dt = 0.016; // Approx 60fps
        const angle = this.params.rotationSpeed * dt;
        // Rotate around an arbitrary axis for interest (e.g., slowly shifting axis)
        // For simplicity, just Y axis or a fixed diagonal
        const axis = vectorPool.acquire().set(0.5, 1, 0.2).normalize();
        const qInc = quaternionPool.acquire().setFromAxisAngle(axis, angle);
        this.rotation.multiply(qInc);

        // Get Mesh
        // Generate fresh mesh (Solids returns new objects)
        const mesh = Solids[this.params.solid]();

        // Apply Transform (Scale + Rotation)
        // We modify vertices in place since they are fresh
        for (const v of mesh.vertices) {
            if (this.params.scale !== 1.0) v.multiplyScalar(this.params.scale);
            v.applyQuaternion(this.rotation);
        }

        const colorBlue = (v, t, d, i) => {
            // Use face index (i) to pick color from rainbow palette
            // Normalize i by number of faces (mesh.faces.length)
            const hue = (i % mesh.faces.length) / mesh.faces.length;
            const c = rainbow.get(hue).color;
            return color4Pool.acquire().set(c.r, c.g, c.b, this.params.opacity);
        };
        const colorWhite = (v) => color4Pool.acquire().set(1, 1, 1, this.params.opacity);

        if (this.params.scan) {
            Scan.Mesh.draw(this.pipeline, mesh, colorBlue, this.params.debugBB);
        }

        if (this.params.plot) {
            Plot.Mesh.draw(this.pipeline, mesh, colorWhite);
        }
    }

    getLabels() {
        return [];
    }
}
