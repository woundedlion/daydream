import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  cmult, cadd, snapComplex,
  elliptic, hyperbolic, loxodromic, parabolic, inversion, tumble, cayley,
  glslComplexFunctions, glslProjectionFunctions, mobiusCodeString,
  stereo, projectDiv, STEREO_INF, STEREO_POLE_EPS, STEREO_AZIMUTH_EPS,
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
 * The determinant AD - BC of a Mobius coefficient set.
 * @param {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} coeffs - The {A,B,C,D} coefficient set.
 * @returns {{re:number, im:number}} The determinant.
 */
function determinant({ A, B, C, D }) {
  const ad = cmult(A, D);
  const bc = cmult(B, C);
  return { re: ad.re - bc.re, im: ad.im - bc.im };
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


// --- GLSL/JS parity -------------------------------------------------------
// The shader can't import the JS module, so the GLSL source for cmult/cadd
// lives in mobius_transforms.js (glslComplexFunctions). These tests transpile
// that GLSL body to JS and assert it agrees with the JS functions, so the two
// implementations cannot silently diverge.

/**
 * Transpiles the `const float NAME = VALUE;` declarations of a GLSL source into
 * a JS declaration preamble, so a transpiled body reads the constants the shader
 * itself compiles rather than a hand-copied second set.
 * @param {string} src - The GLSL source to scan.
 * @returns {{js: string, values: Object<string, number>}} The preamble and the values it evaluates to.
 * @details The values come from evaluating the preamble, so a constant the
 * shader derives from an earlier one is read as the shader computes it rather
 * than parsed as a literal.
 */
function glslConstants(src) {
  const decls = [...src.matchAll(/const\s+float\s+(\w+)\s*=\s*([^;]+);/g)];
  const js = decls.map(([, name, value]) => `const ${name} = ${value};`).join('\n');
  const names = decls.map(([, name]) => name);
  const values = new Function(`${js}\nreturn { ${names.join(', ')} };`)();
  return { js, values };
}

/**
 * Transpiles the body of one `CNum NAME(...) { ... return CNum(RE, IM); }`
 * GLSL function from `src` into a JS function over its arguments.
 * @param {string} src - The GLSL source containing the function.
 * @param {string} name - The function name to extract.
 * @param {string[]} [params] - The JS parameter names, in signature order.
 * @returns {Function} The transpiled function.
 */
function transpileGlslCNum(src, name, params = ['p', 'q']) {
  const body = src.slice(src.indexOf(`CNum ${name}(`));
  const open = body.indexOf('{');
  let depth = 0, end = -1;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) { end = i; break; }
  }
  // GLSL -> JS: `float` decls become `const`, the built-in math functions gain
  // their `Math.` prefix, and `CNum(re, im)` constructors become `{ re, im }`
  // objects. Constructors can nest parens, so split args by the top-level comma
  // rather than with a regex.
  const toObj = (s) => {
    let i = 0;
    while ((i = s.indexOf('CNum(', i)) !== -1) {
      let depth = 0, j = i + 4, start = j + 1, comma = -1, end2 = -1;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') { if (--depth === 0) { end2 = j; break; } }
        else if (s[j] === ',' && depth === 1) comma = j;
      }
      s = s.slice(0, i)
        + `({ re: (${s.slice(start, comma)}), im: (${s.slice(comma + 1, end2)}) })`
        + s.slice(end2 + 1);
      i = 0;
    }
    return s;
  };
  const js = toObj(body.slice(open + 1, end)
    .replace(/\bfloat\b/g, 'const')
    .replace(/\b(sqrt|abs|max|min)\(/g, 'Math.$1('));
  return new Function(...params, `${glslConstants(src).js}\n${js}`);
}

const glsl = {
  cmult: transpileGlslCNum(glslComplexFunctions, 'cmult'),
  cadd: transpileGlslCNum(glslComplexFunctions, 'cadd'),
  stereo: transpileGlslCNum(glslProjectionFunctions, 'stereo', ['v']),
  projectDiv: transpileGlslCNum(glslProjectionFunctions, 'project_div', ['num', 'den']),
};

