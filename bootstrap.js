/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

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

/**
 * Re-fetch every same-origin script the page has already loaded, bypassing the
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
  const scripts = new Set();
  for (const { name } of timeline?.getEntriesByType?.('resource') ?? []) {
    if (typeof name === 'string' && name.startsWith(`${origin}/`) &&
        name.split(/[?#]/)[0].endsWith('.js')) {
      scripts.add(name);
    }
  }
  await Promise.allSettled(
    Array.from(scripts, (url) => fetchResource(url, { cache: 'reload' })));
}

/**
 * @param {unknown} error Bootstrap failure.
 * @param {{document?: Document, location?: Location, title?: string,
 *   refresh?: () => Promise<void>}} [dependencies]
 * @returns {void}
 */
export function showBootstrapFailure(error, {
  document: doc = globalThis.document,
  location: pageLocation = globalThis.location,
  title: titleText = 'Failed to start the simulator.',
  refresh = refreshModuleCache,
} = {}) {
  const overlay = doc?.getElementById('loading-overlay');
  if (!overlay) return;

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
  overlay.replaceChildren(title, detail, reload);
}

/**
 * @param {{loader?: () => Promise<unknown>|unknown, document?: Document,
 *   location?: Location, logger?: Pick<Console, 'error'>}} [dependencies]
 * @returns {Promise<boolean>} True when the application module loaded.
 */
export async function bootstrap({
  loader = () => import('./daydream.js'),
  document: doc = globalThis.document,
  location: pageLocation = globalThis.location,
  logger = globalThis.console,
} = {}) {
  try {
    await loader();
    return true;
  } catch (error) {
    logger?.error('Failed to bootstrap Daydream:', error);
    showBootstrapFailure(error, { document: doc, location: pageLocation });
    return false;
  }
}

if (globalThis.document) {
  void bootstrap();
}
