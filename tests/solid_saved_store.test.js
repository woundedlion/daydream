import {test} from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RECIPE_STEPS } from '../src/workbench/solids/solid_validation.js';
import {loadSavedSolids, mergeSavedSolids, persistSavedSolids, captureSavedSolidThumbnail, queueSavedSolidRestore, SAVED_SOLIDS_MAX,
  REJECTED_BACKUP_ENTRIES, REJECTED_BACKUP_ENTRY_CHARS, SAVED_SOLIDS_KEY, REJECTED_SOLIDS_KEY, importedSavedSolid, resolveSavedSolidsStorage} from '../src/workbench/solids/solid_saved_store.js';

test('blocked browser storage resolves once to an isolated session store', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
  let reads = 0;
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, get() {
    reads++;
    throw new DOMException('blocked', 'SecurityError');
  }});
  const resolved = resolveSavedSolidsStorage();
  assert.equal(reads, 1);
  assert.match(resolved.notice, /session only.*storage is unavailable/);
  assert.equal(resolved.storage.getItem(SAVED_SOLIDS_KEY), null);
  const card = {base: 'cube', ops: [{op: 'dual', params: {}}]};
  persistSavedSolids(resolved.storage, [card], {notice: resolved.notice, rejected: []});
  assert.deepEqual(loadSavedSolids(resolved.storage).entries, [card]);
  assert.equal(reads, 1);
  assert.equal(resolveSavedSolidsStorage().storage.getItem(SAVED_SOLIDS_KEY), null);
});

test('available browser storage remains the saved-solid storage port', () => {
  const storage = {getItem: () => null, setItem() {}};
  assert.deepEqual(resolveSavedSolidsStorage(() => storage), {storage, notice: ''});
});

test('a rejected entry stays pending until a backup lands', () => {
  const values = new Map([[SAVED_SOLIDS_KEY, '{broken']]);
  const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  const loaded = loadSavedSolids(storage);
  assert.deepEqual(loaded.entries, []);
  assert.deepEqual(loaded.rejected, ['{broken']);
  assert.match(persistSavedSolids(storage, loaded.entries, loaded), /invalid saved-solid JSON/);
  assert.deepEqual(JSON.parse(values.get(REJECTED_SOLIDS_KEY)), ['{broken']);
  assert.equal(loaded.rejected.length, 0);
});

test('rejected backups retain only recent bounded data without thumbnails', () => {
  const values = new Map();
  const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  const cards = Array.from({length: REJECTED_BACKUP_ENTRIES + 5}, (_, id) => ({
    id, base: 'retired', ops: [], thumb: 'data:image/png;base64,thumbnail',
  }));
  const oversizedLength = REJECTED_BACKUP_ENTRY_CHARS + 1000;
  const oversized = {payload: 'x'.repeat(oversizedLength), thumb: 'data:image/png;base64,large'};
  const rejected = [...cards, oversized, 'y'.repeat(oversizedLength)];
  const state = {notice: '', rejected};
  persistSavedSolids(storage, [], state);
  const backup = JSON.parse(values.get(REJECTED_SOLIDS_KEY));
  assert.equal(backup.length, REJECTED_BACKUP_ENTRIES);
  assert.deepEqual(backup.slice(0, -2).map(({id}) => id),
    cards.slice(cards.length + 2 - REJECTED_BACKUP_ENTRIES).map(({id}) => id));
  assert.ok(backup.slice(0, -2).every((entry) => !Object.hasOwn(entry, 'thumb')));
  assert.deepEqual(backup.at(-2), {truncated: true});
  assert.equal(backup.at(-1), 'y'.repeat(REJECTED_BACKUP_ENTRY_CHARS));
  assert.equal(cards[0].thumb, 'data:image/png;base64,thumbnail');
  assert.equal(oversized.payload.length, oversizedLength);
  assert.equal(oversized.thumb, 'data:image/png;base64,large');
  assert.deepEqual(state.rejected, []);
  assert.deepEqual(JSON.parse(values.get(SAVED_SOLIDS_KEY)), []);
});

