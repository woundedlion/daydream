/*
 * Exercises the shader workbench's pipeline controls in headless Chrome over
 * the same manifest server scripts/browser-smoke.mjs uses.
 *
 *   node scripts/workbench-probe.mjs
 */
import puppeteer from 'puppeteer-core';

import { manifestEntries } from '../tests/site_pages.js';
import { BROWSER_ARGS, resolveBrowser } from './browser.mjs';
import { serveManifest } from './serve-manifest.mjs';

const PAGE = 'tools/shader.html';
const VIEWPORT = { width: 1674, height: 543 };
const TIMEOUT_MS = 90_000;
const SLIDER_FRACTION = 0.75;
// A fraction of a domain that lands on no round step grid.
const OFF_GRID_FRACTION = 0.3170159;
const VALUE_TOLERANCE = 1e-4;

/** @param {import('puppeteer-core').Page} tab @param {string} selector */
async function boxOf(tab, selector) {
  const handle = await tab.waitForSelector(selector, { timeout: TIMEOUT_MS });
  const box = await handle.boundingBox();
  if (box === null) throw new Error(`${selector} has no layout box`);
  return box;
}

/** @param {{x: number, y: number, width: number, height: number}} box */
const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/**
 * @param {{x: number, y: number, width: number, height: number}} a
 * @param {{x: number, y: number, width: number, height: number}} b
 */
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;

/** @param {import('puppeteer-core').Page} tab @param {string} carrier */
const bandChipNames = (tab, carrier) => tab.$$eval(
  `.chain-band[data-carrier="${carrier}"] .chain-chip-name`,
  (nodes) => nodes.map((node) => node.textContent ?? ''));

/** @param {import('puppeteer-core').Page} tab */
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

