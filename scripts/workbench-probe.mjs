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
const VIEWPORT = { width: 1400, height: 900 };
const TIMEOUT_MS = 90_000;
const SLIDER_FRACTION = 0.75;
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

  const chips = await tab.$$('.chain-chip');
  const expanded = await tab.$$('.chain-chip-params');
  check(expanded.length > 0 && await tab.$('.chain-chip-disclosure') === null,
    `${expanded.length} stage-control groups stay expanded across ${chips.length} chips`);

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

  await (await tab.waitForSelector(
    '.chain-band[data-carrier="sphere"] .chain-band-add')).click();
  await (await tab.waitForSelector(
    '.chain-palette-entry[data-operator="sphere.lens.twist.v2"]')).click();
  const sphereBefore = await bandChipNames(tab, 'sphere');
  const moveLater = '.chain-band[data-carrier="sphere"]'
    + ' .chain-chip-move[aria-label$="later"]:not(:disabled)';
  await (await tab.waitForSelector(moveLater)).click();
  const sphereAfter = await bandChipNames(tab, 'sphere');
  check(sphereAfter.join() === [...sphereBefore].reverse().join(),
    `reorder buttons move stages (${sphereAfter.join(', ')})`);

  const track = '.chain-chip[data-label="rotate"]'
    + ' .chain-param[data-parameter="rotate.wander"] .chain-param-control';
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
  for (const region of ['#chain-strip', '#shader-toolbar']) {
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
