/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The page's shared notice element, written per owner.
 */

const APPLY_NOTICE_MS = 8000;

/**
 * Build the page's notice sink over the shared apply-notice element.
 *
 * Every write names an owner: raising takes the element over, but a clear lands
 * only when the caller owns the notice on screen.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {Document} deps.doc - Document holding the notice elements.
 * @param {number} [deps.timeoutMs] - Dwell time before a notice self-clears.
 * @param {(fn: () => void, ms: number) => any} [deps.schedule] - Timer source.
 * @param {(handle: any) => void} [deps.cancel] - Timer sink.
 * @param {(message: string) => void} [deps.logWarning] - Sink for the
 *   one-shot report that the notice elements are absent.
 * @returns {{show: (message: string|null, owner: string, gesture?: object) => void,
 *   clear: () => void, owner: () => string|null}} The sink. clear() drops the
 *   notice whoever raised it; owner() reports who holds the element.
 */
export function createApplyNotice({
  doc,
  timeoutMs = APPLY_NOTICE_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  logWarning = (message) => console.warn(message),
}) {
  /** @type {{body: HTMLElement, text: HTMLElement}|null} */
  let elements = null;
  let missLogged = false;
  /** @type {any} */
  let handle = null;
  /** @type {string|null} */
  let held = null;
  /** @type {object|undefined} */
  let heldGesture;

  const resolve = () => {
    if (elements) return elements;
    const found = {
      body: doc.getElementById('apply-notice-body'),
      text: doc.getElementById('apply-notice-text'),
    };
    if (found.body && found.text) {
      elements = { body: found.body, text: found.text };
      return elements;
    }
    if (!missLogged) {
      missLogged = true;
      const missing = Object.entries(found)
        .filter(([, el]) => !el).map(([part]) => `apply-notice-${part}`);
      logWarning(
        `Apply-notice elements absent from the document (${missing.join(', ')}); `
        + 'rejection and fallback messages are not shown until they appear.');
    }
    return null;
  };

  const write = (
    /** @type {string|null} */ notice, /** @type {string|null} */ owner,
    /** @type {object|undefined} */ gesture = undefined) => {
    const el = resolve();
    if (!el) return;
    const { body, text } = el;
    if (handle !== null) cancel(handle);
    handle = null;
    const hidden = notice === null;
    const current = text.textContent;
    let content = notice ?? '';
    if (notice !== null) {
      const repeated = notice + '\u200b';
      const sameGesture = gesture !== undefined && gesture === heldGesture && owner === held;
      if (sameGesture && (current === notice || current === repeated)) content = current;
      else if (current === notice) content = repeated;
    }
    held = hidden ? null : owner;
    heldGesture = hidden ? undefined : gesture;
    if (body.hidden !== hidden) body.hidden = hidden;
    if (current !== content) text.textContent = content;
    if (notice !== null) handle = schedule(() => expire(owner), timeoutMs);
  };

  const expire = (/** @type {string|null} */ owner) => {
    if (elements?.body.contains(doc.activeElement) || elements?.body.matches(':hover')) {
      handle = schedule(() => expire(owner), timeoutMs);
      return;
    }
    write(null, owner);
  };

  return {
    show(message, owner, gesture) {
      const notice = message || null;
      if (notice === null && held !== null && held !== owner) return;
      write(notice, owner, gesture);
    },
    clear: () => write(null, null),
    owner: () => held,
  };
}
