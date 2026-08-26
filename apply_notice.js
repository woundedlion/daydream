/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The page's shared notice element. Several subsystems announce through the one
 * element, so every write names an owner and a clear lands only for the owner
 * holding it.
 */

// Dwell time before a notice self-clears, so a stale rejection cannot outlive
// the action that raised it.
const APPLY_NOTICE_MS = 8000;

/**
 * Build the page's notice sink over the shared apply-notice element.
 *
 * Several subsystems announce through that one element, so every write names an
 * owner: raising takes the element over, but a clear lands only when the caller
 * owns the notice on screen. A parameter write during a slider drag therefore
 * leaves a switch rejection standing instead of erasing the only explanation the
 * user was given.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {Document} deps.doc - Document holding the notice elements.
 * @param {number} [deps.timeoutMs] - Dwell time before a notice self-clears.
 * @param {(fn: () => void, ms: number) => any} [deps.schedule] - Timer source.
 * @param {(handle: any) => void} [deps.cancel] - Timer sink.
 * @param {(message: string) => void} [deps.logWarning] - Sink for the
 *   one-shot report that the notice elements are absent.
 * @returns {{show: (message: string|null, owner: string) => void,
 *   clear: () => void, owner: () => string|null}} The sink. clear() drops the
 *   notice whoever raised it, for the dismiss button and the page teardown;
 *   owner() reports who holds the element.
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

  // Latched only once both elements are present, so markup that arrives after
  // construction still gets its notices; the absence is reported once rather
  // than dropping every rejection message unremarked.
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
    /** @type {string|null} */ notice, /** @type {string|null} */ owner) => {
    const el = resolve();
    if (!el) return;
    const { body, text } = el;
    if (handle !== null) cancel(handle);
    handle = null;
    held = notice === null ? null : owner;
    // Hidden content sits outside the accessibility tree, so the text has to
    // land in an already-exposed body: unhide before writing, hide before
    // clearing. Writing first leaves the unhide as the only mutation assistive
    // tech sees, which is not reliably announced.
    // Written only on a change: an accepted parameter write clears the notice
    // per pointermove across a slider drag, and an unchanged attribute or
    // textContent still costs an invalidation.
    const hidden = notice === null;
    const content = notice ?? '';
    if (body.hidden !== hidden) body.hidden = hidden;
    if (text.textContent !== content) text.textContent = content;
    if (notice !== null) handle = schedule(() => expire(owner), timeoutMs);
  };

  // Hiding the body takes the dismiss button inside it out of the tree and drops
  // keyboard focus to <body>, so the dwell is served again while the user stands
  // on it. Only the self-clear waits; an explicit clear() is the user's own act.
  const expire = (/** @type {string|null} */ owner) => {
    if (elements?.body.contains?.(doc.activeElement)) {
      handle = schedule(() => expire(owner), timeoutMs);
      return;
    }
    write(null, owner);
  };

  return {
    show(message, owner) {
      const notice = message || null;
      if (notice === null && held !== null && held !== owner) return;
      write(notice, owner);
    },
    clear: () => write(null, null),
    owner: () => held,
  };
}
