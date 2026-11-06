/*
 * The scaffolding every scripts/*-probe.mjs runs on: the manifest server and
 * browser one probe drives, the collector every tab is watched through, and the
 * pointer helpers the gestures are made of.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import puppeteer from 'puppeteer-core';

import { BROWSER_ARGS, resolveBrowser } from './browser.mjs';
import { serveStagedSite } from './vendor-stage.mjs';

/**
 * @param {unknown} error - Whatever was thrown.
 * @returns {string} Its message.
 */
const reason = (error) => (error instanceof Error ? error.message : String(error));
const pendingRequests = new WeakMap();

/**
 * Reports the failed phase and a bounded snapshot of the page.
 * @param {import('puppeteer-core').Page|undefined} tab
 * @param {string} phase
 * @param {unknown} error
 * @returns {Promise<string>}
 */
export async function describeProbeFailure(tab, phase, error) {
  let timer;
  let state;
  try {
    if (!tab) throw new Error('page was not opened');
    state = await Promise.race([
      tab.evaluate(() => {
        const text = (id) => document.getElementById(id)?.textContent?.slice(0, 240) ?? null;
        return {
          path: location.pathname,
          ready: document.readyState,
          visibility: document.visibilityState,
          focused: document.hasFocus(),
          overlay: text('loading-overlay'),
          status: text('shader-document-status'),
          statusKind: document.getElementById('shader-document-status')?.dataset.status ?? null,
          error: text('shader-document-error'),
          guiChildren: document.getElementById('gui-container')?.children.length ?? 0,
          globalGuiChildren: document.querySelector('.global-gui')?.children.length ?? 0,
          canvases: [...document.querySelectorAll('canvas')].slice(0, 4)
            .map((canvas) => ({width: canvas.width, height: canvas.height,
              clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight})),
          chips: [...document.querySelectorAll('.chain-chip')].slice(0, 16)
            .map((chip) => chip.dataset.label),
          undoDisabled: document.querySelector('.chain-undo')?.disabled ?? null,
          hash: location.hash.slice(0, 24),
          hashLength: location.hash.length,
          draws: window.daydreamSmokeDraws ?? null,
          glDraws: window.daydreamSmokeGlDraws ?? null,
          glPixels: window.daydreamSmokeGlPixels ?? null,
          resources: performance.getEntriesByType('resource').slice(-20)
            .map((entry) => ({path: new URL(entry.name).pathname.slice(0, 160),
              duration: Math.round(entry.duration), transfer: entry.transferSize,
              type: entry.initiatorType})),
        };
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('page state timed out after 1000ms'), 1000);
      }),
    ]);
  } catch (captureError) {
    state = `page state unavailable: ${reason(captureError).slice(0, 240)}`;
  } finally {
    clearTimeout(timer);
  }
  const snapshot = typeof state === 'object' ? state : {capture: state};
  snapshot.pendingRequests = [...(pendingRequests.get(tab)?.values() ?? [])].slice(0, 20);
  return `${phase}: ${reason(error)}; state=${JSON.stringify(snapshot)}`;
}

/**
 * @param {string} url - The calling module's import.meta.url.
 * @returns {boolean} Whether node was pointed at that module.
 * @details A probe is a script and a module at once: run directly it drives a
 *   browser, imported by a test it is just its interaction functions.
 */
export function isMain(url) {
  return process.argv[1] !== undefined && url === pathToFileURL(realpathSync(process.argv[1])).href;
}

const checkRuns = new AsyncLocalStorage();

/**
 * A verdict sink: one console line per check, and the misses kept for the
 * probe's own report.
 * @returns {{failures: string[], count: number, check: (ok: boolean, message: string) => void}}
 *   The collected failures and the recorder that fills them.
 */
export function checks() {
  let count = 0;
  /** @type {string[]} */
  const failures = [];
  return {
    failures,
    get count() { return count; },
    check(ok, message) {
      count += 1;
      const run = checkRuns.getStore();
      if (run) run.count += 1;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
      if (!ok) failures.push(message);
    },
  };
}

/**
 * @param {() => Promise<string[]>} run - Probe interactions.
 * @param {number} minimumChecks - Required number of executed checks.
 * @returns {Promise<{failures: string[], count: number}>} The measured verdict.
 */
