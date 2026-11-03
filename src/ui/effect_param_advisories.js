/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Conservative fold estimates on field-strength controls. */

import { focusWidget } from './effect_panel_view.js';

/**
 * Paint the engine's advisory range without writing a parameter.
 * @param {Map<string, import('./effect_param_controls.js').GuiController>} controllers - Displayed controls.
 * @param {Array<{name: string, foldStrength: number}>} advisories - Current engine estimates.
 * @returns {void}
 */
export function syncParamAdvisories(controllers, advisories) {
  const estimates = new Map(advisories.map(({ name, foldStrength }) => [name, foldStrength]));
  for (const [name, controller] of controllers) {
    const range = controller.paramRange;
    if (!range) continue;
    const estimate = estimates.get(name);
    const active = typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0;
    const root = controller.domElement;
    let note = root.querySelector('.param-fold-note');
    const widget = focusWidget(controller) ?? root;
    if (!active) {
      root.classList.remove('param-fold-advisory');
      if (note) {
        const noteId = note.id;
        const described = (widget.getAttribute('aria-describedby') ?? '').split(' ')
          .filter((id) => id && id !== noteId);
        if (described.length) widget.setAttribute('aria-describedby', described.join(' '));
        else widget.removeAttribute('aria-describedby');
        note.remove();
      }
      continue;
    }
    const [min, max] = range;
    const percent = (/** @type {number} */ value) => `${100 * Math.max(0, Math.min(1, (value - min) / (max - min)))}%`;
    root.style.setProperty('--param-fold-low', percent(-estimate));
    root.style.setProperty('--param-fold-high', percent(estimate));
    root.classList.add('param-fold-advisory');
    if (!note) {
      note = root.ownerDocument.createElement('span');
      note.className = 'param-fold-note';
      note.id = `param-fold-${encodeURIComponent(name)}`;
      root.appendChild(note);
      const described = widget.getAttribute('aria-describedby');
      widget.setAttribute('aria-describedby', [described, note.id].filter(Boolean).join(' '));
    }
    const text = `Folds may appear above strength ${estimate.toPrecision(3)} in magnitude. Shaded values remain available.`;
    if (note.textContent !== text) note.textContent = text;
  }
}
