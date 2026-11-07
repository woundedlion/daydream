import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {compileShaderDocument, DEFAULT_LIMITS} from '../generated/shader/shader_workbench.mjs';
import {scratchChainDocument} from '../src/workbench/shader/chain_document_store.js';
import {
  CHAIN_SNAPSHOT_SCHEMA_VERSION, createShaderLinkWriter, decodeShaderStateHash,
  encodeShaderStateHash, replaceShaderStateHash,
} from '../src/workbench/shader/shader_deeplink.js';

const SCRATCH = scratchChainDocument(JSON.parse(readFileSync(
  new URL('../generated/shader/engine_catalog.json', import.meta.url), 'utf8')));

test('refusing a shader link invalidates an active encode until the link is released', async () => {
  const hashes = [];
  let releases = 0;
  const writer = createShaderLinkWriter({
    canWrite: () => true,
    readState: () => ({document: SCRATCH, preset: 'one', bypassed: [], paused: false}),
    replace: (hash) => hashes.push(hash),
    onError: (error) => assert.fail(error),
    onOriginalLinkReleased: () => { releases += 1; },
  });
  writer.schedule();
  const stale = writer.flush();
  writer.refuseLink();
  writer.schedule();
  await stale;
  await writer.flush();
  assert.deepEqual(hashes, []);
  assert.equal(writer.preservesOriginalLink(), true);

  writer.releaseOriginalLink();
  writer.releaseOriginalLink();
  assert.equal(releases, 1);
  writer.schedule();
  await writer.dispose();
  writer.schedule();
  await writer.flush();
  assert.equal(hashes.length, 1);
  assert.equal((await decodeShaderStateHash(hashes[0])).preset, 'one');
});

test('shader state hashes round-trip the complete authoring state', async () => {
  const state = {
    document: { document_id: 'study-λ', descriptor: { chain: [{ label: 'camera' }, { label: 'warp1' }] } },
    preset: 'night',
    bypassed: ['camera', 'warp1'],
    paused: true,
  };
  const hash = await encodeShaderStateHash(state);

  assert.match(hash, /^#shader=v2\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(JSON.stringify(await decodeShaderStateHash(hash))), state);
  assert.equal(await decodeShaderStateHash('#unrelated'), null);
  await assert.rejects(decodeShaderStateHash('#shader=v2.not-gzip'),
    /invalid shader link payload/);
});

test('shader links reject callable snapshots carrying the current schema version', async () => {
  const chainSnapshot = Object.assign(() => {}, {
    schemaVersion: CHAIN_SNAPSHOT_SCHEMA_VERSION, chain: [], parameters: [], modulation: [],
  });
  await assert.rejects(encodeShaderStateHash({document: SCRATCH,
    preset: 'one', bypassed: [], paused: false, chainSnapshot}), /invalid shader link snapshot/);
});

test('v2 shader links retain typed runtime and palette state', async () => {
  const state = {
    document: {descriptor: {chain: [{label: 'source'}]}},
    preset: 'night', bypassed: [], paused: true,
    chainSnapshot: {
      schemaVersion: CHAIN_SNAPSHOT_SCHEMA_VERSION, chain: [{instance: 'source', operator: 'sample.grid.v4'}],
      modulation: [], parameters: [{name: 'source.pattern-freq', value: 1}], animationsPaused: true,
      runtime: [{instance: 'source', kind: 'source-clock-v1',
        state: {primary: 1.25, secondary: 0.5, angle: 2}}],
      paletteBank: {chroma: 0.75, hues: [0, 159, 318],
        cycles: [{frame: 713, nextSequence: 7, fadeActive: true, displayDirty: false}]},
    },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(
    await decodeShaderStateHash(await encodeShaderStateHash(state)))), state);
  await assert.rejects(encodeShaderStateHash({...state, chainSnapshot: {schemaVersion: 1}}),
    /unsupported shader snapshot version/);
  const unsupportedSnapshot = {...state.chainSnapshot, schemaVersion: 2};
  await assert.rejects(encodeShaderStateHash({...state, chainSnapshot: unsupportedSnapshot}),
    /unsupported shader snapshot version/);
  const missingModulation = structuredClone(state.chainSnapshot);
  delete missingModulation.modulation;
  await assert.rejects(encodeShaderStateHash({...state, chainSnapshot: missingModulation}),
    /invalid shader link snapshot/);
});