export async function measureChecks(run, minimumChecks) {
  if (!Number.isInteger(minimumChecks) || minimumChecks < 1)
    throw new Error('minimumChecks must be a positive integer');
  const measurement = { count: 0 };
  const failures = await checkRuns.run(measurement, run);
  if (measurement.count < minimumChecks)
    failures.push(`only ${measurement.count} checks executed; expected at least ${minimumChecks}`);
  return { failures, count: measurement.count };
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
 * The padding box of one element, which boxOf's border box overstates by the
 * border on every side. A canvas' bitmap and an absolutely positioned child's
 * percentages both sit inside the border, so a gesture aimed at a fraction of
 * the border box lands somewhere else on the surface it is scrubbing.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @param {string} selector - The element to measure.
 * @returns {Promise<{x: number, y: number, width: number, height: number}>} Its box.
 * @throws {Error} When the element never lays one out.
 */
export async function paddingBoxOf(tab, selector) {
  await tab.waitForSelector(selector);
  const box = await tab.$eval(selector, (node) => {
    const rect = node.getBoundingClientRect();
    return {
      x: rect.left + node.clientLeft, y: rect.top + node.clientTop,
      width: node.clientWidth, height: node.clientHeight,
    };
  });
  if (!(box.width > 0 && box.height > 0))
    throw new Error(`${selector} has no layout box`);
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
 * @param {{steps?: number, touch?: boolean, pressed?: () => Promise<void>, moved?: () => Promise<void>}} [options] -
 *   Path resolution, whether to drive the touchscreen rather than the mouse, and
 *   a hook that runs with the pointer still down at `from`.
 * @returns {Promise<void>}
 */
export async function dragBetween(tab, from, to, options = {}) {
  const { steps = 12, touch = false, pressed, moved } = options;
  if (touch) {
    const finger = await tab.touchscreen.touchStart(from.x, from.y);
    if (pressed) await pressed();
    for (let i = 1; i <= steps; i++) {
      await finger.move(from.x + ((to.x - from.x) * i) / steps,
        from.y + ((to.y - from.y) * i) / steps);
    }
    if (moved) await moved();
    await finger.end();
    return;
  }
  await tab.mouse.move(from.x, from.y);
  await tab.mouse.down();
  if (pressed) await pressed();
  await walkTo(tab, from, to, steps);
  if (moved) await moved();
  await tab.mouse.up();
}

// Chrome's implicit icon request.
const ABSENT_PATHS = ['favicon.ico'];

/**
 * Watches one tab for everything that went wrong on it: uncaught exceptions,
 * console errors, refused requests and error responses. A page that swallows an
 * exception on every chip render clears every geometric assertion, so the
 * console is as load-bearing as the geometry.
 * @param {import('puppeteer-core').Page} tab - The tab to watch.
 * @param {string} origin - App base URL the manifest server serves under.
 * @param {string[]} problems - Takes one line per problem the page raises.
 * @returns {void}
 */
export function collectProblems(tab, origin, problems) {
  const base = new URL(origin.endsWith('/') ? origin : `${origin}/`);
  const pending = new Map();
  pendingRequests.set(tab, pending);
  tab.on('request', (request) => {
    pending.set(request, new URL(request.url(), base).pathname.slice(0, 160));
  });
  tab.on('requestfinished', (request) => pending.delete(request));
  const absentPaths = new Set([
    '/favicon.ico', ...ABSENT_PATHS.map((path) => new URL(path, base).pathname),
  ]);
  /** @param {string} [href] - Where the problem came from. */
  const absent = (href) => {
    if (href === undefined) return false;
    const url = new URL(href, base);
    return url.origin === base.origin && absentPaths.has(url.pathname);
  };
  tab.on('console', (message) => {
    if (message.type() !== 'error' || absent(message.location()?.url)) return;
    problems.push(`console error: ${message.text()}`);
  });
  tab.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  tab.on('requestfailed', (request) => {
    pending.delete(request);
    if (absent(request.url())) return;
    problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`);
  });
  tab.on('response', (response) => {
    if (response.status() < 400 || absent(response.url())) return;
    problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
}

/**
 * Runs one probe over a manifest server and a browser of its own, reports
 * everything that failed, and exits the process on the verdict.
 * @param {Object} probe - The probe to run.
 * @param {string} probe.name - Its name, which every line it prints is tagged with.
 * @param {string} probe.page - Repo-relative page the probe opens by default.
 * @param {number} probe.timeoutMs - Ceiling every wait and navigation is held to.
 * @param {string[]} [probe.args] - Browser flags; the shared set by default.
 * @param {number} probe.minimumChecks - Minimum number of executed checks.
 * @param {string} probe.success - What the run proved, printed when nothing failed.
 * @param {(context: {origin: string, open: (options?: {viewport?: Object,
 *   page?: string, prepare?: (tab: import('puppeteer-core').Page) => Promise<void>}) =>
 *   Promise<import('puppeteer-core').Page>}) => Promise<string[]>} probe.run -
 *   Drives the page and returns one entry per failed check.
 * @returns {Promise<void>} Resolves only on a clean run; a failed one exits 1.
 */
export async function runProbe({ name, page, timeoutMs, args = BROWSER_ARGS, success, minimumChecks, run }) {
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
      collectProblems(tab, origin, failures);
      await tab.goto(`${origin}/${path}`, { timeout: timeoutMs });
      return tab;
    };
    const result = await measureChecks(() => run({ origin, open }), minimumChecks);
    failures.push(...result.failures);
    console.log(`${name}: ${result.count} checks executed`);
  } catch (error) {
    failures.push(reason(error));
  } finally {
    await closeProbeResources(browser, site, failures);
  }

  if (failures.length > 0) {
    console.error(`${name}: ${failures.length} checks failed:`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`${name}: ${success}`);
}

/**
 * @param {{close: () => Promise<void>}|null} browser
 * @param {{close: () => Promise<void>}|null} site
 * @param {string[]} failures
 * @returns {Promise<void>}
 */
export async function closeProbeResources(browser, site, failures) {
  for (const [name, resource] of [['browser', browser], ['site', site]]) {
    try {
      await resource?.close();
    } catch (error) {
      failures.push(`${name} teardown: ${reason(error)}`);
    }
  }
}
