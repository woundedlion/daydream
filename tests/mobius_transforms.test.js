// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  cmult, cadd, cdiv, snapComplex,
  elliptic, hyperbolic, loxodromic, parabolic, inversion, tumble, cayley,
} = await import('../tools/mobius_transforms.js');

const EPS = 1e-12;

/** Asserts a complex { re, im } equals expected within EPS. */
function assertComplex(actual, re, im, msg) {
  assert.ok(
    Math.abs(actual.re - re) < EPS && Math.abs(actual.im - im) < EPS,
    `${msg || ''} got (${actual.re}, ${actual.im}); want (${re}, ${im})`);
}

/** Asserts every coefficient of a {A,B,C,D} set is finite. */
function assertFiniteCoeffs(coeffs, label) {
  for (const k of ['A', 'B', 'C', 'D']) {
    assert.ok(Number.isFinite(coeffs[k].re), `${label}: ${k}.re not finite`);
    assert.ok(Number.isFinite(coeffs[k].im), `${label}: ${k}.im not finite`);
  }
}

// --- snapComplex ----------------------------------------------------------

test('snapComplex snaps near-zero values to exactly 0', () => {
  assert.equal(snapComplex(0.05), 0);
  assert.equal(snapComplex(-0.09), 0);
  assert.equal(snapComplex(0), 0);
});

test('snapComplex snaps to the nearest integer within threshold', () => {
  assert.equal(snapComplex(0.98), 1);
  assert.equal(snapComplex(1.03), 1);
  assert.equal(snapComplex(-2.02), -2);
  assert.equal(snapComplex(1.96, 0.05), 2);
});

test('snapComplex leaves values outside threshold untouched', () => {
  assert.equal(snapComplex(0.5), 0.5);
  assert.equal(snapComplex(1.2), 1.2);
  assert.equal(snapComplex(-1.5), -1.5);
  // 1.93 is 0.07 from 2 -> outside the default 0.05 threshold.
  assert.equal(snapComplex(1.93), 1.93);
});

test('snapComplex respects an explicit threshold', () => {
  assert.equal(snapComplex(1.09, 0.1), 1);
  assert.equal(snapComplex(1.09, 0.05), 1.09);
});

// --- complex arithmetic ---------------------------------------------------

test('cmult computes (a+bi)(c+di)', () => {
  // (1 + 2i)(3 + 4i) = 3 + 4i + 6i + 8i^2 = -5 + 10i
  assertComplex(cmult({ re: 1, im: 2 }, { re: 3, im: 4 }), -5, 10, 'cmult');
  // i * i = -1
  assertComplex(cmult({ re: 0, im: 1 }, { re: 0, im: 1 }), -1, 0, 'i*i');
});

test('cadd computes (a+bi)+(c+di)', () => {
  assertComplex(cadd({ re: 1, im: 2 }, { re: 3, im: -5 }), 4, -3, 'cadd');
});

test('cdiv computes (a+bi)/(c+di)', () => {
  // (1 + 0i) / (0 + 1i) = -i
  assertComplex(cdiv({ re: 1, im: 0 }, { re: 0, im: 1 }), 0, -1, 'cdiv 1/i');
  // (3 + 4i) / (1 + 0i) = 3 + 4i
  assertComplex(cdiv({ re: 3, im: 4 }, { re: 1, im: 0 }), 3, 4, 'cdiv /1');
});

test('cdiv guards against a near-zero denominator', () => {
  assertComplex(cdiv({ re: 1, im: 1 }, { re: 0, im: 0 }), 0, 0, 'cdiv by ~0');
});

// --- preset generators ----------------------------------------------------

test('elliptic at t=0 is the identity transform', () => {
  const c = elliptic(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

test('inversion at t=0 is the identity transform', () => {
  const c = inversion(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

test('tumble at t=0 is the identity transform', () => {
  const c = tumble(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

test('hyperbolic at t=0 is the identity transform (scale 1)', () => {
  const c = hyperbolic(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

test('parabolic at t=0 is the identity, and B drifts linearly', () => {
  const c0 = parabolic(0);
  assertComplex(c0.A, 1, 0, 'A');
  assertComplex(c0.B, 0, 0, 'B');
  assertComplex(c0.C, 0, 0, 'C');
  assertComplex(c0.D, 1, 0, 'D');
  // B.re = t * 0.8
  assertComplex(parabolic(2.5).B, 2.0, 0, 'B@2.5');
});

test('cayley at t=0 is the identity and saturates to Cayley (1,-i,1,i)', () => {
  assertComplex(cayley(0).A, 1, 0, 'A@0');
  assertComplex(cayley(0).B, 0, 0, 'B@0');
  assertComplex(cayley(0).C, 0, 0, 'C@0');
  assertComplex(cayley(0).D, 1, 0, 'D@0');
  // p saturates at 1 for t >= 2 -> A=1, B=-i, C=1, D=i
  const sat = cayley(10);
  assertComplex(sat.A, 1, 0, 'A_sat');
  assertComplex(sat.B, 0, -1, 'B_sat');
  assertComplex(sat.C, 1, 0, 'C_sat');
  assertComplex(sat.D, 0, 1, 'D_sat');
});

test('loxodromic at t=0 is the identity transform', () => {
  const c = loxodromic(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

test('all preset generators produce finite coefficients across a range of t', () => {
  const gens = { elliptic, hyperbolic, loxodromic, parabolic, inversion, tumble, cayley };
  for (const t of [0, 0.1, 1, 2.5, 5, 10, 42]) {
    for (const [name, gen] of Object.entries(gens)) {
      assertFiniteCoeffs(gen(t), `${name}@${t}`);
    }
  }
});
