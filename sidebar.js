/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {
  balancedColumnRows,
  sortItems,
  navTargetIndex,
  scrollArrowState,
} from "./sidebar_logic.js";
import { formatKB } from "./tools/kb_format.js";

/**
 * Options per column in the option list: the row count of a column-flow grid
 * (the mobile layout), else 1 for the desktop single column.
 * @param {HTMLElement} listEl - The option list element.
 * @returns {number} Index distance between an option and its horizontal neighbour.
 */
function columnStride(listEl) {
  const style = listEl?.ownerDocument?.defaultView?.getComputedStyle?.(listEl);
  if (!style || !String(style.gridAutoFlow ?? '').includes('column')) return 1;
  const rows = String(style.gridTemplateRows ?? '').trim();
  if (!rows || rows === 'none') return 1;
  return rows.split(/\s+/).length;
}

/**
 * Self-contained sidebar managing the effect list, sort controls, and keyboard navigation.
 * Owns its container element and maintains persistent button references across a
 * SORT: sortBy() reorders the existing button DOM nodes rather than destroying and
 * recreating them. The roster itself is a separate operation — setEffects() rebuilds
 * every button from scratch (innerHTML = ''), since the effect set has changed.
 */
export class EffectSidebar {
  /**
   * Construct the sidebar: build the heading, sort controls, option list, and
   * scroll arrows, then attach them to the container along with the keyboard,
   * scroll, and resize listeners.
   * @param {HTMLElement} container - The sidebar DOM element this instance owns.
   * @param {Function} onSelect - Callback invoked with the selected effect name (string).
   */
  constructor(container, onSelect) {
    this.container = container;
    this.doc = container.ownerDocument;
    // Observer and frame timers come from the container's own window; a
    // detached document has no defaultView, leaving only the ambient one.
    this.win = this.doc?.defaultView ?? globalThis;
    this.onSelect = onSelect;
    /** @type {Map<string, HTMLButtonElement>} */
    this.buttons = new Map();
    /** @type {HTMLElement[]} Buttons in the order they are laid out. */
    this.orderedButtons = [];
    /** @type {Array<{name: string, size: number}>} */
    this.items = [];
    /** @type {number|null} Measured lazily; see onKeyDown. */
    this.gridStride = null;
    /** @type {string|null} */
    this.activeName = null;
    /** @type {{key: 'name'|'size', dir: 'asc'|'desc'}} */
    this.sort = { key: 'name', dir: 'asc' };

    this.heading = this.doc.createElement('h2');
    this.heading.textContent = 'Effects';
    this.heading.className = 'effect-sidebar-heading';

    this.sortRow = this.doc.createElement('div');
    this.sortRow.className = 'sort-controls';

    this.nameBtn = this.createSortBtn('name', 'Name');
    this.sizeBtn = this.createSortBtn('size', 'Size');
    this.sortRow.appendChild(this.nameBtn);
    this.sortRow.appendChild(this.sizeBtn);

    // Roving tabindex: exactly one option carries tabindex=0 (see setRovingTabbable).
    this.listEl = this.doc.createElement('div');
    this.listEl.setAttribute('role', 'listbox');
    this.listEl.setAttribute('aria-label', this.listLabel());
    this.listEl.className = 'effect-list';
    /** @type {HTMLElement|null} Option currently holding tabindex=0. */
    this.tabbableBtn = null;
    /** @type {HTMLElement|null} Option setActive last scrolled into view. */
    this.scrolledBtn = null;
    this.scrollArrowsRaf = 0;
    this.onKeyDownBound = (/** @type {KeyboardEvent} */ e) => this.onKeyDown(e);
    this.onScrollBound = () => this.scheduleScrollArrows();
    this.onResizeBound = () => {
      this.gridStride = null;
      this.scheduleScrollArrows();
    };
    this.listEl.addEventListener('keydown', this.onKeyDownBound);

    // Decorative scroll-arrow glyphs — hidden from assistive tech.
    this.arrowLeft = this.doc.createElement('div');
    this.arrowLeft.className = 'scroll-arrow scroll-arrow-left';
    this.arrowLeft.textContent = '\u2039';
    this.arrowLeft.setAttribute('aria-hidden', 'true');

    this.arrowRight = this.doc.createElement('div');
    this.arrowRight.className = 'scroll-arrow scroll-arrow-right';
    this.arrowRight.textContent = '\u203A';
    this.arrowRight.setAttribute('aria-hidden', 'true');

    this.listEl.addEventListener('scroll', this.onScrollBound, { passive: true });
    /** @type {ResizeObserver|null} */
    this.resizeObs = this.win.ResizeObserver
      ? new this.win.ResizeObserver(this.onResizeBound) : null;
    this.resizeObs?.observe(this.listEl);

    this.container.appendChild(this.heading);
    this.container.appendChild(this.sortRow);
    this.container.appendChild(this.listEl);
    this.container.appendChild(this.arrowLeft);
    this.container.appendChild(this.arrowRight);
  }

