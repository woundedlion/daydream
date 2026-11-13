/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createSliderProxy} from '../../shared/slider.js';
import {HUE_KEY_NAMES} from './palette_wheel.js';

/** Creates accessible hue-key slider handles.
 * @param {HTMLElement} group @param {(index: number) => void} select
 * @param {(event: KeyboardEvent, index: number) => void} nudgeKey
 * @returns {{syncHandles: (degrees: number[]) => void, focus: (index: number) => void,
 * dispose: () => void}} Handle updates, focus, and cleanup. */
export function createHueKeyHandles(group, select, nudgeKey) {
  /** @type {HTMLElement[]} */
  let handles = [];
  /**
   * @param {number[]} degrees - Every drawn key's hue, in whole degrees.
   * @returns {void}
   */
  const syncHandles = (degrees) => {
    handles.forEach((handle, index) => {
      if (index < degrees.length) {
        handle.hidden = false;
        handle.setAttribute('aria-valuenow', String(degrees[index]));
        handle.setAttribute('aria-valuetext', `${degrees[index]} degrees`);
        return;
      }
      if (handle === document.activeElement && degrees.length > 0)
        handles[degrees.length - 1].focus();
      handle.hidden = true;
    });
  };
  handles = HUE_KEY_NAMES.map((name, index) => {
    const handle = createSliderProxy({ label: `Hue key ${name}`, min: 0, max: 360,
      keys: 'ArrowLeft ArrowRight ArrowUp ArrowDown '
        + 'Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown' });
    handle.hidden = true;
    handle.addEventListener('focus', () => {
      select(index);
    });
    handle.addEventListener('keydown', (event) => nudgeKey(event, index));
    group.appendChild(handle);
    return handle;
  });
  return {syncHandles, focus: (/** @type {number} */ index) => handles[index].focus(),
    dispose() {for (const handle of handles) handle.remove(); handles = [];}};
}
