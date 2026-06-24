// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { findBestRationalRatio, snapToRationalRatio, lissajous, lissajousCodeString } =
  await import('../tools/lissajous_math.js');

const TWO_PI = 2 * Math.PI;

/**
 * Brute-forces the smallest absolute error of any fraction M/N with both terms
 * in [1, maxDenominator], so tests can assert the search returns the genuinely
 * closest reachable fraction.
 * @param {number} value - Target real value to approximate.
 * @param {number} maxDenominator - Inclusive upper bound for both M and N.
 * @returns {number} The minimum |value - M/N| over the searched fraction grid.
 */
function closestError(value, maxDenominator) {
  let best = Infinity;
  for (let n = 1; n <= maxDenominator; n++) {
    for (let m = 1; m <= maxDenominator; m++) {
      best = Math.min(best, Math.abs(value - m / n));
    }
  }
  return best;
}

/** Verifies the exact value 0.5 snaps to the fraction 1/2. */
test('findBestRationalRatio: target 0.5 snaps to 1/2', () => {
  const { M, N } = findBestRationalRatio(0.5);
  assert.equal(M, 1);
  assert.equal(N, 2);
});

/** Verifies the value 1.5 snaps to the fraction 3/2. */
test('findBestRationalRatio: target ~1.5 snaps to 3/2', () => {
  const { M, N } = findBestRationalRatio(1.5);
  assert.equal(M, 3);
  assert.equal(N, 2);
});

/**
 * Verifies that for an irrational target both terms respect maxDenominator and
 * the returned fraction is the closest reachable approximation (3/1 for PI when
 * capped at 8, since fine fractions like 22/7 are out of reach).
 */
test('findBestRationalRatio: irrational (PI) clamped to maxDenominator returns the closest reachable fraction', () => {
  const maxDenominator = 8;
  const { M, N } = findBestRationalRatio(Math.PI, maxDenominator);
  assert.ok(M >= 1 && M <= maxDenominator, 'M within bound');
  assert.ok(N >= 1 && N <= maxDenominator, 'N within bound');
  const value = M / N;
  const expectedErr = closestError(Math.PI, maxDenominator);
  assert.ok(
    Math.abs(Math.abs(Math.PI - value) - expectedErr) < 1e-12,
    `ratio ${M}/${N} should be the closest reachable to PI`,
  );
  assert.equal(M, 3);
  assert.equal(N, 1);
});

/** Verifies the result is in simplest form (0.5 yields 1/2, not 2/4). */
test('findBestRationalRatio: simplest form preferred (0.5 → 1/2 not 2/4)', () => {
  const { M, N } = findBestRationalRatio(0.5);
  assert.equal(M, 1);
  assert.equal(N, 2);
});

/**
 * Verifies the input 0 returns the fraction 0/1 (its exact value), so a
 * deliberately-zeroed frequency stays zero rather than snapping up to the
 * passive frequency.
 */
test('findBestRationalRatio: value 0 returns 0/1 (stays zero, no snap-up)', () => {
  const { M, N } = findBestRationalRatio(0);
  assert.equal(M, 0);
  assert.equal(N, 1);
});

/**
 * A negative target must snap to the sign-flipped fraction (same magnitude as
 * its positive counterpart), not collapse to the closest positive ratio. The
 * sign rides on the numerator; the denominator stays positive.
 */
test('findBestRationalRatio: negative target snaps to the sign-flipped fraction', () => {
  const neg = findBestRationalRatio(-1.5);
  assert.equal(neg.M, -3);
  assert.equal(neg.N, 2);
  // Magnitude matches the positive target exactly (sign split off before search).
  const pos = findBestRationalRatio(1.5);
  assert.equal(Math.abs(neg.M), pos.M);
  assert.equal(neg.N, pos.N);
});

/** A negative active/passive ratio keeps its sign through the snap. */
test('snapToRationalRatio: negative ratio keeps its sign', () => {
  const { snappedActiveC, m, n } = snapToRationalRatio(-3, 2);
  assert.equal(m, -3);
  assert.equal(n, 2);
  assert.ok(snappedActiveC < 0, `expected negative snapped freq, got ${snappedActiveC}`);
});

/**
 * Verifies the returned fraction is always in lowest terms (gcd(M,N) === 1)
 * across a sweep of targets, so the ratio — and the closing period derived from
 * N — is never an unreduced multiple regardless of search iteration order.
 */
