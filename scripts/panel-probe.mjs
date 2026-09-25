/*
 * Drives the effect panel's scroll and focus restoration, and the sidebar's two
 * layout-derived computations, in headless Chrome over the same manifest server
 * scripts/browser-smoke.mjs uses.
 *
 *   node scripts/panel-probe.mjs
 *
 * The unit suite runs over tests/helpers/fake_dom.js, where scrollTop is a plain
 * expando: any number written to it reads back. A browser clamps it to
 * scrollHeight - clientHeight, so a panel that has not laid out takes 0 whatever
 * was written. Only a real layout decides whether the offset survives a rebuild.
 * The sidebar reads gridTemplateRows for its arrow-key column stride and
 * scrollLeft/scrollWidth/clientWidth for its scroll arrows — quantities the fake
 * DOM answers from hand-written style objects, so only a real grid decides
 * whether either one is measuring the layout that shipped.
 * The same suite has no accessibility tree, so the preset dropdown's computed
 * name is read out of the browser's.
 * A slider drag is lil-gui's own mouse gesture, which the fake DOM does not
 * raise and cannot interleave a second pointer with, so only a browser says
 * whether the panel's drag latch tracks the pointer that opened it.
 */
import { checks, isMain, runProbe } from './probe_harness.mjs';

const PAGE = 'index.html';
// Short enough that the panel's max-height cap bites and its own .lil-children
// becomes the scroller, which is what effect_gui.js writes the offset onto.
const VIEWPORT = { width: 1280, height: 240 };
const MOBILE_VIEWPORT = { width: 800, height: 720, hasTouch: true };
// Narrow enough that the column-flow effect list overruns its track and the
// scroll arrows have something to report; 800px lays the whole roster out.
const SIDEBAR_VIEWPORT = { width: 480, height: 720 };
// The roster's widest parameter schema, so the panel overflows the cap.
const EFFECT = 'ShapeShifter';
const TIMEOUT_MS = 90_000;
// Longer than state.js's URL flush debounce, so a deferred write has landed.
const URL_SETTLE_MS = 2200;
// Bound on the wait for the query string to stop changing.
const URL_SETTLE_POLLS = 20;
const SCROLLER = '.effect-gui .lil-children';
const PANEL_SLIDER = '.effect-gui .lil-controller.lil-number .lil-slider';
const PANEL_TITLE = '.effect-gui > .lil-title';
const RESET = '.effect-action-reset button';
const LIST = '.effect-list';
const OPTION = '.effect-button';
const SORT_STATUS = '.sort-controls [role="status"]';
const ARROW_LEFT = '.scroll-arrow-left';
const ARROW_RIGHT = '.scroll-arrow-right';

// What the :focus-visible rule in styles/index.css paints outside an option:
// a 2px ring at a 2px offset.
const RING_CLEARANCE = 4;

// The roster's stage-folder schema: its folders truncate control labels to the
// role each one plays inside its stage.
const STAGE_EFFECT = 'LatticeMelt';
const STAGE_WIDGET = '.effect-gui .lil-gui .lil-controller :is(input, select)';
// The roster's engine-written telemetry: a value the effect clobbers every
// frame, which the panel shows but the engine refuses to be written.
const TELEMETRY_EFFECT = 'MindSplatter';
const TELEMETRY_WIDGET = '.effect-gui .lil-controller input[aria-readonly="true"]';
const PRESET_SELECT = '.preset-nav-selector select';
const PRESET_NAME = 'Preset';

/** @param {import('puppeteer-core').Page} tab */
async function settleUrl(tab) {
  let last = null;
  for (let poll = 0; poll < URL_SETTLE_POLLS; poll += 1) {
    const search = await tab.evaluate(() => location.search);
    if (search === last) return;
    last = search;
    await new Promise((resolve) => setTimeout(resolve, URL_SETTLE_MS));
  }
  throw new Error('The URL did not settle before the probe baseline');
}

/** @param {import('puppeteer-core').Page} tab */
const scrollerMetrics = (tab) => tab.$eval(SCROLLER, (node) => ({
  scrollTop: node.scrollTop,
  scrollHeight: node.scrollHeight,
  clientHeight: node.clientHeight,
}));

