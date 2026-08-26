/*
 * Drives the effect panel's scroll and focus restoration, and the sidebar's two
 * layout-derived computations, in headless Chrome over the same manifest server
 * scripts/browser-smoke.mjs uses.
 *
 *   node scripts/panel-probe.mjs
 *
 * The unit suite runs over tests/fake_dom.js, where scrollTop is a plain
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
import { checks, runProbe } from './probe_harness.mjs';

const PAGE = 'index.html';
// Short enough that the panel's max-height cap bites and its own .lil-children
// becomes the scroller, which is what effect_gui.js writes the offset onto.
const VIEWPORT = { width: 1280, height: 240 };
const MOBILE_VIEWPORT = { width: 800, height: 720 };
// Narrow enough that the column-flow effect list overruns its track and the
// scroll arrows have something to report; 800px lays the whole roster out.
const SIDEBAR_VIEWPORT = { width: 480, height: 720 };
// The roster's widest parameter schema, so the panel overflows the cap.
const EFFECT = 'ShapeShifter';
const TIMEOUT_MS = 90_000;
// Longer than state.js's URL flush debounce, so a deferred write has landed.
const URL_SETTLE_MS = 600;
// Bound on the wait for the query string to stop changing.
const URL_SETTLE_POLLS = 20;
// Long enough that a note squeezed onto the control row would be clipped.
const WARNING = 'Legacy Stereo Noise requires Projection = Stereographic.';
const SCROLLER = '.effect-gui .lil-children';
const PANEL_SLIDER = '.effect-gui .lil-controller.lil-number .lil-slider';
const PANEL_TITLE = '.effect-gui > .lil-title';
const RESET = '.effect-action-reset button';
const LIST = '.effect-list';
const OPTION = '.effect-button';
const ARROW_LEFT = '.scroll-arrow-left';
const ARROW_RIGHT = '.scroll-arrow-right';

// What the :focus-visible rule in styles/index.css paints outside an option:
// a 2px ring at a 2px offset.
const RING_CLEARANCE = 4;

const PRESET_SELECT = '.preset-nav-selector select';
const PRESET_NAME = 'Preset';

/** @param {import('puppeteer-core').Page} tab */
const scrollerMetrics = (tab) => tab.$eval(SCROLLER, (node) => ({
  scrollTop: node.scrollTop,
  scrollHeight: node.scrollHeight,
  clientHeight: node.clientHeight,
}));

