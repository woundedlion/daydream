/*
 * Drives the shader workbench's pipeline strip with a real mouse in headless
 * Chrome, over the same manifest server scripts/browser-smoke.mjs uses.
 *
 *   node scripts/workbench-probe.mjs
 *
 * The unit suite renders the strip into tests/fake_dom.js, which has neither
 * layout nor pointer capture, so it can see neither where a palette lands on
 * screen nor that a captured press swallows the click behind it. Those need a
 * browser: palette placement is measured against the control that opened it, the
 * floating controls are measured against the regions they must not cover, and
 * every gesture below is a genuine mouse down/move/up — including the press on a
 * chip's own slider, which the chip drag must leave alone.
 */
import puppeteer from 'puppeteer-core';

import { manifestEntries } from '../tests/site_pages.js';
import { BROWSER_ARGS, resolveBrowser } from './browser.mjs';
import { serveManifest } from './serve-manifest.mjs';

const PAGE = 'tools/shader.html';
const VIEWPORT = { width: 1400, height: 900 };
const LOAD_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 90_000;

// A palette carries a border and the strip a little padding, so its box never
// starts exactly on the button's. Anything past this is the anchoring failing
// rather than rounding: the defect this pins put a socket's palette 1070px out.
const ANCHOR_TOLERANCE_PX = 16;

// Steps a drag is moved in. One jump would leave the strip a single hover to
// resolve, which is not the gesture a hand makes.
const DRAG_STEPS = 16;

// Travel that arms a drag: past the strip's slop, so the press stops reading as
// a click and the drop targets take their live sizes.
const DRAG_ARM_PX = 8;

// Where along a slider's track the probe clicks, and the value that lands there.
const SLIDER_FRACTION = 0.75;

// Slack between the slider's own value and the one the exported document
// carries: the two are the same number through a JSON round trip, so this only
// absorbs the export's own binary32 rounding.
const VALUE_TOLERANCE = 1e-4;

/**
 * @param {import('puppeteer-core').Page} tab - The page under test.
 * @param {string} selector - Element to find.
 * @returns {Promise<{x: number, y: number, width: number, height: number}>} Its
 *   viewport box.
 */
async function boxOf(tab, selector) {
  const handle = await tab.waitForSelector(selector, { timeout: READY_TIMEOUT_MS });
  const box = await handle.boundingBox();
  if (box === null) throw new Error(`${selector} has no layout box`);
  return box;
}

/** @param {{x: number, y: number, width: number, height: number}} box */
const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/**
 * @param {{x: number, y: number, width: number, height: number}} a - One box.
 * @param {{x: number, y: number, width: number, height: number}} b - Another.
 * @returns {boolean} Whether the two boxes share any pixel.
 */
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Presses at one point, travels to a target, and releases: the gesture the
 * strip's pointer capture sees, rather than a synthesized drop. The target is
 * resolved once the drag is armed, because the strip widens its gaps into hit
 * areas the moment one starts and everything to their right moves with them.
 * @param {import('puppeteer-core').Page} tab - The page under test.
 * @param {{x: number, y: number}} from - Where the press lands.
 * @param {() => Promise<{x: number, y: number}>} target - Resolves the release
 *   point against the layout the running drag has.
 * @returns {Promise<void>}
 */
async function dragFrom(tab, from, target) {
  await tab.mouse.move(from.x, from.y);
  await tab.mouse.down();
  const armed = { x: from.x + DRAG_ARM_PX, y: from.y };
  await tab.mouse.move(armed.x, armed.y);
  const to = await target();
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    await tab.mouse.move(
      armed.x + ((to.x - armed.x) * step) / DRAG_STEPS,
      armed.y + ((to.y - armed.y) * step) / DRAG_STEPS,
    );
  }
  await tab.mouse.up();
}

/**
 * The chip names one band holds, left to right.
 * @param {import('puppeteer-core').Page} tab - The page under test.
 * @param {string} carrier - The band's carrier.
 * @returns {Promise<string[]>} Operator display names.
 */
