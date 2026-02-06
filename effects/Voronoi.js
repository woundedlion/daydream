/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "../gui.js";
import { Daydream } from "../driver.js";
import { Palettes } from "../palettes.js";
import { randomVector } from "../geometry.js";
import { quinticKernel } from "../filters.js";
import { KDTree } from "../spatial.js";

export class Voronoi {
    constructor() {
        this.numSites = 200;
        this.speed = 20;
        this.borderThickness = 0.0;
        this.showBorders = true;
        this.showSites = false;
        this.smoothness = 100.0;
        this.sites = [];
        this.gui = new gui.GUI({ autoPlace: false });
        this.palette = Palettes.richSunset;

        this.gui.add(this, 'numSites', 2, 1000).step(1).name('Site Count').onChange(() => this.initSites());
        this.gui.add(this, 'speed', 0, 100.0).name('Speed');
        this.gui.add(this, 'showBorders').name('Show Borders');
        this.gui.add(this, 'borderThickness', 0.000, 0.1).name('Border Size');
        this.gui.add(this, 'smoothness', 0.0, 500.0).name('Smoothness');
        this.gui.add(this, 'showSites').name('Show Sites');

        this.initSites();
    }

    initSites() {
        this.sites = [];
        for (let i = 0; i < this.numSites; i++) {
            const goldenAngle = Math.PI * (3 - Math.sqrt(5));
            const y = 1 - (i / (this.numSites - 1)) * 2;
            const radius = Math.sqrt(Math.max(0, 1 - y * y));
            const theta = goldenAngle * i;

            const x = Math.cos(theta) * radius;
            const z = Math.sin(theta) * radius;

            const v = new THREE.Vector3(x, y, z);
            const vel = randomVector();
            const axis = vel.clone(); // Clone for persistence
            const t = i / (this.numSites - 1 || 1);
            const color = this.palette.get(t);
            const persistentColor = new THREE.Color().copy(color.color);

            this.sites.push({
                pos: v,
                axis: axis,
                color: persistentColor,
                id: i
            });
        }
    }

    drawFrame() {
        for (const site of this.sites) {
            const s = Math.log(this.speed + 1) * 0.005;
            site.pos.applyAxisAngle(site.axis, s);
        }

        const tree = new KDTree([...this.sites]);

        for (let i = 0; i < Daydream.pixelPositions.length; i++) {
            const p = Daydream.pixelPositions[i];

            // Get 2 nearest neighbors
            const neighbors = tree.nearest(p, 2);

            const bestSite = neighbors[0];
            const secondBestSite = neighbors[1];

            const maxDot1 = p.dot(bestSite.pos);
            const maxDot2 = secondBestSite ? p.dot(secondBestSite.pos) : -1.0;

            const i3 = i * 3;

            if (bestSite) {
                // Copy
                Daydream.pixels[i3] = bestSite.color.r;
                Daydream.pixels[i3 + 1] = bestSite.color.g;
                Daydream.pixels[i3 + 2] = bestSite.color.b;

                if (secondBestSite && this.smoothness > 0) {
                    const diff = maxDot1 - maxDot2;
                    let factor = Math.min(1.0, diff * this.smoothness);
                    factor = quinticKernel(factor);
                    const t = 0.5 + 0.5 * factor;

                    // Lerp
                    const invT = 1.0 - t;
                    Daydream.pixels[i3] += (secondBestSite.color.r - Daydream.pixels[i3]) * invT;
                    Daydream.pixels[i3 + 1] += (secondBestSite.color.g - Daydream.pixels[i3 + 1]) * invT;
                    Daydream.pixels[i3 + 2] += (secondBestSite.color.b - Daydream.pixels[i3 + 2]) * invT;
                }
            }

            if (this.showBorders) {
                const dist1 = Math.acos(Math.min(1, maxDot1));
                const dist2 = Math.acos(Math.min(1, maxDot2));
                if (dist2 - dist1 < this.borderThickness) {
                    Daydream.pixels[i3] = 0;
                    Daydream.pixels[i3 + 1] = 0;
                    Daydream.pixels[i3 + 2] = 0;
                }
            }

            if (this.showSites) {
                if (maxDot1 > 0.999 && Math.acos(maxDot1) < 0.015) {
                    Daydream.pixels[i3] = 1;
                    Daydream.pixels[i3 + 1] = 1;
                    Daydream.pixels[i3 + 2] = 1;
                }
            }
        }
    }
}

