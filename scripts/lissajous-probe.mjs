/*
 * Drives the Lissajous tool's rational lock in headless Chrome, over the same
 * manifest server scripts/browser-smoke.mjs uses.
 *
 *   node scripts/lissajous-probe.mjs
 *
 * The lock couples three controls: the checkbox, the frequency slider the
 * pointer is on, and the Domain slider it disables and then drives from the
 * snapped ratio. Only a real browser closes that loop, and tests/fake_dom.js
 * reaches no part of it: a range input turns a pointer x into a value through
 * its own layout, which the fake has none of, and it is the UA — not the page —
 * that refuses input on a disabled control. This job drags each frequency thumb
 * with a real mouse and requires what the page exports to be a closed curve:
 * C1/C2 an exact simple rational, and the domain the period that ratio closes
 * on.
 */
import puppeteer from 'puppeteer-core';

import { manifestEntries } from '../tests/site_pages.js';
import { BROWSER_ARGS, resolveBrowser } from './browser.mjs';
import { serveManifest } from './serve-manifest.mjs';

const PAGE = 'tools/lissajous.html';
// Somewhere else on the origin to leave for, carrying no script of its own.
const AWAY = 'tools/tools.css';
const VIEWPORT = { width: 1280, height: 900 };
const TIMEOUT_MS = 90_000;
const TWO_PI = 2 * Math.PI;
const LOCK = '#rational_lock';
const CODE = '#lissajous_code_output';
const WARNING = '#domain_closure_warning';
const DOMAIN_SLIDER = '#Duration_slider';
const DOMAIN_GROUP = '#Duration_container';
const DOMAIN_READOUT = '#Duration_value';
const DRAG_STEPS = 8;
// Largest numerator and denominator the ratio search admits, and the frequency
// sliders' range; tools/lissajous_math.js and tools/lissajous_page.js own them.
const MAX_RATIONAL_TERM = 8;
const FREQUENCY_RANGE = { min: 1, max: 100 };
// The exported literals are float32 round-trips, so a snapped ratio matches to
// far inside this, while distinct fractions of terms <= 8 stand 1/56 apart.
const RATIO_EPSILON = 1e-4;
// The Domain control's step, in radians: its readout sits on that grid while the
// exported domain is the unrounded period.
const DOMAIN_STEP = TWO_PI / 500;

/**
 * The parameters the page exports, at the snippet's full precision, once the
 * frame its rebuild was scheduled on has run.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @returns {Promise<{c1: number, c2: number, a: number, domain: number}>} The four fields.
 */
async function exported(tab) {
  await tab.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const text = await tab.$eval(CODE, (node) => node.textContent ?? '');
  const body = /^LissajousParams\{(.*)\}$/.exec(text)?.[1];
  if (body === undefined) throw new Error(`the export snippet reads "${text}"`);
  const [c1, c2, a, domain] = body.split(',').map((field) => {
    // An exact multiple of the period is emitted against PI_F, not as a decimal.
    const multiple = /^\s*(-?\d+) \* PI_F\s*$/.exec(field);
    return multiple ? Number(multiple[1]) * Math.PI : parseFloat(field);
  });
  return { c1, c2, a, domain };
}

/**
 * The simple rational the two frequencies stand in, in lowest terms.
 * @param {number} c1 - Frequency C1.
 * @param {number} c2 - Frequency C2.
 * @returns {?{m: number, n: number}} C1/C2 as m/n, or null when it is no such ratio.
 */
function rationalRatio(c1, c2) {
  const ratio = c1 / c2;
  for (let n = 1; n <= MAX_RATIONAL_TERM; n++) {
    for (let m = 1; m <= MAX_RATIONAL_TERM; m++) {
      if (Math.abs(ratio - m / n) <= RATIO_EPSILON) return { m, n };
    }
  }
  return null;
}

/**
 * Walks a real mouse across a control's track, between two fractions of its box.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @param {string} selector - The control to drag.
 * @param {number} from - Where the press lands, as a fraction of the width.
 * @param {number} to - Where the release lands.
 * @returns {Promise<void>}
 */
async function dragTrack(tab, selector, from, to) {
  await tab.$eval(selector, (node) => node.scrollIntoView({ block: 'center' }));
  const box = await (await tab.$(selector)).boundingBox();
  if (!box) throw new Error(`${selector} has no layout box`);
  const y = box.y + box.height / 2;
  // Held a pixel inside the box, so an endpoint fraction still hits the control.
  const at = (fraction) =>
    box.x + Math.min(box.width - 1, Math.max(1, box.width * fraction));
  await tab.mouse.move(at(from), y);
  await tab.mouse.down();
  for (let i = 1; i <= DRAG_STEPS; i++) {
    await tab.mouse.move(at(from + ((to - from) * i) / DRAG_STEPS), y);
  }
  await tab.mouse.up();
}

