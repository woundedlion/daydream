/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Assigns a folder segment within its sibling list.
 * @param {string} name - Folder title.
 * @param {(string|null)[]} siblings - Assigned sibling segments.
 * @returns {string} Stable folder segment.
 */
export function folderSegment(name, siblings) {
  return name ? (siblings.includes(name) ? `${name}#${siblings.length}` : name) : `#${siblings.length}`;
}

/** A deep-link namespace with stable folder segments. */
export class KeyPath {
  /**
   * @param {string|null} [namespace=null] - Root namespace.
   * @param {KeyPath|null} [parent=null] - Enclosing path.
   * @param {string|null} [segment=null] - Folder segment.
   */
  constructor(namespace = null, parent = null, segment = null) {
    this.namespace = namespace;
    this.parent = parent;
    this.segment = segment;
    /** @type {KeyPath[]} */
    this.children = [];
  }

  /**
   * Builds a control key within this path.
   * @param {string} prop - Property name.
   * @returns {string} Dot-joined deep-link key.
   */
  key(prop) {
    const keys = [prop];
    /** @type {KeyPath} */
    let current = this;
    while (current.parent) {
      if (current.segment) keys.unshift(current.segment);
      current = current.parent;
    }
    if (current.namespace) keys.unshift(current.namespace);
    return keys.join('.');
  }

  /**
   * Adds a folder path; display folders contribute no key segment.
   * @param {string} name - Folder title.
   * @param {boolean} [display=false] - Whether the folder is visual only.
   * @returns {KeyPath} Child path.
   */
  folder(name, display = false) {
    const segment = display ? null : folderSegment(name, this.children.map(child => child.segment));
    const child = new KeyPath(null, this, segment);
    this.children.push(child);
    return child;
  }
}
