/*
 * The scaffolding every scripts/*-probe.mjs runs on: the manifest server and
 * browser one probe drives, the collector every tab is watched through, and the
 * pointer helpers the gestures are made of.
 */
import puppeteer from 'puppeteer-core';

import { BROWSER_ARGS, resolveBrowser } from './browser.mjs';
import { serveStagedSite } from './vendor-stage.mjs';

/**
 * @param {unknown} error - Whatever was thrown.
 * @returns {string} Its message.
 */
const reason = (error) => (error instanceof Error ? error.message : String(error));

/**
 * A verdict sink: one console line per check, and the misses kept for the
 * probe's own report.
 * @returns {{failures: string[], check: (ok: boolean, message: string) => void}}
 *   The collected failures and the recorder that fills them.
 */
export function checks() {
  /** @type {string[]} */
  const failures = [];
  return {
    failures,
    check(ok, message) {
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
      if (!ok) failures.push(message);
    },
  };
}

/**
 * @param {{x: number, y: number, width: number, height: number}} box - A layout box.
 * @returns {{x: number, y: number}} Its middle, in viewport coordinates.
 */
export const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/**
 * The laid-out box of one element, once it is in the document.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @param {string} selector - The element to measure.
 * @returns {Promise<{x: number, y: number, width: number, height: number}>} Its box.
 * @throws {Error} When the element never lays one out.
 */
export async function boxOf(tab, selector) {
  const handle = await tab.waitForSelector(selector);
  const box = await handle?.boundingBox();
  if (!box) throw new Error(`${selector} has no layout box`);
  return box;
}

/**
 * Walks a pointer from one viewport point to another without pressing it.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @param {{x: number, y: number}} from - Where the walk starts.
 * @param {{x: number, y: number}} to - Where it ends.
 * @param {number} [steps] - Moves the path is delivered in.
 * @returns {Promise<void>}
 */
export async function walkTo(tab, from, to, steps = 12) {
  for (let i = 1; i <= steps; i++) {
    await tab.mouse.move(from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps);
  }
}

/**
 * One press-walk-release gesture between two viewport points.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @param {{x: number, y: number}} from - Where the press lands.
 * @param {{x: number, y: number}} to - Where the release lands.
 * @param {{steps?: number, touch?: boolean, pressed?: () => Promise<void>}} [options] -
 *   Path resolution, whether to drive the touchscreen rather than the mouse, and
 *   a hook that runs with the pointer still down at `from`.
 * @returns {Promise<void>}
 */
export async function dragBetween(tab, from, to, options = {}) {
  const { steps = 12, touch = false, pressed } = options;
  if (touch) {
    const finger = await tab.touchscreen.touchStart(from.x, from.y);
    if (pressed) await pressed();
    for (let i = 1; i <= steps; i++) {
      await finger.move(from.x + ((to.x - from.x) * i) / steps,
        from.y + ((to.y - from.y) * i) / steps);
    }
    await finger.end();
    return;
  }
  await tab.mouse.move(from.x, from.y);
  await tab.mouse.down();
  if (pressed) await pressed();
  await walkTo(tab, from, to, steps);
  await tab.mouse.up();
}

/**
 * @param {import('puppeteer-core').Page} tab - The tab to watch.
 * @param {string[]} problems - Takes one line per problem the page raises.
 * @returns {void}
 */
function collectProblems(tab, problems) {
  tab.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
}

/**
 * Runs one probe over a manifest server and a browser of its own, reports
 * everything that failed, and exits the process on the verdict.
 * @param {Object} probe - The probe to run.
 * @param {string} probe.name - Its name, which every line it prints is tagged with.
 * @param {string} probe.page - Repo-relative page the probe opens by default.
 * @param {number} probe.timeoutMs - Ceiling every wait and navigation is held to.
 * @param {string[]} [probe.args] - Browser flags; the shared set by default.
 * @param {string} probe.success - What the run proved, printed when nothing failed.
 * @param {(context: {origin: string, open: (options?: {viewport?: Object,
 *   page?: string, prepare?: (tab: import('puppeteer-core').Page) => Promise<void>}) =>
 *   Promise<import('puppeteer-core').Page>}) => Promise<string[]>} probe.run -
 *   Drives the page and returns one entry per failed check.
 * @returns {Promise<void>} Resolves only on a clean run; a failed one exits 1.
 */
export async function runProbe({ name, page, timeoutMs, args = BROWSER_ARGS, success, run }) {
  let executablePath;
  try {
    executablePath = resolveBrowser();
  } catch (error) {
    console.error(`${name}: ${reason(error)}`);
    process.exit(1);
  }

  console.log(`${name}: ${page}, ${executablePath}`);
  let site = null;
  let browser = null;
  const failures = [];
  try {
    site = await serveStagedSite();
    browser = await puppeteer.launch({ executablePath, headless: true, args });
    const origin = site.origin;
    const open = async ({ viewport, page: path = page, prepare } = {}) => {
      const tab = await browser.newPage();
      tab.setDefaultTimeout(timeoutMs);
      if (viewport) await tab.setViewport(viewport);
      if (prepare) await prepare(tab);
      collectProblems(tab, failures);
      await tab.goto(`${origin}/${path}`, { timeout: timeoutMs });
      return tab;
    };
    failures.push(...await run({ origin, open }));
  } catch (error) {
    failures.push(reason(error));
  } finally {
    await browser?.close();
    await site?.close();
  }

  if (failures.length > 0) {
    console.error(`${name}: ${failures.length} checks failed:`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`${name}: ${success}`);
}
