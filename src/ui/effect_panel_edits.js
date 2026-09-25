/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { focusWidget } from './effect_panel_view.js';

const DRAG_END_EVENTS = ['pointerup', 'pointercancel', 'blur'];

/** Edit lifetime and persistence deferred until a slider gesture ends. */
export class EffectPanelEdits {
  activeDragEnds = new Set();
  activeKeyEdits = new Set();
  pending = null;

  /** @param {EventTarget} dragTarget @param {(edited: *) => void} persist */
  constructor(dragTarget, persist) {
    this.dragTarget = dragTarget;
    this.write = persist;
  }

  /** @returns {boolean} Whether a pointer or keyboard edit is held. */
  get active() {
    return this.activeDragEnds.size > 0 || this.activeKeyEdits.size > 0;
  }

  /** @param {*} controller @param {*} edited */
  persist(controller, edited) {
    if (controller.dragging) this.pending = edited;
    else this.write(edited);
  }

  /** Write the pending edit once. */
  flush() {
    const edited = this.pending;
    this.pending = null;
    if (edited !== null) this.write(edited);
  }

  /** Observe pointer identity without capturing lil-gui's mouse gesture. */
  trackDrag(controller) {
    controller.domElement.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0 || controller.dragging) return;
      const { pointerId } = event;
      controller.dragging = true;
      const end = (release) => {
        if (release.type !== 'blur' && release.pointerId !== pointerId) return;
        controller.dragging = false;
        for (const type of DRAG_END_EVENTS) this.dragTarget.removeEventListener(type, end);
        this.activeDragEnds.delete(end);
        this.flush();
      };
      this.activeDragEnds.add(end);
      for (const type of DRAG_END_EVENTS) this.dragTarget.addEventListener(type, end);
    });
  }

  /** @param {*} controller - The control whose keyboard gesture is observed. */
  trackKeyboard(controller) {
    const widget = focusWidget(controller);
    if (!widget) return;
    widget.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        this.activeKeyEdits.add(controller);
      }
    });
    const end = () => this.activeKeyEdits.delete(controller);
    widget.addEventListener('keyup', end);
    widget.addEventListener('blur', end);
  }

  /** Remove drag listeners and flush any held URL write. */
  dispose() {
    for (const end of this.activeDragEnds) {
      for (const type of DRAG_END_EVENTS) this.dragTarget.removeEventListener(type, end);
    }
    this.activeDragEnds.clear();
    this.activeKeyEdits.clear();
    this.flush();
  }
}