  /**
   * Release everything this sidebar owns and detach what it appended: the
   * ResizeObserver, the keydown/scroll listeners, every button's click closure,
   * and the nodes added to the container. Symmetric with the constructor so the
   * container is left clean and reusable. Mirrors Daydream.dispose(); call before
   * discarding the sidebar so no observer keeps firing into a dead DOM subtree.
   */
  dispose() {
    this.win.cancelAnimationFrame(this.scrollArrowsRaf);
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.listEl.removeEventListener('keydown', this.onKeyDownBound);
    this.listEl.removeEventListener('scroll', this.onScrollBound);
    for (const btn of this.buttons.values()) btn.onclick = null;
    this.buttons.clear();
    this.orderedButtons = [];
    this.tabbableBtn = null;
    this.scrolledBtn = null;
    this.scrollArrowsRaf = 0;
    this.nameBtn.onclick = null;
    this.sizeBtn.onclick = null;
    this.listEl.innerHTML = '';
    this.heading.remove();
    this.sortRow.remove();
    this.listEl.remove();
    this.arrowLeft.remove();
    this.arrowRight.remove();
  }

  /**
   * Create the option buttons once for the given effect names and metadata, then
   * apply the current sort order, active highlight, and roving tabindex anchor,
   * restoring keyboard focus when it was inside the list.
   * @param {Array<string>} names - Effect names, one button per name.
   * @param {Record<string, number>} [effectSizes] - Map of effect name to size in bytes; missing or absent entries are treated as 0.
   * @param {Record<string, number>} [presetCounts] - Map of effect name to
   *   authored preset count; the displayed count has a minimum of 1.
   */
  setEffects(names, effectSizes, presetCounts) {
    // Discarding the focused option drops focus to <body>, where the list's
    // keydown handler no longer sees it and Space reaches the global one
    // instead. Name it now; the rebuilt button carrying that name takes it back.
    const focused = /** @type {HTMLElement|null} */ (this.doc.activeElement);
    const refocusName = focused && this.listEl.contains(focused)
      ? (focused.dataset?.effect ?? '') : null;

    this.buttons.clear();
    this.listEl.innerHTML = '';
    this.items = [];
    this.listEl.style.gridTemplateRows =
      `repeat(${balancedColumnRows(names.length)}, auto)`;
    this.gridStride = null;

    names.forEach(name => {
      const size = effectSizes ? (effectSizes[name] || 0) : 0;
      const presetCount = Math.max(1, presetCounts ? (presetCounts[name] || 0) : 0);
      this.items.push({ name, size });

      const btn = this.doc.createElement('button');
      btn.type = 'button';
      btn.className = 'effect-button';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', 'false');
      btn.tabIndex = -1; // roving tabindex
      btn.dataset.effect = name;

      const nameSpan = this.doc.createElement('span');
      nameSpan.className = 'effect-name';
      nameSpan.textContent = `${name} (${presetCount})`;
      btn.appendChild(nameSpan);

      if (size > 0) {
        const sizeSpan = this.doc.createElement('span');
        sizeSpan.className = 'effect-size';
        sizeSpan.textContent = `${formatKB(size)} KB`;
        btn.appendChild(sizeSpan);
      }

      btn.onclick = () => { this.setRovingTabbable(btn); this.onSelect(name); };
      this.buttons.set(name, btn);
    });

    this.applySortOrder();
    this.updateActiveClass();
    this.tabbableBtn = null;
    this.scrolledBtn = null;
    this.setRovingTabbable(
      this.activeButton() || this.orderedButtons[0]
    );
    // Only when focus was already in the list: a rebuild driven from elsewhere
    // must not pull it out of whatever the user is on. An option that left the
    // roster hands focus to the tab stop rather than off the list.
    if (refocusName !== null) {
      (this.buttons.get(refocusName) || this.tabbableBtn)?.focus();
    }
    // Defer until the grid has laid out before measuring scroll extents.
    this.scheduleScrollArrows();
  }

