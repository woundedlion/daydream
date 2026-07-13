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
 * @param {unknown} error Bootstrap failure.
 * @param {{document?: Document, location?: Location}} [dependencies]
 * @returns {void}
 */
export function showBootstrapFailure(error, {
  document: doc = globalThis.document,
  location: pageLocation = globalThis.location,
} = {}) {
  const overlay = doc?.getElementById('loading-overlay');
  if (!overlay) return;

  const title = doc.createElement('span');
  title.className = 'load-error-title';
  title.textContent = 'Failed to start the simulator.';

  const detail = doc.createElement('span');
  detail.className = 'load-error-detail';
  detail.textContent = errorDetail(error);

  const reload = doc.createElement('button');
  reload.type = 'button';
  reload.className = 'context-lost-reload';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => pageLocation?.reload());

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
