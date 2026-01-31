/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { vectorPool } from "./memory.js";

export class KDTree {
    constructor(points) {
        // Points is array of { pos: Vector3, ...data }
        this.root = this._build(points, 0);
    }

    _build(points, depth) {
        if (!points.length) return null;

        const axis = depth % 3;
        const axisName = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';

        // Sort by current axis
        points.sort((a, b) => a.pos[axisName] - b.pos[axisName]);

        const mid = points.length >> 1; // Fast integer divide by 2
        return {
            point: points[mid],
            axis: axisName,
            left: this._build(points.slice(0, mid), depth + 1),
            right: this._build(points.slice(mid + 1), depth + 1)
        };
    }

    nearest(target, k = 1) {
        const best = []; // Stores { dist, node }
        this._search(this.root, target, k, best);
        return best.map(b => b.node);
    }

    _search(node, target, k, best) {
        if (!node) return;

        const dSq = node.point.pos.distanceToSquared(target);
        const axisDist = target[node.axis] - node.point.pos[node.axis];

        // Maintain "Best K" list
        if (best.length < k || dSq < best[best.length - 1].dist) {
            best.push({ dist: dSq, node: node.point });
            best.sort((a, b) => a.dist - b.dist);
            if (best.length > k) best.pop();
        }

        // Recursive Search
        const near = axisDist < 0 ? node.left : node.right;
        const far = axisDist < 0 ? node.right : node.left;

        this._search(near, target, k, best);

        // Pruning: Only check "far" side if plane intersects our best-so-far radius
        if (best.length < k || (axisDist * axisDist) < best[best.length - 1].dist) {
            this._search(far, target, k, best);
        }
    }
}

/**
 * Axis-Aligned Bounding Box.
 */
export class AABB {
    constructor() {
        this.min = new THREE.Vector3(Infinity, Infinity, Infinity);
        this.max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    }

    /**
     * Expands the AABB to include a point.
     * @param {THREE.Vector3} p - Point to include.
     */
    expand(p) {
        this.min.min(p);
        this.max.max(p);
    }

    /**
     * Expands the AABB to include another AABB.
     * @param {AABB} box - Box to include.
     */
    union(box) {
        this.min.min(box.min);
        this.max.max(box.max);
    }

    /**
     * Clones the AABB.
     * @returns {AABB} Cloned box.
     */
    clone() {
        const box = new AABB();
        box.min.copy(this.min);
        box.max.copy(this.max);
        return box;
    }

    /**
     * Checks if a ray intersects this AABB.
     * @param {THREE.Vector3} origin - Ray origin.
     * @param {THREE.Vector3} direction - Ray direction (normalized).
     * @returns {boolean} True if intersecting.
     */
    intersectRay(origin, direction) {
        let tmin = (this.min.x - origin.x) / direction.x;
        let tmax = (this.max.x - origin.x) / direction.x;

        if (tmin > tmax) [tmin, tmax] = [tmax, tmin];

        let tymin = (this.min.y - origin.y) / direction.y;
        let tymax = (this.max.y - origin.y) / direction.y;

        if (tymin > tymax) [tymin, tymax] = [tymax, tymin];

        if ((tmin > tymax) || (tymin > tmax)) return false;

        if (tymin > tmin) tmin = tymin;
        if (tymax < tmax) tmax = tymax;

        let tzmin = (this.min.z - origin.z) / direction.z;
        let tzmax = (this.max.z - origin.z) / direction.z;

        if (tzmin > tzmax) [tzmin, tzmax] = [tzmax, tzmin];

        if ((tmin > tzmax) || (tzmin > tmax)) return false;

        return true;
    }

    /**
     * Returns the closest distance from a point to the AABB.
     * 0 if inside.
     * @param {THREE.Vector3} p - Point.
     * @returns {number} Squared distance.
     */
    distanceToPointSquared(p) {
        let dx = Math.max(this.min.x - p.x, 0, p.x - this.max.x);
        let dy = Math.max(this.min.y - p.y, 0, p.y - this.max.y);
        let dz = Math.max(this.min.z - p.z, 0, p.z - this.max.z);
        return dx * dx + dy * dy + dz * dz;
    }
}

/**
 * Node in the BVH tree.
 */
class BVHNode {
    constructor() {
        this.aabb = new AABB();
        this.left = null;
        this.right = null;
        this.indices = null; // Leaf only: array of face indices
    }
}

/**
 * Bounding Volume Hierarchy for a triangle mesh.
 */
export class BVH {
    constructor(mesh) {
        this.mesh = mesh;
        this.root = null;
    }

    /**
     * Builds the BVH from the mesh.
     */
    build() {
        const indices = []; // Face indices
        const centroids = []; // Face centroids for splitting

        for (let i = 0; i < this.mesh.faces.length; i++) {
            indices.push(i);

            // Compute centroid
            const face = this.mesh.faces[i];
            const c = new THREE.Vector3();
            for (const vIdx of face) {
                c.add(this.mesh.vertices[vIdx]);
            }
            c.divideScalar(face.length);
            centroids.push(c);
        }

        this.root = this.buildRecursive(indices, centroids);
    }

