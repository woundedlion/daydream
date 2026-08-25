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
 */
import puppeteer from 'puppeteer-core';

import { manifestEntries } from '../tests/site_pages.js';
import { BROWSER_ARGS, resolveBrowser } from './browser.mjs';
import { serveManifest } from './serve-manifest.mjs';

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
const SCROLLER = '.effect-gui .lil-children';
const PANEL_TITLE = '.effect-gui > .lil-title';
const RESET = '.effect-action-reset button';
const LIST = '.effect-list';
const OPTION = '.effect-button';
const ARROW_LEFT = '.scroll-arrow-left';
const ARROW_RIGHT = '.scroll-arrow-right';

/** @param {import('puppeteer-core').Page} tab */
const scrollerMetrics = (tab) => tab.$eval(SCROLLER, (node) => ({
  scrollTop: node.scrollTop,
  scrollHeight: node.scrollHeight,
  clientHeight: node.clientHeight,
}));

/** @param {import('puppeteer-core').Page} tab */
async function probePanel(tab) {
  const failures = [];
  const check = (ok, message) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
  };

  await (await tab.waitForSelector(`[data-effect="${EFFECT}"]`, { timeout: TIMEOUT_MS })).click();
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

/** @param {import('puppeteer-core').Page} tab */
async function probeMobilePanel(tab) {
  const failures = [];
  const check = (ok, message) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
  };

  await (await tab.waitForSelector(`[data-effect="${EFFECT}"]`, { timeout: TIMEOUT_MS })).click();
  const initiallyClosed = await tab.$eval(
    '.effect-gui', (panel) => panel.classList.contains('lil-closed'));
  check(initiallyClosed, 'the first mobile panel mount is collapsed');
  await (await tab.waitForSelector(PANEL_TITLE, { timeout: TIMEOUT_MS })).click();
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
  const failures = [];
  const check = (ok, message) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
  };

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

let executablePath;
try {
  executablePath = resolveBrowser();
} catch (error) {
  console.error(`panel-probe: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

console.log(`panel-probe: ${PAGE}, ${executablePath}`);
const site = await serveManifest(manifestEntries());
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: BROWSER_ARGS,
});

const failures = [];
try {
  const tab = await browser.newPage();
  await tab.setViewport(VIEWPORT);
  tab.on('pageerror', (error) => failures.push(`uncaught: ${error.message}`));
  await tab.goto(`${site.origin}/${PAGE}`, { timeout: TIMEOUT_MS });
  await tab.waitForFunction(() => !document.getElementById('loading-overlay'),
    { timeout: TIMEOUT_MS });
  await tab.waitForSelector('.effect-gui', { timeout: TIMEOUT_MS });
  failures.push(...await probePanel(tab));
  await tab.setViewport(MOBILE_VIEWPORT);
  await tab.reload({ timeout: TIMEOUT_MS });
  await tab.waitForFunction(() => !document.getElementById('loading-overlay'),
    { timeout: TIMEOUT_MS });
  await tab.waitForSelector('.effect-gui', { timeout: TIMEOUT_MS });
  failures.push(...await probeMobilePanel(tab));
  await tab.setViewport(SIDEBAR_VIEWPORT);
  await tab.reload({ timeout: TIMEOUT_MS });
  await tab.waitForFunction(() => !document.getElementById('loading-overlay'),
    { timeout: TIMEOUT_MS });
  await tab.waitForSelector(`${LIST} ${OPTION}`, { timeout: TIMEOUT_MS });
  failures.push(...await probeSidebar(tab));
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
  await site.close();
}

if (failures.length > 0) {
  console.error(`panel-probe: ${failures.length} checks failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  'panel-probe: the effect panel restored what it captured, '
  + 'and the sidebar measured the grid it laid out.');