test('findBestRationalRatio: returned ratio is always reduced (gcd(M,N) === 1)', () => {
  const g = (a, b) => (b === 0 ? a : g(b, a % b));
  for (let v = 0.1; v <= 4.0; v += 0.07) {
    const { M, N } = findBestRationalRatio(v);
    assert.equal(g(M, N), 1, `ratio ${M}/${N} for value ${v.toFixed(2)} not reduced`);
  }
});

/**
 * Verifies snapping 6/4 to 3/2 preserves the rational ratio of the active to
 * passive frequency and yields the closing period T = 2π·n / passiveC.
 */
test('snapToRationalRatio: closing period equals 2π·n/passiveC for a known ratio', () => {
  // activeC/passiveC = 6/4 = 1.5 → 3/2.
  const passiveC = 4;
  const activeC = 6;
  const { m, n, snappedActiveC, closingPeriod } = snapToRationalRatio(activeC, passiveC);
  assert.equal(m, 3);
  assert.equal(n, 2);
  assert.equal(snappedActiveC, passiveC * (m / n));
  assert.equal(closingPeriod, (TWO_PI * n) / passiveC);
});

/** Verifies an equal active/passive frequency closes after one 2π/passiveC period. */
test('snapToRationalRatio: 1:1 ratio closes after one full 2π/passiveC period', () => {
  const passiveC = 5;
  const activeC = 5;
  const { m, n, closingPeriod } = snapToRationalRatio(activeC, passiveC);
  assert.equal(m, 1);
  assert.equal(n, 1);
  assert.equal(closingPeriod, TWO_PI / passiveC);
});

/**
 * Verifies a zero passive frequency is guarded: the ratio and closing period
 * would otherwise divide by zero and hand the caller Infinity/NaN. The active
 * frequency must pass through unchanged with a trivial 1/1 ratio and a finite
 * zero period.
 */
test('snapToRationalRatio: zero passive frequency yields finite values, not NaN/Infinity', () => {
  const { snappedActiveC, m, n, closingPeriod } = snapToRationalRatio(6, 0);
  assert.equal(snappedActiveC, 6);
  assert.equal(m, 1);
  assert.equal(n, 1);
  assert.equal(closingPeriod, 0);
  assert.ok(Number.isFinite(closingPeriod), 'closing period is finite');
});

/** Verifies the curve starts at (0, 1, 0) when t=0 (sin(0)=0, cos(0)=1). */
test('lissajous: at t=0 returns the expected point (0, 1, 0)', () => {
  // sin(0)=0, cos(0)=1: x = 0·cos(-a)=0, y = cos(0)=1, z = 0·sin(-a)=0.
  const p = lissajous(12, 5, 0, 0);
  assert.equal(p.x, 0);
  assert.equal(p.y, 1);
  assert.equal(p.z, 0);
});

/** Verifies every sampled point lies on the unit sphere (|point| ≈ 1). */
test('lissajous: point lies on the unit sphere (R = 1) for several t', () => {
  const m1 = 12, m2 = 5, a = 0.7;
  for (const t of [0, 0.1, 0.5, 1.0, 2.3, Math.PI, 5.5]) {
    const p = lissajous(m1, m2, a, t);
    const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    assert.ok(Math.abs(r - 1) < 1e-12, `|point| ≈ 1 at t=${t}, got ${r}`);
  }
});

/**
 * Verifies the C++ LissajousParams initializer string renders correctly: a 2π
 * domain as a PI_F multiple, a multi-period domain as a larger PI_F multiple
 * with phase in radians, and a non-2π domain as a plain float literal.
 */
test('lissajousCodeString emits a C++ LissajousParams initializer', () => {
  // Matches ChaoticStrings' built-in config{12.0f, 5.0f, 0, 2 * PI_F}.
  assert.equal(
    lissajousCodeString(12, 5, 0, TWO_PI),
    'LissajousParams{12.0f, 5.0f, 0.0f, 2 * PI_F}');

  assert.equal(
    lissajousCodeString(3, 2, 1.5708, 2 * TWO_PI),
    'LissajousParams{3.0f, 2.0f, 1.571f, 4 * PI_F}');

  assert.equal(
    lissajousCodeString(1.06, 1.06, 0, 5.909),
    'LissajousParams{1.06f, 1.06f, 0.0f, 5.909f}');
});
