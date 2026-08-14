/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Scene construction for the solids tool (tools/solids.html): turns the JS-side
 * mesh copy into the face / vertex / edge / normal objects and the vertex-index
 * labels, without replaying the WASM op chain.
 *
 * The three.js namespace, the scene and the shared materials are injected rather
 * than imported, matching solid_codegen.js's three-free contract — the renderer
 * runs against a stand-in namespace in a test. Vertices are anything with
 * THREE.Vector3's shape.
 */

import {
  fanTriangulateFace,
  uniqueEdges,
  geodesicSegments,
  geodesicTriangleVertices,
} from './solid_codegen.js';

/**
 * Vertex count at which the index overlay stops being built: one DOM node per
 * vertex, reprojected every frame the camera moves.
 */
export const MAX_INDEX_LABELS = 1000;

/** @typedef {{x: number, y: number, z: number}} Point */

/**
 * A mesh vertex: as much of THREE.Vector3's shape as the render reads.
 * @typedef {Point & {angleTo: (other: any) => number}} Vertex
 */

/**
 * @typedef {{vertices: Vertex[], faces: Array<Array<number>>}} SolidMeshData
 */

/**
 * The three.js namespace, injected so a stand-in can serve in a test. Its
 * constructors are reached by name rather than declared here.
 * @typedef {Object<string, any>} ThreeNamespace
 */

/**
 * The page's presentation toggles.
 * @typedef {object} SolidViewFlags
 * @property {boolean} showGeodesics - Curve the faces and edges onto the sphere.
 * @property {boolean} showFaces - Draw the face geometry.
 * @property {boolean} colorizeFaces - Tint faces by topology class, faces permitting.
 * @property {boolean} showVertices - Draw the vertex dots.
 * @property {boolean} showNormals - Draw the per-face normals.
 * @property {boolean} showIndices - Overlay the vertex-index labels.
 */

/**
 * The stats line under the viewport: vertex, edge, face and index counts.
 * @param {SolidMeshData} meshData - The rendered mesh.
 * @param {number} edgeCount - Unique undirected edges, as counted by the render.
 * @returns {string} The formatted line.
 */
export function meshStatsLine(meshData, edgeCount) {
  const indexCount = meshData.faces.reduce((sum, f) => sum + f.length, 0);
  return `${meshData.vertices.length}V / ${edgeCount}E / `
    + `${meshData.faces.length}F / ${indexCount}I`;
}

/**
 * Builds the mesh renderer, which owns the four scene objects it swaps.
 * @param {Object} opts - Renderer context.
 * @param {ThreeNamespace} opts.THREE - The three.js namespace.
 * @param {{add: (object: any) => void, remove: (object: any) => void}} opts.scene - Scene the objects are added to.
 * @param {Object<string, any>} opts.materials - Shared materials: {face, faceColorize, vert, edge, normal}.
 * @param {Element} [opts.labelsContainer] - Overlay the vertex-index labels are appended to; without one the render builds no labels.
 * @param {Document} [opts.doc] - Document the label nodes are created in.
 * @returns {{render: (meshData: SolidMeshData, view: SolidViewFlags, faceClassIds: Int32Array?) => {edgeCount: number, labelsBuilt: boolean}, disposeGeometry: () => void}} The renderer.
 */