/**
 * @param {import('puppeteer-core').Page} tab - The page.
 * @returns {Promise<string[]>} One entry per failed check.
 */
async function probeRationalLock(tab) {
  const failures = [];
  const check = (ok, message) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
  };

  /**
   * Requires the exported curve to close: the ratio the lock promises, the
   * period that ratio closes on, and both frequencies still on their sliders.
   * @param {{c1: number, c2: number, domain: number}} params - What the page exports.
   * @param {string} subject - What produced them, for the check messages.
   */
  const requireClosed = (params, subject) => {
    const ratio = rationalRatio(params.c1, params.c2);
    check(ratio !== null,
      `${subject} leaves C1/C2 a simple rational (${params.c1}/${params.c2})`);
    if (!ratio) return;
    // 2*PI*n/c2 and 2*PI*m/c1 are the same period, so this holds whichever
    // frequency the pointer was on.
    const period = (TWO_PI * ratio.n) / params.c2;
    check(Math.abs(params.domain - period) <= 1e-3 * period,
      `${subject} sets the domain ${ratio.m}/${ratio.n} closes on `
        + `(${params.domain.toFixed(4)} for ${period.toFixed(4)})`);
    const inRange = (c) => c >= FREQUENCY_RANGE.min && c <= FREQUENCY_RANGE.max;
    check(inRange(params.c1) && inRange(params.c2),
      `${subject} keeps both frequencies on their sliders (${params.c1}, ${params.c2})`);
  };

  const disabled = () => tab.$eval(DOMAIN_SLIDER, (node) => node.disabled);
  const dimmed = () =>
    tab.$eval(DOMAIN_GROUP, (node) => node.classList.contains('opacity-50'));
  const warned = async () =>
    !await tab.$eval(WARNING, (node) => node.classList.contains('hidden'));

  const track = await (await tab.$('#C1_slider')).boundingBox();
  if (!track) throw new Error('the C1 slider has no layout box');
  check(track.width > 0 && track.height > 0,
    `the C1 slider lays out ${Math.round(track.width)}x${Math.round(track.height)}`);

  const opening = await exported(tab);
  check(opening.c1 === 12 && opening.c2 === 5,
    `the page opens on C1 ${opening.c1}, C2 ${opening.c2}`);
  check(!await disabled(), 'the Domain slider takes input while the lock is off');

  // Control 1, the checkbox: it snaps the frequency the page is already on and
  // hands the Domain control over to the period that snap closes on.
  await tab.click(LOCK);
  check(await disabled(), 'the lock disables the Domain slider');
  check(await dimmed(), 'the lock dims the Domain control');
  const locked = await exported(tab);
  check(locked.c1 !== opening.c1,
    `the lock snaps C1 off ${opening.c1} (${locked.c1})`);
  requireClosed(locked, 'the lock');
  check(!await warned(), 'a locked curve raises no closure warning');

  // Control 2, a frequency slider under a real pointer: every input event on the
  // drag re-snaps the ratio and recomputes the domain from it.
  await dragTrack(tab, '#C1_slider', 0.2, 0.55);
  const draggedC1 = await exported(tab);
  check(draggedC1.c1 !== locked.c1,
    `the C1 drag moves the frequency (${locked.c1} to ${draggedC1.c1})`);
  requireClosed(draggedC1, 'the C1 drag');
  check(draggedC1.domain !== locked.domain,
    `the C1 drag drives the disabled Domain control (${draggedC1.domain.toFixed(4)})`);
  const shown = Number(await tab.$eval(DOMAIN_READOUT, (node) => node.textContent));
  check(Math.abs(shown - draggedC1.domain) <= DOMAIN_STEP,
    `the Domain readout follows the computed period (${shown})`);

  // The other frequency: the held side flips to C1, and the domain is recomputed
  // against it.
  await dragTrack(tab, '#C2_slider', 0.2, 0.9);
  const draggedC2 = await exported(tab);
  check(draggedC2.c2 !== draggedC1.c2,
    `the C2 drag moves the frequency (${draggedC1.c2} to ${draggedC2.c2})`);
  requireClosed(draggedC2, 'the C2 drag');

  // Control 3, the Domain slider: while the lock holds it, the refusal is the
  // UA's, so a real pointer on its track is what tests it.
  await dragTrack(tab, DOMAIN_SLIDER, 0.2, 0.8);
  const refused = await exported(tab);
  check(refused.domain === draggedC2.domain,
    `dragging the disabled Domain slider changes nothing (${refused.domain.toFixed(4)})`);

  // Releasing the lock hands the domain back. Dragging it to the floor cannot
  // close any curve, so the warning the export carries has to come up.
  await tab.click(LOCK);
  check(!await disabled(), 'unlocking re-enables the Domain slider');
  check(!await dimmed(), 'unlocking undims the Domain control');
  await dragTrack(tab, DOMAIN_SLIDER, 0.8, 0);
  const free = await exported(tab);
  check(free.domain === 0,
    `the unlocked Domain slider takes the pointer to its floor (${free.domain})`);
  check(free.c1 === refused.c1 && free.c2 === refused.c2,
    'the Domain drag leaves the frequencies alone');
  check(await warned(), 'an open domain raises the closure warning');
  const text = await tab.$eval(WARNING, (node) => node.textContent ?? '');
  check(text.includes('does not close') && text.includes('0.000'),
    `the warning names the domain it is about ("${text.slice(0, 40)}")`);

  return failures;
}

