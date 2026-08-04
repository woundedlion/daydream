/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { showFatalError } from './tools/banner.js';

/**
 * @param {unknown} error Bootstrap failure.
 * @returns {string} Plain-text failure detail.
 */
function errorDetail(error) {
  if (error && typeof error === 'object' && 'message' in error &&
      typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

// Extensions refreshModuleCache re-fetches. The WASM binary is in because the
// deploy binds it to its glue by content hash, so a cached binary against fresh
// glue is the canonical skew a Reload has to clear.
const REFRESHED_EXTENSIONS = ['.js', '.wasm'];

/**
 * Re-fetch every same-origin module the page has already loaded, bypassing the
 * HTTP cache and replacing each cache entry with the server's current copy.
 * A plain reload only revalidates the top-level document, so a module held in
 * cache from an earlier deploy stays stale and keeps failing to link against
 * its freshly fetched importers.
 * @param {{performance?: Performance, fetch?: typeof globalThis.fetch,
 *   origin?: string}} [dependencies]
 * @returns {Promise<void>} Resolves once every re-fetch has settled.
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
  await Promise.allSettled(
    Array.from(modules, (url) => fetchResource(url, { cache: 'reload' })));
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

  const reload = doc.createElement('button');
  reload.type = 'button';
  reload.className = 'context-lost-reload';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () =>
    refresh().catch(() => {}).then(() => pageLocation?.reload()));

  overlay.classList.add('error');
  // The markup ships role="status" for the polite loading message; a boot
  // failure is assertive.
  overlay.setAttribute('role', 'alert');
  overlay.replaceChildren(title, detail, reload);
  // A role swap on a live node is not reliably announced; focus carries it, and
  // leaves the keyboard user on the one control the overlay offers.
  reload.focus({ preventScroll: true });
  return true;
}

/**
 * @param {{loader?: () => Promise<unknown>|unknown, document?: Document,
 *   location?: Location, logger?: Pick<Console, 'error'>,
 *   fatal?: (message: string) => void}} [dependencies]
 * @returns {Promise<boolean>} True when the application module loaded.
 */
export async function bootstrap({
  loader = () => import('./daydream.js'),
  document: doc = globalThis.document,
  location: pageLocation = globalThis.location,
  logger = globalThis.console,
  fatal = showFatalError,
} = {}) {
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

if (globalThis.document) {
  void bootstrap();
}