/** @param {import('puppeteer-core').Page} tab */
async function probeStrip(tab) {
  const failures = [];
  const check = (ok, message) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
  };

  check(await tab.$('#chain-library') === null,
    'the stage bank is absent');
  check(await tab.$('.chain-gap') === null,
    'the pipeline exposes no drag/drop targets');
  check(await tab.$('#gui-container > .effect-gui') === null,
    'the local effect panel is absent');
  check(await tab.$('#gui-container > .global-gui') !== null,
    'global controls remain mounted');

  const initialStages = await tab.$$eval('.chain-chip[aria-expanded]', (nodes) => nodes.map(
    (node) => ({ expanded: node.getAttribute('aria-expanded'),
      controls: getComputedStyle(node.querySelector('.chain-chip-params')).display })));
  check(initialStages.length > 0
      && initialStages.every((stage) => stage.expanded === 'false'
        && stage.controls === 'none'),
  `${initialStages.length} stage cards start as single collapsed header rows`);
  const minimalHeaders = await tab.evaluate(() => {
    const rotate = document.querySelector('.chain-chip[data-label="rotate"]');
    const project = document.querySelector('.chain-chip[data-label="project"]');
    return {
      icons: [...rotate.querySelectorAll('.chain-chip-header button')]
        .map((button) => button.textContent),
      rotateLabel: getComputedStyle(rotate.querySelector('.chain-chip-label')).display,
      projectLabel: getComputedStyle(project.querySelector('.chain-chip-label')).display,
      projectSelector: getComputedStyle(
        project.querySelector('.chain-chip-function-label')).display,
    };
  });
  check(minimalHeaders.icons.join('') === '◉←→×'
      && minimalHeaders.rotateLabel === 'none'
      && minimalHeaders.projectLabel === 'none'
      && minimalHeaders.projectSelector === 'none',
  'closed cards show only the operation and legal icon controls');
  check(await tab.$('.chain-band[data-carrier="color"] .chain-band-add') === null,
    'a domain with no valid stages has no inert + button');

  const hoverHeader = '.chain-chip[data-label="project"] .chain-chip-header';
  const closedCard = await boxOf(tab, '.chain-chip[data-label="project"]');
  await (await tab.waitForSelector(hoverHeader)).hover();
  await tab.waitForFunction(() => document.querySelector(
    '.chain-chip[data-label="project"]')?.getAttribute('aria-expanded') === 'true');
  const hoverCard = await boxOf(tab, '.chain-chip[data-label="project"]');
  check(hoverCard.width > closedCard.width,
    `an open card expands from ${Math.round(closedCard.width)}px to ${Math.round(hoverCard.width)}px`);
  check(await tab.$eval('.chain-chip[data-label="project"]', (node) =>
    getComputedStyle(node.querySelector('.chain-chip-label')).display !== 'none'
      && getComputedStyle(node.querySelector('.chain-chip-function-label')).display !== 'none'),
  'an open card restores its full header metadata');
  await tab.mouse.move(0, 0);
  await tab.waitForFunction(() => document.querySelector(
    '.chain-chip[data-label="project"]')?.getAttribute('aria-expanded') === 'false');
  check(true, 'mouse leave closes a transient stage card');

  await (await tab.waitForSelector(hoverHeader)).click();
  await tab.mouse.move(0, 0);
  check(await tab.$eval('.chain-chip[data-label="project"]',
    (node) => node.getAttribute('aria-expanded') === 'true'),
  'click pins a stage card open after mouse leave');
  await (await tab.waitForSelector(hoverHeader)).click();
  check(await tab.$eval('.chain-chip[data-label="project"]',
    (node) => node.getAttribute('aria-expanded') === 'false'),
  'clicking a pinned stage header closes it');

  const collapsedDomain = await tab.$eval('.chain-band[data-carrier="sphere"]', (node) => ({
    band: node.getBoundingClientRect().height,
    frame: Number.parseFloat(getComputedStyle(node, '::before').height),
  }));
  await (await tab.waitForSelector(
    '.chain-chip[data-label="rotate"] .chain-chip-header')).hover();
  await tab.waitForFunction(() => document.querySelector(
    '.chain-chip[data-label="rotate"]')?.getAttribute('aria-expanded') === 'true');
  const openDomain = await tab.$eval('.chain-band[data-carrier="sphere"]', (node) => ({
    band: node.getBoundingClientRect().height,
    frame: Number.parseFloat(getComputedStyle(node, '::before').height),
  }));
  check(openDomain.band > collapsedDomain.band
      && Math.abs(openDomain.frame - collapsedDomain.frame) < 1,
  `an open stage leaves the domain frame at ${Math.round(openDomain.frame)}px`);
  await tab.mouse.move(0, 0);

  const layout = await tab.evaluate(() => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top,
        bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const chipBoxes = [...document.querySelectorAll('.chain-chip')].map(box);
    const contained = [...document.querySelectorAll('.chain-band > .chain-chip')]
      .every((chip) => {
        const child = chip.getBoundingClientRect();
        const parent = chip.parentElement.getBoundingClientRect();
        return child.left >= parent.left && child.right <= parent.right;
      });
    const separate = chipBoxes.every((chip, index) => chipBoxes.slice(index + 1)
      .every((other) => chip.right <= other.left || other.right <= chip.left
        || chip.bottom <= other.top || other.bottom <= chip.top));
    return {
      chipBoxes,
      contained,
      separate,
      strip: box(document.getElementById('chain-strip')),
      main: box(document.querySelector('.main-area')),
      stripOpacity: getComputedStyle(document.getElementById('chain-strip')).opacity,
      stripPosition: getComputedStyle(document.getElementById('chain-strip')).position,
    };
  });
  check(layout.contained && layout.separate,
    'stage cards stay inside their bands without overlapping');
  check(layout.chipBoxes.every((box) => box.width <= 320),
    'collapsed stage headers have a compact, bounded width');
  check(layout.stripPosition === 'absolute'
      && Math.abs(layout.strip.top - layout.main.top) < 1
      && Number(layout.stripOpacity) === 0.9,
  'the pipeline overlays the preview at 90% opacity');
  check(layout.main.height > VIEWPORT.height * 0.8,
    `the preview retains ${Math.round(layout.main.height)}px beneath the pipeline`);

  // A `<input type=range>` re-snaps its value onto its step grid, and a fake DOM
  // does not: only a real browser shows whether an authored value survives being
  // written to the control it is edited through.
  const held = await tab.$$eval('.chain-param-control[type="range"]', (nodes, fraction) => nodes
    .filter((node) => node instanceof HTMLInputElement)
    .map((node) => {
      const minimum = Number(node.min);
      const probe = minimum + (Number(node.max) - minimum) * fraction;
      const authored = node.value;
      node.value = String(probe);
      const kept = Math.abs(Number(node.value) - probe) <= Math.abs(probe) * 1e-6;
      node.value = authored;
      const row = node.closest('.chain-param');
      return { kept, parameter: row instanceof HTMLElement ? row.dataset.parameter ?? '' : '' };
    }), OFF_GRID_FRACTION);
  const snapped = held.filter((entry) => !entry.kept).map((entry) => entry.parameter);
  check(held.length > 0 && snapped.length === 0,
    `${held.length} inline sliders hold an off-grid value unsnapped`
      + (snapped.length > 0 ? ` (${snapped.join(', ')} re-snapped)` : ''));

  const add = '.chain-band[data-carrier="plane"] .chain-band-add';
  await (await tab.waitForSelector(add)).click();
  const choices = await tab.$$eval('.chain-palette-entry', (nodes) => nodes.map((node) => ({
    operator: node instanceof HTMLElement ? node.dataset.operator ?? '' : '',
    disabled: node.getAttribute('aria-disabled'),
  })));
  check(choices.length > 0 && choices.every((choice) => choice.disabled === null),
    `the + menu contains ${choices.length} valid choices and no disabled rows`);
  check(!choices.some((choice) => choice.operator === 'sphere.rotate.v2'),
    'the plane + menu omits an invalid sphere stage');
  await (await tab.waitForSelector(
    '.chain-palette-entry[data-operator="warp.wave-shear.v2"]')).click();
  check((await bandChipNames(tab, 'plane')).includes('Wave Shear'),
    'the + menu inserts its selected stage');

  // A palette that survives a press elsewhere outlives the chain it was opened
  // over; the fake DOM models neither the press nor the focus move.
  await (await tab.waitForSelector(add)).click();
  check(await tab.$eval('.chain-palette .chain-palette-entry',
    (node) => node.getAttribute('aria-selected')) === 'true',
  'the opened palette marks its focused option selected');
  const elsewhere = await boxOf(tab,
    '.chain-band[data-carrier="sphere"] .chain-band-title');
  check(!overlaps(await boxOf(tab, '.chain-palette'), elsewhere),
    'the dismissal target sits clear of the open palette');
  await tab.mouse.click(centre(elsewhere).x, centre(elsewhere).y);
  check(await tab.$('.chain-palette') === null,
    'a press outside the palette dismisses it');

  const source = '.chain-chip-replace[aria-label="Source function"]';
  const sourceChoices = await tab.$eval(source, (node) => ({
    label: node.getAttribute('aria-label'),
    values: node instanceof HTMLSelectElement
      ? [...node.options].map((option) => option.value) : [],
  }));
  check(sourceChoices.label === 'Source function'
      && sourceChoices.values.every((value) => value.startsWith('sample.')),
  `the Source function selector offers ${sourceChoices.values.length} sampling stages`);
  await tab.select(source, 'sample.rings.v2');
  check(await tab.$eval(source, (node) => node instanceof HTMLSelectElement
    && node.value === 'sample.rings.v2'),
  'the source function changes directly from its selector');

  const sphereBandBefore = await boxOf(tab, '.chain-band[data-carrier="sphere"]');
  await (await tab.waitForSelector(
    '.chain-band[data-carrier="sphere"] .chain-band-add')).click();
  await (await tab.waitForSelector(
    '.chain-palette-entry[data-operator="sphere.lens.twist.v2"]')).click();
  const sphereBandAfter = await boxOf(tab, '.chain-band[data-carrier="sphere"]');
  check(sphereBandAfter.width > sphereBandBefore.width,
    `adding a stage widens its domain (${Math.round(sphereBandBefore.width)}px → ${Math.round(sphereBandAfter.width)}px)`);
  const sphereBefore = await bandChipNames(tab, 'sphere');
  const moveLater = '.chain-band[data-carrier="sphere"]'
    + ' .chain-chip-move[aria-label$="later"]:not(:disabled)';
  await (await tab.waitForSelector(moveLater)).click();
  const sphereAfter = await bandChipNames(tab, 'sphere');
  check(sphereAfter.join() === [...sphereBefore].reverse().join(),
    `reorder buttons move stages (${sphereAfter.join(', ')})`);

  const track = '.chain-chip[data-label="rotate"]'
    + ' .chain-param[data-parameter="rotate.wander"] .chain-param-control';
  await (await tab.waitForSelector(
    '.chain-chip[data-label="rotate"] .chain-chip-name')).click();
  const slider = await boxOf(tab, track);
  await tab.mouse.click(slider.x + slider.width * SLIDER_FRACTION, centre(slider).y);
  const shown = Number(await tab.$eval(track, (node) => node.value));
  const stored = (await savedDocument(tab)).preset_bank.presets[0].values['rotate.wander'];
  check(Math.abs(stored - shown) < VALUE_TOLERANCE,
    `an inline control saves its value (${stored})`);

  const animation = await tab.$eval('#shader-animation-toggle', (node) => ({
    disabled: node instanceof HTMLButtonElement ? node.disabled : true,
    text: node.textContent ?? '',
  }));
  check(!animation.disabled && animation.text === 'Pause animation',
    `animation is running after preset/control writes (${animation.text})`);

  const panels = await boxOf(tab, '#gui-container');
  for (const region of ['#shader-toolbar']) {
    const box = await boxOf(tab, region);
    check(!overlaps(panels, box), `global controls clear ${region}`);
  }
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
  await tab.goto(`${site.origin}/${PAGE}`, { timeout: TIMEOUT_MS });
  await tab.waitForFunction(() => !document.getElementById('loading-overlay'),
    { timeout: TIMEOUT_MS });
  await tab.waitForSelector('.chain-chip', { timeout: TIMEOUT_MS });
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
console.log('workbench-probe: every pipeline control behaved.');
