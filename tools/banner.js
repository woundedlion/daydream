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
 * Build the banner shell — a message slot and a dismiss button — and attach it
 * to the page. The banner is fixed across the top of the viewport, so the
 * dismiss button is what keeps a survivable failure from permanently occluding
 * a working page; dismissing removes the element, and the next failure builds a
 * fresh one.
 * @returns {Object} The banner element, attached when the page has a parent.
 */
function buildBanner() {
  const el = document.createElement('div');
  el.id = 'fatal-error-overlay';
  el.setAttribute('role', 'alert');
  Object.assign(el.style, {
    position: 'fixed', top: '0', left: '0', right: '0', zIndex: '9999',
    display: 'flex', alignItems: 'center', gap: '12px',
    padding: '12px 16px', background: '#7f1d1d', color: '#fff',
    font: '14px/1.4 system-ui, sans-serif', textAlign: 'center',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
  });

  const message = document.createElement('span');
  message.className = 'fatal-error-message';
  message.style.flex = '1';
  el.appendChild(message);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'fatal-error-dismiss';
  dismiss.textContent = '✕';
  dismiss.setAttribute('aria-label', 'Dismiss');
  Object.assign(dismiss.style, {
    flex: '0 0 auto', padding: '0 4px', border: '0', background: 'transparent',
    color: 'inherit', font: 'inherit', fontSize: '16px', lineHeight: '1',
    cursor: 'pointer',
  });
  dismiss.addEventListener('click', () => el.remove());
  el.appendChild(dismiss);

  const parent = document.body || document.documentElement;
  if (parent) parent.appendChild(el);
  return el;
}

/**
 * Render a visible error banner across the top of the page. Tool pages that
 * boot a WASM engine call this from their bootstrap catch so a missing or
 * failed-to-load artifact surfaces to the user, instead of leaving a blank
 * canvas with only a console line (mirrors the segmented view's fault overlay).
 * Idempotent — repeated calls update the single banner. Dismissible.
 *
 * @param {string} message - Human-readable failure description.
 * @returns {void}
 */
export function showFatalError(message) {
  const el = document.getElementById('fatal-error-overlay') || buildBanner();
  // textContent, not innerHTML — no injection.
  el.querySelector('.fatal-error-message').textContent = `⚠ ${message}`;
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
