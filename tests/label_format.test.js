// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prettify } from '../label_format.js';

const PHI = (1 + Math.sqrt(5)) / 2;

// Symbolic glyphs spelled with escapes so the expectations are independent of
// this file's own text encoding.
const PI = 'π';        // π
const PHI_GLYPH = 'φ'; // φ
const INV = '⁻¹'; // superscript -1
const SQRT = '√';      // √

test('prettify snaps the basic constants', () => {
  assert.equal(prettify(0), '0');
  assert.equal(prettify(1), '1');
  assert.equal(prettify(-1), '-1');
});

test('prettify names multiples of pi', () => {
  assert.equal(prettify(Math.PI), PI);
  assert.equal(prettify(-Math.PI), '-' + PI);
  assert.equal(prettify(Math.PI / 2), PI + '/2');
  assert.equal(prettify(Math.PI / 4), PI + '/4');
  assert.equal(prettify(3 * Math.PI / 2), '3' + PI + '/2');
});

test('prettify names the golden ratio and its inverse', () => {
  assert.equal(prettify(PHI), PHI_GLYPH);              // φ ≈ 1.618
  assert.equal(prettify(1 / PHI), PHI_GLYPH + INV);    // φ⁻¹ ≈ 0.618
  assert.equal(prettify(1 / Math.sqrt(3)), SQRT + '3' + INV);
});

test('prettify snaps within the 1e-5 tolerance but not outside it', () => {
  assert.equal(prettify(Math.PI + 5e-6), PI);          // inside the band -> symbol
  assert.equal(prettify(Math.PI + 5e-4), '3.142');     // outside -> 3-decimal string
});

test('prettify falls back to a 3-decimal string for arbitrary values', () => {
  assert.equal(prettify(0.333333), '0.333');
  assert.equal(prettify(2.5), '2.500');
});
