// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  cmult, cadd, cdiv, snapComplex,
  elliptic, hyperbolic, loxodromic, parabolic, inversion, tumble, cayley,
  glslComplexFunctions,
} = await import('../tools/mobius_transforms.js');

const EPS = 1e-12;

/**
 * Asserts that a complex value equals an expected (re, im) within EPS.
 * @param {{re:number, im:number}} actual - The complex value under test.
 * @param {number} re - Expected real part.
 * @param {number} im - Expected imaginary part.
 * @param {string} [msg] - Optional label prefixed to the failure message.
 * @returns {void}
 */
function assertComplex(actual, re, im, msg) {
  assert.ok(
    Math.abs(actual.re - re) < EPS && Math.abs(actual.im - im) < EPS,
    `${msg || ''} got (${actual.re}, ${actual.im}); want (${re}, ${im})`);
}

/**
 * Asserts that every coefficient of a Mobius coefficient set is finite.
 * @param {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} coeffs - The {A,B,C,D} coefficient set to check.
 * @param {string} label - Context label prefixed to any failure message.
 * @returns {void}
 */
function assertFiniteCoeffs(coeffs, label) {
  for (const k of ['A', 'B', 'C', 'D']) {
    assert.ok(Number.isFinite(coeffs[k].re), `${label}: ${k}.re not finite`);
    assert.ok(Number.isFinite(coeffs[k].im), `${label}: ${k}.im not finite`);
  }
}

// --- snapComplex ----------------------------------------------------------

/** Values within threshold of zero collapse to exactly 0. */
test('snapComplex snaps near-zero values to exactly 0', () => {
  assert.equal(snapComplex(0.05), 0);
  assert.equal(snapComplex(-0.09), 0);
  assert.equal(snapComplex(0), 0);
});

/** Values within threshold of an integer snap to that integer. */
test('snapComplex snaps to the nearest integer within threshold', () => {
  assert.equal(snapComplex(0.98), 1);
  assert.equal(snapComplex(1.03), 1);
  assert.equal(snapComplex(-2.02), -2);
  assert.equal(snapComplex(1.96, 0.05), 2);
});

/** Values farther than threshold from an integer pass through unchanged. */
test('snapComplex leaves values outside threshold untouched', () => {
  assert.equal(snapComplex(0.5), 0.5);
  assert.equal(snapComplex(1.2), 1.2);
  assert.equal(snapComplex(-1.5), -1.5);
  // 1.93 is 0.07 from 2, just outside the 0.05 default threshold.
  assert.equal(snapComplex(1.93), 1.93);
});

/** A caller-supplied threshold overrides the default snap distance. */
test('snapComplex respects an explicit threshold', () => {
  assert.equal(snapComplex(1.09, 0.1), 1);
  assert.equal(snapComplex(1.09, 0.05), 1.09);
});

// --- complex arithmetic ---------------------------------------------------

/** Complex multiplication follows (a+bi)(c+di). */
test('cmult computes (a+bi)(c+di)', () => {
  // (1+2i)(3+4i) = -5 + 10i
  assertComplex(cmult({ re: 1, im: 2 }, { re: 3, im: 4 }), -5, 10, 'cmult');
  assertComplex(cmult({ re: 0, im: 1 }, { re: 0, im: 1 }), -1, 0, 'i*i');
});

/** Complex addition sums real and imaginary parts componentwise. */
test('cadd computes (a+bi)+(c+di)', () => {
  assertComplex(cadd({ re: 1, im: 2 }, { re: 3, im: -5 }), 4, -3, 'cadd');
});

/** Complex division follows (a+bi)/(c+di). */
test('cdiv computes (a+bi)/(c+di)', () => {
  // (1+0i)/(0+1i) = -i
  assertComplex(cdiv({ re: 1, im: 0 }, { re: 0, im: 1 }), 0, -1, 'cdiv 1/i');
  assertComplex(cdiv({ re: 3, im: 4 }, { re: 1, im: 0 }), 3, 4, 'cdiv /1');
});

/** Dividing by a ~zero denominator yields 0 rather than NaN/Infinity. */
test('cdiv guards against a near-zero denominator', () => {
  assertComplex(cdiv({ re: 1, im: 1 }, { re: 0, im: 0 }), 0, 0, 'cdiv by ~0');
});

