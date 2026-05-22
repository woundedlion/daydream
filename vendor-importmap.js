/*
 * Builds the page's importmap with local-first / CDN-fallback resolution
 * for 3rd-party libraries (three.js, lil-gui). The script auto-detects
 * its own location, so it works from index.html (./vendor-importmap.js)
 * or tools/*.html (../vendor-importmap.js) with no per-page configuration.
 *
 * Probes synchronously via XHR HEAD before any ES module loads. If a
 * page needs page-specific local imports (e.g. tool helpers), assign
 * window.__DAYDREAM_EXTRA_IMPORTS = { name: '...' } before this script.
 */
(function () {
  const ROOT = new URL('.', document.currentScript.src);
  const EXTRA = window.__DAYDREAM_EXTRA_IMPORTS || {};

  // Versions match daydream/package.json. Bump together when upgrading.
  const THREE_VERSION = '0.183.1';
  const LIL_GUI_VERSION = '0.21.0';
  const CDN = 'https://cdn.jsdelivr.net/npm';

  const abs = (path) => new URL(path, ROOT).href;
  const exists = (url) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('HEAD', url, false);
      xhr.send();
      return xhr.status >= 200 && xhr.status < 400;
    } catch (e) {
      return false;
    }
  };

  const localThreeBase = abs('three.js/');
  const localLilGui = abs('node_modules/lil-gui/dist/lil-gui.esm.min.js');
  const threeBase = exists(localThreeBase + 'build/three.module.js')
    ? localThreeBase
    : `${CDN}/three@${THREE_VERSION}/`;
  const lilGui = exists(localLilGui)
    ? localLilGui
    : `${CDN}/lil-gui@${LIL_GUI_VERSION}/dist/lil-gui.esm.min.js`;

  const imports = Object.assign({
    'three': `${threeBase}build/three.module.js`,
    'three/webgpu': `${threeBase}examples/jsm/renderers/webgpu/WebGPURenderer.js`,
    'three/addons/': `${threeBase}examples/jsm/`,
    'lil-gui': lilGui,
    'gui': abs('gui.js'),
  }, EXTRA);

  const s = document.createElement('script');
  s.type = 'importmap';
  s.textContent = JSON.stringify({ imports });
  document.head.appendChild(s);
})();
