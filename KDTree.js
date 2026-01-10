/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

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