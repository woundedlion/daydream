import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../generated/shader/sha256.mjs';
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

test('a committed shader document keeps its recorded digests', () => {
  const source = readFileSync(
    new URL('../generated/shader/patterns/example.shader.json', import.meta.url),
    'utf8',
  );
  const catalog = JSON.parse(readFileSync(
    new URL('../generated/shader/engine_catalog.json', import.meta.url),
    'utf8',
  ));
  const compiled = compileShaderDocument(source, { catalog });

  assert.equal(compiled.status, 'VALID');
  assert.equal(
    compiled.descriptor_digest,
    '7bfb4ca893490291c3e19f096580ea8faa1d6c9fd5c0a7d7e4648b64d46e467f',
  );
  assert.equal(
    compiled.preset_bank_digest,
    'a1ca741f5ff587a5f12ef5327e0ce809d446076b8795934e30d590730840e833',
  );
  assert.equal(sha256Hex(compiled.descriptor_json), compiled.descriptor_digest);
  assert.equal(
    createHash('sha256').update(compiled.descriptor_json).digest('hex'),
    compiled.descriptor_digest,
  );
});
