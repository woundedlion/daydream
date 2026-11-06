/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { savedChainShapeError, savedSolidExportError, formatSolidName } from './solid_codegen.js';

/** Maximum number of thumbnail-bearing solids retained by the page. */
export const SAVED_SOLIDS_MAX = 40;

/**
 * Captures a saved-solid thumbnail only while the list has capacity.
 * @param {number} savedCount - Current saved-solid count.
 * @param {() => string} capture - Thumbnail capture callback.
 * @returns {{full: boolean, dataURL: ?string}} Capture result and capacity state.
 */
export function captureSavedSolidThumbnail(savedCount, capture) {
  if (savedCount >= SAVED_SOLIDS_MAX) return { full: true, dataURL: null };
  return { full: false, dataURL: capture() };
}

/**
 * Queues a restore only after its persisted chain passes the shape check.
 * @param {{base: *, ops: *}} item - Persisted saved-solid shape.
 * @param {() => void} queue - Callback that queues the state mutation.
 * @returns {?string} Shape error, or null after the restore is queued.
 */
export function queueSavedSolidRestore(item, queue) {
  const error = savedChainShapeError(item.base, item.ops);
  if (error) return error;
  queue();
  return null;
}

export const SAVED_SOLIDS_KEY = 'daydream.savedSolids.v1';
export const REJECTED_SOLIDS_KEY = 'daydream.savedSolids.rejected.v1';
/** @param {Pick<Storage, "getItem">} storage */
export function loadSavedSolids(storage) {
  const entries = [], rejected = [];
  let reason = '';
  let raw;
  try {
    raw = storage.getItem(SAVED_SOLIDS_KEY) || '[]';
    const parsed = JSON.parse(raw);
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      const error = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? savedSolidExportError(entry.base, entry.ops) : 'not a saved-solid object';
      if (error) {
        rejected.push(entry);
        reason ||= error;
      } else entries.push(entry);
    }
  } catch (error) {
    console.warn('Could not restore saved solids:', error);
    if (raw !== undefined) rejected.push(raw);
    reason = 'invalid saved-solid JSON';
  }
  return { entries, rejected, notice: rejected.length
    ? `${rejected.length} saved solid${rejected.length === 1 ? '' : 's'} could not be loaded: ${reason}. Saving attempts a backup of up to 20 rejected entries without thumbnails; oversized data may be truncated or omitted.` : '' };
}

/** @param {Pick<Storage, "getItem"|"setItem">} storage @param {any[]} savedSolids @param {{notice:string, rejected:any[]}} savedStorage */
export function persistSavedSolids(storage, savedSolids, savedStorage) {
  let notice = savedStorage.notice;
  try {
    if (savedStorage.rejected.length) {
      try {
        const raw = storage.getItem(REJECTED_SOLIDS_KEY) || '[]';
        let previous;
        try {
          previous = JSON.parse(raw);
        } catch {
          previous = [];
        }
        const backup = [...(Array.isArray(previous) ? previous : []), ...savedStorage.rejected]
          .slice(-20).map((entry) => {
            if (!entry || typeof entry !== 'object') return String(entry).slice(0, 4096);
            const data = { ...entry };
            delete data.thumb;
            return JSON.stringify(data).length <= 4096 ? data : { truncated: true };
          });
        storage.setItem(REJECTED_SOLIDS_KEY, JSON.stringify(backup));
        savedStorage.rejected.length = 0;
      } catch (error) {
        console.warn('Could not back up rejected solids:', error);
        notice = `${savedStorage.notice} Rejected cards could not be backed up.`;
      }
    }
    storage.setItem(SAVED_SOLIDS_KEY, JSON.stringify([...savedSolids, ...savedStorage.rejected]));
    return notice;
  } catch (error) {
    console.warn('Could not persist saved solids:', error);
    return [savedStorage.notice,
      'Changes apply to this session only: browser storage refused the write.'].filter(Boolean).join(' ');
  }
}

/** Flags a saved card carries, each absent from a card saved before it existed. */
const SAVED_FLAGS = ['geodesics', 'faces', 'colorize', 'vertices', 'normals', 'indices'];

/**
 * Rebuilds one imported entry as a saved card, field by field.
 * @param {any} entry - A shape-checked entry from an exported file.
 * @returns {any} The card to hold in the saved list.
 * @details Only the fields the card and the C++ export read are carried across;
 * a flag the entry does not hold is left absent. A thumbnail is taken only as a
 * data image.
 */
export function importedSavedSolid(entry) {
  const text = (/** @type {any} */ value) => (typeof value === 'string' ? value : '');
  /** @type {Record<string, any>} */
  const item = {
    base: entry.base,
    ops: structuredClone(entry.ops),
    thumb: text(entry.thumb).startsWith('data:image/') ? entry.thumb : '',
    title: text(entry.title) || formatSolidName(entry.base),
    desc: text(entry.desc),
    stats: text(entry.stats),
  };
  for (const flag of SAVED_FLAGS) {
    if (typeof entry[flag] === 'boolean') item[flag] = entry[flag];
  }
  for (const count of ['vCount', 'fCount', 'iCount']) {
    if (Number.isFinite(entry[count])) item[count] = entry[count];
  }
  return item;
}

/** @param {string} text @param {any[]} savedSolids */
export function mergeSavedSolids(text, savedSolids) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { added: 0, message: `import rejected: ${error instanceof Error ? error.message : String(error)}`, persist: true };
  }
  if (!Array.isArray(parsed)) {
    return { added: 0, message: 'import rejected: the file holds no list of saved solids', persist: true };
  }

  let refused = 0;
  let firstRefusal = null;
  let full = 0;
  const before = savedSolids.length;
  for (const entry of parsed) {
    const reason = !entry || typeof entry !== 'object' || Array.isArray(entry)
      ? 'entry is not a saved-solid object' : savedSolidExportError(entry.base, entry.ops);
    if (reason) {
      refused++;
      firstRefusal ??= reason;
      continue;
    }
    if (savedSolids.length >= SAVED_SOLIDS_MAX) {
      full++;
      continue;
    }
    savedSolids.push(importedSavedSolid(entry));
  }

  const added = savedSolids.length - before;
  const skipped = [];
  if (refused > 0) skipped.push(`${refused} invalid entries (${firstRefusal})`);
  if (full > 0) skipped.push(`${full} past the ${SAVED_SOLIDS_MAX}-card limit`);
  return { added, message: `imported ${added} solid${added === 1 ? '' : 's'}`
    + (skipped.length > 0 ? ` — skipped ${skipped.join(' and ')}` : ''),
    persist: skipped.length > 0 };
}
