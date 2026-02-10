/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Timeline, Transition, RandomTimer, Rotation, Orientation
} from "../animation.js";
import {
    angleBetween, pixelToVector, randomVector
} from "../geometry.js";
import { Plot } from "../plot.js";
import { GenerativePalette } from "../color.js";
import { color4Pool } from "../memory.js";
import { easeMid, easeInOutSin } from "../easing.js";
import {
    createRenderPipeline, Filter
} from "../filters.js";
import {
    dir, wrap, shortest_distance
} from "../util.js";

export class Dynamo {
    static Node = class {
        constructor(y) {
            this.x = 0;
            this.y = y;
            this.v = 0;
        }
    }

    constructor() {
        // State
        this.palettes = [new GenerativePalette('vignette')];
        this.paletteBoundaries = [];
        this.paletteNormal = Daydream.Y_AXIS.clone();

        this.nodes = [];
        for (let i = 0; i < Daydream.H; ++i) {
            this.nodes.push(new Dynamo.Node(i));
        }
        this.speed = 2;
        this.gap = 5;
        this.trailLength = 8;
        this.orientation = new Orientation();

        // Filters
        this.filters = createRenderPipeline(
            new Filter.World.Trails(this.trailLength, Math.max(4096, Daydream.W * Daydream.H)),
            new Filter.World.Replicate(3),
            new Filter.World.Orient(this.orientation),
            new Filter.Screen.AntiAlias()
        );

        // Scene
        this.timeline = new Timeline();

        this.timeline.add(0,
            new RandomTimer(4, 64, () => {
                this.reverse();
            }, true)
        );
        this.timeline.add(0,
            new RandomTimer(20, 64, () => {
                this.colorWipe();
            }, true)
        );

        this.timeline.add(0,
            new RandomTimer(48, 160, () => {
                this.rotate();
            }, true)
        );
    }

    reverse() {
        this.speed *= -1;
    }

    rotate() {
        this.timeline.add(0,
            new Rotation(
                this.orientation,
                randomVector().clone(),
                Math.PI,
                40,
                easeInOutSin,
                false
            )
        );
    }

    colorWipe() {
        this.palettes.unshift(new GenerativePalette('vignette'));
        this.paletteBoundaries.unshift({ val: 0 });
        this.timeline.add(0,
            new Transition(this.paletteBoundaries[0], 'val', Math.PI, 20, easeMid)
                .then(() => {
                    this.paletteBoundaries.pop();
                    this.palettes.pop();
                }
                )
        );
    }

    color(v, t) {
        const blendWidth = Math.PI / 4;
        const numBoundaries = this.paletteBoundaries.length;
        const numPalettes = this.palettes.length;
        const a = angleBetween(v, this.paletteNormal);

        for (let i = 0; i < numBoundaries; ++i) {
            const boundary = this.paletteBoundaries[i].val;
            const lowerBlendEdge = boundary - blendWidth;
            const upperBlendEdge = boundary + blendWidth;

            if (a < lowerBlendEdge) {
                return this.palettes[i].get(t);
            }

            if (a >= lowerBlendEdge && a <= upperBlendEdge) {
                const blendFactor = (a - lowerBlendEdge) / (2 * blendWidth);
                const clampedBlendFactor = Math.max(0, Math.min(blendFactor, 1));

                const c1 = this.palettes[i].get(t);
                const c2 = this.palettes[i + 1].get(t);

                const result = color4Pool.acquire().copy(c1).lerp(c2, clampedBlendFactor);
                return result;
            }

            const nextBoundaryLowerBlendEdge = (i + 1 < numBoundaries)
                ? this.paletteBoundaries[i + 1].val - blendWidth
                : Infinity;

            if (a > upperBlendEdge && a < nextBoundaryLowerBlendEdge) {
                return this.palettes[i + 1].get(t);
            }
        }

        return this.palettes[0].get(t);
    }

    drawFrame() {
        this.orientation.collapse();
        this.timeline.step();
        for (let i = Math.abs(this.speed) - 1; i >= 0; --i) {
            this.pull(0);
            this.drawNodes(i * 1 / Math.abs(this.speed));
        }

        // Render Trails
        this.filters.flush((v, t) => this.color(v, t));
    }

    nodeY(node) {
        return (node.y / (this.nodes.length - 1)) * (Daydream.H - 1);
    }

    drawNodes(age) {
        for (let i = 0; i < this.nodes.length; ++i) {
            if (i == 0) {
                let from = pixelToVector(this.nodes[i].x, this.nodeY(this.nodes[i]));
                Plot.Point.draw(this.filters, from, (v, frag) => {
                    const c = this.color(v, 0);
                    c.alpha = (c.alpha || 1) * 0.5;
                    frag.color = c;
                });
            } else {
                let from = pixelToVector(this.nodes[i - 1].x, this.nodeY(this.nodes[i - 1]));
                let to = pixelToVector(this.nodes[i].x, this.nodeY(this.nodes[i]));
                Plot.Line.draw(this.filters, from, to, (v, frag) => {
                    const c = this.color(v, 0);
                    c.alpha = (c.alpha || 1) * 0.5;
                    frag.color = c;
                });
            }
        }
    }

    pull(y) {
        this.nodes[y].v = dir(this.speed);
        this.move(this.nodes[y]);
        for (let i = y - 1; i >= 0; --i) {
            this.drag(this.nodes[i + 1], this.nodes[i]);
        }
        for (let i = y + 1; i < this.nodes.length; ++i) {
            this.drag(this.nodes[i - 1], this.nodes[i]);
        }
    }

    drag(leader, follower) {
        let dest = wrap(follower.x + follower.v, Daydream.W);
        if (shortest_distance(dest, leader.x, Daydream.W) > this.gap) {
            follower.v = leader.v;
            while (shortest_distance(follower.x, leader.x, Daydream.W) > this.gap) {
                this.move(follower);
            }
        } else {
            this.move(follower);
        }
    }

    move(ring) {
        let dest = wrap(ring.x + ring.v, Daydream.W);
        let x = ring.x;
        while (x != dest) {
            x = wrap(x + dir(ring.v), Daydream.W);
        }
        ring.x = dest;
    }
}

