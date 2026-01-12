/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "../gui.js";
import { Daydream } from "../driver.js";
import { ReversePalette, richSunset } from "../color.js";
import { randomVector } from "../geometry.js";
import { quinticKernel } from "../filters.js";
import { KDTree } from "../KDTree.js";

export class Voronoi {
    constructor() {
        this.numSites = 200;
        this.speed = 20;
        this.borderThickness = 0.0;
        this.showBorders = true;
        this.showSites = false;
        this.smoothness = 50.0;
        this.sites = [];
        this.gui = new gui.GUI({ autoPlace: false });
        this.palette = richSunset;

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
            const axis = vel;
            const t = i / (this.numSites - 1 || 1);
            const color = this.palette.get(t);

            this.sites.push({
                pos: v,
                axis: axis,
                color: color.color,
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

            const outColor = Daydream.pixels[i];

            if (bestSite) {
                outColor.copy(bestSite.color);

                if (secondBestSite && this.smoothness > 0) {
                    const diff = maxDot1 - maxDot2;
                    let factor = Math.min(1.0, diff * this.smoothness);
                    factor = quinticKernel(factor);
                    const t = 0.5 + 0.5 * factor;
                    outColor.lerp(secondBestSite.color, 1.0 - t);
                }
            }

            if (this.showBorders) {
                const dist1 = Math.acos(Math.min(1, maxDot1));
                const dist2 = Math.acos(Math.min(1, maxDot2));
                if (dist2 - dist1 < this.borderThickness) {
                    outColor.setRGB(0, 0, 0);
                }
            }

            if (this.showSites) {
                if (maxDot1 > 0.999 && Math.acos(maxDot1) < 0.015) {
                    outColor.setRGB(1, 1, 1);
                }
            }
        }
    }
}