test('shader links bound the expanded UTF-8 state including its wrapper', async () => {
  const limit = 524288;
  const compact = { d: { metadata: '' }, p: 'night', b: [], a: false };
  const wrapperBytes = Buffer.byteLength(JSON.stringify(compact));
  for (const size of [limit - 1, limit, limit + 1]) {
    const paddingBytes = size - wrapperBytes;
    compact.d.metadata = '\u03bb'.repeat(Math.floor(paddingBytes / 2))
      + 'x'.repeat(paddingBytes % 2);
    assert.equal(Buffer.byteLength(JSON.stringify(compact)), size);
    const state = {
      document: compact.d, preset: compact.p, bypassed: compact.b, paused: compact.a,
    };
    if (size <= limit) {
      const hash = await encodeShaderStateHash(state);
      assert.ok(hash.length < 4096);
      assert.deepEqual(JSON.parse(JSON.stringify(await decodeShaderStateHash(hash))), state);
    } else {
      await assert.rejects(encodeShaderStateHash(state), /shader link state is too large/);
      const payload = gzipSync(JSON.stringify(compact)).toString('base64url');
      await assert.rejects(decodeShaderStateHash(`#shader=v2.${payload}`),
        /shader link state is too large/);
    }
  }
});

test('a deep-linked document is held to the reader string limit', async () => {
  const overlong = 'x'.repeat(DEFAULT_LIMITS.stringLength + 1);
  const linked = async (/** @type {*} */ document) => {
    const hash = await encodeShaderStateHash(
      { document, preset: 'night', bypassed: [], paused: false });
    const state = await decodeShaderStateHash(hash);
    return compileShaderDocument(state.document);
  };
  const codes = (/** @type {*} */ compiled) =>
    compiled.diagnostics.map((/** @type {*} */ diagnostic) => diagnostic.code);

  const nested = { document_id: 'study', descriptor: { chain: [{ label: overlong }] } };
  assert.equal((await linked(nested)).status, 'INVALID');
  assert.deepEqual(codes(await linked(nested)), ['STRING_LIMIT']);
  assert.deepEqual(codes(await linked({ document_id: 'study', [overlong]: 1 })),
    ['STRING_LIMIT']);
  // The text path is the reference the deep link has to answer with.
  assert.deepEqual(codes(compileShaderDocument(JSON.stringify(nested))), ['STRING_LIMIT']);
});

test('shader state hash replacement preserves the route and query', () => {
  const writes = [];
  const win = {
    location: { pathname: '/tools/shader.html', search: '?effect=KaleidoscopeStainedGlass' },
    history: { replaceState: (state, title, url) => writes.push(url) },
  };

  assert.equal(replaceShaderStateHash('#shader=v2.payload', win), true);
  assert.deepEqual(writes, [
    '/tools/shader.html?effect=KaleidoscopeStainedGlass#shader=v2.payload',
  ]);
});

test('shader links reject malformed compact state before it reaches the store', async () => {
  const state = { d: { descriptor: { chain: [{}, {}] } }, p: 'preset', b: [], a: false };
  for (const invalid of [
    { ...state, d: [] }, { ...state, p: '' }, { ...state, b: 'x' },
    { ...state, b: [1] }, { ...state, b: ['a', 'a'] },
    { ...state, b: ['a', 'b', 'c'] }, { ...state, a: 'yes' },
  ]) {
    const payload = gzipSync(JSON.stringify(invalid)).toString('base64url');
    await assert.rejects(decodeShaderStateHash(`#shader=v2.${payload}`),
      { message: 'invalid shader link state' });
  }
});

test('shader links reject duplicate document keys before information is lost', async () => {
  for (const source of [
    '{"d":{"document_id":"first","document_id":"second"},"p":"p","b":[],"a":false}',
    '{"d":{"e\\u0301":1,"\\u00e9":2},"p":"p","b":[],"a":false}',
  ]) {
    const payload = gzipSync(source).toString('base64url');
    await assert.rejects(decodeShaderStateHash(`#shader=v2.${payload}`),
      (error) => error.cause?.code === 'DUPLICATE_KEY');
  }
});

test('unsupported shader hash versions are rejected', async () => {
  for (const version of [0, 1, 3]) {
    await assert.rejects(decodeShaderStateHash(`#shader=v${version}.payload`),
      /unsupported shader link version/);
  }
});

test('shader links refuse null snapshot entries before initializing a candidate', async () => {
  for (const [chain, parameters, modulation = []] of [
    [[], [null]], [[null], []], [[], [{name: 42}]],
    [[], [], [null]], [[], [], [[]]], [[], [], [3]],
  ]) {
    const compact = {d: {descriptor: {chain: []}}, p: 'night', b: [], a: true,
      s: {schemaVersion: CHAIN_SNAPSHOT_SCHEMA_VERSION, chain, parameters, modulation}};
    const payload = gzipSync(JSON.stringify(compact)).toString('base64url');
    await assert.rejects(decodeShaderStateHash(`#shader=v2.${payload}`), /invalid shader link snapshot/);
    await assert.rejects(encodeShaderStateHash({document: compact.d, preset: compact.p,
      bypassed: compact.b, paused: compact.a, chainSnapshot: compact.s}), /invalid shader link snapshot/);
  }
});
