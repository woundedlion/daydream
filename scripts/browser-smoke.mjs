/*
 * Loads every page site_manifest.txt serves in headless Chrome, over a server
 * that publishes exactly the manifest set, and requires each page to reach a
 * clean console and a painted frame.
 *
 *   node scripts/browser-smoke.mjs
 *
 * The browser is the one already installed: $CHROME_PATH, else the standard
 * Chrome/Chromium locations. Nothing is downloaded, and a machine with no
 * browser fails rather than reporting a green run over zero pages.
 *
 * Software rasterization (--use-gl=angle --use-angle=swiftshader
 * --enable-unsafe-swiftshader) because a runner has no GPU and every page but
 * palettes.html renders through WebGL.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { manifestEntries, servedPages } from '../tests/site_pages.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BROWSER_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
];

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];

const VIEWPORT = { width: 1280, height: 900 };
const LOAD_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 90_000;

// A .wasm served as anything else drops Emscripten to the ArrayBuffer path, and
// a module served as text/plain is refused outright.
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

// Paths the served set answers with a 404 by design: Chrome's implicit icon
// fetch on a page that declares none, and the gitignored offline font drop the
// tool pages link behind an onerror fallback to the font CDN.
const ABSENT_PATHS = [/^\/favicon\.ico$/, /^\/vendor\//];

/**
 * Readiness a page must reach beyond a painted frame, evaluated in the page.
 * The simulator paints its empty scene before the engine is up, so a frame alone
 * would pass over a WASM module that never loaded; it removes the loading
 * overlay once the engine has booted and the first effect applied.
 */
const PAGE_READY = {
  'index.html': () => !document.getElementById('loading-overlay'),
};

/**
 * Path of the browser to drive.
 * @returns {string} An existing executable path.
 * @throws {Error} When neither $CHROME_PATH nor any standard location exists.
 */
function resolveBrowser() {
  const declared = process.env.CHROME_PATH;
  if (declared) {
    if (!existsSync(declared)) {
      throw new Error(`CHROME_PATH=${declared} does not exist.`);
    }
    return declared;
  }
  const found = BROWSER_CANDIDATES.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      'no Chrome or Chromium found. Set CHROME_PATH, or install one at ' +
        `${BROWSER_CANDIDATES.join(', ')}.`,
    );
  }
  return found;
}

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

/**
 * Serves the manifest set out of the repository, so the smoke sees the layout
 * deploy.yml stages rather than the whole tree.
 * @param {string[]} entries - site_manifest.txt's entries; a directory entry serves recursively.
 * @returns {Promise<{origin: string, close: () => Promise<void>}>} The listening origin and its shutdown.
 */
async function serveManifest(entries) {
  const served = (path) =>
    entries.some((entry) => path === entry || path.startsWith(`${entry}/`));

  const server = createServer((req, res) => {
    const requested = decodeURIComponent(
      new URL(req.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '');
    const path = requested === '' ? 'index.html' : requested;
    const target = resolve(ROOT, path);
    const ok = served(path) && target.startsWith(`${ROOT}${sep}`) &&
      existsSync(target) && statSync(target).isFile();
    if (!ok) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not in site_manifest.txt\n');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    });
    createReadStream(target).pipe(res);
  });

  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the manifest server did not bind a port');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((done) => server.close(() => done(undefined))),
  };
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
  /** @param {string} [href] */
  const absent = (href) => {
    if (href === undefined) return false;
    const url = new URL(href, origin);
    return url.origin === origin && ABSENT_PATHS.some((re) => re.test(url.pathname));
  };

  const tab = await browser.newPage();
  await tab.setViewport(VIEWPORT);
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

  await tab.evaluateOnNewDocument(installDrawProbe);
  try {
    await tab.goto(`${origin}/${page}`, { timeout: LOAD_TIMEOUT_MS });
    const ready = PAGE_READY[page];
    if (ready) await tab.waitForFunction(ready, { timeout: READY_TIMEOUT_MS });
    await tab.waitForFunction(
      () => window.daydreamSmokeDraws > 0, { timeout: READY_TIMEOUT_MS });
    const draws = await tab.evaluate(() => window.daydreamSmokeDraws);
    console.log(`  ${page}: ${draws} draw calls`);
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

let executablePath;
try {
  executablePath = resolveBrowser();
} catch (error) {
  console.error(`browser-smoke: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

console.log(`browser-smoke: ${pages.length} pages, ${executablePath}`);

const site = await serveManifest(manifestEntries());
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: BROWSER_ARGS,
});

const failures = [];
try {
  for (const page of pages) {
    const problems = await smokePage(browser, site.origin, page);
    for (const problem of problems) failures.push(`${page}: ${problem}`);
  }
} finally {
  await browser.close();
  await site.close();
}

if (failures.length > 0) {
  console.error(`browser-smoke: ${failures.length} problems across ${pages.length} pages:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`browser-smoke: ${pages.length} pages loaded clean and painted.`);