test('a corrupt rejected backup is replaced before the primary save discards rejected entries', () => {
  const stale = {base: 'cube', ops: [{op: 'truncate', params: {t: 50}}]};
  const values = new Map([[SAVED_SOLIDS_KEY, JSON.stringify([stale])], [REJECTED_SOLIDS_KEY, '{broken']]);
  const writes = [];
  const storage = {getItem: key => values.get(key), setItem(key, value) {
    writes.push(key);
    values.set(key, value);
  }};
  const loaded = loadSavedSolids(storage);
  persistSavedSolids(storage, loaded.entries, loaded);
  assert.deepEqual(writes, [REJECTED_SOLIDS_KEY, SAVED_SOLIDS_KEY]);
  assert.deepEqual(JSON.parse(values.get(REJECTED_SOLIDS_KEY)), [stale]);
  assert.deepEqual(JSON.parse(values.get(SAVED_SOLIDS_KEY)), []);
  assert.equal(loaded.rejected.length, 0);
});

test('imports retain valid entries up to saved-solid capacity', () => {
  const entries = Array.from({length: SAVED_SOLIDS_MAX - 1}, () => ({base: 'cube', ops: [{op: 'dual', params: {}}]}));
  const card = {base: 'cube', ops: [{op: 'dual', params: {}}], title: 'Imported'};
  const result = mergeSavedSolids(JSON.stringify([card, card, null]), entries);
  assert.equal(result.added, 1);
  assert.equal(entries.length, SAVED_SOLIDS_MAX);
  assert.match(result.message, new RegExp(`1 invalid entry.*1 past the ${SAVED_SOLIDS_MAX}-card limit`));
  assert.equal(result.persist, true);
  assert.deepEqual(entries.at(-1).ops, [{op: 'dual', params: {}}]);
});

test('imports refuse files without a saved-solid list', () => {
  assert.match(mergeSavedSolids('{}', []).message, /the file holds no list of saved solids/);
});

test('imports refuse malformed JSON', () => {
  assert.match(mergeSavedSolids('{', []).message, /import rejected/);
});

test('import rejects an op chain beyond its step limit', () => {
  const ops = Array.from({length: MAX_RECIPE_STEPS + 1}, () => ({op: 'dual', params: {}}));
  const entries = [];
  const result = mergeSavedSolids(JSON.stringify([{base: 'cube', ops}]), entries);
  assert.equal(result.added, 0);
  assert.match(result.message, new RegExp(`at most ${MAX_RECIPE_STEPS}`));
  assert.deepEqual(entries, []);
});

test('imported cards retain only safe typed fields and own their recipe', () => {
  const entry = {base: 'cube', ops: [{op: 'dual', params: {}}], thumb: 'javascript:x',
    title: '', desc: 'Description', stats: 'V8', unknown: 'discard', vCount: 'x', fCount: Infinity,
    iCount: 12, geodesics: 1, faces: false, colorize: true, vertices: 'yes', normals: null};
  const card = importedSavedSolid(entry);
  assert.deepEqual(card, {base: 'cube', ops: [{op: 'dual', params: {}}], thumb: '',
    title: 'Cube', desc: 'Description', stats: 'V8', iCount: 12, faces: false, colorize: true});
  entry.ops[0].op = 'kis';
  assert.equal(card.ops[0].op, 'dual');
  assert.equal(importedSavedSolid({...entry, thumb: 'data:image/png;base64,x'}).thumb, 'data:image/png;base64,x');
});

test('saved solids discard entries without exportable recipes', () => {
  const result = loadSavedSolids({ getItem: () => '[null, 1, false, "bad", [], {"base":"cube","ops":[]}, {"base":"cube","ops":[{"op":"dual","params":{}}]}]' });
  assert.equal(JSON.stringify(result.entries), '[{"base":"cube","ops":[{"op":"dual","params":{}}]}]');
  assert.equal(result.rejected.length, 6);
  assert.match(result.notice, /6 saved solids could not be loaded: not a saved-solid object/);
});

