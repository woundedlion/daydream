/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { errorDetail, showFatalError } from './tools/banner.js';

// The vendored libraries index.html loads from the CDN, and the remedy for a
// page that cannot reach it. refreshModuleCache is same-origin only, so a
// Reload re-attempts the CDN fetch but never repairs a cached vendor module.
export const VENDOR_REMEDY = 'three and lil-gui load from cdn.jsdelivr.net. If '
  + 'this machine is offline or the CDN is blocked, run `npm run importmap:local` '
  + 'to serve the vendored copies instead (README §10.8).';

// A module the browser fetched but could not link against its importers: the
// deploy moved under a copy this browser still holds. The Reload sweep is the
// repair, so the remedy names the control the overlay already offers.
export const STALE_MODULE_REMEDY = 'A page module did not link against the rest '
  + 'of the deploy — usually a stale copy left in the browser cache. Reload '
  + 're-fetches the whole module graph.';

// A module the browser could not fetch at all, across the three engines'
// wordings. Chrome reports the entry module's URL rather than the one that
// actually failed, so a blocked CDN and a missing same-origin module are the
// same string: the vendor remedy is the widest one that still fits both.
const MODULE_FETCH_FAILURE = new RegExp([
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'Importing a module script failed',
  'Failed to resolve module specifier',
].join('|'), 'i');

// Extensions refreshModuleCache re-fetches. The WASM binary is in because the
// deploy binds it to its glue by content hash, so a cached binary against fresh
// glue is the canonical skew a Reload has to clear. '.mjs' does not end in
// '.js', so the shader workbench and its digest module need their own entry.
const REFRESHED_EXTENSIONS = ['.js', '.mjs', '.wasm', '.css', '.json'];

// Re-fetches in flight at once. Past the browser's per-host connection limit
// the extra requests only queue, and the multi-megabyte binary — the one
// re-fetch a Reload exists for — waits behind whatever small modules opened
// their sockets first.
const REFRESH_CONCURRENCY = 6;

// Resource-timing entries kept, over the 250-entry default. The buffer drops
// every load past its size, and the dropped ones are the earliest — the modules
// a Reload most needs to re-fetch.
const RESOURCE_TIMING_ENTRIES = 1000;

// Deadline for the Reload sweep. The sweep only primes the cache; the reload
// chained behind it is the recovery, so a connection that stalls rather than
// failing must not hold the overlay's one control. Well under the main module
// load's deadline for that reason: there is a working outcome past this one,
// and none past that one.
export const REFRESH_DEADLINE_MS = 20000;

/**
 * Read a re-fetched response to the end of its body.
 * @param {Response} response Re-fetch response.
 * @returns {Promise<void>} Resolves once the body has been read.
 * @details fetch settles on the headers; a response whose body is never read is
 *   aborted when it is collected, leaving the stale cache entry in place.
 */
async function drainBody(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    await response?.arrayBuffer?.();
    return;
  }
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

/**
 * Re-fetch every same-origin module the page has already loaded, bypassing the
 * HTTP cache and replacing each cache entry with the server's current copy.
 * A plain reload only revalidates the top-level document, so a module held in
 * cache from an earlier deploy stays stale and keeps failing to link against
 * its freshly fetched importers.
 * @param {{performance?: Performance, fetch?: typeof globalThis.fetch,
 *   origin?: string, signal?: AbortSignal}} [dependencies]
 * @returns {Promise<void>} Resolves once every re-fetch has been read to the end
 *   of its body and the cache entry it replaces is written.
 */
export async function refreshModuleCache({
  performance: timeline = globalThis.performance,
  fetch: fetchResource = globalThis.fetch,
  origin = globalThis.location?.origin,
  signal = undefined,
} = {}) {
  if (!origin || typeof fetchResource !== 'function') return;
  const modules = new Set();
  for (const { name } of timeline?.getEntriesByType?.('resource') ?? []) {
    if (typeof name !== 'string' || !name.startsWith(`${origin}/`)) continue;
    const path = name.split(/[?#]/)[0];
    if (REFRESHED_EXTENSIONS.some((ext) => path.endsWith(ext))) modules.add(name);
  }
  // Load order, so the queue drains the way the page pulled the graph in.
  const queue = Array.from(modules);
  const init = signal ? { cache: 'reload', signal } : { cache: 'reload' };
  const lanes = Array.from(
    { length: Math.min(REFRESH_CONCURRENCY, queue.length) },
    async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        // An abort rejects every remaining re-fetch in turn; emptying the queue
        // here settles the sweep on the deadline rather than lanes later.
        if (signal?.aborted) return;
        // A failed re-fetch leaves its stale entry; the rest of the sweep runs.
        try { await drainBody(await fetchResource(url, init)); }
        catch { /* reported by the reload that follows, not recoverable here */ }
      }
    });
  await Promise.all(lanes);
}

/**
 * Run the module-cache sweep under a deadline, so a re-fetch that stalls rather
 * than failing cannot hold the reload chained behind it.
 *
 * The deadline aborts the sweep's re-fetches and settles this promise, so the
 * page always reaches the reload, with whatever cache entries the sweep did
 * replace. The timer is cleared once the race settles, and the sweep's own
 * rejection is absorbed rather than escaping as an unhandled one.
 *
 * @param {(dependencies?: {signal?: AbortSignal}) => Promise<void>} refresh -
 *   Starts the sweep on the deadline's signal.
 * @param {{ms?: number, timers?: {setTimeout: Function, clearTimeout: Function},
 *   createController?: () => AbortController}} [dependencies]
 * @returns {Promise<void>} Resolves once the sweep settles or the deadline
 *   aborts it; never rejects, since the reload runs either way.
 */
