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

// Extensions refreshModuleCache re-fetches. The WASM binary is in because the
// deploy binds it to its glue by content hash, so a cached binary against fresh
// glue is the canonical skew a Reload has to clear.
const REFRESHED_EXTENSIONS = ['.js', '.wasm', '.css', '.json'];

// Re-fetches in flight at once. Past the browser's per-host connection limit
// the extra requests only queue, and the multi-megabyte binary — the one
// re-fetch a Reload exists for — waits behind whatever small modules opened
// their sockets first.
const REFRESH_CONCURRENCY = 6;

// Resource-timing entries kept, over the 250-entry default. The buffer drops
// every load past its size, and the dropped ones are the earliest — the modules
// a Reload most needs to re-fetch.
const RESOURCE_TIMING_ENTRIES = 1000;

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
 *   origin?: string}} [dependencies]
 * @returns {Promise<void>} Resolves once every re-fetch has been read to the end
 *   of its body and the cache entry it replaces is written.
 */
export async function refreshModuleCache({
  performance: timeline = globalThis.performance,
  fetch: fetchResource = globalThis.fetch,
  origin = globalThis.location?.origin,
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
  const lanes = Array.from(
    { length: Math.min(REFRESH_CONCURRENCY, queue.length) },
    async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        // A failed re-fetch leaves its stale entry; the rest of the sweep runs.
        try { await drainBody(await fetchResource(url, { cache: 'reload' })); }
        catch { /* reported by the reload that follows, not recoverable here */ }
      }
    });
  await Promise.all(lanes);
}

/**
 * @param {unknown} error Bootstrap failure.
 * @param {{document?: Document, location?: Location, title?: string,
 *   refresh?: () => Promise<void>}} [dependencies]
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

  const remedy = doc.createElement('span');
  remedy.className = 'load-error-remedy';
  remedy.textContent = VENDOR_REMEDY;

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
    return refresh().catch(() => {}).then(() => pageLocation?.reload());
  });

  overlay.classList.add('error');
  // The markup ships role="status" for the polite loading message; a boot
  // failure is assertive.
  overlay.setAttribute('role', 'alert');
  overlay.replaceChildren(title, detail, remedy, reload);
  // A role swap on a live node is not reliably announced; focus carries it, and
  // leaves the keyboard user on the one control the overlay offers.
  reload.focus({ preventScroll: true });
  return true;
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
    if (!showBootstrapFailure(error, { document: doc, location: pageLocation })) {
      fatal(`Failed to start the simulator. ${errorDetail(error)}`);
    }
    return false;
  }
}