/** @param {import('puppeteer-core').Page} tab */
export async function probePanel(tab) {
  const { failures, check } = checks();

  await (await tab.waitForSelector(`[data-effect="${EFFECT}"]`)).click();
  await tab.waitForFunction(
    (selector) => (document.querySelector(selector)?.scrollHeight ?? 0) > 0,
    { timeout: TIMEOUT_MS }, SCROLLER);

  const laid = await scrollerMetrics(tab);
  const overflow = laid.scrollHeight - laid.clientHeight;
  check(overflow > 0,
    `the panel overflows its height cap by ${overflow}px, so it can scroll at all`);
  if (overflow <= 0) return failures;

  // The clamp the fake DOM has no way to model: a browser refuses an offset past
  // the scrollable extent, so a restore onto an unlaid-out panel yields 0.
  const clamped = await tab.$eval(SCROLLER, (node) => {
    node.scrollTop = 1e6;
    return node.scrollTop;
  });
  check(clamped === overflow,
    `scrollTop clamps to the scrollable extent (${clamped} of ${overflow})`);

  const offset = Math.round(overflow / 2);
  await tab.$eval(SCROLLER, (node, to) => { node.scrollTop = to; }, offset);
  const held = (await scrollerMetrics(tab)).scrollTop;
  check(held === offset, `the panel holds a mid-list offset (${held})`);

  const focusedControl = await tab.$eval(SCROLLER, (scroller) => {
    const bounds = scroller.getBoundingClientRect();
    const controllers = [...scroller.querySelectorAll('.lil-controller.lil-number')]
      .sort((a, b) => {
        const middle = (bounds.top + bounds.bottom) / 2;
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return Math.abs((aRect.top + aRect.bottom) / 2 - middle)
          - Math.abs((bRect.top + bRect.bottom) / 2 - middle);
      });
    const controller = controllers[0];
    const widget = controller?.querySelector('input');
    const name = controller?.querySelector('.lil-name')?.textContent?.trim();
    if (!widget || !name) throw new Error('the panel has no named number input');
    widget.focus();
    return { name, widget: widget.localName, focused: document.activeElement === widget };
  });
  check(focusedControl.focused && focusedControl.widget === 'input',
    `the visible ${focusedControl.name} number input holds focus`);

  const before = await tab.$eval(SCROLLER, (node) => {
    window.probedScroller = node;
    return document.querySelectorAll('.effect-gui').length;
  });
  check(before === 1, `exactly one effect panel is mounted (${before})`);

  await tab.$eval(RESET, (node) => node.click());
  await tab.waitForFunction(
    () => document.querySelector('.effect-gui .lil-children') !== window.probedScroller,
    { timeout: TIMEOUT_MS });

  const rebuilt = await scrollerMetrics(tab);
  check(rebuilt.scrollHeight - rebuilt.clientHeight === overflow,
    'the rebuilt panel carries the same scrollable extent');
  check(rebuilt.scrollTop === offset,
    `the rebuilt panel keeps the offset it was scrolled to (${rebuilt.scrollTop} of ${offset})`);
  const restoredControl = await tab.evaluate(() => {
    const widget = document.activeElement;
    const controller = widget?.closest('.lil-controller.lil-number');
    return {
      name: controller?.querySelector('.lil-name')?.textContent?.trim() ?? '',
      widget: widget?.localName ?? '',
    };
  });
  check(restoredControl.name === focusedControl.name
      && restoredControl.widget === focusedControl.widget,
    `the rebuilt panel restores focus to the ${focusedControl.name} number input `
      + `(${restoredControl.name || 'none'} ${restoredControl.widget || 'widget'})`);

  return failures;
}

/**
 * Drags a panel slider with the mouse, releasing a second pointer over the page
 * mid-gesture. lil-gui runs the drag on mouse events, and effect_gui.js latches
 * the controller off a pointerdown, so the two channels only meet in a browser:
 * the deferred deep-link write must survive the stray release and land on the
 * drag's own.
 * @param {import('puppeteer-core').Page} tab
 */