export function refreshWithDeadline(refresh, {
  ms = REFRESH_DEADLINE_MS,
  timers = globalThis,
  createController = () => new AbortController(),
} = {}) {
  const controller = createController();
  /** @type {any} */
  let timer = null;
  const expired = new Promise((resolve) => {
    timer = timers.setTimeout(() => { controller.abort(); resolve(undefined); }, ms);
    // No-op in browsers; keeps an unfired deadline from holding the unit-test
    // process open.
    timer?.unref?.();
  });
  // A synchronous throw from refresh() would leave the deadline armed with
  // nothing to abort and the reload unreached.
  let swept;
  try {
    swept = Promise.resolve(refresh({ signal: controller.signal }));
  } catch {
    timers.clearTimeout(timer);
    return Promise.resolve();
  }
  // Raced, not awaited: a lane that ignores the signal must not outlive the
  // deadline that fired for it.
  return Promise.race([swept.catch(() => {}), expired])
    .finally(() => timers.clearTimeout(timer));
}

/**
 * The advice that fits a boot failure's cause.
 * @param {unknown} error Boot failure.
 * @returns {string} Remedy text, empty when no advice fits the cause.
 * @details A fetch failure may be the CDN-hosted vendor libraries; a link or
 *   parse failure is a cached module against a newer deploy. Everything else
 *   — the engine, the initial apply — failed past a module graph that had
 *   already loaded, and neither remedy applies.
 */
export function bootRemedy(error) {
  const detail = errorDetail(error);
  if (detail.startsWith('SyntaxError')) return STALE_MODULE_REMEDY;
  if (MODULE_FETCH_FAILURE.test(detail)) return VENDOR_REMEDY;
  return '';
}

/**
 * @param {unknown} error Bootstrap failure.
 * @param {{document?: Document, location?: Location, title?: string,
 *   refresh?: (dependencies?: {signal?: AbortSignal}) => Promise<void>}} [dependencies]
 * @returns {boolean} True when the failure was rendered into the overlay; false
 *   when no overlay exists and the caller must surface the error another way.
 */
export function showBootstrapFailure(error, {
  document: doc = globalThis.document,
  location: pageLocation = globalThis.location,
  title: titleText = 'Failed to start the simulator.',
  refresh = refreshModuleCache,
} = {}) {
  const overlay = doc?.getElementById('loading-overlay');
  if (!overlay) return false;

  const title = doc.createElement('span');
  title.className = 'load-error-title';
  title.textContent = titleText;

  const detail = doc.createElement('span');
  detail.className = 'load-error-detail';
  detail.textContent = errorDetail(error);

  const remedyText = bootRemedy(error);
  let remedy = null;
  if (remedyText) {
    remedy = doc.createElement('span');
    remedy.className = 'load-error-remedy';
    remedy.textContent = remedyText;
  }

  const reload = doc.createElement('button');
  reload.type = 'button';
  reload.className = 'context-lost-reload';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => {
    // The sweep re-fetches the whole module graph, the multi-megabyte binary
    // included, so it needs a progress report and exactly one run per click.
    // Relabel before disabling: the name change on the focused control is what
    // carries the state, and a disabled button drops focus.
    reload.textContent = 'Reloading…';
    reload.disabled = true;
    // Deadlined: a stalled re-fetch would otherwise leave this button
    // relabelled, disabled and inert for the page's lifetime.
    return refreshWithDeadline(refresh).then(() => pageLocation?.reload());
  });

  overlay.classList.add('error');
  // The markup ships role="status" for the polite loading message; a boot
  // failure is assertive.
  overlay.setAttribute('role', 'alert');
  overlay.replaceChildren(...(remedy ? [title, detail, remedy, reload]
    : [title, detail, reload]));
  // A role swap on a live node is not reliably announced; focus carries it, and
  // leaves the keyboard user on the one control the overlay offers.
  reload.focus({ preventScroll: true });
  return true;
}

/**
 * Surface a boot failure: into the loading overlay when the page still has
 * one, and through the fatal banner when it does not.
 * @param {unknown} error Boot failure.
 * @param {{title?: string, document?: Document, location?: Location,
 *   fatal?: (message: string) => void}} [dependencies]
 * @returns {void}
 */
export function reportBootFailure(error, {
  title = 'Failed to start the simulator.',
  document: doc = globalThis.document,
  location: pageLocation = globalThis.location,
  fatal = showFatalError,
} = {}) {
  if (showBootstrapFailure(
    error, { document: doc, location: pageLocation, title })) {
    return;
  }
  fatal(`${title} ${errorDetail(error)}`);
}

/**
 * @param {{loader?: () => Promise<unknown>|unknown, document?: Document,
 *   location?: Location, logger?: Pick<Console, 'error'>,
 *   fatal?: (message: string) => void, performance?: Performance}} [dependencies]
 * @returns {Promise<boolean>} True when the application module loaded.
 */
export async function bootstrap({
  loader = async () => (await import('./daydream.js')).start(),
  document: doc = globalThis.document,
  location: pageLocation = globalThis.location,
  logger = globalThis.console,
  fatal = showFatalError,
  performance: timeline = globalThis.performance,
} = {}) {
  // Widened before the application module pulls its graph in, so every module
  // refreshModuleCache has to re-fetch is still in the buffer to be found.
  timeline?.setResourceTimingBufferSize?.(RESOURCE_TIMING_ENTRIES);
  try {
    await loader();
    return true;
  } catch (error) {
    logger?.error('Failed to bootstrap Daydream:', error);
    reportBootFailure(error, { document: doc, location: pageLocation, fatal });
    return false;
  }
}