// --- GLSL/JS parity -------------------------------------------------------
// The shader can't import the JS module, so the GLSL source for cmult/cadd/cdiv
// lives in mobius_transforms.js (glslComplexFunctions). These tests transpile
// that GLSL body to JS and assert it agrees with the JS functions, so the two
// implementations cannot silently diverge.

/**
 * Transpiles the body of one `CNum NAME(CNum p, CNum q) { ... return CNum(RE, IM); }`
 * GLSL function from `src` into a JS function over {re,im} operands.
 * @param {string} src - The GLSL source containing the function.
 * @param {string} name - The function name to extract (cmult/cadd/cdiv).
 * @returns {(p:{re:number,im:number}, q:{re:number,im:number}) => {re:number,im:number}}
 */
function transpileGlslCNum(src, name) {
  const body = src.slice(src.indexOf(`CNum ${name}(`));
  const open = body.indexOf('{');
  let depth = 0, end = -1;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) { end = i; break; }
  }
  // GLSL -> JS: `float` decls become `const`, `CNum(re, im)` constructors become
  // `{ re, im }` objects. Constructors can nest parens, so split args by the
  // top-level comma rather than with a regex.
  const toObj = (s) => {
    let out = '', i = 0;
    while ((i = s.indexOf('CNum(', i)) !== -1) {
      let depth = 0, j = i + 4, start = j + 1, comma = -1, end2 = -1;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') { if (--depth === 0) { end2 = j; break; } }
        else if (s[j] === ',' && depth === 1) comma = j;
      }
      out = s.slice(0, i)
        + `({ re: (${s.slice(start, comma)}), im: (${s.slice(comma + 1, end2)}) })`
        + s.slice(end2 + 1);
      s = out;
      i = 0;
    }
    return s;
  };
  const js = toObj(body.slice(open + 1, end).replace(/\bfloat\b/g, 'const'));
  // eslint-disable-next-line no-new-func
  return new Function('p', 'q', js);
}

const glsl = {
  cmult: transpileGlslCNum(glslComplexFunctions, 'cmult'),
  cadd: transpileGlslCNum(glslComplexFunctions, 'cadd'),
  cdiv: transpileGlslCNum(glslComplexFunctions, 'cdiv'),
};