export async function probeSliderDrag(tab) {
  const { failures, check } = checks();

  const name = await tab.$eval(PANEL_SLIDER, (slider) => {
    slider.scrollIntoView({ block: 'center' });
    return slider.closest('.lil-controller').querySelector('.lil-name').textContent.trim();
  });
  const box = await (await tab.$(PANEL_SLIDER)).boundingBox();
  if (box === null) {
    check(false, `${name} has no layout box to drag`);
    return failures;
  }
  const valueOf = () => tab.$eval(PANEL_SLIDER, (slider) =>
    Number(slider.closest('.lil-controller').querySelector('input').value));
  // The live fx.<name> key is written per move; only __accepted.<name> carries
  // the persistence the drag defers to its release.
  const accepted = () => tab.evaluate((param) => new URLSearchParams(location.search)
    .get(`fx.__accepted.${param}`), name);


  await settleUrl(tab);
  const before = await valueOf();
  const acceptedBefore = await accepted();
  const y = box.y + box.height / 2;
  await tab.mouse.move(box.x + box.width * 0.2, y);
  await tab.mouse.down();
  await tab.mouse.move(box.x + box.width * 0.8, y, { steps: 12 });

  const dragged = await valueOf();
  check(dragged !== before, `the mouse drag moves ${name} (${before} -> ${dragged})`);
  check(await tab.$eval(PANEL_SLIDER, (slider) => slider.classList.contains('lil-active')),
    'lil-gui still owns the gesture it started on mousedown');
  check(await accepted() === acceptedBefore, 'the drag defers the accepted-value write');

  await tab.evaluate(() => window.dispatchEvent(new PointerEvent(
    'pointerup', { pointerId: 99, bubbles: true, isPrimary: false })));
  await new Promise((resolve) => setTimeout(resolve, URL_SETTLE_MS));
  check(await accepted() === acceptedBefore,
    'a second pointer releasing mid-gesture flushes nothing');

  await tab.mouse.move(box.x + box.width * 0.9, y, { steps: 4 });
  const tracked = await valueOf();
  check(tracked !== dragged, `the drag still tracks the mouse (${tracked})`);

  await tab.mouse.up();
  await tab.waitForFunction((param, want) => {
    const at = new URLSearchParams(location.search).get(`fx.__accepted.${param}`);
    return at !== null && Number(at) === want;
  }, { timeout: TIMEOUT_MS }, name, tracked).catch(() => {});
  const written = await accepted();
  check(Number(written) === tracked,
    `the release deep-links the dragged value (${written})`);
  check(await valueOf() === tracked,
    'the value stream leaves the released value alone');
  await tab.mouse.move(0, 0);

  return failures;
}

/** @param {import('puppeteer-core').Page} tab */
export async function probeTouchSlider(tab) {
  const { failures, check } = checks();
  const viewport = tab.viewport();
  await tab.setViewport({ ...VIEWPORT, hasTouch: true });
  await tab.evaluate(() => document.activeElement?.blur());
  const name = await tab.$eval(PANEL_SLIDER, slider => {
    slider.scrollIntoView({ block: 'center', behavior: 'instant' });
    return slider.closest('.lil-controller').querySelector('.lil-name').textContent.trim();
  });
  await settleUrl(tab);
  const read = () => tab.$eval(PANEL_SLIDER, (slider, param) => ({
    value: Number(slider.closest('.lil-controller').querySelector('input[type=number]').value),
    accepted: new URLSearchParams(location.search).get(`fx.__accepted.${param}`),
  }), name);
  const before = await read();
  await tab.evaluate(() => {
    window.probeTouchCancels = 0;
    window.addEventListener('pointercancel', () => { window.probeTouchCancels += 1; }, { once: true });
  });
  const cdp = await tab.createCDPSession();
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
  });
  try {
    let box = await (await tab.$(PANEL_SLIDER)).boundingBox();
    if (!box) throw new Error('Touch slider has no layout box');
    const x = box.x + box.width * 0.5;
    const y = box.y + box.height * 0.5;
    check(await tab.evaluate((px, py) => Boolean(document.elementFromPoint(px, py)?.closest('.lil-slider')), x, y),
      `the touch starts on the slider (${x}, ${y})`);
    await touch('touchStart', x, y);
    for (let step = 1; step <= 6; step += 1) await touch('touchMove', x, y - step * 8);
    await touch('touchEnd');
    check(await tab.evaluate(() => window.probeTouchCancels) === 1,
      'a vertical touch scroll cancels the slider pointer');
    check((await read()).value === before.value, 'scrolling over the slider leaves its value unchanged');

    await tab.$eval(PANEL_SLIDER, slider => slider.scrollIntoView({ block: 'center', behavior: 'instant' }));
    box = await (await tab.$(PANEL_SLIDER)).boundingBox();
    if (!box) throw new Error('Touch slider has no layout box after scrolling');
    await touch('touchStart', box.x + box.width * 0.8, box.y + box.height * 0.5);
    for (let step = 1; step <= 6; step += 1)
      await touch('touchMove', box.x + box.width * (0.8 - step * 0.1), box.y + box.height * 0.5);
    const held = await read();
    check(held.value !== before.value, 'the next horizontal touch gesture moves the slider');
    check(held.accepted === before.accepted, 'the touch drag defers the accepted-value write');
    await touch('touchEnd');
    await tab.waitForFunction((param, value) => Number(new URLSearchParams(location.search)
      .get(`fx.__accepted.${param}`)) === value, { timeout: TIMEOUT_MS }, name, held.value);
    check(Number((await read()).accepted) === held.value, 'touch release persists after the cancelled scroll');
  } finally {
    await cdp.detach();
    await tab.setViewport(viewport);
  }
  return failures;
}

