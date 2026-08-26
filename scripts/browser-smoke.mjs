/*
 * Loads every page site_manifest.txt serves in headless Chrome, over a server
 * that publishes exactly the manifest set, and requires each page to reach a
 * clean console, a painted frame and a quiet network.
 *
 *   node scripts/browser-smoke.mjs
 *
 * The browser and its flags come from scripts/browser.mjs.
 */
import puppeteer from 'puppeteer-core';

import { servedPages } from '../tests/site_pages.js';
import { BROWSER_ARGS, resolveBrowser } from './browser.mjs';
import { serveStagedSite } from './vendor-stage.mjs';

const VIEWPORT = { width: 1280, height: 900 };
const LOAD_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 90_000;

const NETWORK_IDLE_MS = 500;
const NETWORK_IDLE_TIMEOUT_MS = 30_000;

// Paths the served set answers with a 404 by design: Chrome's implicit icon
// fetch on a page that declares none, and the gitignored offline font drop the
// tool pages link behind an onerror fallback to the font CDN.
const ABSENT_PATHS = [/^\/favicon\.ico$/, /^\/vendor\//];

/**
 * Readiness a page must reach beyond a painted frame, evaluated in the page.
 * The app paints its empty scene before the engine is up, so a frame alone would
 * pass over a WASM module that never loaded; it removes the loading overlay once
 * the engine has booted and the first effect applied. Every page that declares
 * `#loading-overlay` runs that startup, so each must clear it.
 */
const enginePainted = () => !document.getElementById('loading-overlay');

/**
 * The palette tool's readiness: it fills the effect-recipe list from the
 * engine's PaletteOps presets, and the markup ships that list holding nothing
 * but its placeholder option.
 */
const paletteRecipesListed = () =>
  (document.getElementById('effect_recipe_preset')?.children.length ?? 0) > 1;

/**
 * The solids tool's readiness: the mesh readout is written once the engine's
 * registry has supplied a solid and the scene has rendered it. Its own draw
 * count reaches one on the reference sphere the scaffold shows before any mesh
 * is built.
 */
const solidMeshBuilt = () =>
  (document.getElementById('meshStats')?.textContent ?? '').trim() !== '';

const PAGE_READY = {
  'index.html': enginePainted,
  'tools/lissajous.html': null,
  'tools/mobius.html': null,
  'tools/palettes.html': paletteRecipesListed,
  'tools/shader.html': enginePainted,
  'tools/solids.html': solidMeshBuilt,
};

/**
 * Counts the draw calls the page issues into its canvases, installed before any
 * page script runs. WebGL2's interface does not inherit WebGL1's, so both carry
 * their own copies of the draw entry points.
 * @returns {void}
 */
function installDrawProbe() {
  window.daydreamSmokeDraws = 0;
  /**
   * @param {unknown} ctor - Context interface to instrument, when the browser has it.
   * @param {string[]} methods - Draw entry points on its prototype.
   */
  const probe = (ctor, methods) => {
    if (typeof ctor !== 'function') return;
    for (const name of methods) {
      const original = ctor.prototype[name];
      if (typeof original !== 'function') continue;
      ctor.prototype[name] = function (...args) {
        window.daydreamSmokeDraws += 1;
        return original.apply(this, args);
      };
    }
  };
  const glDraws = [
    'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced',
  ];
  probe(window.WebGLRenderingContext, glDraws);
  probe(window.WebGL2RenderingContext, glDraws);
  probe(window.CanvasRenderingContext2D,
    ['drawImage', 'fill', 'fillRect', 'putImageData', 'stroke']);
}

/** @returns {void} */
function installSegmentProbe() {
  window.daydreamSegmentProbe = { modulePosts: 0, transferPosts: 0 };
  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, transferOrOptions) {
    if (message?.type === 'init'
        && message.wasmModule instanceof WebAssembly.Module) {
      window.daydreamSegmentProbe.modulePosts += 1;
    }
    const transfer = Array.isArray(transferOrOptions)
      ? transferOrOptions
      : transferOrOptions?.transfer;
    if (transfer?.length > 0) window.daydreamSegmentProbe.transferPosts += 1;
    return postMessage.call(this, message, transferOrOptions);
  };
}

/**
 * @param {import('puppeteer-core').Page} tab
 * @param {string} origin
 * @param {string[]} problems
 */