  /**
   * Mark `name` as the active effect, toggling the .active class and
   * aria-selected on only the previous and new buttons, moving the roving
   * tabindex, and scrolling a newly-active option into view.
   * @param {string} name - Name of the effect to mark active.
   */
  setActive(name) {
    const newBtn = this.buttons.get(name);
    // An off-list name has no button: keep the current selection rather than
    // deselecting it and pointing activeName at a missing entry.
    if (!newBtn) return;

    const oldBtn = this.activeButton();
    if (oldBtn) {
      oldBtn.classList.remove('active');
      oldBtn.setAttribute('aria-selected', 'false');
    }

    this.activeName = name;
    newBtn.classList.add('active');
    newBtn.setAttribute('aria-selected', 'true');
    this.setRovingTabbable(newBtn);
    // Re-applying the live effect (Reset) selects the same node again; scrolling
    // it would yank a mobile strip the user has scrolled elsewhere. A rebuilt
    // roster hands over a fresh node, which is still scrolled into view.
    if (newBtn !== this.scrolledBtn) {
      this.scrolledBtn = newBtn;
      newBtn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    }
  }

  /**
   * Set the sort key and direction, reorder the option buttons, and refresh the
   * sort-control UI.
   * @param {'name'|'size'} key - Sort key.
   * @param {'asc'|'desc'} dir - Sort direction.
   */
  sortBy(key, dir) {
    // Moving a node is a remove plus an insert, which drops focus to <body>
    // even though the option itself survives. Hold the focused option and hand
    // it back afterwards; a sort driven from a sort control leaves focus there.
    const focused = /** @type {HTMLElement|null} */ (this.doc.activeElement);
    const refocus = focused && this.listEl.contains(focused) ? focused : null;
    this.sort = { key, dir };
    this.applySortOrder();
    this.updateSortBtnUI();
    refocus?.focus();
  }

  // ---- Internal ----

  /**
   * Glyph for a sort button: the directional arrow when this key is the active
   * sort, else the neutral both-ways glyph. Shared by the initial render and
   * the update path so the button shows the correct arrow from the first paint
   * (the Name-ascending default is active immediately, not only after a click).
   * @param {string} key - Sort key this button controls ('name' or 'size').
   * @returns {string} '▲' / '▼' if active, otherwise '⇅'.
   */
  sortGlyph(key) {
    if (this.sort.key !== key) return '⇅';
    return this.sort.dir === 'asc' ? '▲' : '▼';
  }

  /**
   * Spoken form of the current sort direction.
   * @returns {string} 'ascending' or 'descending'.
   */
  dirWord() {
    return this.sort.dir === 'asc' ? 'ascending' : 'descending';
  }

  /**
   * Accessible name for the option list, naming the order it is currently in.
   * @returns {string} e.g. 'Effects, sorted by name ascending'.
   */
  listLabel() {
    return `Effects, sorted by ${this.sort.key} ${this.dirWord()}`;
  }

  /**
   * Build a sort-control button for `key` labelled `label`. Clicking toggles
   * direction when this key is already active, else activates it (size defaults
   * to descending, others to ascending). The label and the glyph are separate
   * children so the direction arrow can stay presentational; the direction
   * itself reaches assistive tech through the accessible name (syncSortBtn).
   * @param {'name'|'size'} key - Sort key this button controls.
   * @param {string} label - Human-readable button label.
   * @returns {HTMLElement} The created sort-control button.
   */
  createSortBtn(key, label) {
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.dataset.sortLabel = label.toLowerCase();

    const labelSpan = this.doc.createElement('span');
    labelSpan.textContent = label;
    btn.appendChild(labelSpan);

    const glyphSpan = this.doc.createElement('span');
    glyphSpan.className = 'sort-glyph';
    glyphSpan.setAttribute('aria-hidden', 'true');
    btn.appendChild(glyphSpan);

    this.syncSortBtn(btn, key);
    btn.onclick = () => {
      if (this.sort.key === key) {
        this.sortBy(key, this.sort.dir === 'asc' ? 'desc' : 'asc');
      } else {
        this.sortBy(key, key === 'size' ? 'desc' : 'asc');
      }
    };
    return btn;
  }