/*
 * The preset dropdown carries no aria-label of its own: lil-gui points the
 * select at its own .lil-name element, which the action row hides. A fake DOM
 * has no accessibility tree, so only the browser's computed name says whether
 * a hidden label element still names the control.
 * @param {import('puppeteer-core').Page} tab
 */
export async function probePresetName(tab) {
  const { failures, check } = checks();

  const cdp = await tab.createCDPSession();
  try {
    await cdp.send('Accessibility.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await cdp.send('DOM.querySelector',
      { nodeId: doc.root.nodeId, selector: PRESET_SELECT });
    check(nodeId !== 0, 'the preset dropdown is mounted');
    if (nodeId === 0) return failures;

    const tree = await cdp.send('Accessibility.getPartialAXTree',
      { nodeId, fetchRelatives: false });
    const ax = tree.nodes.find((node) => node.role?.value === 'combobox');
    const name = ax?.name?.value ?? '';
    check(name === PRESET_NAME,
      `the preset dropdown computes the accessible name ${PRESET_NAME} `
        + `(${name || 'none'})`);
    return failures;
  } finally {
    await cdp.detach();
  }
}

/*
 * A stage folder truncates each control's visible label to its role inside the
 * folder, so "Wander", "Speed" and "Mode" all repeat across folders. lil-gui
 * points every widget at its own .lil-name element, so only the browser's
 * computed name says whether the repeated labels reach the accessibility tree.
 * @param {import('puppeteer-core').Page} tab
 */
export async function probeStageNames(tab) {
  const { failures, check } = checks();

  await (await tab.waitForSelector(`[data-effect="${STAGE_EFFECT}"]`)).click();
  await tab.waitForFunction(
    (selector) => document.querySelectorAll(selector).length > 1,
    { timeout: TIMEOUT_MS }, STAGE_WIDGET);

  const visible = await tab.$$eval(STAGE_WIDGET, (widgets) => widgets.map(
    (widget) => widget.closest('.lil-controller')
      ?.querySelector('.lil-name')?.textContent?.trim() ?? ''));
  const repeated = visible.filter(
    (label, index) => visible.indexOf(label) !== index);
  check(repeated.length > 0,
    `stage folders repeat ${repeated.length} visible label(s) (${
      [...new Set(repeated)].join(', ')})`);

  const cdp = await tab.createCDPSession();
  try {
    await cdp.send('Accessibility.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll',
      { nodeId: doc.root.nodeId, selector: STAGE_WIDGET });
    const names = [];
    for (const nodeId of nodeIds) {
      const tree = await cdp.send('Accessibility.getPartialAXTree',
        { nodeId, fetchRelatives: false });
      names.push(tree.nodes.find((node) => node.name)?.name?.value ?? '');
    }

    check(names.length === visible.length && !names.includes(''),
      `every one of the ${names.length} stage controls computes a name`);
    const distinct = new Set(names).size;
    check(distinct === names.length,
      `the ${names.length} stage controls compute ${distinct} distinct names`);

    return failures;
  } finally {
    await cdp.detach();
  }
}

/*
 * Engine-written telemetry. A `disabled` control takes no focus and the
 * accessibility tree ignores it, so the fake DOM — where focus() is a counter
 * and there is no tree at all — cannot tell read-only from unavailable.
 * @param {import('puppeteer-core').Page} tab
 */
