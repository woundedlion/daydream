/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

/** @typedef {import('three').Scene} Scene */
/** @typedef {import('three').Vector3} Vector3 */

/**
 * Reuses CSS2DObject label sprites across frames so axis labels can be
 * rebuilt every frame without churning the DOM. acquire() hands out pooled
 * objects in order; cleanup() removes from the scene any left over from the
 * previous frame.
 */
export class LabelPool {
  /**
   * @param {Scene} scene - Scene that pooled label objects are added to and removed from.
   * @param {number} radius - Sphere radius that unit label directions are scaled to.
   * @param {Document} [doc] - Document label elements are created in; defaults to the global `document`.
   */
  constructor(scene, radius, doc = globalThis.document) {
    this.scene = scene;
    this.radius = radius;
    this.doc = doc;
    /** @type {CSS2DObject[]} */
    this.pool = [];
    this.activeCount = 0;
  }

  /**
   * Mark all pooled labels free for reuse this frame (without hiding them yet).
   */
  reset() {
    this.activeCount = 0;
  }

  /**
   * Place the next pooled label at `position` (a unit direction, scaled to the
   * sphere surface) showing `content`, growing the pool if exhausted.
   * @param {Vector3} position - Unit direction, scaled to the sphere surface for placement.
   * @param {string} content - Plain-text label content (set via textContent so it cannot inject markup).
   */
  acquire(position, content) {
    let labelObj;

    if (this.activeCount < this.pool.length) {
      labelObj = this.pool[this.activeCount];
    } else {
      const div = this.doc.createElement("div");
      div.className = "label";
      labelObj = new CSS2DObject(div);
      labelObj.center.set(0, 0);
      this.pool.push(labelObj);
    }

    if (labelObj.parent !== this.scene) {
      this.scene.add(labelObj);
    }

    labelObj.position.copy(position).multiplyScalar(this.radius);
    labelObj.visible = true;

    if (labelObj.element.textContent !== content) {
      labelObj.element.textContent = content;
    }

    this.activeCount++;
  }

  /**
   * Remove from the scene any pooled labels not acquired this frame, so stale
   * labels from a busier previous frame disappear.
   */
  cleanup() {
    for (let i = this.activeCount; i < this.pool.length; i++) {
      const obj = this.pool[i];
      if (obj.parent === this.scene) {
        this.scene.remove(obj);
      }
    }
  }
}
