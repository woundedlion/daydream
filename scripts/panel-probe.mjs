/*
 * Drives the effect panel's scroll and focus restoration in headless Chrome,
 * over the same manifest server scripts/browser-smoke.mjs uses.
 *
 *   node scripts/panel-probe.mjs
 *
 * The unit suite runs over tests/fake_dom.js, where scrollTop is a plain
 * expando: any number written to it reads back. A browser clamps it to
 * scrollHeight - clientHeight, so a panel that has not laid out takes 0 whatever
 * was written. Only a real layout decides whether the offset survives a rebuild.
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
// The roster's widest parameter schema, so the panel overflows the cap.
const EFFECT = 'ShapeShifter';
const TIMEOUT_MS = 90_000;
const SCROLLER = '.effect-gui .lil-children';
const PANEL_TITLE = '.effect-gui > .lil-title';
const RESET = '.effect-action-reset button';

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
console.log('panel-probe: the effect panel restored what it captured.');