export async function probeTelemetry(tab) {
  const { failures, check } = checks();

  await (await tab.waitForSelector(`[data-effect="${TELEMETRY_EFFECT}"]`)).click();
  await tab.waitForSelector(TELEMETRY_WIDGET, { timeout: TIMEOUT_MS });

  const reached = await tab.$eval(TELEMETRY_WIDGET, (widget) => {
    widget.focus();
    return {
      name: widget.closest('.lil-controller')
        ?.querySelector('.lil-name')?.textContent?.trim() ?? '',
      focused: document.activeElement === widget,
      disabled: widget.disabled,
    };
  });
  check(!reached.disabled && reached.focused,
    `the ${reached.name || 'telemetry'} readout still takes keyboard focus`);

  const cdp = await tab.createCDPSession();
  try {
    await cdp.send('Accessibility.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await cdp.send('DOM.querySelector',
      { nodeId: doc.root.nodeId, selector: TELEMETRY_WIDGET });
    const tree = await cdp.send('Accessibility.getPartialAXTree',
      { nodeId, fetchRelatives: false });
    const ax = tree.nodes.find((node) => node.name);
    const property = (name) => ax?.properties
      ?.find((entry) => entry.name === name)?.value?.value;
    check(ax !== undefined && ax.ignored !== true,
      `the readout is exposed to assistive tech (${ax?.name?.value ?? 'ignored'})`);
    check(property('disabled') !== true,
      'the readout is not announced as unavailable');
    check(property('readonly') === true,
      'the readout is announced as read-only');

    return failures;
  } finally {
    await cdp.detach();
  }
}

/** @param {import('puppeteer-core').Page} tab */
export async function probeMobilePanel(tab) {
  const { failures, check } = checks();

  await (await tab.waitForSelector(`[data-effect="${EFFECT}"]`)).click();
  const initiallyClosed = await tab.$eval(
    '.effect-gui', (panel) => panel.classList.contains('lil-closed'));
  check(initiallyClosed, 'the first mobile panel mount is collapsed');
  await (await tab.waitForSelector(PANEL_TITLE)).click();
  await tab.waitForFunction(
    () => !document.querySelector('.effect-gui')?.classList.contains('lil-closed'),
    { timeout: TIMEOUT_MS });

  const focusedName = await tab.$eval('.effect-gui', (panel) => {
    const controller = panel.querySelector('.lil-controller.lil-number');
    const widget = controller?.querySelector('input');
    widget?.focus();
    window.probedPanel = panel;
    return controller?.querySelector('.lil-name')?.textContent?.trim() ?? '';
  });
  check(focusedName !== '', `the opened mobile panel focuses ${focusedName || 'a control'}`);

  await tab.$eval(RESET, (node) => node.click());
  await tab.waitForFunction(
    () => document.querySelector('.effect-gui') !== window.probedPanel,
    { timeout: TIMEOUT_MS });
  const rebuilt = await tab.evaluate(() => {
    const panel = document.querySelector('.effect-gui');
    const widget = document.activeElement;
    const controller = widget?.closest('.lil-controller.lil-number');
    return {
      open: !panel?.classList.contains('lil-closed'),
      focusedName: controller?.querySelector('.lil-name')?.textContent?.trim() ?? '',
    };
  });
  check(rebuilt.open, 'the rebuilt mobile panel keeps the user-opened state');
  check(rebuilt.focusedName === focusedName,
    `the rebuilt mobile panel restores focus to ${focusedName}`);

  return failures;
}

/**
 * Move the sidebar to one edge and wait through its queued arrow refresh.
 * @param {import('puppeteer-core').Page} tab - The page under probe.
 * @param {'start'|'end'} edge - Horizontal edge to reach.
 * @returns {Promise<{left: boolean, right: boolean, offset: number, limit: number}>}
 *   Arrow visibility and scroll geometry after the refresh.
 */
const scrollToEdge = (tab, edge) => tab.$eval(LIST,
  (list, targetEdge, leftSelector, rightSelector) => new Promise((resolve) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const limit = list.scrollWidth - list.clientWidth;
    list.scrollTo({ left: targetEdge === 'start' ? 0 : limit, behavior: 'instant' });
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      left: document.querySelector(leftSelector).classList.contains('visible'),
      right: document.querySelector(rightSelector).classList.contains('visible'),
      offset: list.scrollLeft,
      limit,
    })));
  }), edge, ARROW_LEFT, ARROW_RIGHT);

/**
 * The sidebar's two layout-derived reads under the mobile column-flow grid.
 * @param {import('puppeteer-core').Page} tab - The page under probe.
 * @returns {Promise<string[]>} The failed check descriptions.
 */
