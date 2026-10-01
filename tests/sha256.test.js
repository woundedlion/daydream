import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../generated/shader/sha256.mjs';
import { scratchChainDocument } from '../src/workbench/shader/chain_document_store.js';
import { compileShaderDocument } from '../generated/shader/shader_workbench.mjs';

test('SHA-256 agrees with Node across UTF-8 block and padding boundaries', () => {
  for (let length = 0; length <= 130; length++) {
    for (const character of ['a', '\u00e9', '\u20ac', '\u{1f600}']) {
      const width = Buffer.byteLength(character, 'utf8');
      const value = character.repeat(Math.floor(length / width)) + 'x'.repeat(length % width);
      assert.equal(Buffer.byteLength(value, 'utf8'), length);
      assert.equal(sha256Hex(value), createHash('sha256').update(value).digest('hex'),
        `${length} bytes using ${character}`);
    }
  }
});

test('a current shader document keeps its recorded digests', () => {
  const catalog = JSON.parse(readFileSync(
    new URL('../generated/shader/engine_catalog.json', import.meta.url),
    'utf8',
  ));
  const compiled = compileShaderDocument(scratchChainDocument(catalog), { catalog });

  assert.equal(compiled.status, 'VALID');
  assert.equal(
    compiled.descriptor_digest,
    'd795b7027a44f89bf080552da74b66d76ccde455d2f9c162e581298854c093c4',
  );
  assert.equal(
    compiled.preset_bank_digest,
    'b0f2e130ec19488f0e57b2b3c89839cebf89590c0969a140736c75aca6292091',
  );
  assert.equal(sha256Hex(compiled.descriptor_json), compiled.descriptor_digest);
  assert.equal(
    createHash('sha256').update(compiled.descriptor_json).digest('hex'),
    compiled.descriptor_digest,
  );
});
