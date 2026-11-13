/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

const MIN_SCROLL_STEP = 160;
const WHEEL_LINE_PX = 16;
const SCROLL_STEP_RATIO = 0.75;

/** @param {import('./chain_row_controls.js').ElementFactory} el */
export function createChainViewport(el) {
  /** @param {HTMLElement} viewport @param {number} direction */
  const scrollPipeline = (viewport, direction) => {
    const distance = Math.max(MIN_SCROLL_STEP,
      Number(viewport.clientHeight ?? 0) * SCROLL_STEP_RATIO);
    viewport.scrollTop = Math.max(0,
      Number(viewport.scrollTop ?? 0) + direction * distance);
  };

  /** @param {HTMLElement} viewport @param {number} direction @returns {HTMLButtonElement} */
  const scrollButton = (viewport, direction) => {
    const button = el('button', 'chain-scroll-button');
    button.type = 'button';
    button.setAttribute('aria-label', direction < 0
      ? 'Scroll shader chain up' : 'Scroll shader chain down');
    const icon = el('span', direction < 0
      ? 'chain-scroll-icon chain-scroll-icon--up' : 'chain-scroll-icon');
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    button.addEventListener('click', () => scrollPipeline(viewport, direction));
    return button;
  };
  /** @param {HTMLElement} viewport @param {() => void} closePalette */
  function wireViewport(viewport, closePalette) {
    viewport.addEventListener('wheel', (event) => {
      if ((/** @type {Element|null} */ (event.target))?.closest?.('.chain-palette')) return;
      const delta = event.deltaY;
      if (delta === 0) return;
      const height = Number(viewport.clientHeight ?? 0);
      const overflow = Number(viewport.scrollHeight ?? 0) - height;
      if (overflow <= 0) return;
      closePalette();
      // deltaMode counts pixels, lines or pages.
      const scale = event.deltaMode === 1 ? WHEEL_LINE_PX
        : event.deltaMode === 2 ? Math.max(MIN_SCROLL_STEP, height) : 1;
      viewport.scrollTop = Math.min(overflow,
        Math.max(0, Number(viewport.scrollTop ?? 0) + delta * scale));
      event.preventDefault();
    }, { passive: false });
    viewport.addEventListener('keydown', (event) => {
      if (event.target !== viewport
        || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      scrollPipeline(viewport, event.key === 'ArrowUp' ? -1 : 1);
    });
  }
  return {scrollPipeline, scrollButton, wireViewport};
}
