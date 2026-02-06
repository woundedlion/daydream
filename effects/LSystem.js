/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import { Timeline, Rotation, Orientation } from "../animation.js";
import { Plot } from "../plot.js";
import { createRenderPipeline, FilterOrient, FilterAntiAlias } from "../filters.js";
import { easeMid } from "../easing.js";
import { GenerativePalette } from "../color.js";
import { TWO_PI } from "../3dmath.js";

class SphericalTurtle {
    constructor(pos, heading) {
        this.pos = pos.clone().normalize();
        this.heading = heading.clone().normalize();
    }

    copy() {
        return new SphericalTurtle(this.pos, this.heading);
    }

    forward(dist) {
        // Move along geodesic by distance 'dist' (radians)
        const axis = new THREE.Vector3().crossVectors(this.pos, this.heading).normalize();
        const rot = new THREE.Quaternion().setFromAxisAngle(axis, dist);

        const start = this.pos.clone();
        this.pos.applyQuaternion(rot);
        this.heading.applyQuaternion(rot); // Transport heading

        return { start, end: this.pos.clone() };
    }

    turn(angle) {
        // Rotate heading around local normal (pos)
        const rot = new THREE.Quaternion().setFromAxisAngle(this.pos, angle);
        this.heading.applyQuaternion(rot);
    }
}

export class LSystem {
    constructor() {
        this.orientation = new Orientation();
        this.timeline = new Timeline();
        this.filters = createRenderPipeline(
            new FilterOrient(this.orientation),
            new FilterAntiAlias()
        );
        this.palette = new GenerativePalette();

        this.params = {
            iterations: 3,
            step: 0.4,
            angle: 60,
            rule: 0
        };

        this.rulesets = [
            {
                name: "Tree",
                axiom: "X",
                rules: {
                    "X": "F[+X][-X]FX",
                    "F": "FF"
                },
                angle: 35,
                step: 0.25,
                iterations: 4
            },
            {
                name: "Bush",
                axiom: "F",
                rules: {
                    "F": "FF-[-F+F+F]+[+F-F-F]"
                },
                angle: 25,
                step: 0.1,
                iterations: 4
            },
            {
                name: "Mosaic",
                axiom: "F++F++F",
                rules: {
                    "F": "F-F++F-F"
                },
                angle: 79,
                step: 0.33,
                iterations: 3
            }
        ];

        this.params = {
            iterations: this.rulesets[2].iterations,
            step: this.rulesets[2].step,
            angle: this.rulesets[2].angle,
            rule: 2
        };

        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this.params, 'iterations', 1, 6).step(1).listen().onChange(() => this.regenerate());
        this.gui.add(this.params, 'step', 0.01, 1.0).listen().onChange(() => this.regenerate());
        this.gui.add(this.params, 'angle', 0, 120).listen().onChange(() => this.regenerate());
        this.gui.add(this.params, 'rule', { "Tree": 0, "Bush": 1, "Mosaic": 2 }).onChange(() => {
            // Auto-update params to preset defaults
            const preset = this.rulesets[this.params.rule];
            this.params.iterations = preset.iterations;
            this.params.step = preset.step;
            this.params.angle = preset.angle;
            this.regenerate();
        });

        // Initial generation
        this.regenerate();

        // Spin the tree
        this.timeline.add(0, new Rotation(this.orientation, Daydream.Y_AXIS, TWO_PI, 1200, easeMid, true));
    }

    regenerate() {
        this.segments = this.generateTree();
    }

    generateTree() {
        const ruleset = this.rulesets[this.params.rule];
        let s = ruleset.axiom;

        for (let i = 0; i < this.params.iterations; i++) {
            s = s.split('').map(c => {
                if (ruleset.rules[c] !== undefined) return ruleset.rules[c];
                return c;
            }).join('');
        }

        const step = this.params.step;
        const angle = this.params.angle * Math.PI / 180;

        // Start near bottom
        let pos = new THREE.Vector3(0, -1, 0);
        // Initial heading roughly North
        let heading = new THREE.Vector3(0, 0, 1);

        // Perturb start slightly to avoid singularity issues if exactly at pole
        // But spherical turtle handles pole fine as long as heading is orthogonal.
        // (0,-1,0) dot (0,0,1) = 0. OK.

        let turtle = new SphericalTurtle(pos, heading);
        const stack = [];
        const segments = [];

        for (let c of s) {
            if (c === 'F') {
                segments.push(turtle.forward(step));
            }
            else if (c === '+') {
                turtle.turn(angle);
            }
            else if (c === '-') {
                turtle.turn(-angle);
            }
            else if (c === '[') {
                stack.push(turtle.copy());
            }
            else if (c === ']') {
                const state = stack.pop();
                if (state) turtle = state;
            }
        }
        return segments;
    }

    drawFrame() {
        this.orientation.collapse();
        this.timeline.step();

        if (this.segments) {
            for (let seg of this.segments) {
                Plot.Line.draw(this.filters, seg.start, seg.end, (v) => this.palette.get((v.y + 1) / 2));
            }
        }
    }
}

