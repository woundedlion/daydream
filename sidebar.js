/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Self-contained sidebar managing the effect list, sort controls, and keyboard navigation.
 * Owns its container element and maintains persistent button references — on sort,
 * existing DOM nodes are reordered rather than destroyed and recreated.
 */
export class EffectSidebar {
  /**
   * @param {HTMLElement} container - The sidebar DOM element
   * @param {(name: string) => void} onSelect - Callback when an effect is selected
   */
  constructor(container, onSelect) {
    this.container = container;
    this.onSelect = onSelect;
    this.buttons = new Map();      // name -> button element
    this.items = [];               // [{name, size}]
    this.activeName = null;
    this.sort = { key: 'name', dir: 'asc' };

    // Static heading
    this.heading = document.createElement('h3');
    this.heading.innerText = 'Effects';
    this.heading.className = 'effect-sidebar-heading';

    // Sort controls
    this.sortRow = document.createElement('div');
    this.sortRow.className = 'sort-controls';

    this.nameBtn = this._createSortBtn('name', 'Name');
    this.sizeBtn = this._createSortBtn('size', 'Size');
    this.sortRow.appendChild(this.nameBtn);
    this.sortRow.appendChild(this.sizeBtn);

    // Button list container (for keyboard nav scoping). Roving tabindex: the
    // listbox is not itself a tab stop \u2014 exactly one option carries tabindex=0
    // (see _setRovingTabbable), so Tab lands on the active option once rather
    // than on the container and then every button.
    this.listEl = document.createElement('div');
    this.listEl.setAttribute('role', 'listbox');
    this.listEl.setAttribute('aria-label', 'Effects');
    this.listEl.className = 'effect-list';
    // The option that currently holds tabindex=0 (roving tabindex anchor).
    this._tabbableBtn = null;
    // Keep bound handlers so dispose() can detach them.
    this._onKeyDownBound = (e) => this._onKeyDown(e);
    this._onScrollBound = () => this._updateScrollArrows();
    this.listEl.addEventListener('keydown', this._onKeyDownBound);

    // Scroll arrow indicators (mobile horizontal scroll). Decorative glyphs \u2014
    // hidden from assistive tech so screen readers don't announce them.
    this.arrowLeft = document.createElement('div');
    this.arrowLeft.className = 'scroll-arrow scroll-arrow-left';
    this.arrowLeft.textContent = '\u2039';
    this.arrowLeft.setAttribute('aria-hidden', 'true');

    this.arrowRight = document.createElement('div');
    this.arrowRight.className = 'scroll-arrow scroll-arrow-right';
    this.arrowRight.textContent = '\u203A';
    this.arrowRight.setAttribute('aria-hidden', 'true');

    this.listEl.addEventListener('scroll', this._onScrollBound, { passive: true });
    this._resizeObs = new ResizeObserver(this._onScrollBound);
    this._resizeObs.observe(this.listEl);

    this.container.appendChild(this.heading);
    this.container.appendChild(this.sortRow);
    this.container.appendChild(this.listEl);
    this.container.appendChild(this.arrowLeft);
    this.container.appendChild(this.arrowRight);
  }

  /**
   * Release the resources this sidebar owns: the ResizeObserver and the
   * keydown/scroll listeners on the list element. Mirrors Daydream.dispose();
   * call before discarding the sidebar so no observer keeps firing into a dead
   * DOM subtree.
   */
  dispose() {
    this._resizeObs?.disconnect();
    this._resizeObs = null;
    this.listEl.removeEventListener('keydown', this._onKeyDownBound);
    this.listEl.removeEventListener('scroll', this._onScrollBound);
  }