  /**
   * Apply this.sort to one sort control: active class, pressed state, the
   * presentational direction glyph, and the accessible name. The active button
   * names the direction it sorted in, which the aria-hidden glyph cannot convey.
   * @param {HTMLElement} btn - Sort-control button to sync.
   * @param {'name'|'size'} key - Sort key this button controls.
   */
  syncSortBtn(btn, key) {
    const active = this.sort.key === key;
    btn.className = 'sort-btn' + (active ? ' active' : '');
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    const glyph = btn.querySelector('.sort-glyph');
    if (glyph) glyph.textContent = this.sortGlyph(key);
    const name = `Sort by ${btn.dataset.sortLabel}`;
    btn.setAttribute('aria-label', active ? `${name}, ${this.dirWord()}` : name);
  }

  /** Sync the sort buttons and the list's announced order to this.sort. */
  updateSortBtnUI() {
    this.syncSortBtn(this.nameBtn, 'name');
    this.syncSortBtn(this.sizeBtn, 'size');
    this.listEl.setAttribute('aria-label', this.listLabel());
  }

  /**
   * Reorder the existing button DOM nodes to match the current sort key and
   * direction. Re-appending moves nodes in place rather than recreating them,
   * so their click handlers survive; focus does not, and sortBy hands it back.
   */
  applySortOrder() {
    const sorted = sortItems(this.items, this.sort.key, this.sort.dir);

    this.orderedButtons = [];
    sorted.forEach(({ name }) => {
      const btn = this.buttons.get(name);
      if (!btn) return;
      this.listEl.appendChild(btn);
      this.orderedButtons.push(btn);
    });
  }

  /** Mark the currently active effect's button as selected after a rebuild. */
  updateActiveClass() {
    if (!this.activeName) return;
    const btn = this.activeButton();
    if (btn) {
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
    }
  }

  /**
   * The active effect's option button.
   * @returns {HTMLButtonElement|undefined} The button, or undefined when no
   *   effect is active or the active one is off the roster.
   */
  activeButton() {
    return this.activeName === null ? undefined : this.buttons.get(this.activeName);
  }

  /**
   * Roving tabindex: make `btn` the list's sole tab stop (tabindex=0), demoting
   * the previous anchor to -1. A null/undefined target leaves the list with no
   * tab stop (e.g. an empty list).
   * @param {HTMLElement|null} [btn] - Button to promote to the tab stop, or falsy for none.
   */
  setRovingTabbable(btn) {
    if (this.tabbableBtn && this.tabbableBtn !== btn) {
      this.tabbableBtn.tabIndex = -1;
    }
    if (btn) btn.tabIndex = 0;
    this.tabbableBtn = btn || null;
  }

  /**
   * Keyboard navigation handler: arrow keys move focus between options (wrapping
   * at the ends and updating the roving tabindex), and Enter/Space selects the
   * focused effect. Up/Down step one option; Left/Right step one column, which is
   * also one option wherever the list is a single column.
   * @param {KeyboardEvent} e - The keydown event from the list element.
   */
  onKeyDown(e) {
    const btns = this.orderedButtons;
    if (!btns.length) return;

    const focused = /** @type {HTMLElement|null} */ (this.doc.activeElement);
    const idx = focused ? btns.indexOf(focused) : -1;

    // Measuring the stride forces a style recalc, so it is held until a resize
    // or a new roster invalidates it.
    this.gridStride ??= columnStride(this.listEl);
    const target = navTargetIndex(idx, btns.length, e.key, this.gridStride);
    if (target !== -1) {
      e.preventDefault();
      this.setRovingTabbable(btns[target]);
      btns[target].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (focused && focused.dataset.effect) {
        this.setRovingTabbable(focused);
        this.onSelect(focused.dataset.effect);
      }
    }
  }

  /**
   * Queue a scroll-arrow refresh on the next frame, replacing any pending one.
   * Scroll and resize bursts then force layout once per frame instead of per event.
   */
  scheduleScrollArrows() {
    this.win.cancelAnimationFrame(this.scrollArrowsRaf);
    this.scrollArrowsRaf = this.win.requestAnimationFrame(() => {
      this.scrollArrowsRaf = 0;
      this.updateScrollArrows();
    });
  }

  /** Show/hide scroll arrows based on current scroll position. */
  updateScrollArrows() {
    const el = this.listEl;
    const { left, right } = scrollArrowState(el.scrollLeft, el.scrollWidth, el.clientWidth);
    this.arrowLeft.classList.toggle('visible', left);
    this.arrowRight.classList.toggle('visible', right);
  }
}
