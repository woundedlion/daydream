import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../generated/shader/sha256.mjs';
import { compileShaderDocument } from '../generated/shader/shader_workbench.mjs';

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
