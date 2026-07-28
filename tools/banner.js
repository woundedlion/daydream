/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Dependency-free page-level banner and bootstrap helpers for the tool pages.
 *
 * Kept separate from shared.js (the Three.js scene setup) so non-3D pages —
 * e.g. palettes.html — can surface a fatal error without pulling Three.js into
 * their module graph. shared.js re-exports these for its scene-based callers.
 */

/**
 * Render a visible error banner across the top of the page. Tool pages that
 * boot a WASM engine call this from their bootstrap catch so a missing or
 * failed-to-load artifact surfaces to the user, instead of leaving a blank
 * canvas with only a console line (mirrors the segmented view's fault overlay).
 * Idempotent — repeated calls update the single banner.
 *
 * @param {string} message - Human-readable failure description.
 * @returns {void}
 */
export function showFatalError(message) {
  const existing = document.getElementById('fatal-error-overlay');
  const el = existing || document.createElement('div');
  el.id = 'fatal-error-overlay';
  el.setAttribute('role', 'alert');
  el.textContent = `⚠ ${message}`; // textContent, not innerHTML — no injection
  Object.assign(el.style, {
    position: 'fixed', top: '0', left: '0', right: '0', zIndex: '9999',
    padding: '12px 16px', background: '#7f1d1d', color: '#fff',
    font: '14px/1.4 system-ui, sans-serif', textAlign: 'center',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
  });
  if (!existing) {
    const parent = document.body || document.documentElement;
    if (parent) parent.appendChild(el);
  }
}

/**
 * Run a tool page's initializer on window load and route any failure to the
 * console plus a fatal banner. Accepts a synchronous or an async init: a thrown
 * error and a rejected promise take the same path.
 *
 * addEventListener (not `window.onload =`) avoids clobbering any other load
 * handler.
 *
 * @param {Function} init - The page's initializer; may return a promise.
 * @param {string} label - Page name used in both messages, e.g. 'Lissajous tool'.
 * @returns {void}
 */
export function bootstrapTool(init, label) {
  window.addEventListener('load', () => {
    const fail = (e) => {
      console.error(`${label} failed to initialize:`, e);
      showFatalError(`The ${label} failed to initialize — see the browser console for details.`);
    };
    try {
      const started = init();
      if (started && typeof started.catch === 'function') started.catch(fail);
    } catch (e) {
      fail(e);
    }
  });
}
