import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatFloatCpp } = await import('../tools/cpp_format.js');

/** A whole number keeps one fractional digit and the f suffix (never "2f"). */
test('formatFloatCpp: whole value renders as "2.0f"', () => {
  assert.equal(formatFloatCpp(2), '2.0f');
});

/** digits=0 (no fractional digits requested) still yields a valid literal, not "2f". */
test('formatFloatCpp: digits=0 whole value stays a valid float literal', () => {
  assert.equal(formatFloatCpp(2, 0), '2.0f');
  assert.equal(formatFloatCpp(-3, 0), '-3.0f');
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

/** `digits` is a floor: precision widens until the literal reads back as the same float32. */
test('formatFloatCpp: widens past the requested digits to keep the float32', () => {
  assert.equal(formatFloatCpp(0.12345678), '0.12345678f');
  assert.equal(formatFloatCpp(0.5, 0), '0.5f');
});

/**
 * A value whose significant figures fall past the 6th fractional digit keeps
 * them rather than rounding to a fraction of its magnitude.
 */
test('formatFloatCpp: small value keeps its significant figures', () => {
  const literal = formatFloatCpp(2.5714e-6);
  assert.notEqual(literal, '0.000003f');
  assert.equal(Math.fround(parseFloat(literal)), Math.fround(2.5714e-6));
});

/** Every emitted literal reads back as the float32 it was formatted from. */
test('formatFloatCpp: round-trips float32 across a value sweep', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const values = [0, 1, -1, 0.1, 1 / 3, Math.PI, 1e-7, 1e20, -2.5714e-6];
  for (let i = 0; i < 5000; i++) {
    values.push(rnd(), Math.pow(10, -8 + 11 * rnd()) * (rnd() < 0.5 ? -1 : 1));
  }
  for (const v of values) {
    const literal = formatFloatCpp(v);
    assert.match(literal, /^-?\d+\.\d+f$/, `plain decimal for ${v}`);
    assert.equal(Math.fround(parseFloat(literal)), Math.fround(v), `round-trip for ${v}`);
  }
});

/**
 * Non-finite input throws rather than emitting "NaNf" / "Infinityf", which the
 * C++ compiler would reject far from the GUI value that produced it.
 */
test('formatFloatCpp: non-finite input throws', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => formatFloatCpp(bad), /non-finite value/);
  }
});

/** toFixed switches to exponential at 1e21, so that magnitude throws instead. */
test('formatFloatCpp: magnitude at or above 1e21 throws', () => {
  assert.throws(() => formatFloatCpp(1e21), /exponential notation/);
  assert.throws(() => formatFloatCpp(-1e21), /exponential notation/);
  assert.equal(formatFloatCpp(1e20), '100000000000000000000.0f');
});

/** Below the toFixed(100) floor the small-value rescue cannot recover a digit. */
test('formatFloatCpp: magnitude below the max-precision floor throws', () => {
  assert.throws(() => formatFloatCpp(1e-200), /underflows to zero/);
  assert.throws(() => formatFloatCpp(-Number.MIN_VALUE), /underflows to zero/);
  assert.equal(formatFloatCpp(1e-100), `0.${'0'.repeat(99)}1f`);
});