  /** Create buttons once for the given effect names and sizes. */
  setEffects(names, effectSizes) {
    // Clear old buttons
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
      btn.tabIndex = -1; // roving tabindex; the active/first option is promoted to 0
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

      btn.onclick = () => this.onSelect(name);
      this.buttons.set(name, btn);
    });

    this._applySortOrder();
    this._updateActiveClass();
    // Anchor the roving tabindex on the active option, or the first one if none
    // is active yet, so the rebuilt list has exactly one tab stop.
    this._tabbableBtn = null;
    this._setRovingTabbable(
      this.buttons.get(this.activeName) || this.listEl.querySelector('.effect-button')
    );
    // Defer so the grid has laid out before we measure scroll extents
    requestAnimationFrame(() => this._updateScrollArrows());
  }

  /** Toggle .active class and aria-selected on old and new button only. */
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
      this._setRovingTabbable(newBtn);
      newBtn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }

  /** Sort by key ('name' | 'size') and direction ('asc' | 'desc'). */
  sortBy(key, dir) {
    this.sort = { key, dir };
    this._applySortOrder();
    this._updateSortBtnUI();
  }

  // ---- Internal ----

  _createSortBtn(key, label) {
    const btn = document.createElement('button');
    btn.className = 'sort-btn' + (this.sort.key === key ? ' active' : '');
    btn.innerText = label + ' ⇅';
    btn.onclick = () => {
      if (this.sort.key === key) {
        this.sortBy(key, this.sort.dir === 'asc' ? 'desc' : 'asc');
      } else {
        this.sortBy(key, key === 'size' ? 'desc' : 'asc');
      }
    };
    return btn;
  }

  _updateSortBtnUI() {
    const arrow = (dir) => dir === 'asc' ? '▲' : '▼';
    this.nameBtn.className = 'sort-btn' + (this.sort.key === 'name' ? ' active' : '');
    this.nameBtn.innerText = 'Name ' + (this.sort.key === 'name' ? arrow(this.sort.dir) : '⇅');
    this.sizeBtn.className = 'sort-btn' + (this.sort.key === 'size' ? ' active' : '');
    this.sizeBtn.innerText = 'Size ' + (this.sort.key === 'size' ? arrow(this.sort.dir) : '⇅');
  }

  _applySortOrder() {
    const sorted = [...this.items].sort((a, b) => {
      const mul = this.sort.dir === 'asc' ? 1 : -1;
      if (this.sort.key === 'size') return (a.size - b.size) * mul;
      return a.name.localeCompare(b.name) * mul;
    });

    // Reorder existing DOM nodes (no destroy/recreate)
    sorted.forEach(({ name }) => {
      const btn = this.buttons.get(name);
      if (btn) this.listEl.appendChild(btn);
    });
  }

  _updateActiveClass() {
    if (!this.activeName) return;
    const btn = this.buttons.get(this.activeName);
    if (btn) {
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
    }
  }

  /** Roving tabindex: make `btn` the list's sole tab stop (tabindex=0), demoting
   * the previous anchor to -1. No-op target leaves the list with no tab stop
   * (e.g. an empty list). */
  _setRovingTabbable(btn) {
    if (this._tabbableBtn && this._tabbableBtn !== btn) {
      this._tabbableBtn.tabIndex = -1;
    }
    if (btn) btn.tabIndex = 0;
    this._tabbableBtn = btn || null;
  }

  /** Keyboard navigation: arrow keys move focus, Enter/Space selects. */
  _onKeyDown(e) {
    const btns = Array.from(this.listEl.querySelectorAll('.effect-button'));
    if (!btns.length) return;

    const focused = document.activeElement;
    const idx = btns.indexOf(focused);

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = idx < btns.length - 1 ? idx + 1 : 0;
      this._setRovingTabbable(btns[next]);
      btns[next].focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = idx > 0 ? idx - 1 : btns.length - 1;
      this._setRovingTabbable(btns[prev]);
      btns[prev].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (focused && focused.dataset.effect) {
        this.onSelect(focused.dataset.effect);
      }
    }
  }

  /** Show/hide scroll arrows based on current scroll position. */
  _updateScrollArrows() {
    const el = this.listEl;
    const maxScroll = el.scrollWidth - el.clientWidth;
    if (maxScroll <= 0) {
      this.arrowLeft.classList.remove('visible');
      this.arrowRight.classList.remove('visible');
      return;
    }
    this.arrowLeft.classList.toggle('visible', el.scrollLeft > 4);
    this.arrowRight.classList.toggle('visible', el.scrollLeft < maxScroll - 4);
  }
}
