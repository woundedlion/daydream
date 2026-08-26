/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * A pointer-capture drag on one element, shared by the tool pages that let a
 * pointer scrub a canvas.
 *
 * The capture keeps the drag bound to the element it started on, so mouse and
 * touch share one path, the move and end handlers stay on the element rather
 * than on the document, and an interrupted gesture (an OS focus steal, a touch
 * cancelled by the system) arrives as pointercancel instead of stranding the
 * drag. An element that takes a touch drag needs `touch-action: none`, which is
 * what stops the page scrolling under it.
 */

/**
 * An element's padding box in viewport coordinates — its content box wherever it
 * carries no padding.
 *
 * getBoundingClientRect() reports the border box, but a canvas' bitmap and an
 * absolutely positioned child's percentages both start inside the border, so a
 * pointer normalized against the rect on a bordered element lands one border
 * width off and never reaches either end.
 * @param {HTMLElement} element - Element the pointer is over.
 * @returns {{left: number, top: number, width: number, height: number}} The box.
 */
export function innerRect(element) {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left + element.clientLeft,
    top: rect.top + element.clientTop,
    width: element.clientWidth,
    height: element.clientHeight,
  };
}

/**
 * Wires the drag. The opening pointerdown is the primary button's alone, and
 * only while no drag is running; once accepted, the pointer is captured, the
 * pointerdown's default action is suppressed, and every later event is filtered
 * to that pointer id.
 * @param {object} options - The element and its drag callbacks.
 * @param {HTMLElement} options.element - Element the drag is captured on.
 * @param {(event: PointerEvent) => (boolean|void)} [options.onStart] - Runs on
 *   the opening pointerdown, before the capture. Returning false declines the
 *   drag, leaving the pointer uncaptured and the default action intact.
 * @param {(event: PointerEvent) => void} [options.onMove] - Runs on each move
 *   carrying the drag's own pointer.
 * @param {(event: PointerEvent) => void} [options.onHover] - Runs on each move
 *   that carries any other pointer, dragging or not.
 * @param {(event: ?PointerEvent) => void} [options.onEnd] - Runs on the
 *   release, after the capture is dropped.
 * @param {(event: ?PointerEvent) => void} [options.onCancel] - Runs on
 *   pointercancel and on stop(), after the capture is dropped. Defaults to
 *   onEnd, which is what a page wants when a cancelled gesture and a release
 *   unwind the same way.
 * @returns {{stop: () => void, remove: () => void}} stop() ends a running drag
 *   as a cancel; remove() detaches the listeners without ending it.
 */
export function createPointerDrag({
  element, onStart, onMove, onHover, onEnd, onCancel,
}) {
  let activePointerId = /** @type {?number} */ (null);
  const cancelHandler = onCancel ?? onEnd;

  /**
   * @param {?PointerEvent} event - The event ending the drag, or null for stop().
   * @param {((event: ?PointerEvent) => void)|undefined} handler - What to run once the capture is dropped.
   * @returns {void}
   */
  const finish = (event, handler) => {
    if (activePointerId === null) return;
    if (event && event.pointerId !== activePointerId) return;
    if (element.hasPointerCapture(activePointerId)) {
      element.releasePointerCapture(activePointerId);
    }
    activePointerId = null;
    if (handler) handler(event);
  };

  /**
   * @param {PointerEvent} event - The opening pointerdown.
   * @returns {void}
   */
  const handleDown = (event) => {
    if (!event.isPrimary || event.button !== 0 || activePointerId !== null) return;
    if (onStart && onStart(event) === false) return;
    activePointerId = event.pointerId;
    element.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  /**
   * @param {PointerEvent} event - A move over the element or under its capture.
   * @returns {void}
   */
  const handleMove = (event) => {
    if (event.pointerId !== activePointerId) {
      if (onHover) onHover(event);
      return;
    }
    if (onMove) onMove(event);
  };

  /**
   * @param {PointerEvent} event - The release.
   * @returns {void}
   */
  const handleUp = (event) => finish(event, onEnd);

  /**
   * @param {PointerEvent} event - The cancelled gesture.
   * @returns {void}
   */
  const handleCancel = (event) => finish(event, cancelHandler);

  element.addEventListener('pointerdown', /** @type {EventListener} */ (handleDown));
  element.addEventListener('pointermove', /** @type {EventListener} */ (handleMove));
  element.addEventListener('pointerup', /** @type {EventListener} */ (handleUp));
  element.addEventListener('pointercancel', /** @type {EventListener} */ (handleCancel));

  return {
    stop: () => finish(null, cancelHandler),
    remove: () => {
      element.removeEventListener('pointerdown', /** @type {EventListener} */ (handleDown));
      element.removeEventListener('pointermove', /** @type {EventListener} */ (handleMove));
      element.removeEventListener('pointerup', /** @type {EventListener} */ (handleUp));
      element.removeEventListener('pointercancel', /** @type {EventListener} */ (handleCancel));
    },
  };
}
