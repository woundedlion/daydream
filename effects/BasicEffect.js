/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream } from "../driver.js";
import { Timeline, Orientation, Animation } from "../animation.js";
import { easeMid } from "../easing.js";
import {
    createRenderPipeline,
    Filter,
} from "../filters.js";

export class BasicEffect {
    constructor() {
        this.orientation = new Orientation();
        this.timeline = new Timeline();
        this.timeline.add(0, new Animation.RandomWalk(this.orientation, Daydream.UP));

        this.filters = createRenderPipeline(
            new Filter.World.Orient(this.orientation),
            new Filter.Screen.AntiAlias()
        );

    }

    spawnEntity(duration = 180) { // Default 3 seconds
        const entity = new BasicEffect.Entity();

        const sprite = new Animation.Sprite(
            (opacity) => this.drawEntity(entity, opacity),
            -1,
            32, easeMid, // Fade In
            0, easeMid  // Fade Out
        );

        this.timeline.add(0, sprite);
        return entity;
    }

    drawEntity(entity, opacity) {
        // Override this method in subclasses
    }

    drawFrame() {
        this.timeline.step();
        this.filters.flush(null, 1.0);
    }

    static Entity = class Entity {
        constructor() {
            this.orientation = new Orientation();
        }
    }
}
