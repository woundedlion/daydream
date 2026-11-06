import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadSavedSolids, mergeSavedSolids, persistSavedSolids, SAVED_SOLIDS_MAX,
  SAVED_SOLIDS_KEY, REJECTED_SOLIDS_KEY, importedSavedSolid, resolveSavedSolidsStorage} from '../src/workbench/solids/solid_saved_store.js';

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

test('invalid storage survives until a successful bounded rejected backup', () => {
  const values = new Map([[SAVED_SOLIDS_KEY, '{broken']]);
  const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  const loaded = loadSavedSolids(storage);
  assert.deepEqual(loaded.entries, []);
  assert.deepEqual(loaded.rejected, ['{broken']);
  assert.match(persistSavedSolids(storage, loaded.entries, loaded), /invalid saved-solid JSON/);
  assert.deepEqual(JSON.parse(values.get(REJECTED_SOLIDS_KEY)), ['{broken']);
  assert.equal(loaded.rejected.length, 0);
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

test('imports report malformed files and preserve capacity without mutating their source', () => {
  const entries = Array.from({length: SAVED_SOLIDS_MAX - 1}, () => ({base: 'cube', ops: [{op: 'dual', params: {}}]}));
  const card = {base: 'cube', ops: [{op: 'dual', params: {}}], title: 'Imported'};
  const result = mergeSavedSolids(JSON.stringify([card, card, null]), entries);
  assert.equal(result.added, 1);
  assert.equal(entries.length, SAVED_SOLIDS_MAX);
  assert.match(result.message, /1 invalid entries.*1 past the 40-card limit/);
  assert.equal(result.persist, true);
  assert.equal(mergeSavedSolids('{}', entries).added, 0);
  assert.match(mergeSavedSolids('{', entries).message, /import rejected/);
  assert.deepEqual(entries.at(-1).ops, [{op: 'dual', params: {}}]);
  assert.notEqual(entries.at(-1), card);
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