export async function probeSidebar(tab) {
  const { failures, check } = checks();

  // The sort announcement carries .visually-hidden; only a browser resolves the
  // class against the stylesheet the page actually loaded.
  const announcement = await tab.$eval(SORT_STATUS, (status) => {
    const style = getComputedStyle(status);
    const box = status.getBoundingClientRect();
    return {
      position: style.position,
      nowrap: style.whiteSpace,
      width: box.width,
      height: box.height,
    };
  });
  check(announcement.position === 'absolute' && announcement.nowrap === 'nowrap'
      && announcement.width <= 1 && announcement.height <= 1,
    `the sort announcement is clipped out of the layout (${announcement.position}, `
      + `${announcement.nowrap}, ${announcement.width}x${announcement.height})`);

  const grid = await tab.$eval(LIST, (list) => {
    const style = getComputedStyle(list);
    return {
      flow: style.gridAutoFlow,
      // What columnStride() splits: a resolved track list, not the authored
      // repeat() the fake DOM hands back verbatim.
      rows: style.gridTemplateRows,
      options: list.querySelectorAll('.effect-button').length,
      overflow: list.scrollWidth - list.clientWidth,
    };
  });
  const stride = grid.rows.trim().split(/\s+/).length;
  check(grid.flow.includes('column'),
    `the mobile list is a column-flow grid (${grid.flow})`);
  check(stride > 1 && stride < grid.options,
    `gridTemplateRows resolves to ${stride} tracks over ${grid.options} options`);
  check(grid.overflow > 0,
    `the list overruns its track by ${grid.overflow}px, so the arrows have work`);
  if (grid.overflow <= 0 || stride <= 1) return failures;

  const focusedIndex = (page) => page.evaluate((option) => {
    const options = [...document.querySelectorAll(option)];
    return options.indexOf(document.activeElement);
  }, OPTION);

  await tab.$eval(LIST, (list) => {
    list.scrollLeft = 0;
    list.querySelector('.effect-button').focus();
  });
  check(await focusedIndex(tab) === 0, 'the first option takes focus');

  await tab.keyboard.press('ArrowRight');
  const right = await focusedIndex(tab);
  check(right === stride,
    `ArrowRight crosses one whole column (option ${right}, stride ${stride})`);

  await tab.keyboard.press('ArrowLeft');
  const back = await focusedIndex(tab);
  check(back === 0, `ArrowLeft crosses back (option ${back})`);

  // overflow-y is hidden on the column-flow list, so the focus ring survives
  // only where the list's padding leaves it room above and below the option.
  const ring = await tab.$eval(LIST, (list) => {
    const box = /** @type {HTMLElement} */ (document.activeElement)
      .getBoundingClientRect();
    const track = list.getBoundingClientRect();
    return { above: box.top - track.top, below: track.bottom - box.bottom };
  });
  check(ring.above >= RING_CLEARANCE && ring.below >= RING_CLEARANCE,
    `the focus ring clears the clip (${ring.above}px above, ${ring.below}px `
      + `below, ${RING_CLEARANCE}px needed)`);

  const atStart = await scrollToEdge(tab, 'start');
  check(!atStart.left && atStart.right,
    `at the start only the right arrow shows (left ${atStart.left}, `
      + `right ${atStart.right}, offset ${atStart.offset}/${atStart.limit})`);

  const atEnd = await scrollToEdge(tab, 'end');
  check(atEnd.left && !atEnd.right,
    `at the end only the left arrow shows (left ${atEnd.left}, `
      + `right ${atEnd.right}, offset ${atEnd.offset}/${atEnd.limit})`);

  return failures;
}

/**
 * The engine's parameter warning, laid out. The fake DOM the unit suite runs
 * over has no box model, so only a browser decides whether the note the panel
 * builds is on screen at all, and whether it takes a line of its own rather
 * than being squeezed onto the row beside the widget.
 * @param {import('puppeteer-core').Page} tab - The page under probe.
 * @param {string} layout - Which layout is mounted, for the check text.
 * @returns {Promise<string[]>} The failed check descriptions.
 */
