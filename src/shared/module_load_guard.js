// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

(() => {
  window.addEventListener('error', (event) => {
    if (!(event.error instanceof SyntaxError)
        && !(event.target instanceof HTMLScriptElement && event.target.type === 'module')) return;
    let overlay = document.getElementById('loading-overlay');
    if (overlay?.dataset.moduleLoadFailure === 'true' || overlay?.classList.contains('error')) return;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'loading-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:grid;place-items:center;'
        + 'padding:2rem;background:#0f172a;text-align:center;font:1rem/1.5 system-ui';
      document.body.appendChild(overlay);
    }
    overlay.dataset.moduleLoadFailure = 'true';
    overlay.hidden = false;
    overlay.style.color = '#fca5a5';
    overlay.setAttribute('role', 'alert');
    overlay.textContent = 'Unable to load the application. Hard-reload the page '
      + '(Ctrl+Shift+R / Cmd+Shift+R) to fetch the current version.';
  }, true);
})();
