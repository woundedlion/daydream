import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { decodeShaderStateHash, encodeShaderStateHash, CHAIN_SNAPSHOT_SCHEMA_VERSION }
  from '../src/workbench/shader/shader_deeplink.js';
import { documentFromChainSnapshot, scratchChainDocument }
  from '../src/workbench/shader/chain_document_store.js';
import { compileShaderDocument } from '../generated/shader/shader_workbench.mjs';

const CATALOG = JSON.parse(readFileSync(new URL('../generated/shader/engine_catalog.json', import.meta.url), 'utf8'));
const document = scratchChainDocument(CATALOG);
const current = () => ({schemaVersion: CHAIN_SNAPSHOT_SCHEMA_VERSION,
  chain: document.descriptor.chain.map(({label, operator}) => ({instance: label, operator})),
  parameters: [], modulation: [], animationsPaused: true});
const state = (chainSnapshot) => ({document, preset: document.preset_bank.presets[0].preset_id,
  bypassed: [], paused: true, chainSnapshot});
const rawHash = (value) => '#shader=v2.' + gzipSync(JSON.stringify({d: value.document,
  p: value.preset, b: value.bypassed, a: value.paused, s: value.chainSnapshot})).toString('base64url');

test('current documents and snapshots round-trip without conversion', async () => {
  const value = state(current());
  assert.equal(compileShaderDocument(document, {catalog: CATALOG}).status, 'VALID');
  assert.equal(compileShaderDocument(documentFromChainSnapshot(value.chainSnapshot, CATALOG),
    {catalog: CATALOG}).status, 'VALID');
  assert.deepEqual(JSON.parse(JSON.stringify(await decodeShaderStateHash(await encodeShaderStateHash(value)))), value);
});

for (const schemaVersion of [3, 4]) {
  test(`snapshot version ${schemaVersion} is refused by links and document import`, async () => {
    const snapshot = {...current(), schemaVersion};
    const before = structuredClone(snapshot);
    await assert.rejects(encodeShaderStateHash(state(snapshot)), /unsupported shader snapshot version/);
    await assert.rejects(decodeShaderStateHash(rawHash(state(snapshot))), /unsupported shader snapshot version/);
    assert.throws(() => documentFromChainSnapshot(snapshot, CATALOG), /unsupported chain snapshot/);
    assert.deepEqual(snapshot, before);
  });
}

for (const operator of ['sphere.lens.mobius.v2', 'sphere.displace.symmetric.v1',
  'colorize.generated-palette.v3', 'modulate.field.v1', 'modulate.hue-shift.v1']) {
  test(`retired operator ${operator} is refused without conversion`, () => {
    const retired = structuredClone(document);
    retired.descriptor.chain[0].operator = operator;
    const before = structuredClone(retired);
    assert.equal(compileShaderDocument(retired, {catalog: CATALOG}).status, 'INVALID');
    assert.throws(() => documentFromChainSnapshot({...current(),
      chain: [{instance: 'retired', operator}]}, CATALOG), /catalog carries no operator/);
    assert.deepEqual(retired, before);
  });
}