/** The GLSL source defines exactly the three complex ops the JS module exports. */
test('glslComplexFunctions defines cmult, cadd and cdiv with the 1e-6 guard', () => {
  assert.match(glslComplexFunctions, /CNum cmult\(/);
  assert.match(glslComplexFunctions, /CNum cadd\(/);
  assert.match(glslComplexFunctions, /CNum cdiv\(/);
  assert.match(glslComplexFunctions, /denom < 1e-6/);
});

/** GLSL cmult/cadd/cdiv agree bit-for-bit with the JS versions across representative inputs. */
test('GLSL complex ops match the JS implementations', () => {
  const cases = [
    { re: 1, im: 2 }, { re: 3, im: 4 }, { re: 0, im: 1 }, { re: -2, im: 0.5 },
    { re: 0, im: 0 }, { re: 0.001, im: 0 }, { re: 1e-3, im: 1e-3 }, { re: -5, im: 7 },
  ];
  for (const p of cases) {
    for (const q of cases) {
      for (const [name, jsFn] of [['cmult', cmult], ['cadd', cadd], ['cdiv', cdiv]]) {
        const a = jsFn(p, q);
        const b = glsl[name](p, q);
        assert.equal(b.re, a.re, `${name}.re for p=${JSON.stringify(p)} q=${JSON.stringify(q)}`);
        assert.equal(b.im, a.im, `${name}.im for p=${JSON.stringify(p)} q=${JSON.stringify(q)}`);
      }
    }
  }
});

/** The 1e-6 guard fires identically in both: |q|^2 just below the threshold yields 0. */
test('GLSL and JS cdiv share the 1e-6 near-zero-denominator guard', () => {
  // |q|^2 = 1.6e-7 < 1e-6 -> guarded to 0 in both.
  const q = { re: 4e-4, im: 0 };
  assert.ok(q.re * q.re < 1e-6);
  const a = cdiv({ re: 1, im: 1 }, q);
  const b = glsl.cdiv({ re: 1, im: 1 }, q);
  assert.deepEqual(b, a);
  assertComplex(a, 0, 0, 'cdiv guarded');
});

// --- preset generators ----------------------------------------------------

/** elliptic(0) yields the identity coefficients (A=1, B=0, C=0, D=1). */
test('elliptic at t=0 is the identity transform', () => {
  const c = elliptic(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

/** inversion(0) yields the identity coefficients. */
test('inversion at t=0 is the identity transform', () => {
  const c = inversion(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

/** tumble(0) yields the identity coefficients. */
test('tumble at t=0 is the identity transform', () => {
  const c = tumble(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

/** hyperbolic(0) yields the identity coefficients (unit scale). */
test('hyperbolic at t=0 is the identity transform (scale 1)', () => {
  const c = hyperbolic(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

/** parabolic(0) is the identity, and its B coefficient grows linearly (B.re = t * 0.8). */
test('parabolic at t=0 is the identity, and B drifts linearly', () => {
  const c0 = parabolic(0);
  assertComplex(c0.A, 1, 0, 'A');
  assertComplex(c0.B, 0, 0, 'B');
  assertComplex(c0.C, 0, 0, 'C');
  assertComplex(c0.D, 1, 0, 'D');
  // B.re = t * 0.8
  assertComplex(parabolic(2.5).B, 2.0, 0, 'B@2.5');
});

/** cayley(0) is the identity; for t >= 2 the blend saturates to the Cayley map (1, -i, 1, i). */
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

/** loxodromic(0) yields the identity coefficients. */
test('loxodromic at t=0 is the identity transform', () => {
  const c = loxodromic(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

// --- non-trivial goldens (catch a sign flip or wrong rate) ----------------
// Expected coefficients are derived from the closed form at a chosen t, not by
// calling the generator, so a wrong rotation rate/sign/conjugate fails here.

/** elliptic(pi): angle = pi/2, so A = i and D = conj(A) = -i. */
test('elliptic at t=pi rotates a quarter turn (A=i, D=-i)', () => {
  const c = elliptic(Math.PI);
  assertComplex(c.A, 0, 1, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 0, -1, 'D');
});

/** hyperbolic(1): s = sqrt(e^0.4) = e^0.2, so A = e^0.2, D = e^-0.2. */
test('hyperbolic at t=1 scales by e^0.2 (A=e^0.2, D=e^-0.2)', () => {
  const c = hyperbolic(1);
  assertComplex(c.A, Math.exp(0.2), 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, Math.exp(-0.2), 0, 'D');
});

/** loxodromic(1): angle=0.3, s=e^0.15; A=s*e^{i0.3}, D=(1/s)*e^{-i0.3}. */
test('loxodromic at t=1 spirals (scale e^0.15, angle 0.3)', () => {
  const c = loxodromic(1);
  assertComplex(c.A, Math.exp(0.15) * Math.cos(0.3), Math.exp(0.15) * Math.sin(0.3), 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, Math.exp(-0.15) * Math.cos(0.3), -Math.exp(-0.15) * Math.sin(0.3), 'D');
});

/** inversion(pi): theta=pi/2 -> c=0,s=1, so B=C=i and A=D=0. */
test('inversion at t=pi swaps 0/inf (B=C=i, A=D=0)', () => {
  const c = inversion(Math.PI);
  assertComplex(c.A, 0, 0, 'A');
  assertComplex(c.B, 0, 1, 'B');
  assertComplex(c.C, 0, 1, 'C');
  assertComplex(c.D, 0, 0, 'D');
});

/** tumble(pi/0.8): theta=pi/2 -> c=0,s=1, so B=-1, C=1 (the sign asymmetry). */
test('tumble at theta=pi/2 gives B=-1, C=1', () => {
  const c = tumble(Math.PI / 0.8);
  assertComplex(c.A, 0, 0, 'A');
  assertComplex(c.B, -1, 0, 'B');
  assertComplex(c.C, 1, 0, 'C');
  assertComplex(c.D, 0, 0, 'D');
});

/** Every preset generator returns finite A,B,C,D coefficients across a spread of t values. */
test('all preset generators produce finite coefficients across a range of t', () => {
  const gens = { elliptic, hyperbolic, loxodromic, parabolic, inversion, tumble, cayley };
  for (const t of [0, 0.1, 1, 2.5, 5, 10, 42]) {
    for (const [name, gen] of Object.entries(gens)) {
      assertFiniteCoeffs(gen(t), `${name}@${t}`);
    }
  }
});