const bandChipNames = (tab, carrier) => tab.$$eval(
  `.chain-band[data-carrier="${carrier}"] .chain-chip-name`,
  (nodes) => nodes.map((node) => node.textContent ?? ''));

/**
 * Opens a palette from one control and reports how far it landed from it.
 * @param {import('puppeteer-core').Page} tab - The page under test.
 * @param {string} selector - The control that opens the palette.
 * @returns {Promise<number>} Distance between the two left edges.
 */
async function paletteOffsetFrom(tab, selector) {
  const control = await boxOf(tab, selector);
  await tab.mouse.click(centre(control).x, centre(control).y);
  const palette = await boxOf(tab, '.chain-palette');
  const offset = Math.abs(palette.x - control.x);
  await tab.keyboard.press('Escape');
  await tab.waitForFunction(() => document.querySelector('.chain-palette') === null,
    { timeout: READY_TIMEOUT_MS });
  return offset;
}

/**
 * Clicks Save and reads back the document it exported, by capturing the blob
 * the download is built from rather than waiting on a file.
 * @param {import('puppeteer-core').Page} tab - The page under test.
 * @returns {Promise<*>} The exported document.
 */
async function savedDocument(tab) {
  await tab.evaluate(() => {
    const create = URL.createObjectURL.bind(URL);
    Object.assign(window, { exported: [] });
    URL.createObjectURL = (blob) => {
      window.exported.push(blob.text());
      return create(blob);
    };
  });
  await (await tab.waitForSelector('#shader-document-save')).click();
  const source = await tab.evaluate(async () => (await Promise.all(window.exported)).at(-1));
  if (typeof source !== 'string') throw new Error('Save exported no document');
  return JSON.parse(source);
}

/**
 * Runs every gesture check against a loaded workbench.
 * @param {import('puppeteer-core').Page} tab - The page under test.
 * @returns {Promise<string[]>} One line per failure; empty when all pass.
 */
