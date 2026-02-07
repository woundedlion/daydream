/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";

/**
 * A generic, fixed-size object pool that mimics C++ static allocation.
 * Optimized for "per-frame" scratch objects that are discarded together.
 */
export class StaticPool {
    /**
     * @param {class} Type - The class constructor (e.g., THREE.Vector3)
     * @param {number} capacity - The maximum number of objects (e.g., 10000)
     */
    constructor(Type, capacity) {
        this.store = new Array(capacity);
        this.cursor = 0;
        this.capacity = capacity;
        this.Type = Type;
        this.initializedCount = 0;
    }

    /**
     * Returns an instance from the pool.
     * * @returns {Object} An instance of Type
     */
    acquire() {
        // Late binding check
        if (!this.Type) {
            console.error("StaticPool: Type is not defined (Late Binding missed)!", this);
            return null;
        }

        if (this.cursor >= this.capacity) {
            const newCap = this.capacity * 2;
            console.warn(`StaticPool: Expanding capacity for ${this.Type.name} from ${this.capacity} to ${newCap}`);
            this.capacity = newCap;
        }

        if (this.cursor >= this.initializedCount) {
            this.store[this.cursor] = new this.Type();
            this.initializedCount++;
        }

        return this.store[this.cursor++];
    }

    /**
     * Resets the allocator for the next frame.
     * Does NOT delete objects, just rewinds the cursor.
     */
    reset() {
        this.cursor = 0;
    }
}


/** @type {StaticPool} Global pool for temporary Vector3 objects. */
export const vectorPool = new StaticPool(THREE.Vector3, 2000000);

/** @type {StaticPool} Global pool for temporary Quaternion objects. */
export const quaternionPool = new StaticPool(THREE.Quaternion, 4000000);

/** @type {StaticPool} Global pool for temporary Color objects used in blending. */
export const colorPool = new StaticPool(THREE.Color, 1000000);

/** @type {StaticPool} Global pool for temporary Dot objects. */
export const dotPool = new StaticPool(null, 10000);

/** @type {StaticPool} Global pool for temporary Color4 objects. */
export const color4Pool = new StaticPool(null, 250000);

/** @type {StaticPool} Global pool for Fragment objects (Pos + Data). */
export const fragmentPool = new StaticPool(null, 2000000);