    buildRecursive(indices, centroids) {
        const node = new BVHNode();

        // 1. Compute AABB for this node
        for (const idx of indices) {
            const face = this.mesh.faces[idx];
            for (const vIdx of face) {
                node.aabb.expand(this.mesh.vertices[vIdx]);
            }
        }

        // 2. Leaf condition
        if (indices.length <= 4) { // Small enough bucket
            node.indices = indices;
            return node;
        }

        // 3. Split
        // Find split axis (longest extent of AABB)
        const size = new THREE.Vector3().subVectors(node.aabb.max, node.aabb.min);
        let axis = 'x';
        if (size.y > size.x && size.y > size.z) axis = 'y';
        if (size.z > size.x && size.z > size.y) axis = 'z';

        const mid = (node.aabb.min[axis] + node.aabb.max[axis]) * 0.5;

        const leftIndices = [];
        const rightIndices = [];

        for (const idx of indices) {
            if (centroids[idx][axis] < mid) {
                leftIndices.push(idx);
            } else {
                rightIndices.push(idx);
            }
        }

        // Handle case where all centroids are on one side (e.g. coincident faces)
        if (leftIndices.length === 0 || rightIndices.length === 0) {
            node.indices = indices;
            return node;
        }

        node.left = this.buildRecursive(leftIndices, centroids);
        node.right = this.buildRecursive(rightIndices, centroids);

        return node;
    }

    /**
     * Intersects the BVH with a ray.
     * @param {THREE.Vector3} origin - Ray origin.
     * @param {THREE.Vector3} direction - Ray direction.
     * @param {Object} [result] - Closest hit result { dist, point, faceIndex }.
     * @returns {Object|null} Result or null.
     */
    intersectRay(origin, direction) {
        let bestHit = null;
        const stack = [this.root];

        // Temp vectors for triangle intersection
        const v0 = vectorPool.acquire();
        const edge1 = vectorPool.acquire();
        const edge2 = vectorPool.acquire();
        const h = vectorPool.acquire();
        const s = vectorPool.acquire();
        const q = vectorPool.acquire();

        while (stack.length > 0) {
            const node = stack.pop();

            if (!node.aabb.intersectRay(origin, direction)) continue;

            if (node.indices) {
                // Leaf: check faces
                for (const idx of node.indices) {
                    const face = this.mesh.faces[idx];

                    // Fan triangulation for polygon faces
                    for (let i = 0; i < face.length - 2; i++) {
                        v0.copy(this.mesh.vertices[face[0]]);
                        const v1 = this.mesh.vertices[face[i + 1]];
                        const v2 = this.mesh.vertices[face[i + 2]];

                        edge1.subVectors(v1, v0);
                        edge2.subVectors(v2, v0);

                        h.crossVectors(direction, edge2);
                        const a = edge1.dot(h);

                        if (a > -1e-6 && a < 1e-6) continue; // Parallel

                        const f = 1.0 / a;
                        s.subVectors(origin, v0);
                        const u = f * s.dot(h);

                        if (u < 0.0 || u > 1.0) continue;

                        q.crossVectors(s, edge1);
                        const v = f * direction.dot(q);

                        if (v < 0.0 || u + v > 1.0) continue;

                        const t = f * edge2.dot(q);

                        if (t > 1e-6) { // Valid hit
                            if (!bestHit || t < bestHit.dist) {
                                if (!bestHit) bestHit = { point: new THREE.Vector3() };
                                bestHit.dist = t;
                                bestHit.faceIndex = idx;
                                bestHit.point.copy(origin).addScaledVector(direction, t);
                            }
                        }
                    }
                }
            } else {
                if (node.left) stack.push(node.left);
                if (node.right) stack.push(node.right);
            }
        }

        return bestHit;
    }
}

/**
 * Spatial hashing for neighbor lookup.
 */
export class SpatialHash {
    constructor(cellSize) {
        this.cellSize = cellSize;
        this.buckets = new Map();
    }

    /**
     * Inserts a particle.
     * @param {Object} particle - Particle with .orientedPosition.
     */
    insert(particle) {
        const key = this.getKey(particle.orientedPosition);
        if (!this.buckets.has(key)) this.buckets.set(key, []);
        this.buckets.get(key).push(particle);
    }

    /**
     * Gets hash key for a vector.
     * @param {THREE.Vector3} v - Position.
     * @returns {string} Hash key.
     */
    getKey(v) {
        const x = Math.floor(v.x / this.cellSize);
        const y = Math.floor(v.y / this.cellSize);
        const z = Math.floor(v.z / this.cellSize);
        return `${x},${y},${z}`;
    }

    /**
     * Finds neighbors within radius.
     * @param {THREE.Vector3} position - Center.
     * @param {number} radius - Search radius.
     * @returns {Array} List of neighbors.
     */
    query(position, radius) {
        const particles = [];
        const cx = Math.floor(position.x / this.cellSize);
        const cy = Math.floor(position.y / this.cellSize);
        const cz = Math.floor(position.z / this.cellSize);
        const range = Math.ceil(radius / this.cellSize);

        for (let x = cx - range; x <= cx + range; x++) {
            for (let y = cy - range; y <= cy + range; y++) {
                for (let z = cz - range; z <= cz + range; z++) {
                    const key = `${x},${y},${z}`;
                    if (this.buckets.has(key)) {
                        const bucket = this.buckets.get(key);
                        for (const p of bucket) {
                            if (p.orientedPosition.distanceToSquared(position) <= radius * radius) particles.push(p);
                        }
                    }
                }
            }
        }
        return particles;
    }

    /**
     * Clears the hash.
     */
    clear() {
        this.buckets.clear();
    }
}