test('stale card backup failure cannot block the primary save', () => {
  const valid = {base: 'cube', ops: [{op: 'dual', params: {}}]};
  const stale = {base: 'cube', ops: [{op: 'truncate', params: {t: 50}}]};
  const storage = new Map([[SAVED_SOLIDS_KEY, JSON.stringify([valid, stale])], [REJECTED_SOLIDS_KEY, '[{"older":true}]']]);
  const writes = [];
  let refusingBackup = true;
  const localStorage = {getItem: key => storage.get(key), setItem(key, value) {
    writes.push(key);
    if (key === REJECTED_SOLIDS_KEY && refusingBackup) throw new Error('quota');
    storage.set(key, value);
  }};
  const savedStorage = loadSavedSolids(localStorage);
  assert.equal(savedStorage.entries.length, 1);
  assert.equal(savedStorage.rejected.length, 1);
  assert.match(savedStorage.notice, /1 saved solid could not be loaded.*out-of-range/);
  const pendingNotice = savedStorage.backupNotice;
  assert.ok(pendingNotice, 'a pending backup is announced');
  const status = {textContent: savedStorage.notice};
  const persist = () => { status.textContent = persistSavedSolids(localStorage, savedStorage.entries, savedStorage); };
  persist();
  assert.deepEqual(JSON.parse(storage.get(SAVED_SOLIDS_KEY)), [valid, stale]);
  assert.deepEqual(loadSavedSolids(localStorage).rejected, [stale]);
  assert.deepEqual(writes, [REJECTED_SOLIDS_KEY, SAVED_SOLIDS_KEY]);
  const failed = status.textContent;
  assert.ok(failed.startsWith(savedStorage.notice), failed);
  assert.ok(failed.length > `${savedStorage.notice} ${pendingNotice}`.length, 'the refused backup is reported');
  assert.equal(savedStorage.rejected.length, 1);
  refusingBackup = false;
  persist();
  assert.deepEqual(writes, [REJECTED_SOLIDS_KEY, SAVED_SOLIDS_KEY, REJECTED_SOLIDS_KEY, SAVED_SOLIDS_KEY]);
  assert.deepEqual(JSON.parse(storage.get(SAVED_SOLIDS_KEY)), [valid]);
  assert.deepEqual(JSON.parse(storage.get(REJECTED_SOLIDS_KEY)), [{older: true}, stale]);
  assert.equal(savedStorage.rejected.length, 0);
  assert.ok(status.textContent.startsWith(savedStorage.notice), status.textContent);
  assert.ok(savedStorage.backupNotice, 'a confirmed backup is announced');
  assert.notEqual(status.textContent, failed, 'success and failure read differently');
  assert.ok(!status.textContent.includes(pendingNotice), 'the pending notice is replaced');
  const confirmed = status.textContent;
  persist();
  assert.equal(status.textContent, confirmed);
  assert.deepEqual(JSON.parse(storage.get(REJECTED_SOLIDS_KEY)), [{older: true}, stale], 'later writes do not duplicate the backup');
});

test('a fully valid saved list needs no recovery notice or rejected backup', () => {
  const localStorage = {getItem: () => '[{"base":"cube","ops":[{"op":"dual","params":{}}]}]'};
  const loaded = loadSavedSolids(localStorage);
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.rejected.length, 0);
  assert.equal(loaded.notice, '');
});

test('a malformed saved solid is rejected before its restore is queued', () => {
  let queued = false;
  const error = queueSavedSolidRestore(
    { base: 'cube', ops: [{ op: 'unknown' }] },
    () => { queued = true; });

  assert.match(error, /unknown operator/);
  assert.equal(queued, false);

  assert.equal(queueSavedSolidRestore(
    { base: 'cube', ops: [] }, () => { queued = true; }), null);
  assert.equal(queued, true);
});

test('a full saved-solid list refuses before thumbnail capture', () => {
  let captures = 0;
  const capture = () => {
    captures++;
    return 'data:image/png;base64,test';
  };

  assert.deepEqual(captureSavedSolidThumbnail(SAVED_SOLIDS_MAX, capture),
    { full: true, dataURL: null });
  assert.equal(captures, 0);
  assert.deepEqual(captureSavedSolidThumbnail(SAVED_SOLIDS_MAX - 1, capture),
    { full: false, dataURL: 'data:image/png;base64,test' });
  assert.equal(captures, 1);
});