export function createMeshRenderer({ THREE, scene, materials, labelsContainer, doc = document }) {
  /** @type {any} */
  let mainMesh = null;
  /** @type {any} */
  let edgeLines = null;
  /** @type {any} */
  let vertPoints = null;
  /** @type {any} */
  let normalLines = null;

  /**
   * Drops one scene object and its geometry.
   * @param {any} object - The object, or null when the toggle left it unbuilt.
   * @returns {null} Always null, so the caller's handle is cleared.
   */
  function discard(object) {
    if (object) {
      object.geometry.dispose();
      scene.remove(object);
    }
    return null;
  }

  return {
    /**
     * Frees the geometry of whatever is currently built, for page teardown.
     * @returns {void}
     */
    disposeGeometry() {
      mainMesh?.geometry.dispose();
      edgeLines?.geometry.dispose();
      vertPoints?.geometry.dispose();
      normalLines?.geometry.dispose();
    },

    /**
     * Rebuilds the scene from a mesh already read out of WASM.
     * @param {SolidMeshData} meshData - The mesh to draw.
     * @param {SolidViewFlags} view - The page's presentation flags.
     * @param {Int32Array?} faceClassIds - Per-face topology class ids, or null when none were computed.
     * @returns {{edgeCount: number, labelsBuilt: boolean}} What the render produced.
     */
    render(meshData, view, faceClassIds) {
      // Colorize is applied only when faces are shown; otherwise the per-vertex
      // color attribute would be built for hidden geometry.
      const faceClasses = (view.colorizeFaces && view.showFaces) ? faceClassIds : null;

      // Null each handle after disposal: a toggle that leaves its object
      // unbuilt would otherwise re-dispose the same geometry on every recompute.
      mainMesh = discard(mainMesh);
      edgeLines = discard(edgeLines);
      vertPoints = discard(vertPoints);
      normalLines = discard(normalLines);
      if (labelsContainer) labelsContainer.replaceChildren();

      // Faces
      /** @type {number[]} */
      const vertices = [];
      /** @type {number[]} */
      const faceColors = []; // per-vertex RGB, filled only when colorizing
      const classColor = new THREE.Color();

      /** @type {any[]} */
      const faceCenters = [];
      /** @type {any[]} */
      const faceNormals = [];

      // Geodesic mode curves the faces onto the sphere (geodesicTriangleVertices
      // does the per-triangle tessellation); geodesicSegments() picks geoN from
      // the mesh's widest arc and its triangle count. Geodesic mode forces the
      // centroid fan, so a face emits f.length triangles, not f.length - 2.
      let geoN = 1;
      if (view.showFaces && view.showGeodesics) {
        let triCount = 0;
        let maxArc = 0;
        meshData.faces.forEach(f => {
          triCount += f.length;
          for (let i = 1; i < f.length - 1; i++) {
            const a = meshData.vertices[f[0]];
            const b = meshData.vertices[f[i]];
            const c = meshData.vertices[f[i + 1]];
            maxArc = Math.max(maxArc, a.angleTo(b), b.angleTo(c), c.angleTo(a));
          }
        });
        geoN = geodesicSegments(maxArc, triCount);
      }

      const pushVert = (/** @type {Point} */ v) => {
        vertices.push(v.x, v.y, v.z);
        if (faceClasses) {
          faceColors.push(classColor.r, classColor.g, classColor.b);
        }
      };

      // Append one fan triangle's geoN² spherical sub-triangles, matching
      // pushVert's per-vertex color emission.
      const emitSphericalTri = (/** @type {Point} */ a, /** @type {Point} */ b, /** @type {Point} */ c) => {
        const xyz = geodesicTriangleVertices(a, b, c, geoN);
        for (let i = 0; i < xyz.length; i += 3) {
          vertices.push(xyz[i], xyz[i + 1], xyz[i + 2]);
          if (faceClasses) {
            faceColors.push(classColor.r, classColor.g, classColor.b);
          }
        }
      };

      const emitFlatTri = (/** @type {Point} */ a, /** @type {Point} */ b, /** @type {Point} */ c) => {
        pushVert(a);
        pushVert(b);
        pushVert(c);
      };
      const emitTri = view.showGeodesics ? emitSphericalTri : emitFlatTri;

      meshData.faces.forEach((f, fi) => {
        if (view.showFaces) {
          if (faceClasses) {
            // Golden-ratio hue stride keeps consecutive class ids far apart on
            // the color wheel, so adjacent face groups stay distinguishable.
            classColor.setHSL((faceClasses[fi] * 0.618034) % 1, 0.65, 0.55);
          }
          fanTriangulateFace(meshData.vertices, f, emitTri, view.showGeodesics);
        }

        if (!view.showNormals) return;

        // Center/Normal for other viz
        const center = new THREE.Vector3();
        f.forEach(idx => {
          let v = new THREE.Vector3().copy(meshData.vertices[idx]);
          if (view.showGeodesics) v.normalize();
          center.add(v);
        });
        center.divideScalar(f.length);
        faceCenters.push(center);

        // Normal
        const v0 = meshData.vertices[f[0]];
        const v1 = meshData.vertices[f[1]];
        const v2 = meshData.vertices[f[f.length - 1]];
        const n = new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(v1, v0), new THREE.Vector3().subVectors(v2, v0)).normalize();
        faceNormals.push(n);
      });

      if (view.showFaces) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        if (view.showGeodesics) {
          // Every emitted vertex sits on the unit sphere, so its normal IS its
          // position; computeVertexNormals on this non-indexed geometry would
          // yield per-triangle normals and shade the tessellation as facets.
          geometry.setAttribute('normal', new THREE.Float32BufferAttribute([...vertices], 3));
        } else {
          geometry.computeVertexNormals();
        }
        if (faceClasses) {
          geometry.setAttribute('color', new THREE.Float32BufferAttribute(faceColors, 3));
        }

        // Flat shading reads face normals in-shader (ignoring the normal
        // attribute), which is right for the polyhedral look but would facet the
        // sphere; geodesic mode needs the smooth normals set above.
        const wantFlat = !view.showGeodesics;
        for (const m of [materials.face, materials.faceColorize]) {
          if (m.flatShading !== wantFlat) {
            m.flatShading = wantFlat;
            m.needsUpdate = true;
          }
        }

        mainMesh = new THREE.Mesh(geometry, faceClasses ? materials.faceColorize : materials.face);
        scene.add(mainMesh);
      }

      // Vertices
      if (view.showVertices) {
        const dotGeo = new THREE.BufferGeometry().setFromPoints(meshData.vertices);
        vertPoints = new THREE.Points(dotGeo, materials.vert);
        scene.add(vertPoints);
      }

      // Edges
      const edges = uniqueEdges(meshData.faces, meshData.vertices.length);

      /** @type {any[]} */
      const lineGeoPoints = [];
      for (const [ai, bi] of edges) {
        const va = meshData.vertices[ai];
        const vb = meshData.vertices[bi];

        if (view.showGeodesics) {
          const steps = 12;
          for (let j = 0; j < steps; j++) {
            const t1 = j / steps;
            const t2 = (j + 1) / steps;
            const p1 = new THREE.Vector3().copy(va).lerp(vb, t1).normalize().multiplyScalar(1.002);
            const p2 = new THREE.Vector3().copy(va).lerp(vb, t2).normalize().multiplyScalar(1.002);
            lineGeoPoints.push(p1, p2);
          }
        } else {
          lineGeoPoints.push(va, vb);
        }
      }

      const lineGeo = new THREE.BufferGeometry().setFromPoints(lineGeoPoints);
      edgeLines = new THREE.LineSegments(lineGeo, materials.edge);
      scene.add(edgeLines);

      // Normals
      if (view.showNormals) {
        /** @type {any[]} */
        const normalPoints = [];
        /** @type {number[]} */
        const colors = [];
        faceCenters.forEach((c, i) => {
          const n = faceNormals[i];
          const p2 = c.clone().add(n.multiplyScalar(0.15));
          normalPoints.push(c, p2);
          colors.push(0, 1, 0, 0, 1, 0);
        });
        const normGeo = new THREE.BufferGeometry().setFromPoints(normalPoints);
        normGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        normalLines = new THREE.LineSegments(normGeo, materials.normal);
        scene.add(normalLines);
      }

      // Indices. Build into a DocumentFragment and insert in a single
      // appendChild so the whole label set costs one DOM mutation instead of
      // one per vertex.
      let labelsBuilt = false;
      if (view.showIndices && labelsContainer
          && meshData.vertices.length < MAX_INDEX_LABELS) {
        const frag = doc.createDocumentFragment();
        meshData.vertices.forEach((v, i) => {
          const el = doc.createElement('div');
          el.textContent = String(i);
          el.className = 'absolute text-[0.75rem] font-mono text-white bg-black/50 px-1 rounded transform -translate-x-1/2 -translate-y-1/2 pointer-events-none';
          el.dataset.index = String(i);
          frag.appendChild(el);
        });
        labelsContainer.appendChild(frag);
        labelsBuilt = true;
      }

      return { edgeCount: edges.length, labelsBuilt };
    },
  };
}
