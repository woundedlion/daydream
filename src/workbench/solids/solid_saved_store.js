/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { savedChainShapeError, savedSolidExportError } from './solid_validation.js';
import { formatSolidName } from './solid_codegen.js';

/** Maximum number of thumbnail-bearing solids retained by the page. */
export const SAVED_SOLIDS_MAX = 40;
/** Most recent rejected entries the rejected-card backup keeps. */
export const REJECTED_BACKUP_ENTRIES = 20;
/** Longest serialized rejected entry the backup keeps; longer ones are truncated or replaced. */
export const REJECTED_BACKUP_ENTRY_CHARS = 4096;

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

/** Primary saved-card storage key. */
export const SAVED_SOLIDS_KEY = 'daydream.savedSolids.v1';
/** Backup key for rejected saved cards. */
export const REJECTED_SOLIDS_KEY = 'daydream.savedSolids.rejected.v1';

/**
 * @param {() => Pick<Storage, 'getItem'|'setItem'>} [readStorage] - Resolves browser storage.
 * @returns {{storage: Pick<Storage, 'getItem'|'setItem'>, notice: string}} Persistent or session storage.
 */
export function resolveSavedSolidsStorage(readStorage = () => localStorage) {
  try {
    return {storage: readStorage(), notice: ''};
  } catch {
    const values = new Map();
    return {storage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    }, notice: 'Changes apply to this session only: browser storage is unavailable.'};
  }
}

/**
 * Separates stored cards from rejected data.
 * @param {Pick<Storage, "getItem">} storage - Source of the saved list.
 * @returns {{entries: any[], rejected: any[], notice: string, backupNotice: string}} Parsed cards and recovery status.
 */
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
  return {
    entries,
    rejected,
    notice: rejected.length
      ? `${rejected.length} saved solid${rejected.length === 1 ? '' : 's'} could not be loaded: ${reason}.` : '',
    backupNotice: rejected.length
      ? `Saving attempts a backup of up to ${REJECTED_BACKUP_ENTRIES} rejected entries without thumbnails; `
        + 'oversized data may be truncated or omitted.' : '',
  };
}

/**
 * Saves cards, retaining rejected entries until they can be backed up.
 * @param {Pick<Storage, "getItem"|"setItem">} storage - Destination and backup store.
 * @param {any[]} savedSolids - Cards to persist.
 * @param {{notice: string, backupNotice?: string, rejected: any[]}} savedStorage - Rejected data and recovery status.
 * @returns {string} Notice to display after saving.
 */
export function persistSavedSolids(storage, savedSolids, savedStorage) {
  let backupNotice = savedStorage.backupNotice;
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
          .slice(-REJECTED_BACKUP_ENTRIES).map((entry) => {
            if (!entry || typeof entry !== 'object') return String(entry).slice(0, REJECTED_BACKUP_ENTRY_CHARS);
            const data = { ...entry };
            delete data.thumb;
            return JSON.stringify(data).length <= REJECTED_BACKUP_ENTRY_CHARS ? data : { truncated: true };
          });
        storage.setItem(REJECTED_SOLIDS_KEY, JSON.stringify(backup));
        savedStorage.rejected.length = 0;
        backupNotice = savedStorage.backupNotice = 'Rejected entries were backed up. '
          + `The backup keeps up to ${REJECTED_BACKUP_ENTRIES} entries without thumbnails; oversized data may have been truncated or omitted.`;
      } catch (error) {
        console.warn('Could not back up rejected solids:', error);
        backupNotice = [backupNotice, 'Rejected cards could not be backed up.'].filter(Boolean).join(' ');
      }
    }
    storage.setItem(SAVED_SOLIDS_KEY, JSON.stringify([...savedSolids, ...savedStorage.rejected]));
    return [savedStorage.notice, backupNotice].filter(Boolean).join(' ');
  } catch (error) {
    console.warn('Could not persist saved solids:', error);
    return [savedStorage.notice, backupNotice,
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

/**
 * Appends admissible cards from an export to the saved list.
 * @param {string} text - Exported JSON.
 * @param {any[]} savedSolids - List to extend.
 * @returns {{added: number, message: string, persist: boolean}} Import outcome. If
 *   persist is true, the status line stays until replaced.
 */
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
  if (refused > 0) skipped.push(`${refused} invalid ${refused === 1 ? 'entry' : 'entries'} (${firstRefusal})`);
  if (full > 0) skipped.push(`${full} past the ${SAVED_SOLIDS_MAX}-card limit`);
  return { added, message: `imported ${added} solid${added === 1 ? '' : 's'}`
    + (skipped.length > 0 ? ` — skipped ${skipped.join(' and ')}` : ''),
    persist: skipped.length > 0 };
}