/**
 * Locks the curve, leaves the page, and comes back over a restore that re-runs
 * the module, requiring the lock checkbox to come back off. A browser carries a
 * form control's state across a history navigation on its own, so a checkbox it
 * restores lands in a module that has started over from its own initial state,
 * and the page then reads locked while it behaves unlocked. Only the browser
 * writes that state and nothing in the DOM records it, so this is a case no
 * fake DOM has to answer for. The bfcache is off for this run (see the launch
 * args): a restore that hits it brings the module's state back with the DOM,
 * and it is the miss that can split the two.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @param {string} origin - The site the manifest server is on.
 * @returns {Promise<string[]>} One entry per failed check.
 */
async function probeHistoryRestore(tab, origin) {
  const failures = [];
  const check = (ok, message) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
  };

  await tab.evaluateOnNewDocument(() => {
    window.addEventListener(
      'pageshow', (event) => { window.probeFromCache = event.persisted; });
  });
  await tab.goto(`${origin}/${PAGE}`, { timeout: TIMEOUT_MS });
  await tab.waitForSelector('#C1_slider', { visible: true, timeout: TIMEOUT_MS });
  await tab.click(LOCK);
  await tab.goto(`${origin}/${AWAY}`, { timeout: TIMEOUT_MS });
  await tab.goBack({ waitUntil: 'load', timeout: TIMEOUT_MS });
  await tab.waitForSelector('#C1_slider', { visible: true, timeout: TIMEOUT_MS });

  const cached = await tab.evaluate(() => window.probeFromCache);
  check(cached === false, `the restore re-ran the module (persisted ${cached})`);
  const checked = await tab.$eval(LOCK, (node) => node.checked);
  const held = await tab.$eval(DOMAIN_SLIDER, (node) => node.disabled);
  const dim = await tab.$eval(DOMAIN_GROUP,
    (node) => node.classList.contains('opacity-50'));
  check(!checked, `the restore leaves the lock off, as the module has it (${checked})`);
  check(checked === held,
    `the restored checkbox and the Domain slider agree (checked ${checked}, `
      + `held ${held})`);
  check(checked === dim,
    `the restored checkbox and the Domain dimming agree (checked ${checked}, `
      + `dimmed ${dim})`);

  return failures;
}

let executablePath;
try {
  executablePath = resolveBrowser();
} catch (error) {
  console.error(`lissajous-probe: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

console.log(`lissajous-probe: ${PAGE}, ${executablePath}`);
const site = await serveManifest(manifestEntries());
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  // Without the bfcache, going back always re-runs the page's modules, which is
  // the restore probeHistoryRestore is about; nothing else here navigates.
  args: [...BROWSER_ARGS, '--disable-features=BackForwardCache'],
});

const failures = [];
try {
  const tab = await browser.newPage();
  await tab.setViewport(VIEWPORT);
  tab.on('pageerror', (error) => failures.push(`uncaught: ${error.message}`));
  await tab.goto(`${site.origin}/${PAGE}`, { timeout: TIMEOUT_MS });
  // The sliders are built by the page's init, before the scene goes up.
  await tab.waitForSelector('#C1_slider', { visible: true, timeout: TIMEOUT_MS });
  failures.push(...await probeRationalLock(tab));
  failures.push(...await probeHistoryRestore(tab, site.origin));
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
  await site.close();
}

if (failures.length > 0) {
  console.error(`lissajous-probe: ${failures.length} checks failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('lissajous-probe: the rational lock closes the curve under a real pointer.');