function collectProblems(tab, origin, problems) {
  /** @param {string} [href] */
  const absent = (href) => {
    if (href === undefined) return false;
    const url = new URL(href, origin);
    return url.origin === origin && ABSENT_PATHS.some((re) => re.test(url.pathname));
  };
  tab.on('console', (message) => {
    if (message.type() !== 'error' || absent(message.location()?.url)) return;
    problems.push(`console error: ${message.text()}`);
  });
  tab.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  tab.on('requestfailed', (request) => {
    if (absent(request.url())) return;
    problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`);
  });
  tab.on('response', (response) => {
    if (response.status() < 400 || absent(response.url())) return;
    problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
}

/**
 * Loads one page and collects everything that went wrong on it.
 * @param {import('puppeteer-core').Browser} browser - The running browser.
 * @param {string} origin - Origin the manifest server listens on.
 * @param {string} page - Repo-relative page path.
 * @returns {Promise<string[]>} One line per problem; empty when the page is clean.
 */
async function smokePage(browser, origin, page) {
  const problems = [];
  const tab = await browser.newPage();
  await tab.setViewport(VIEWPORT);
  collectProblems(tab, origin, problems);

  await tab.evaluateOnNewDocument(installDrawProbe);
  try {
    await tab.goto(`${origin}/${page}`, { timeout: LOAD_TIMEOUT_MS });
    const ready = PAGE_READY[page];
    if (ready) await tab.waitForFunction(ready, { timeout: READY_TIMEOUT_MS });
    await tab.waitForFunction(
      () => window.daydreamSmokeDraws > 0, { timeout: READY_TIMEOUT_MS });
    try {
      await tab.waitForNetworkIdle(
        { idleTime: NETWORK_IDLE_MS, timeout: NETWORK_IDLE_TIMEOUT_MS });
    } catch {
      problems.push(
        `network never went idle for ${NETWORK_IDLE_MS}ms within ` +
          `${NETWORK_IDLE_TIMEOUT_MS}ms`);
    }
    const draws = await tab.evaluate(() => window.daydreamSmokeDraws);
    console.log(`  ${page}: ${draws} draw calls`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  await tab.close();
  return problems;
}

/**
 * Runs the segmented worker path in a real browser.
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} origin
 * @returns {Promise<string[]>}
 */
async function smokeSegmentedMode(browser, origin) {
  const problems = [];
  const tab = await browser.newPage();
  await tab.setViewport(VIEWPORT);
  collectProblems(tab, origin, problems);
  await tab.evaluateOnNewDocument(installSegmentProbe);

  const url = new URL('/index.html', origin);
  url.searchParams.set('view.Segmented POV.segmented', 'true');
  url.searchParams.set('view.Segmented POV.segments', '2');
  try {
    await tab.goto(url.href, { timeout: LOAD_TIMEOUT_MS });
    await tab.waitForFunction(enginePainted, { timeout: READY_TIMEOUT_MS });
    await tab.waitForFunction(() => {
      const overlay = document.getElementById('segment-stats');
      if (!overlay) return false;
      const rows = [...(overlay?.querySelectorAll('tr') ?? [])]
        .filter((row) => /^Seg \d+$/.test(
          row.querySelector('.seg-label')?.textContent ?? ''));
      const probe = window.daydreamSegmentProbe;
      return getComputedStyle(overlay).display !== 'none'
        && rows.length === 2
        && rows.every((row) => row.querySelector('.seg-range')?.textContent !== '?')
        && probe.modulePosts === 2
        && probe.transferPosts > 0;
    }, { timeout: READY_TIMEOUT_MS });
    const probe = await tab.evaluate(() => window.daydreamSegmentProbe);
    console.log(`  index.html segmented: ${probe.modulePosts} module clones, `
      + `${probe.transferPosts} transferable posts`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  await tab.close();
  return problems;
}

const pages = servedPages();
if (pages.length === 0) {
  console.error(
    'browser-smoke: site_manifest.txt publishes no .html page — refusing to ' +
      'report a green run over an empty page set.',
  );
  process.exit(1);
}
const missingReadiness = pages.filter((page) => !Object.hasOwn(PAGE_READY, page));
const staleReadiness = Object.keys(PAGE_READY).filter((page) => !pages.includes(page));
if (missingReadiness.length > 0 || staleReadiness.length > 0) {
  console.error('browser-smoke: PAGE_READY must name every served page exactly; '
    + `missing [${missingReadiness.join(', ')}], stale [${staleReadiness.join(', ')}].`);
  process.exit(1);
}

let executablePath;
try {
  executablePath = resolveBrowser();
} catch (error) {
  console.error(`browser-smoke: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

console.log(`browser-smoke: ${pages.length} pages, ${executablePath}`);

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
  for (const page of pages) {
    const problems = await smokePage(browser, site.origin, page);
    for (const problem of problems) failures.push(`${page}: ${problem}`);
  }
  const segmentedProblems = await smokeSegmentedMode(browser, site.origin);
  for (const problem of segmentedProblems)
    failures.push(`index.html segmented: ${problem}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
  await site?.close();
}

if (failures.length > 0) {
  console.error(`browser-smoke: ${failures.length} problems across ${pages.length} pages:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`browser-smoke: ${pages.length} pages and segmented mode loaded clean and painted.`);
