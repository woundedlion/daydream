/*
 * Drives the Möbius tool's complex-plane pads in headless Chrome, over the same
 * manifest server scripts/browser-smoke.mjs uses.
 *
 *   node scripts/mobius-probe.mjs
 *
 * A pad turns a viewport point into a coefficient through its own
 * getBoundingClientRect, and keeps the gesture through pointer capture once the
 * pointer has left it. tests/fake_dom.js supplies neither: its rects are zero,
 * which the pad reads as an unlaid-out control and declines, and a move outside
 * the element never arrives. This job presses the pad at known fractions of its
 * box and requires the coefficient those fractions name, walks the pointer off
 * the pad and requires the clamped value the capture still reports, and requires
 * the press to have stopped the running preset animation.
 */
import puppeteer from 'puppeteer-core';

import { BROWSER_ARGS, resolveBrowser } from './browser.mjs';
import { serveStagedSite } from './vendor-stage.mjs';

const PAGE = 'tools/mobius.html';
const VIEWPORT = { width: 1280, height: 900 };
const TIMEOUT_MS = 90_000;
// The coefficient whose pad the gestures land on.
const PARAM = 'B';
const PAD = `#${PARAM}_plane`;
const DOT = `#${PARAM}_dot`;
const LABEL = `#${PARAM}_label`;
const REAL_AXIS = `#${PARAM}_re_axis`;
const IMAGINARY_AXIS = `#${PARAM}_im_axis`;
// The pad spans [-MAX_EXTENT, MAX_EXTENT] on both axes; tools/mobius_page.js
// owns the value.
const MAX_EXTENT = 2;
const DRAG_STEPS = 12;
// An animating preset to press over, so the press has an animation to stop.
const ANIMATED_PRESET = 'elliptic';

/**
 * What the pad currently reports, through every surface it publishes on.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @returns {Promise<{label: string, left: string, top: string, re: string, im: string}>}
 *   The caption, the dot's inset percentages, and the two axis handles' values.
 */
const padReading = (tab) => tab.evaluate((selectors) => ({
  label: document.querySelector(selectors.label)?.textContent ?? '',
  left: document.querySelector(selectors.dot)?.style.left ?? '',
  top: document.querySelector(selectors.dot)?.style.top ?? '',
  re: document.querySelector(selectors.re)?.getAttribute('aria-valuenow') ?? '',
  im: document.querySelector(selectors.im)?.getAttribute('aria-valuenow') ?? '',
}), { label: LABEL, dot: DOT, re: REAL_AXIS, im: IMAGINARY_AXIS });

/** @param {import('puppeteer-core').Page} tab */
const activePresets = (tab) =>
  tab.$$eval('.preset-btn.active', (nodes) => nodes.length);

/**
 * The complex value a pad fraction names, as the pad's own mapping computes it.
 * @param {number} fractionX - Horizontal position across the pad, in [0, 1].
 * @param {number} fractionY - Vertical position down the pad, in [0, 1].
 * @returns {{re: string, im: string}} The two parts, formatted as the pad writes them.
 */
const valueAt = (fractionX, fractionY) => ({
  re: ((fractionX * 2 - 1) * MAX_EXTENT).toFixed(2),
  im: (-(fractionY * 2 - 1) * MAX_EXTENT).toFixed(2),
});

/**
 * One complex value as the pad's caption spells it.
 * @param {{re: string, im: string}} value - The two parts, already formatted.
 * @returns {string} The caption, e.g. '1.00 - 1.00i'.
 */
const caption = ({ re, im }) =>
  `${re} ${im.startsWith('-') ? '-' : '+'} ${im.replace('-', '')}i`;

/**
 * @param {import('puppeteer-core').Page} tab - The page.
 * @returns {Promise<string[]>} One entry per failed check.
 */
