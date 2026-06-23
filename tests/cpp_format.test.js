// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatFloatCpp } = await import('../tools/cpp_format.js');

/** A whole number keeps one fractional digit and the f suffix (never "2f"). */
test('formatFloatCpp: whole value renders as "2.0f"', () => {
  assert.equal(formatFloatCpp(2), '2.0f');
});

/** Trailing zeros are trimmed but at least one fractional digit remains. */
test('formatFloatCpp: trims trailing zeros to a single fractional digit', () => {
  assert.equal(formatFloatCpp(1.5), '1.5f');
  assert.equal(formatFloatCpp(1.25, 6), '1.25f');
});

/** Output is plain decimal, never scientific notation. */
test('formatFloatCpp: never emits scientific notation', () => {
  assert.ok(!formatFloatCpp(1e-7).includes('e'));
  assert.ok(!formatFloatCpp(1e-7).includes('E'));
});

/**
 * A nonzero value below the requested precision must NOT collapse to "0.0f":
 * it is re-rounded with enough digits to keep its significant figures.
 */
test('formatFloatCpp: small nonzero value is preserved, not zeroed', () => {
  assert.equal(formatFloatCpp(1e-7), '0.0000001f');
  assert.equal(formatFloatCpp(1.5e-7, 6), '0.00000015f');
  // The default 6-digit path would have rounded these to "0.0f".
  assert.notEqual(formatFloatCpp(1e-7), '0.0f');
});

/** A genuine zero still renders as "0.0f". */
test('formatFloatCpp: zero renders as "0.0f"', () => {
  assert.equal(formatFloatCpp(0), '0.0f');
});

/** Negative small values keep their sign and magnitude. */
test('formatFloatCpp: negative small value keeps sign and magnitude', () => {
  assert.equal(formatFloatCpp(-1e-7), '-0.0000001f');
});