export async function probeWarningNote(tab, layout) {
  const { failures, check } = checks();

  await tab.evaluate(async () => {
    const [{ default: loadEngine }, { createEffectGui }, { GUI }] = await Promise.all([
      import('./generated/holosphere_wasm.js'), import('./src/ui/effect_gui.js'), import('./src/ui/gui.js'),
    ]);
    const module = await loadEngine();
    const engine = new module.HolosphereEngine();
    engine.setResolution(8, 4);
    engine.setEffect('Shader');
    const choose = (name, label) => {
      const definition = engine.getParameterDefinitions().find((param) => param.name === name);
      const value = definition.options.indexOf(label);
      if (value < 0) throw new Error(`${name} has no ${label} option`);
      engine.setParameter(name, value);
    };
    choose('Planar Warp 1', 'Mirror Tile');
    choose('Function', 'Noise Contour (Sphere)');
    const container = document.getElementById('gui-container');
    const previous = [...container.children];
    previous.forEach((node) => { node.hidden = true; });
    const panel = createEffectGui({
      engine: {
        getParameterDefinitions: () => engine.getParameterDefinitions(),
        paramGeneration: () => 0, paramValues: () => engine.getParamValues(),
        setParam: (name, value) => engine.setParameter(name, value) === module.ParamSetResult.APPLIED,
        setAnimationsPaused: (value) => engine.setAnimationsPaused(value),
        animationsPaused: () => engine.getAnimationsPaused(),
        getPresetCount: () => engine.getPresetCount(), getPresetIndex: () => engine.getPresetIndex(),
        synchronizePreset: (index) => engine.synchronizePreset(index),
        selectPreset: (index) => engine.selectPreset(index),
      },
      segments: { ownsDisplay: () => false, paramValues: () => null, setParam: () => {} },
      host: {
        createGui: () => new GUI({ autoPlace: false }, 'warning-probe'),
        container: () => container, isMobile: () => matchMedia('(max-width: 900px)').matches,
        applyEffect: () => {}, dragTarget: window,
      },
    });
    panel.build();
    panel.mount();
    panel.active().gui.open();
    window.disposeWarningProbe = () => {
      panel.destroy(); engine.delete(); previous.forEach((node) => { node.hidden = false; });
    };
  });
  const element = await tab.waitForSelector('.effect-gui .param-warning-note');
  await element.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  const note = await element.evaluate((element) => {
    const controller = element.closest('.lil-controller');
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const widget = controller.querySelector('.lil-widget').getBoundingClientRect();
    const panel = element.closest('.effect-gui').getBoundingClientRect();
    return {
      missing: false,
      title: controller.getAttribute('title'),
      text: element.textContent,
      width: Math.round(box.width), height: Math.round(box.height),
      rects: element.getClientRects().length,
      visibility: style.visibility, display: style.display, opacity: Number(style.opacity),
      ownLine: box.top >= widget.bottom - 1,
      inside: box.left >= panel.left - 1 && box.right <= panel.right + 1,
      clippedX: element.scrollWidth - element.clientWidth,
      clippedY: element.scrollHeight - element.clientHeight,
    };
  });

  check(!note.missing, 'the warned control carries a note node');
  if (note.missing) return failures.map((failure) => `${layout}: ${failure}`);
  check(note.text.includes('Planar Warp 1') && note.text.includes('Mirror Tile'),
    `the note carries the warning text (${note.text})`);
  check(note.title === null,
    `the control publishes no pointer-only tooltip (${note.title})`);
  check(note.rects > 0 && note.visibility === 'visible' && note.opacity === 1
      && note.display !== 'none',
    `the note is rendered (${note.rects} box(es), ${note.visibility}, `
      + `opacity ${note.opacity})`);
  check(note.width > 1 && note.height > 1,
    `the note has a real box (${note.width}x${note.height})`);
  check(note.ownLine, 'the note sits below the widget, on its own line');
  check(note.inside, 'the note lays out inside the panel');
  check(note.clippedX <= 1 && note.clippedY <= 1,
    `the text is not clipped (${note.clippedX}px wide, ${note.clippedY}px tall `
      + 'past the box)');

  await tab.evaluate(() => { window.disposeWarningProbe(); delete window.disposeWarningProbe; });
  return failures.map((failure) => `${layout}: ${failure}`);
}

