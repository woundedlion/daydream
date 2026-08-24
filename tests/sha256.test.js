//
// shader/sha256.mjs is the digest every shader document is keyed on: the
// descriptor and preset-bank identities compileShaderDocument publishes are its
// output over the canonical JSON. The published vectors pin the algorithm;
// node:crypto pins the padding and multi-block seams, which no published vector
// covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { sha256Hex } from '../shader/sha256.mjs';
import { compileShaderDocument } from '../shader/shader_workbench.mjs';

// FIPS 180-4 / RFC 6234 test vectors.
const PUBLISHED = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno' +
      'ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
];

/** Verifies the published vectors hash to their published digests. */
test('the published SHA-256 vectors hash to their published digests', () => {
  for (const [message, digest] of PUBLISHED) assert.equal(sha256Hex(message), digest);
});

/** Verifies the output is the lowercase hex form the digest fields carry. */
test('a digest is 64 lowercase hex characters', () => {
  for (const [message] of PUBLISHED) assert.match(sha256Hex(message), /^[0-9a-f]{64}$/);
});

/** Verifies the long-message vector, the only published one past 64 blocks. */
test('the one-million-character vector hashes to its published digest', () => {
  assert.equal(
    sha256Hex('a'.repeat(1000000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  );
});

/**
 * Verifies every length across the padding seam against the platform's own
 * SHA-256: 56..63 bytes leave no room for the 8-byte length and take an extra
 * block, and 64 lands exactly on a block boundary.
 */
test('every length around the padding seam agrees with node:crypto', () => {
  for (let length = 0; length <= 130; ++length) {
    const message = 'x'.repeat(length);
    assert.equal(
      sha256Hex(message),
      createHash('sha256').update(message).digest('hex'),
      `length ${length}`,
    );
  }
});

/** Verifies text is hashed as UTF-8 bytes rather than as code units. */
test('non-ASCII text is hashed as its UTF-8 bytes', () => {
  for (const message of ['é', '☃ snowman', '𝄞 clef', 'naïve café — 1000×']) {
    assert.equal(
      sha256Hex(message),
      createHash('sha256').update(message, 'utf8').digest('hex'),
      message,
    );
  }
});

/**
 * Verifies a committed authoring document keeps the descriptor and preset-bank
 * digests the workbench keys preset and effect matches on. A change to either
 * is a change to that identity.
 */
test('a committed shader document keeps its recorded digests', () => {
  const source = readFileSync(
    new URL('../shader/patterns/example.shader.json', import.meta.url),
    'utf8',
  );
  const catalog = JSON.parse(readFileSync(
    new URL('../shader/engine_catalog.json', import.meta.url),
    'utf8',
  ));
  const compiled = compileShaderDocument(source, { catalog });

  assert.equal(compiled.status, 'VALID');
  assert.equal(
    compiled.descriptor_digest,
    '1ed98bc04fb610b492de3da4b45a4cf3a6520bb21ae9e28099924855d3a7c8b4',
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
