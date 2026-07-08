/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { sortItems, navTargetIndex, scrollArrowState } from "./sidebar_logic.js";

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
    this.onSelect = onSelect;
    this.buttons = new Map();      // name -> button element
    this.items = [];               // [{name, size}]
    this.activeName = null;
    this.sort = { key: 'name', dir: 'asc' };

    this.heading = document.createElement('h3');
    this.heading.innerText = 'Effects';
    this.heading.className = 'effect-sidebar-heading';

    this.sortRow = document.createElement('div');
    this.sortRow.className = 'sort-controls';

    this.nameBtn = this.createSortBtn('name', 'Name');
    this.sizeBtn = this.createSortBtn('size', 'Size');
    this.sortRow.appendChild(this.nameBtn);
    this.sortRow.appendChild(this.sizeBtn);

    // Roving tabindex: exactly one option carries tabindex=0 (see setRovingTabbable).
    this.listEl = document.createElement('div');
    this.listEl.setAttribute('role', 'listbox');
    this.listEl.setAttribute('aria-label', 'Effects');
    this.listEl.className = 'effect-list';
    this.tabbableBtn = null; // option currently holding tabindex=0
    this.onKeyDownBound = (e) => this.onKeyDown(e);
    this.onScrollBound = () => this.updateScrollArrows();
    this.listEl.addEventListener('keydown', this.onKeyDownBound);

    // Decorative scroll-arrow glyphs — hidden from assistive tech.
    this.arrowLeft = document.createElement('div');
    this.arrowLeft.className = 'scroll-arrow scroll-arrow-left';
    this.arrowLeft.textContent = '\u2039';
    this.arrowLeft.setAttribute('aria-hidden', 'true');

    this.arrowRight = document.createElement('div');
    this.arrowRight.className = 'scroll-arrow scroll-arrow-right';
    this.arrowRight.textContent = '\u203A';
    this.arrowRight.setAttribute('aria-hidden', 'true');

    this.listEl.addEventListener('scroll', this.onScrollBound, { passive: true });
    this.scrollArrowsRaf = 0;
    this.resizeObs = new ResizeObserver(this.onScrollBound);
    this.resizeObs.observe(this.listEl);

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
    cancelAnimationFrame(this.scrollArrowsRaf);
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.listEl.removeEventListener('keydown', this.onKeyDownBound);
    this.listEl.removeEventListener('scroll', this.onScrollBound);
    for (const btn of this.buttons.values()) btn.onclick = null;
    this.buttons.clear();
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
   * Create the option buttons once for the given effect names and sizes, then
   * apply the current sort order, active highlight, and roving tabindex anchor.
   * @param {Array<string>} names - Effect names, one button per name.
   * @param {Object} [effectSizes] - Map of effect name to size in bytes; missing or absent entries are treated as 0.
   */
  setEffects(names, effectSizes) {
    this.buttons.clear();
    this.listEl.innerHTML = '';
    this.items = [];

    names.forEach(name => {
      const size = effectSizes ? (effectSizes[name] || 0) : 0;
      this.items.push({ name, size });

      const btn = document.createElement('button');
      btn.className = 'effect-button';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', 'false');
      btn.tabIndex = -1; // roving tabindex
      btn.dataset.effect = name;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'effect-name';
      nameSpan.textContent = name;
      btn.appendChild(nameSpan);

      if (size > 0) {
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'effect-size';
        sizeSpan.textContent = `${(size / 1024).toFixed(1)} KB`;
        btn.appendChild(sizeSpan);
      }

      btn.onclick = () => { this.setRovingTabbable(btn); this.onSelect(name); };
      this.buttons.set(name, btn);
    });

    this.applySortOrder();
    this.updateActiveClass();
    this.tabbableBtn = null;
    this.setRovingTabbable(
      this.buttons.get(this.activeName) || this.listEl.querySelector('.effect-button')
    );
    // Defer until the grid has laid out before measuring scroll extents.
    cancelAnimationFrame(this.scrollArrowsRaf);
    this.scrollArrowsRaf = requestAnimationFrame(() => this.updateScrollArrows());
  }

  /**
   * Mark `name` as the active effect, toggling the .active class and
   * aria-selected on only the previous and new buttons, moving the roving
   * tabindex, and scrolling the new option into view.
   * @param {string} name - Name of the effect to mark active.
   */
  setActive(name) {
    const oldBtn = this.buttons.get(this.activeName);
    if (oldBtn) {
      oldBtn.classList.remove('active');
      oldBtn.setAttribute('aria-selected', 'false');
    }

    this.activeName = name;

    const newBtn = this.buttons.get(name);
    if (newBtn) {
      newBtn.classList.add('active');
      newBtn.setAttribute('aria-selected', 'true');
      this.setRovingTabbable(newBtn);
      newBtn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    }
  }

  /**
   * Set the sort key and direction, reorder the option buttons, and refresh the
   * sort-control UI.
   * @param {string} key - Sort key, either 'name' or 'size'.
   * @param {string} dir - Sort direction, either 'asc' or 'desc'.
   */
  sortBy(key, dir) {
    this.sort = { key, dir };
    this.applySortOrder();
    this.updateSortBtnUI();
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
   * Build a sort-control button for `key` labelled `label`. Clicking toggles
   * direction when this key is already active, else activates it (size defaults
   * to descending, others to ascending).
   * @param {string} key - Sort key this button controls ('name' or 'size').
   * @param {string} label - Human-readable button label.
   * @returns {HTMLElement} The created sort-control button.
   */
  createSortBtn(key, label) {
    const btn = document.createElement('button');
    btn.className = 'sort-btn' + (this.sort.key === key ? ' active' : '');
    btn.innerText = label + ' ' + this.sortGlyph(key);
    btn.onclick = () => {
      if (this.sort.key === key) {
        this.sortBy(key, this.sort.dir === 'asc' ? 'desc' : 'asc');
      } else {
        this.sortBy(key, key === 'size' ? 'desc' : 'asc');
      }
    };
    return btn;
  }

  /** Sync the sort buttons' active state and direction arrow to this.sort. */
  updateSortBtnUI() {
    this.nameBtn.className = 'sort-btn' + (this.sort.key === 'name' ? ' active' : '');
    this.nameBtn.innerText = 'Name ' + this.sortGlyph('name');
    this.sizeBtn.className = 'sort-btn' + (this.sort.key === 'size' ? ' active' : '');
    this.sizeBtn.innerText = 'Size ' + this.sortGlyph('size');
  }

  /**
   * Reorder the existing button DOM nodes to match the current sort key and
   * direction. Re-appending moves nodes in place rather than recreating them,
   * preserving focus and event handlers.
   */
  applySortOrder() {
    const sorted = sortItems(this.items, this.sort.key, this.sort.dir);

    sorted.forEach(({ name }) => {
      const btn = this.buttons.get(name);
      if (btn) this.listEl.appendChild(btn);
    });
  }

  /** Mark the currently active effect's button as selected after a rebuild. */
  updateActiveClass() {
    if (!this.activeName) return;
    const btn = this.buttons.get(this.activeName);
    if (btn) {
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
    }
  }

  /**
   * Roving tabindex: make `btn` the list's sole tab stop (tabindex=0), demoting
   * the previous anchor to -1. A null/undefined target leaves the list with no
   * tab stop (e.g. an empty list).
   * @param {HTMLElement} [btn] - Button to promote to the tab stop, or falsy for none.
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
   * focused effect.
   * @param {KeyboardEvent} e - The keydown event from the list element.
   */
  onKeyDown(e) {
    const btns = Array.from(this.listEl.querySelectorAll('.effect-button'));
    if (!btns.length) return;

    const focused = document.activeElement;
    let idx = btns.indexOf(focused);
    // Focus on the container (not a button): navigate relative to the roving tab stop.
    if (idx === -1) idx = btns.indexOf(this.tabbableBtn);

    const target = navTargetIndex(idx, btns.length, e.key);
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

  /** Show/hide scroll arrows based on current scroll position. */
  updateScrollArrows() {
    const el = this.listEl;
    const { left, right } = scrollArrowState(el.scrollLeft, el.scrollWidth, el.clientWidth);
    this.arrowLeft.classList.toggle('visible', left);
    this.arrowRight.classList.toggle('visible', right);
  }
}