/** @param {import('puppeteer-core').Page} tab */
async function probePanel(tab) {
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
async function probeSliderDrag(tab) {
  const failures = [];
  const check = (ok, message) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
  };

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

  // Waits out the write the panel rebuild above still owes: the baseline the
  // drag is judged against must not be one landing under it.
  const settleUrl = async () => {
    let last = null;
    for (let poll = 0; poll < URL_SETTLE_POLLS; poll += 1) {
      const search = await tab.evaluate(() => location.search);
      if (search === last) return;
      last = search;
      await new Promise((resolve) => setTimeout(resolve, URL_SETTLE_MS));
    }
  };

  await settleUrl();
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

/*
 * The preset dropdown carries no aria-label of its own: lil-gui points the
 * select at its own .lil-name element, which the action row hides. A fake DOM
 * has no accessibility tree, so only the browser's computed name says whether
 * a hidden label element still names the control.
 * @param {import('puppeteer-core').Page} tab
 */
async function probePresetName(tab) {
  const { failures, check } = checks();

  const cdp = await tab.createCDPSession();
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
  await cdp.detach();
  return failures;
}

/** @param {import('puppeteer-core').Page} tab */
async function probeMobilePanel(tab) {
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
 * Which scroll arrows the sidebar currently shows.
 * @param {import('puppeteer-core').Page} tab - The page under probe.
 * @returns {Promise<{left: boolean, right: boolean}>} Arrow visibility.
 */
const readArrows = (tab) => tab.evaluate((left, right) => ({
  left: document.querySelector(left).classList.contains('visible'),
  right: document.querySelector(right).classList.contains('visible'),
}), ARROW_LEFT, ARROW_RIGHT);

/**
 * Poll the arrows until they reach `want`, then report where they stopped: the
 * refresh is one rAF behind the scroll event, and a miss has to name the state
 * it settled at rather than stall on a wait.
 * @param {import('puppeteer-core').Page} tab - The page under probe.
 * @param {{left: boolean, right: boolean}} want - The expected visibility.
 * @returns {Promise<{left: boolean, right: boolean}>} The settled visibility.
 */
async function settledArrows(tab, want) {
  let state = await readArrows(tab);
  for (let tries = 0;
    tries < 40 && (state.left !== want.left || state.right !== want.right);
    tries++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    state = await readArrows(tab);
  }
  return state;
}

/**
 * The sidebar's two layout-derived reads under the mobile column-flow grid.
 * @param {import('puppeteer-core').Page} tab - The page under probe.
 * @returns {Promise<string[]>} The failed check descriptions.
 */
async function probeSidebar(tab) {
  const { failures, check } = checks();

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

  // Focusing an option in a clipped column scrolls it into view, so the arrow
  // checks re-seat the offset rather than assuming it survived.
  await tab.$eval(LIST, (list) => { list.scrollLeft = 0; });
  const atStart = await settledArrows(tab, { left: false, right: true });
  check(!atStart.left && atStart.right,
    `at the start only the right arrow shows (left ${atStart.left}, `
      + `right ${atStart.right})`);

  await tab.$eval(LIST, (list) => { list.scrollLeft = list.scrollWidth; });
  const atEnd = await settledArrows(tab, { left: true, right: false });
  check(atEnd.left && !atEnd.right,
    `at the end only the left arrow shows (left ${atEnd.left}, right ${atEnd.right})`);

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
async function probeWarningNote(tab, layout) {
  const { failures, check } = checks();

  const note = await tab.evaluate(async (warning) => {
    const { addParamControl } = await import('/effect_gui.js');
    const { GUI } = await import('lil-gui');
    const container = document.querySelector('.gui-container');
    const gui = new GUI({ container, title: 'Warning Probe', autoPlace: false });
    gui.domElement.classList.add('effect-gui');
    try {
      const controller = addParamControl(gui, { Speed: 0.5 },
        { name: 'Speed', value: 0.5, min: 0, max: 1, warning });
      const element = controller.domElement.querySelector('.param-warning-note');
      if (!element) {
        return { missing: true, title: controller.domElement.getAttribute('title') };
      }
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const widget = controller.domElement.querySelector('.lil-widget')
        .getBoundingClientRect();
      const panel = gui.domElement.getBoundingClientRect();
      return {
        missing: false,
        title: controller.domElement.getAttribute('title'),
        text: element.textContent,
        width: Math.round(box.width),
        height: Math.round(box.height),
        rects: element.getClientRects().length,
        visibility: style.visibility,
        display: style.display,
        opacity: Number(style.opacity),
        ownLine: box.top >= widget.bottom - 1,
        inside: box.left >= panel.left - 1 && box.right <= panel.right + 1,
        clippedX: element.scrollWidth - element.clientWidth,
        clippedY: element.scrollHeight - element.clientHeight,
      };
    } finally {
      gui.destroy();
      gui.domElement.remove();
    }
  }, WARNING);

  check(!note.missing, 'the warned control carries a note node');
  if (note.missing) return failures.map((failure) => `${layout}: ${failure}`);
  check(note.text === WARNING,
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

  return failures.map((failure) => `${layout}: ${failure}`);
}

await runProbe({
  name: 'panel-probe',
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
    failures.push(...await probeWarningNote(tab, 'desktop'));

    await tab.setViewport(MOBILE_VIEWPORT);
    await tab.reload({ timeout: TIMEOUT_MS });
    await painted();
    await tab.waitForSelector('.effect-gui');
    failures.push(...await probeMobilePanel(tab));
    failures.push(...await probeWarningNote(tab, 'mobile'));

    await tab.setViewport(SIDEBAR_VIEWPORT);
    await tab.reload({ timeout: TIMEOUT_MS });
    await painted();
    await tab.waitForSelector(`${LIST} ${OPTION}`);
    failures.push(...await probeSidebar(tab));
    return failures;
  },
});
