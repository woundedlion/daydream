/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { raceDeadline } from '../shared/deadline.js';
import { errorDetail, showFatalError } from '../shared/banner.js';

// Remedy for an unreachable CDN. refreshModuleCache is same-origin only, so
// Reload never repairs a cached vendor module.
export const VENDOR_REMEDY = 'three and lil-gui load from cdn.jsdelivr.net. If '
  + 'this machine is offline or the CDN is blocked, run `npm run importmap:local` '
  + 'to serve the vendored copies instead (README §10.8).';

// Remedy for a fetched module that failed to link: a cached copy against a
// newer deploy.
export const STALE_MODULE_REMEDY = 'A page module did not link against the rest '
  + 'of the deploy — usually a stale copy left in the browser cache. Reload '
  + 're-fetches the whole module graph.';

/**
 * A module-evaluation guard's report that the graph mixes a cached module with
 * a newer deploy. Browsers raise such skew as a SyntaxError only for an
 * export-name mismatch.
 */
export class StaleModuleError extends Error {
  /** @param {string} message - What did not agree, and what repairs it. */
  constructor(message) {
    super(message);
    this.name = 'StaleModuleError';
  }
}

// A module fetch failure, across browser wordings. Chrome reports the entry
// module's URL, so a blocked CDN and a missing same-origin module look alike.
const MODULE_FETCH_FAILURE = new RegExp([
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'Importing a module script failed',
  'Failed to resolve module specifier',
].join('|'), 'i');

// Extensions refreshModuleCache re-fetches. The deploy binds the WASM binary
// to its glue by content hash.
const REFRESHED_EXTENSIONS = ['.js', '.mjs', '.wasm', '.css', '.json'];

const REFRESH_CONCURRENCY = 6;

const RESOURCE_TIMING_ENTRIES = 1000;

// Reload cache-sweep deadline.
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
 * A plain reload only revalidates the top-level document.
 * @param {{performance?: Performance, fetch?: typeof globalThis.fetch,
 *   origin?: string, signal?: AbortSignal}} [dependencies]
 * @returns {Promise<void>} Resolves after the attempted re-fetches settle,
 *   including failed requests and body reads.
 */
export async function refreshModuleCache({
  performance: timeline = globalThis.performance,
  fetch: fetchResource = globalThis.fetch,
  origin = globalThis.location?.origin,
  signal = undefined,
} = {}) {
  if (!origin || typeof fetchResource !== 'function') return;
  const modules = new Set();
  const binaries = new Set();
  for (const { name } of timeline?.getEntriesByType?.('resource') ?? []) {
    if (typeof name !== 'string' || !name.startsWith(`${origin}/`)) continue;
    const path = name.split(/[?#]/)[0];
    if (!REFRESHED_EXTENSIONS.some((ext) => path.endsWith(ext))) continue;
    modules.add(name);
    if (path.endsWith('.wasm')) binaries.add(name);
  }
  // The WASM binary leads, ahead of the deadline; the rest keep load order.
  const queue = [...binaries, ...[...modules].filter((url) => !binaries.has(url))];
  const init = signal ? { cache: 'reload', signal } : { cache: 'reload' };
  const lanes = Array.from(
    { length: Math.min(REFRESH_CONCURRENCY, queue.length) },
    async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        // Settle on abort rather than rejecting each remaining re-fetch.
        if (signal?.aborted) return;
        // A failed re-fetch leaves its stale entry; the rest of the sweep runs.
        try { await drainBody(await fetchResource(url, init)); }
        catch { /* reported by the reload that follows, not recoverable here */ }
      }
    });
  await Promise.all(lanes);
}

/**
 * Run the module-cache sweep under a deadline that aborts its re-fetches and
 * settles this promise. The sweep's rejection is absorbed.
 *
 * @param {(dependencies?: {signal?: AbortSignal}) => Promise<void>} refresh -
 *   Starts the sweep on the deadline's signal.
 * @param {{ms?: number, timers?: {setTimeout: Function, clearTimeout: Function},
 *   createController?: () => AbortController}} [dependencies]
 * @returns {Promise<void>} Resolves once the sweep settles or the deadline
 *   aborts it; never rejects.
 */
export function refreshWithDeadline(refresh, {
  ms = REFRESH_DEADLINE_MS,
  timers = globalThis,
  createController = () => new AbortController(),
} = {}) {
  const controller = createController();
  return raceDeadline(() => refresh({ signal: controller.signal }), ms, timers,
    () => { controller.abort(); }).catch(() => {});
}

/**
 * The advice that fits a boot failure's cause.
 * @param {unknown} error Boot failure.
 * @returns {string} Remedy text, empty when no advice fits the cause.
 * @details A fetch failure may be the CDN-hosted vendor libraries; a link or
 *   parse failure, or StaleModuleError, is a cached module against a newer
 *   deploy. Anything else gets no remedy.
 */
export function bootRemedy(error) {
  const detail = errorDetail(error);
  if (error instanceof StaleModuleError) return STALE_MODULE_REMEDY;
  if (detail.startsWith('SyntaxError')
      || (typeof globalThis.WebAssembly?.LinkError === 'function'
        && error instanceof globalThis.WebAssembly.LinkError)
      || (typeof globalThis.WebAssembly?.CompileError === 'function'
        && error instanceof globalThis.WebAssembly.CompileError)) return STALE_MODULE_REMEDY;
  if (MODULE_FETCH_FAILURE.test(detail)) return VENDOR_REMEDY;
  return '';
}

/**
 * @param {unknown} error Bootstrap failure.
 * @param {{document?: Document, location?: Location, title?: string,
 *   refresh?: (dependencies?: {signal?: AbortSignal}) => Promise<void>,
 *   logger?: Pick<Console, 'error'>}} [dependencies]
 * @returns {boolean} True when the failure was rendered into the overlay; false
 *   when no overlay exists and the caller must surface the error another way.
 */
export function showBootstrapFailure(error, {
  document: doc = globalThis.document,
  location: pageLocation = globalThis.location,
  title: titleText = 'Failed to start the simulator.',
  refresh = refreshModuleCache,
  logger = globalThis.console,
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
    // Relabel before disabling: a disabled button drops focus.
    reload.textContent = 'Reloading…';
    reload.disabled = true;
    return refreshWithDeadline(refresh)
      .then(() => pageLocation?.reload())
      .catch((failure) => {
        logger?.error?.('The reload could not be completed:', failure);
        reload.textContent = 'Reload';
        reload.disabled = false;
      });
  });

  overlay.classList.add('error');
  // The markup ships role="status" for the polite loading message; a boot
  // failure is assertive.
  overlay.setAttribute('role', 'alert');
  overlay.replaceChildren(...(remedy ? [title, detail, remedy, reload]
    : [title, detail, reload]));
  // A role swap on a live node is not reliably announced; focus carries it.
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
  // Widened before the application graph loads, so refreshModuleCache finds
  // every module.
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