async function probeStrip(tab) {
  const failures = [];
  /**
   * @param {boolean} ok - Whether the check held.
   * @param {string} message - What was checked, and what was measured.
   * @returns {void}
   */
  const check = (ok, message) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
  };

  const bandOffset = await paletteOffsetFrom(
    tab, '.chain-band[data-carrier="plane"] .chain-band-add');
  check(bandOffset <= ANCHOR_TOLERANCE_PX,
    `a band + opens its palette ${bandOffset.toFixed(1)}px from the button`);

  const socketOffset = await paletteOffsetFrom(
    tab, '.chain-chip--socket .chain-chip-swap');
  check(socketOffset <= ANCHOR_TOLERANCE_PX,
    `a socket swap opens its palette ${socketOffset.toFixed(1)}px from the button`);

  // A crossing fits no gap, so the library would read it as permanently dead
  // were insertion its only route. On the scratch chain the sphere → plane
  // socket takes this one, and the entry has to say so and commit it.
  const gnomonic = '.chain-library-entry[data-operator="project.gnomonic.v2"]';
  const crossing = await tab.$eval(gnomonic, (node) => ({
    disabled: node.getAttribute('aria-disabled'),
    reason: node.querySelector('.chain-library-reason')?.textContent ?? '',
  }));
  check(crossing.disabled === null && crossing.reason.includes('socket'),
    `a crossing entry names its swap route (aria-disabled: ${crossing.disabled},`
    + ` "${crossing.reason}")`);
  const socketName = () => tab.$eval('.chain-chip--socket .chain-chip-name',
    (node) => node.textContent ?? '');
  const projectionBefore = await socketName();
  await (await tab.waitForSelector(gnomonic)).click();
  const projectionAfter = await socketName();
  check(projectionAfter === 'Gnomonic' && projectionBefore !== projectionAfter,
    `clicking it swaps the socket it named (${projectionBefore} → ${projectionAfter})`);
  // Clicking an entry scrolls the library to it, and the gestures below measure
  // entry boxes against the panel as it sits.
  await tab.$eval('#chain-library', (node) => { node.scrollTop = 0; });

  // Wave Shear out of the library and onto the plane band, which holds no stage
  // on the scratch chain.
  const before = await bandChipNames(tab, 'plane');
  await dragFrom(tab,
    centre(await boxOf(tab, '.chain-library-entry[data-operator="warp.wave-shear.v2"]')),
    async () => centre(await boxOf(tab, '.chain-band[data-carrier="plane"]')));
  const after = await bandChipNames(tab, 'plane');
  check(!before.includes('Wave Shear') && after.includes('Wave Shear'),
    `dragging a library entry onto a band inserts it (${after.join(', ') || 'nothing'})`);

  // A second sphere stage, so the band holds two chips to reorder and its chips
  // take the pointer instead of declining it.
  await (await tab.waitForSelector(
    '.chain-band[data-carrier="sphere"] .chain-band-add')).click();
  await (await tab.waitForSelector(
    '.chain-palette-entry[data-operator="sphere.lens.twist.v2"]')).click();
  const sphere = await bandChipNames(tab, 'sphere');
  check(sphere.length === 2, `the sphere band holds two chips (${sphere.join(', ')})`);

  await (await tab.waitForSelector(
    '.chain-band[data-carrier="sphere"] .chain-chip .chain-chip-name')).click();
  const selected = await tab.$eval('.chain-strip', (strip) => {
    const chip = strip.querySelector('.chain-chip[aria-current="true"]');
    return chip instanceof HTMLElement ? chip.dataset.label ?? '' : null;
  });
  check(selected !== null, `clicking a chip selects it (aria-current: ${selected})`);

  // Past the chip that is not the one being dragged: the drop lands in the gap
  // beyond it, which is the only one the store accepts.
  await dragFrom(tab,
    centre(await boxOf(tab,
      '.chain-band[data-carrier="sphere"] .chain-chip .chain-chip-name')),
    async () => {
      const other = await boxOf(tab,
        '.chain-band[data-carrier="sphere"] .chain-chip:not([data-dragging])');
      return { x: other.x + other.width - 2, y: centre(other).y };
    });
  const reordered = await bandChipNames(tab, 'sphere');
  check(reordered.join() === [...sphere].reverse().join(),
    `dragging a chip past another reorders the band (${reordered.join(', ')})`);

  check(await tab.$('#parameter-dock') === null && await tab.$('.parameter-dock') === null,
    'the parameter dock is gone: a stage is tuned on its own chip');

  // The selected chip is the expanded one, and it carries the controls the
  // document declares for that instance.
  const chip = '.chain-chip[data-label="rotate"]';
  await (await tab.waitForSelector(`${chip} .chain-chip-name`)).click();
  const controls = await tab.$$eval(`${chip} .chain-param`,
    (nodes) => nodes.map((node) => node.dataset.parameter ?? ''));
  check(controls.join() === 'rotate.wander,rotate.spin-speed',
    `clicking a chip expands it onto its own controls (${controls.join(', ') || 'none'})`);
  check(await tab.$eval(`${chip} .chain-chip-disclosure`,
    (node) => node.getAttribute('aria-expanded')) === 'true',
  'the expanded chip reports itself expanded');

  // A press on a slider must reach the slider: the chip's drag capture would
  // otherwise swallow it and the stage could not be tuned at all.
  const track = `${chip} .chain-param[data-parameter="rotate.wander"] .chain-param-control`;
  const slider = await boxOf(tab, track);
  await tab.mouse.click(slider.x + slider.width * SLIDER_FRACTION, centre(slider).y);
  const shown = Number(await tab.$eval(track, (node) => node.value));
  check(Math.abs(shown - SLIDER_FRACTION) < 0.05,
    `clicking a chip's slider moves it (wander ${shown})`);

  const stored = (await savedDocument(tab)).preset_bank.presets[0].values['rotate.wander'];
  check(Math.abs(stored - shown) < VALUE_TOLERANCE,
    `the control's value round-trips into the saved document (${stored})`);

  // The global controls float over the canvas: an expanded chip makes the strip
  // its tallest, which is when a panel pinned to the whole layout covers it.
  const panels = await boxOf(tab, '#gui-container');
  for (const region of ['#chain-strip', '#shader-toolbar', '#chain-library']) {
    const box = await boxOf(tab, region);
    check(!overlaps(panels, box),
      `the global controls clear ${region} (panels at ${Math.round(panels.x)},`
      + `${Math.round(panels.y)} ${Math.round(panels.width)}x${Math.round(panels.height)})`);
  }

  // A plane stage while a sphere chip is expanded: the selection's own gap
  // refuses it, the plane band takes it, so the entry has to stay live.
  const entry = '.chain-library-entry[data-operator="warp.wave-shear.v2"]';
  const disabled = await tab.$eval(entry, (node) => node.getAttribute('aria-disabled'));
  check(disabled === null,
    `a stage another band accepts stays enabled (aria-disabled: ${disabled})`);
  const planeBefore = await bandChipNames(tab, 'plane');
  await (await tab.waitForSelector(entry)).click();
  const planeAfter = await bandChipNames(tab, 'plane');
  check(planeAfter.length === planeBefore.length + 1,
    `clicking it inserts at the first gap that accepts it (${planeAfter.join(', ')})`);

  // The library commits the same one-for-one replacement a socket's swap does,
  // so re-picking the projection the chain already carries must keep that
  // instance rather than re-seat it on the catalog's defaults.
  const socket = await tab.$eval('.chain-chip--socket',
    (node) => (node instanceof HTMLElement ? node.dataset.label ?? '' : ''));
  await (await tab.waitForSelector('.chain-chip--socket .chain-chip-name')).click();
  const poleFade = `.chain-chip--socket .chain-param[data-parameter="${socket}.pole-fade"]`
    + ' .chain-param-control';
  const pole = await boxOf(tab, poleFade);
  await tab.mouse.click(pole.x + pole.width * SLIDER_FRACTION, centre(pole).y);
  const poleFadeOf = (/** @type {*} */ saved) =>
    saved.preset_bank.presets[0].values[`${socket}.pole-fade`];
  const tuned = poleFadeOf(await savedDocument(tab));
  check(tuned > 1, `the socket's pole fade tunes off its default (${socket} ${tuned})`);

  await (await tab.waitForSelector(gnomonic)).click();
  const kept = await tab.$eval('.chain-chip--socket',
    (node) => (node instanceof HTMLElement ? node.dataset.label ?? '' : ''));
  const keptFade = poleFadeOf(await savedDocument(tab));
  check(kept === socket && keptFade === tuned,
    `re-picking the projection it carries keeps the socket (${socket} → ${kept},`
    + ` pole fade ${keptFade})`);

  return failures;
}

let executablePath;
try {
  executablePath = resolveBrowser();
} catch (error) {
  console.error(`workbench-probe: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

console.log(`workbench-probe: ${PAGE}, ${executablePath}`);

const site = await serveManifest(manifestEntries());
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: BROWSER_ARGS,
});

let failures = [];
try {
  const tab = await browser.newPage();
  await tab.setViewport(VIEWPORT);
  tab.on('pageerror', (error) => failures.push(`uncaught: ${error.message}`));
  await tab.goto(`${site.origin}/${PAGE}`, { timeout: LOAD_TIMEOUT_MS });
  await tab.waitForFunction(() => !document.getElementById('loading-overlay'),
    { timeout: READY_TIMEOUT_MS });
  await tab.waitForSelector('.chain-chip', { timeout: READY_TIMEOUT_MS });
  failures = [...failures, ...await probeStrip(tab)];
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
  await site.close();
}

if (failures.length > 0) {
  console.error(`workbench-probe: ${failures.length} checks failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('workbench-probe: every pipeline-strip gesture behaved.');
