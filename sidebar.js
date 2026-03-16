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

    // Button list container (for keyboard nav scoping)
    this.listEl = document.createElement('div');
    this.listEl.setAttribute('role', 'listbox');
    this.listEl.setAttribute('tabindex', '0');
    this.listEl.className = 'effect-list';
    this.listEl.addEventListener('keydown', (e) => this._onKeyDown(e));

    this.container.appendChild(this.heading);
    this.container.appendChild(this.sortRow);
    this.container.appendChild(this.listEl);
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
  }

  /** Toggle .active class on old and new button only. */
  setActive(name) {
    const oldBtn = this.buttons.get(this.activeName);
    if (oldBtn) oldBtn.classList.remove('active');

    this.activeName = name;

    const newBtn = this.buttons.get(name);
    if (newBtn) {
      newBtn.classList.add('active');
      newBtn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    if (btn) btn.classList.add('active');
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
      btns[next].focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = idx > 0 ? idx - 1 : btns.length - 1;
      btns[prev].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (focused && focused.dataset.effect) {
        this.onSelect(focused.dataset.effect);
      }
    }
  }
}
