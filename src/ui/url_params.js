/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {
  getActiveURLSync, overlayUrlParam, URL_FLUSH_DEBOUNCE_MS, writeUrl,
} from '../app/state.js';

/** @typedef {((key: string, value: string|number|boolean|null|undefined) => void) & {cancel: () => void}} UrlWriter */

/**
 * The last query string parsed per window. Repeated reads clone the cached
 * entries without decoding the query string again.
 * @type {WeakMap<Window, {search: string, params: URLSearchParams}>}
 */
const parsedSearchCache = new WeakMap();

/**
 * Reads the current URL query string into a parsed params object, then applies
 * what the URL writer has decided but not yet flushed: the keys a scheduled
 * reset will drop, and the buffered writes that will replace their query-string
 * values.
 * @param {Window} [win] - The window whose location is read.
 * @returns {URLSearchParams} The query parameters of the current location.
 */
export const getUrlParams = (win = window) => {
  const search = win.location.search;
  let cached = parsedSearchCache.get(win);
  if (cached?.search !== search) {
    cached = { search, params: new URLSearchParams(search) };
    parsedSearchCache.set(win, cached);
  }
  const params = new URLSearchParams(cached.params);
  const sync = getActiveURLSync();
  sync?.applyPendingReset(params);
  sync?.overlayPending(params);
  return params;
};

/**
 * Builds a debounced URL-param writer with its own pending-writes buffer and
 * timer, one per DeepLinkGUI subtree. Writes go through the app's URLSync when
 * present, else a fallback writer; they accumulate per key and merge in one
 * flush.
 * @param {Window|null} [win] - The window this writer reads and rewrites; the
 *   ambient one when omitted.
 * @returns {UrlWriter}
 *   A writer; `value` null/undefined deletes the key.
 */
const makeUrlParamWriter = (win = null) => {
  /** @type {number|undefined} */
  let urlTimer;
  const pendingUrlWrites = new Map(); // key -> value (null/undefined => delete)
  const commit = () => {
    const target = win ?? window;
    const params = getUrlParams(target);
    for (const [k, v] of pendingUrlWrites) overlayUrlParam(params, k, v);
    pendingUrlWrites.clear();
    writeUrl(params, target);
  };
  /** @type {UrlWriter} */
  const writer = (key, value) => {
    const sync = getActiveURLSync();
    if (sync) {
      if (pendingUrlWrites.size) {
        (win ?? window).clearTimeout(urlTimer);
        urlTimer = undefined;
        for (const [k, v] of pendingUrlWrites) sync.setParam(k, v);
        pendingUrlWrites.clear();
      }
      sync.setParam(key, value);
      return;
    }
    pendingUrlWrites.set(key, value);
    (win ?? window).clearTimeout(urlTimer);
    urlTimer = (win ?? window).setTimeout(commit, URL_FLUSH_DEBOUNCE_MS);
  };
  writer.cancel = () => { (win ?? window).clearTimeout(urlTimer); urlTimer = undefined; pendingUrlWrites.clear(); };
  return writer;
};

export { makeUrlParamWriter };

/**
 * Removes deep-link URL params, preserving the given keys. Delegates to the
 * app's URLSync when present, else rewrites the query string directly.
 * @param {Array<string>} [excludedKeys=[]] - Param keys to preserve.
 * @param {Window} [win] - The window whose query string is rewritten.
 * @returns {void}
 */
export const resetGUI = (excludedKeys = [], win = window) => {
  const sync = getActiveURLSync();
  if (sync) {
    sync.reset(excludedKeys);
    return;
  }
  const params = getUrlParams(win);
  for (const key of Array.from(params.keys())) {
    if (!excludedKeys.includes(key)) {
      params.delete(key);
    }
  }
  writeUrl(params, win);
};
