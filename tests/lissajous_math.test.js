// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { findBestRationalRatio, snapToRationalRatio, lissajous, lissajousCodeString } =
  await import('../tools/lissajous_math.js');

const TWO_PI = 2 * Math.PI;

// Brute-force the true closest M/N within [1, maxDenominator]^2 so tests can
// assert the search returns the genuinely closest reachable fraction.
function closestError(value, maxDenominator) {
  let best = Infinity;
  for (let n = 1; n <= maxDenominator; n++) {
    for (let m = 1; m <= maxDenominator; m++) {
      best = Math.min(best, Math.abs(value - m / n));
    }
  }
  return best;
}

test('findBestRationalRatio: target 0.5 snaps to 1/2', () => {
  const { M, N } = findBestRationalRatio(0.5);
  assert.equal(M, 1);
  assert.equal(N, 2);
});

test('findBestRationalRatio: target ~1.5 snaps to 3/2', () => {
  const { M, N } = findBestRationalRatio(1.5);
  assert.equal(M, 3);
  assert.equal(N, 2);
});

test('findBestRationalRatio: irrational (PI) clamped to maxDenominator returns the closest reachable fraction', () => {
  const maxDenominator = 8;
  const { M, N } = findBestRationalRatio(Math.PI, maxDenominator);
  // Both terms must respect the bound.
  assert.ok(M >= 1 && M <= maxDenominator, 'M within bound');
  assert.ok(N >= 1 && N <= maxDenominator, 'N within bound');
  // Returned ratio must equal the closest achievable approximation. Because the
  // numerator is capped at 8, fine fractions like 22/7 are out of reach, so the
  // best reachable approximation to PI is 3/1.
  const value = M / N;
  const expectedErr = closestError(Math.PI, maxDenominator);
  assert.ok(
    Math.abs(Math.abs(Math.PI - value) - expectedErr) < 1e-12,
    `ratio ${M}/${N} should be the closest reachable to PI`,
  );
  assert.equal(M, 3);
  assert.equal(N, 1);
});

test('findBestRationalRatio: simplest form preferred (0.5 → 1/2 not 2/4)', () => {
  const { M, N } = findBestRationalRatio(0.5);
  assert.equal(M, 1);
  assert.equal(N, 2);
});

test('findBestRationalRatio: value 0 returns 1/1', () => {
  const { M, N } = findBestRationalRatio(0);
  assert.equal(M, 1);
  assert.equal(N, 1);
});

test('snapToRationalRatio: closing period equals 2π·n/passiveC for a known ratio', () => {
  // activeC/passiveC = 6/4 = 1.5 → 3/2.
  const passiveC = 4;
  const activeC = 6;
  const { m, n, snappedActiveC, closingPeriod } = snapToRationalRatio(activeC, passiveC);
  assert.equal(m, 3);
  assert.equal(n, 2);
  // Snapped frequency preserves the rational ratio against the passive one.
  assert.equal(snappedActiveC, passiveC * (m / n));
  // The documented closing relation: T = 2π·n / passiveC.
  assert.equal(closingPeriod, (TWO_PI * n) / passiveC);
});

test('snapToRationalRatio: 1:1 ratio closes after one full 2π/passiveC period', () => {
  const passiveC = 5;
  const activeC = 5;
  const { m, n, closingPeriod } = snapToRationalRatio(activeC, passiveC);
  assert.equal(m, 1);
  assert.equal(n, 1);
  assert.equal(closingPeriod, TWO_PI / passiveC);
});

test('lissajous: at t=0 returns the expected point (0, 1, 0)', () => {
  // sin(0)=0, cos(0)=1: x = 0·cos(-a)=0, y = cos(0)=1, z = 0·sin(-a)=0.
  const p = lissajous(12, 5, 0, 0);
  assert.equal(p.x, 0);
  assert.equal(p.y, 1);
  assert.equal(p.z, 0);
});

test('lissajous: point lies on the unit sphere (R = 1) for several t', () => {
  const m1 = 12, m2 = 5, a = 0.7;
  for (const t of [0, 0.1, 0.5, 1.0, 2.3, Math.PI, 5.5]) {
    const p = lissajous(m1, m2, a, t);
    const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    assert.ok(Math.abs(r - 1) < 1e-12, `|point| ≈ 1 at t=${t}, got ${r}`);
  }
});

test('lissajousCodeString emits a C++ LissajousParams initializer', () => {
  // The 12:5 default at zero phase over one full 2π period — matches
  // ChaoticStrings' built-in config{12.0f, 5.0f, 0, 2 * PI_F}.
  assert.equal(
    lissajousCodeString(12, 5, 0, TWO_PI),
    'LissajousParams{12.0f, 5.0f, 0.0f, 2 * PI_F}');

  // Multi-period domain renders as a PI_F multiple; phase stays in radians.
  assert.equal(
    lissajousCodeString(3, 2, 1.5708, 2 * TWO_PI),
    'LissajousParams{3.0f, 2.0f, 1.571f, 4 * PI_F}');

  // A non-2π domain falls back to a plain float literal.
  assert.equal(
    lissajousCodeString(1.06, 1.06, 0, 5.909),
    'LissajousParams{1.06f, 1.06f, 0.0f, 5.909f}');
});
