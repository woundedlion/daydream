// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The one anchor-click download the simulator and the tool pages hand a blob
 * to. Dependency-free, so the THREE-free modules can import it without pulling
 * Three.js in through shared.js.
 */

// The click consumes the blob synchronously; the URL only needs to outlive it.
const REVOKE_DELAY_MS = 1000;

/**
 * Save a blob to the viewer's downloads under `filename`.
 * @param {Document} doc - Document the transient anchor is built in.
 * @param {Blob} blob - The data to save.
 * @param {string} filename - Name the download lands under.
 * @returns {void}
 */
export function downloadBlob(doc, blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