/** @param {import('puppeteer-core').Page} tab */
export async function probeKeyboardEdits(tab) {
  const { failures, check } = checks();
  await tab.evaluate(async () => {
    const [{ createEffectGui }, { GUI }] = await Promise.all([
      import('./src/ui/effect_gui.js'), import('./src/ui/gui.js'),
    ]);
    const container = document.createElement('div');
    container.id = 'keyboard-edit-probe';
    container.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:black';
    document.body.appendChild(container);
    const state = { value: 1, warning: '', warnOnWrite: false };
    const panel = createEffectGui({
      engine: {
        getParameterDefinitions: () => [{ name: 'Probe', value: state.value,
          min: 0, max: 10, warning: state.warning, animated: true }],
        paramGeneration: () => 0, paramValues: () => [state.value],
        setParam: (name, value) => {
          state.value = value;
          if (state.warnOnWrite) state.warning = 'Keyboard edit warning';
          return true;
        },
        setAnimationsPaused: () => {}, animationsPaused: () => false,
        getPresetCount: () => 0, getPresetIndex: () => 0,
        synchronizePreset: () => true, selectPreset: () => false,
      },
      segments: { ownsDisplay: () => false, paramValues: () => null, setParam: () => {} },
      host: {
        createGui: () => new GUI({ autoPlace: false }, 'keyboard-probe'),
        container: () => container, isMobile: () => false, applyEffect: () => {},
        focusedElement: () => document.activeElement, dragTarget: window,
      },
    });
    panel.build(); panel.mount(); panel.active().gui.open();
    window.keyboardEditProbe = { state, panel, container };
  });
  const selector = '#keyboard-edit-probe .lil-number input';
  try {
    await tab.focus(selector);
    await tab.keyboard.down('Control');
    await tab.keyboard.press('KeyA');
    await tab.keyboard.up('Control');
    await tab.keyboard.type('1.2');
    const focused = await tab.evaluate(() => {
      const { state, panel, container } = window.keyboardEditProbe;
      const widget = container.querySelector('.lil-number input');
      state.value = 7;
      panel.sync();
      return { focused: document.activeElement === widget, value: widget.value };
    });
    check(focused.focused && Number(focused.value) === 1.2,
      'frame synchronization preserves the focused numeric input');
    const blurred = await tab.evaluate(() => {
      const { panel, container } = window.keyboardEditProbe;
      document.activeElement.blur(); panel.sync();
      return container.querySelector('.lil-number input').value;
    });
    check(Number(blurred) === 7, 'blurred numeric input resumes engine synchronization');
    await tab.focus(selector);
    await tab.evaluate(() => { window.keyboardEditProbe.state.warnOnWrite = true; });
    await tab.keyboard.down('ArrowUp');
    const held = await tab.evaluate(() => {
      const { panel, container, state } = window.keyboardEditProbe;
      const widget = container.querySelector('.lil-number input');
      panel.sync();
      return { active: panel.active().edits.active, connected: widget.isConnected,
        warning: Boolean(container.querySelector('.param-warning-note')), value: state.value };
    });
    check(held.value > 7, 'lil-gui handles the real ArrowUp key on its numeric input');
    check(held.active && held.connected && !held.warning,
      'a held arrow defers the warning rebuild without replacing its input');
    await tab.keyboard.up('ArrowUp');
    const released = await tab.evaluate(() => {
      const { panel, container } = window.keyboardEditProbe;
      panel.sync();
      return { active: panel.active().edits.active,
        warning: container.querySelector('.param-warning-note')?.textContent };
    });
    check(!released.active && released.warning === 'Keyboard edit warning',
      'arrow release lets the deferred warning rebuild complete');
  } finally {
    await tab.evaluate(() => {
      const { panel, container } = window.keyboardEditProbe;
      panel.destroy(); container.remove(); delete window.keyboardEditProbe;
    });
  }
  return failures;
}

if (isMain(import.meta.url)) await runProbe({
  name: 'panel-probe',
  minimumChecks: 58,
  page: PAGE,
  timeoutMs: TIMEOUT_MS,
  success: 'the effect panel restored what it captured, and the sidebar measured '
    + 'the grid it laid out.',
  run: async ({ open }) => {
    const failures = [];
    const tab = await open({ viewport: VIEWPORT });
    const painted = () => tab.waitForFunction(
      () => !document.getElementById('loading-overlay'));
    await painted();
    await tab.waitForSelector('.effect-gui');
    failures.push(...await probePanel(tab));
    failures.push(...await probeSliderDrag(tab));
    failures.push(...await probePresetName(tab));
    failures.push(...await probeKeyboardEdits(tab));
    failures.push(...await probeWarningNote(tab, 'desktop'));
    failures.push(...await probeStageNames(tab));
    failures.push(...await probeTelemetry(tab));

    await tab.setViewport(MOBILE_VIEWPORT);
    await tab.reload({ timeout: TIMEOUT_MS });
    await painted();
    await tab.waitForSelector('.effect-gui');
    failures.push(...await probeMobilePanel(tab));
    failures.push(...await probeTouchSlider(tab));
    failures.push(...await probeWarningNote(tab, 'mobile'));

    await tab.setViewport(SIDEBAR_VIEWPORT);
    await tab.reload({ timeout: TIMEOUT_MS });
    await painted();
    await tab.waitForSelector(`${LIST} ${OPTION}`);
    failures.push(...await probeSidebar(tab));
    return failures;
  },
});