async function probePad(tab) {
  const failures = [];
  const check = (ok, message) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
  };

  await tab.select('#presetSelect', ANIMATED_PRESET);
  await tab.waitForFunction(() =>
    document.querySelectorAll('.preset-btn.active').length === 1,
  { timeout: TIMEOUT_MS });

  await tab.$eval(PAD, (node) => node.scrollIntoView({ block: 'center' }));
  const box = await (await tab.$(PAD)).boundingBox();
  if (!box) throw new Error(`the ${PARAM} pad has no layout box`);
  check(box.width > 0 && box.height > 0,
    `the ${PARAM} pad lays out ${Math.round(box.width)}x${Math.round(box.height)}`);
  const at = (fractionX, fractionY) => ({
    x: box.x + box.width * fractionX, y: box.y + box.height * fractionY,
  });

  // Fractions chosen so the mapped value lands on an integer, which the pad's
  // snap then absorbs the sub-pixel remainder into.
  const press = valueAt(0.75, 0.25);
  await tab.mouse.move(...Object.values(at(0.75, 0.25)));
  await tab.mouse.down();
  const pressed = await padReading(tab);
  check(pressed.re === press.re && pressed.im === press.im,
    `the press reads ${caption(press)} off the pad (${caption(pressed)})`);
  check(pressed.label === caption(press),
    `the caption reads ${pressed.label}`);
  check(pressed.left === '75%' && pressed.top === '25%',
    `the dot sits where the pointer pressed (${pressed.left}, ${pressed.top})`);
  check(await activePresets(tab) === 0,
    'the press stops the running preset animation');
  check(await tab.$eval(PAD, (node) => node.style.cursor) === 'grabbing',
    'the press takes the grabbing cursor');

  const dragged = valueAt(0.25, 0.75);
  const to = at(0.25, 0.75);
  const from = at(0.75, 0.25);
  for (let i = 1; i <= DRAG_STEPS; i++) {
    await tab.mouse.move(from.x + ((to.x - from.x) * i) / DRAG_STEPS,
      from.y + ((to.y - from.y) * i) / DRAG_STEPS);
  }
  const moved = await padReading(tab);
  check(moved.re === dragged.re && moved.im === dragged.im,
    `the drag tracks the pointer to ${caption(dragged)} (${caption(moved)})`);

  // Off the pad entirely: only the capture keeps the moves coming, and the pad
  // clamps what it maps them to.
  await tab.mouse.move(box.x + box.width * 2, box.y + box.height / 2);
  const outside = await padReading(tab);
  check(outside.re === MAX_EXTENT.toFixed(2) && outside.im === '0.00',
    `a move past the pad's edge clamps to its extent (${caption(outside)})`);
  check(outside.left === '100%',
    `the dot stays inside the pad (${outside.left})`);

  await tab.mouse.up();
  check(await tab.$eval(PAD, (node) => node.style.cursor) === 'grab',
    'the release restores the grab cursor');

  // A move with no button down is not a drag; the pad has no capture to filter
  // it against and must ignore it.
  await tab.mouse.move(...Object.values(at(0.1, 0.9)));
  const hovered = await padReading(tab);
  check(hovered.re === outside.re && hovered.im === outside.im,
    `hovering the released pad moves nothing (${caption(hovered)})`);

  return failures;
}

let executablePath;
try {
  executablePath = resolveBrowser();
} catch (error) {
  console.error(`mobius-probe: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

console.log(`mobius-probe: ${PAGE}, ${executablePath}`);
let site = null;
let browser = null;
const failures = [];
try {
  site = await serveStagedSite();
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: BROWSER_ARGS,
  });
  const tab = await browser.newPage();
  await tab.setViewport(VIEWPORT);
  tab.on('pageerror', (error) => failures.push(`uncaught: ${error.message}`));
  await tab.goto(`${site.origin}/${PAGE}`, { timeout: TIMEOUT_MS });
  // The pads are built by the page's init, after the scene is up.
  await tab.waitForSelector(PAD, { visible: true, timeout: TIMEOUT_MS });
  failures.push(...await probePad(tab));
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
  await site?.close();
}

if (failures.length > 0) {
  console.error(`mobius-probe: ${failures.length} checks failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('mobius-probe: the complex-plane pad tracks a real pointer on and off itself.');