/** The GLSL source defines exactly the complex ops the shader calls. */
test('glslComplexFunctions defines cmult and cadd', () => {
  assert.match(glslComplexFunctions, /CNum cmult\(/);
  assert.match(glslComplexFunctions, /CNum cadd\(/);
  assert.doesNotMatch(glslComplexFunctions, /CNum cdiv\(/,
    'the shader divides through project_div; a GLSL cdiv would be dead source');
});

/** GLSL cmult/cadd agree bit-for-bit with the JS versions across representative inputs. */
test('GLSL complex ops match the JS implementations', () => {
  const cases = [
    { re: 1, im: 2 }, { re: 3, im: 4 }, { re: 0, im: 1 }, { re: -2, im: 0.5 },
    { re: 0, im: 0 }, { re: 0.001, im: 0 }, { re: 1e-3, im: 1e-3 }, { re: -5, im: 7 },
  ];
  for (const p of cases) {
    for (const q of cases) {
      for (const [name, jsFn] of [['cmult', cmult], ['cadd', cadd]]) {
        const a = jsFn(p, q);
        const b = glsl[name](p, q);
        assert.equal(b.re, a.re, `${name}.re for p=${JSON.stringify(p)} q=${JSON.stringify(q)}`);
        assert.equal(b.im, a.im, `${name}.im for p=${JSON.stringify(p)} q=${JSON.stringify(q)}`);
      }
    }
  }
});

// --- projection-domain conventions ----------------------------------------
// These mirror core/math/stereographic.h (STEREO_INF, stereo, project_div). The
// engine owns them; the shader renders what the engine will run, so a
// divergence would make the preview lie about the pole cap and about a
// near-singular divisor.

/** The GLSL prelude declares the same projection constants the JS module exports. */
test('glslProjectionFunctions constants match the JS exports', () => {
  const { values } = glslConstants(glslProjectionFunctions);
  assert.equal(values.STEREO_INF, STEREO_INF);
  assert.equal(values.STEREO_POLE_EPS, STEREO_POLE_EPS);
  assert.equal(values.STEREO_AZIMUTH_EPS, STEREO_AZIMUTH_EPS);
});

/**
 * Absolute pin on the projection constants. WASM parity tests
 * diffs them against core/math/stereographic.h, but only where an engine
 * checkout is present; these literals hold the values where it is not.
 */
test('projection constants hold their engine values (absolute pin)', () => {
  assert.equal(STEREO_INF, 1e4, 'STEREO_INF is the engine sentinel');
  assert.equal(STEREO_POLE_EPS, 2 / (STEREO_INF * STEREO_INF),
    'STEREO_POLE_EPS is the pole cap derived from STEREO_INF');
  assert.equal(STEREO_POLE_EPS, 2e-8, 'STEREO_POLE_EPS value');
  assert.equal(STEREO_AZIMUTH_EPS, 1e-12, 'STEREO_AZIMUTH_EPS value');
});

/**
 * The pole cap is the crossover where the raw quotient reaches the sentinel, not
 * a guard band: just outside it stereo() is still the finite quotient, whose
 * magnitude is STEREO_INF to within the step across the threshold.
 */
test('the pole cap begins where the raw quotient reaches STEREO_INF', () => {
  const outside = 1 - STEREO_POLE_EPS * 1.5;
  const w = stereo({ x: Math.sqrt(1 - outside * outside), y: outside, z: 0 });
  assert.ok(w.re < STEREO_INF, `outside the cap got ${w.re}`);
  assert.ok(w.re > STEREO_INF * 0.8, `outside the cap got ${w.re}`);

  // a cap 5000x wider would flatten this disk onto the sentinel
  const inner = 1 - 1e-4;
  const finite = stereo({ x: Math.sqrt(1 - inner * inner), y: inner, z: 0 });
  assert.ok(Math.abs(finite.re - Math.sqrt(2 / 1e-4 - 1)) < 1e-3,
    `1 - y = 1e-4 must stay finite, got ${finite.re}`);
});

/**
 * Outside the pole cap stereo() is the plain quotient; inside it the result
 * carries the sentinel magnitude along the point's own (x,z) azimuth, so the
 * cap is not painted a single constant colour.
 */
test('stereo keeps the pole cap azimuth at the sentinel magnitude', () => {
  const equator = stereo({ x: 1, y: 0, z: 0 });
  assertComplex(equator, 1, 0, 'stereo at (1,0,0)');
  assertComplex(stereo({ x: 0, y: 0, z: 1 }), 0, 1, 'stereo at (0,0,1)');

  // A point inside the cap (1 - y < STEREO_POLE_EPS) but off the axis.
  const y = 1 - STEREO_POLE_EPS / 2;
  const r = Math.sqrt(1 - y * y);
  for (const [ux, uz] of [[1, 0], [0, 1], [-1, 0], [Math.SQRT1_2, -Math.SQRT1_2]]) {
    const w = stereo({ x: r * ux, y, z: r * uz });
    assert.ok(Math.abs(Math.hypot(w.re, w.im) - STEREO_INF) < 1e-6,
      `cap point (${ux},${uz}) magnitude ${Math.hypot(w.re, w.im)}`);
    assert.ok(Math.abs(Math.atan2(w.im, w.re) - Math.atan2(uz, ux)) < 1e-9,
      `cap point (${ux},${uz}) lost its azimuth`);
  }

  // Only the exact pole, whose azimuth is undefined, falls back to +real.
  assertComplex(stereo({ x: 0, y: 1, z: 0 }), STEREO_INF, 0, 'stereo at the pole');
});

/**
 * project_div's guard is relative (|num| vs |den| * STEREO_INF), not an
 * absolute test on |den|: a large numerator over a moderate divisor still
 * saturates, and a small numerator over a tiny divisor still divides.
 */
test('projectDiv saturates on the relative magnitude, not an absolute divisor', () => {
  const ordinary = projectDiv({ re: 4, im: 2 }, { re: 2, im: 0 });
  assertComplex(ordinary, 2, 1, 'projectDiv ordinary');

  // |num| / |den| = 1e5 > STEREO_INF -> clamped along the numerator direction.
  const big = projectDiv({ re: 1e5, im: 0 }, { re: 1, im: 0 });
  assertComplex(big, STEREO_INF, 0, 'projectDiv saturated');
  const bigDiag = projectDiv({ re: 1e5, im: 1e5 }, { re: 1, im: 0 });
  assert.ok(Math.abs(Math.hypot(bigDiag.re, bigDiag.im) - STEREO_INF) < 1e-6);
  assert.ok(Math.abs(Math.atan2(bigDiag.im, bigDiag.re) - Math.PI / 4) < 1e-12);

  // A divisor an absolute |den|^2 < 1e-6 guard would zero out still divides.
  const tiny = { re: 4e-4, im: 0 };
  assertComplex(projectDiv({ re: 1e-6, im: 0 }, tiny), 1e-6 / 4e-4, 0,
    'projectDiv relative guard');

  // Only an exactly zero numerator is the indeterminate form.
  assertComplex(projectDiv({ re: 0, im: 0 }, { re: 0, im: 0 }), 0, 0, 'projectDiv 0/0');
});

/**
 * The saturating branch normalizes by the peak component before squaring, so a
 * numerator whose squared magnitude overflows to infinity (or underflows to
 * zero) keeps its direction instead of collapsing onto the origin. Doubles
 * overflow at ~1e154 where the shader's floats overflow at ~2e19, so these
 * exponents stand in for the fp32 case the engine guards.
 */
test('projectDiv keeps the direction when the squared magnitude is out of range', () => {
  const huge = projectDiv({ re: 3e200, im: 0 }, { re: 1, im: 0 });
  assertComplex(huge, STEREO_INF, 0, 'projectDiv overflowing numerator');

  const tiny = projectDiv({ re: 0, im: -3e-200 }, { re: 0, im: 0 });
  assertComplex(tiny, 0, -STEREO_INF, 'projectDiv underflowing numerator');

  const diagonal = projectDiv({ re: -3e200, im: 3e200 }, { re: 1, im: 0 });
  assert.ok(Math.abs(Math.hypot(diagonal.re, diagonal.im) - STEREO_INF) < 1e-6,
    `magnitude ${Math.hypot(diagonal.re, diagonal.im)}`);
  assert.ok(Math.abs(Math.atan2(diagonal.im, diagonal.re) - 3 * Math.PI / 4) < 1e-12,
    'diagonal azimuth');
});

/** The GLSL stereo/project_div bodies agree with the JS twins the shader mirrors. */
test('GLSL projection ops match the JS implementations', () => {
  const points = [
    { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: -1, z: 0 },
    { x: 0, y: 1, z: 0 }, { x: 0.48, y: 0.6, z: 0.64 }, { x: 0.6, y: -0.8, z: 0 },
    { x: 6e-3, y: 1 - 2e-5, z: -8e-3 },
  ];
  for (const v of points) {
    assert.deepEqual(glsl.stereo(v), stereo(v), `stereo at ${JSON.stringify(v)}`);
  }
  const complexes = [
    { re: 1, im: 2 }, { re: 0, im: 0 }, { re: 1e5, im: 0 }, { re: 4e-4, im: 0 },
    { re: -2, im: 0.5 }, { re: STEREO_INF, im: 0 }, { re: 1e-6, im: 1e-6 },
    { re: 3e200, im: -3e200 }, { re: 0, im: 3e-200 },
  ];
  for (const num of complexes) {
    for (const den of complexes) {
      assert.deepEqual(glsl.projectDiv(num, den), projectDiv(num, den),
        `project_div(${JSON.stringify(num)}, ${JSON.stringify(den)})`);
    }
  }
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

/** parabolic(0) yields the identity coefficients. */
test('parabolic at t=0 is the identity transform', () => {
  const c = parabolic(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

/** cayley(0) yields the identity coefficients. */
test('cayley at t=0 is the identity transform', () => {
  const c = cayley(0);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
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

/** parabolic(2.5): B.re = t * 0.8 = 2; A, C and D stay at the identity. */
test('parabolic at t=2.5 translates by 2 along the real axis', () => {
  const c = parabolic(2.5);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 2, 0, 'B');
  assertComplex(c.C, 0, 0, 'C');
  assertComplex(c.D, 1, 0, 'D');
});

/** cayley(1): p = t * 0.5 = 0.5, the half-blend of identity toward (1,-i,1,i). */
test('cayley at t=1 is the half-blend toward the Cayley map', () => {
  const c = cayley(1);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, -0.5, 'B');
  assertComplex(c.C, 0.5, 0, 'C');
  assertComplex(c.D, 0.5, 0.5, 'D');
});

/** cayley saturates the blend at p = 1 for t >= 2: A=1, B=-i, C=1, D=i. */
test('cayley saturates to the Cayley map (1,-i,1,i) for t >= 2', () => {
  const c = cayley(10);
  assertComplex(c.A, 1, 0, 'A');
  assertComplex(c.B, 0, -1, 'B');
  assertComplex(c.C, 1, 0, 'C');
  assertComplex(c.D, 0, 1, 'D');
});

// --- mobiusCodeString -----------------------------------------------------

/** The identity coefficients emit the engine's default MobiusParams. */
test('mobiusCodeString emits the identity as a C++ MobiusParams initializer', () => {
  const z = (re, im) => ({ re, im });
  assert.equal(
    mobiusCodeString(z(1, 0), z(0, 0), z(0, 0), z(1, 0)),
    'MobiusParams{1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f}');
});

/** Coefficients are emitted as real/imaginary pairs in a,b,c,d order. */
test('mobiusCodeString orders the eight floats as re/im per coefficient', () => {
  const z = (re, im) => ({ re, im });
  assert.equal(
    mobiusCodeString(z(1, 2), z(3, 4), z(5, 6), z(7, 8)),
    'MobiusParams{1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f, 7.0f, 8.0f}');
});

/** A live preset sample round-trips through the float formatter. */
test('mobiusCodeString formats fractional preset coefficients', () => {
  const c = cayley(1);
  assert.equal(
    mobiusCodeString(c.A, c.B, c.C, c.D),
    'MobiusParams{1.0f, 0.0f, 0.0f, -0.5f, 0.5f, 0.0f, 0.5f, 0.5f}');
});

/**
 * Six of the presets are unimodular: AD - BC stays at 1 for every t, so a
 * negated term, a swapped coefficient or a lost reciprocal fails here. cayley
 * blends toward a non-unimodular map, so it only has to stay non-degenerate;
 * its determinant runs from 1 at p=0 to 2i at p=1.
 */
test('preset generators hold their determinant across a range of t', () => {
  const unimodular = { elliptic, hyperbolic, loxodromic, parabolic, inversion, tumble };
  for (const t of [0, 0.1, 1, 2.5, 5, 10, 42]) {
    for (const [name, gen] of Object.entries(unimodular)) {
      assertComplex(determinant(gen(t)), 1, 0, `${name}@${t} determinant`);
    }
    const d = determinant(cayley(t));
    assert.ok(Math.hypot(d.re, d.im) > 0.5,
      `cayley@${t} determinant (${d.re}, ${d.im}) is degenerate`);
  }
});
