/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { dotDetailFor } from "./dot_detail.js";

/** @typedef {import('./driver.js').RgbMesh} RgbMesh */

/**
 * (Re)build the InstancedMesh of dots, one instance per pixel (W*H). Disposes
 * any previous mesh, lazily builds the dot material (whose injected shader
 * hides black pixels and back-face-culls the far hemisphere), and picks a
 * sphere tessellation that drops as pixel count rises to cap geometry cost.
 * @param {import('./driver.js').Daydream} driver - Display state.
 */
export function setupDots(driver) {
  driver.releaseDotMesh();

  initializeDotMaterial(driver);

  const totalPixels = driver.W * driver.H;
  const detail = dotDetailFor(totalPixels);

  driver.dotGeometry = new THREE.SphereGeometry(
    driver.DOT_SIZE,
    detail,
    detail,
    0,
    Math.PI
  );

  driver.dotMesh = /** @type {RgbMesh} */ (new THREE.InstancedMesh(
    driver.dotGeometry,
    /** @type {THREE.MeshBasicMaterial} */ (driver.dotMaterial),
    totalPixels
  ));

  driver.dotMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  driver.dotMesh.count = totalPixels;
  driver.dotMesh.frustumCulled = false;
  driver.scene.add(driver.dotMesh);
}

/** @param {import('./driver.js').Daydream} driver */
function initializeDotMaterial(driver) {
  if (!driver.dotMaterial) {
    driver.dotMaterial = new THREE.MeshBasicMaterial({
      side: THREE.FrontSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      depthWrite: false
    });

    // Backface-cull + column gap-fill uniforms, updated per frame in
    // updateCullUniforms().
    driver.cullUniforms = {
      uCameraPos: { value: new THREE.Vector3(0, 0, 1) },
      uCullThreshold: { value: -0.06 },
      uColumnFillArc: { value: 0 }
    };

    const uniforms = driver.cullUniforms;
    driver.dotMaterial.onBeforeCompile = (shader) => {
      if (!shader.vertexShader.includes('#include <begin_vertex>'))
        throw new Error('Dot shader is missing the begin_vertex chunk');
      shader.uniforms.uCameraPos = uniforms.uCameraPos;
      shader.uniforms.uCullThreshold = uniforms.uCullThreshold;
      shader.uniforms.uColumnFillArc = uniforms.uColumnFillArc;

      shader.vertexShader = 'uniform vec3 uCameraPos;\nuniform float uCullThreshold;\nuniform float uColumnFillArc;\n' + shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
          #include <begin_vertex>
          #if defined(USE_INSTANCING_COLOR)
             // Hide black pixels
             if (dot(instanceColor, instanceColor) < 1e-10) {
                 transformed *= 0.0;
             }
             vec3 instPos = (instanceMatrix[3]).xyz;
             // Column gap-fill (uColumnFillArc > 0): extend each
             // dot east-west into a PILL whose STRAIGHT (full-radius) middle
             // reaches the column-cell boundary, so a run of lit columns tiles
             // flush — flat seams, no scalloping — and only the run's terminal
             // caps stay rounded. The dot's local +x is the longitude (sweep)
             // tangent after the per-instance lookAt. We TRANSLATE the two
             // x-halves apart by ext (not scale — scaling a sphere yields an
             // oval): the bridge between them becomes a full-radius cylinder and
             // the original rounded caps ride OUT past the cell boundary into the
             // neighbour cell. Where the neighbour is lit, its own straight body
             // buries this cap (flat join); where the neighbour is dark (culled
             // to nothing) the cap shows as the rounded terminal. ext = the cell
             // half-arc times COLUMN_FILL_OVERLAP = uColumnFillArc * sinPhi; sinPhi (latitude
             // foreshortening from instPos) shrinks the cell toward the poles.
             // uColumnFillArc == 0 leaves round dots.
             float sinPhi = length(instPos.xz) / max(length(instPos), 1e-6);
             float ext = uColumnFillArc * sinPhi;
             transformed.x += sign(transformed.x) * ext;
             // Backface cull: dot of instance position with camera direction
             float facing = dot(normalize(instPos), normalize(uCameraPos));
             if (facing < uCullThreshold) {
                 transformed *= 0.0;
             }
          #endif
          `
      );
    };
  }

}
