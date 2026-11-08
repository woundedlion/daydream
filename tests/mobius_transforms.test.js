import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constructorToObject, glslConstants } from './helpers/source_transpile.js';

import {
  cmult, cadd, snapCoefficientComponent, mobiusDeterminant, isDegenerate,
  elliptic, hyperbolic, loxodromic, parabolic, inversion, tumble, cayley,
  glslComplexFunctions, glslProjectionFunctions, mobiusCodeString,
  stereo, projectDiv, STEREO_INF, STEREO_POLE_EPS, STEREO_AZIMUTH_EPS,
  STEREO_UNDERFLOW_LIFT,
  MOBIUS_GRID_SCALE_R, DEGENERATE_DETERMINANT_EPS,
} from '../src/workbench/mobius/mobius_transforms.js';

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

// --- snapCoefficientComponent ----------------------------------------------------------

/** Values within twice the threshold of zero collapse to exactly 0. */
test('snapCoefficientComponent snaps near-zero values to exactly 0', () => {
  assert.equal(snapCoefficientComponent(0.05), 0);
  assert.equal(snapCoefficientComponent(-0.09), 0);
  assert.equal(snapCoefficientComponent(0), 0);
});

/** Values within threshold of an integer snap to that integer. */
test('snapCoefficientComponent snaps to the nearest integer within threshold', () => {
  assert.equal(snapCoefficientComponent(0.98), 1);
  assert.equal(snapCoefficientComponent(1.03), 1);
  assert.equal(snapCoefficientComponent(-2.02), -2);
  assert.equal(snapCoefficientComponent(1.96, 0.05), 2);
});

/** Values farther than threshold from an integer pass through unchanged. */
test('snapCoefficientComponent leaves values outside threshold untouched', () => {
  assert.equal(snapCoefficientComponent(0.5), 0.5);
  assert.equal(snapCoefficientComponent(1.2), 1.2);
  assert.equal(snapCoefficientComponent(-1.5), -1.5);
  // 1.93 is 0.07 from 2, just outside the 0.05 default threshold.
  assert.equal(snapCoefficientComponent(1.93), 1.93);
});

/** A caller-supplied threshold overrides the default snap distance. */
test('snapCoefficientComponent respects an explicit threshold', () => {
  assert.equal(snapCoefficientComponent(1.09, 0.1), 1);
  assert.equal(snapCoefficientComponent(1.09, 0.05), 1.09);
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
// glslComplexFunctions' GLSL cmult/cadd, transpiled to JS and compared with the
// JS functions.

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
  // GLSL -> JS: `float` decls become `let`, the built-in math functions gain
  // their `Math.` prefix, and `CNum(re, im)` constructors become `{ re, im }`
  // objects. Constructors can nest parens, so split args by the top-level comma.
  const js = constructorToObject(body.slice(open + 1, end)
    .replace(/\bfloat\b/g, 'let')
    .replace(/\b(sqrt|abs|max|min)\(/g, 'Math.$1('), 'CNum');
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
// Mirrors of core/math/stereographic.h and core/math/mobius.h (STEREO_INF,
// stereo, project_div).

/** The GLSL prelude declares the same projection constants the JS module exports. */
test('glslProjectionFunctions constants match the JS exports', () => {
  const { values } = glslConstants(glslProjectionFunctions);
  assert.equal(values.STEREO_INF, STEREO_INF);
  assert.equal(values.STEREO_POLE_EPS, STEREO_POLE_EPS);
  assert.equal(values.STEREO_AZIMUTH_EPS, STEREO_AZIMUTH_EPS);
  assert.equal(values.STEREO_UNDERFLOW_LIFT, STEREO_UNDERFLOW_LIFT);
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

  // The exact pole uses the real-axis sentinel.
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

  // |num| / |den| = 1e5 > STEREO_INF -> clamped along the quotient direction.
  const big = projectDiv({ re: 1e5, im: 0 }, { re: 1, im: 0 });
  assertComplex(big, STEREO_INF, 0, 'projectDiv saturated');
  const bigDiag = projectDiv({ re: 1e5, im: 1e5 }, { re: 1, im: 0 });
  assert.ok(Math.abs(Math.hypot(bigDiag.re, bigDiag.im) - STEREO_INF) < 1e-6);
  assert.ok(Math.abs(Math.atan2(bigDiag.im, bigDiag.re) - Math.PI / 4) < 1e-12);
  // 1e4 / -i = 1e4 i: a non-real divisor turns the saturated direction.
  assertComplex(projectDiv({ re: 1e4, im: 0 }, { re: 0, im: -1 }), 0, STEREO_INF,
    'projectDiv saturated over a non-real divisor');

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

/**
 * A nonzero divisor whose square underflows to zero is not the pole: the pair
 * is lifted back into range and divides to the finite quotient, where reading
 * the zero as an exact pole would send it to the sentinel along the numerator.
 */
test('projectDiv lifts a divisor whose square underflows', () => {
  const den = { re: 1e-170, im: 0 };
  assert.equal(den.re * den.re, 0, 'the divisor squared must underflow for the case to bind');
  assertComplex(projectDiv({ re: 2e-170, im: -1e-170 }, den), 2, -1,
    'projectDiv lifted quotient');
  assertComplex(projectDiv({ re: 0, im: 3e-170 }, { re: 0, im: -1e-170 }), -3, 0,
    'projectDiv lifted imaginary divisor');

  const saturated = projectDiv({ re: 1e-160, im: 0 }, den);
  assertComplex(saturated, STEREO_INF, 0, 'a lifted quotient still saturates');
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
    { re: 3e200, im: -3e200 }, { re: 0, im: 3e-200 }, { re: 1e-170, im: -2e-170 },
  ];
  for (const num of complexes) {
    for (const den of complexes) {
      assert.deepEqual(glsl.projectDiv(num, den), projectDiv(num, den),
        `project_div(${JSON.stringify(num)}, ${JSON.stringify(den)})`);
    }
  }
});

// --- preset generators ----------------------------------------------------

/** Preset generators, keyed by export name. */
const GENERATORS = { elliptic, hyperbolic, loxodromic, parabolic, inversion, tumble, cayley };

/** Every preset starts from the identity coefficients (A=1, B=0, C=0, D=1). */
test('every preset generator is the identity at t=0', () => {
  for (const [name, gen] of Object.entries(GENERATORS)) {
    const c = gen(0);
    assertComplex(c.A, 1, 0, `${name} A`);
    assertComplex(c.B, 0, 0, `${name} B`);
    assertComplex(c.C, 0, 0, `${name} C`);
    assertComplex(c.D, 1, 0, `${name} D`);
  }
});

/**
 * The two scaling presets wrap their log-scale parameter inside
 * [0, 1/MOBIUS_GRID_SCALE_R), so the flow is seamless: 2·ln|A| never leaves
 * one grid period.
 */
test('the scaling presets keep their log-scale inside one flow period', () => {
  const logPeriod = 1 / MOBIUS_GRID_SCALE_R;
  for (const [name, gen] of [['hyperbolic', hyperbolic], ['loxodromic', loxodromic]]) {
    let highest = 0;
    for (let i = 0; i <= 4000; i++) {
      const t = i / 20;
      const logScale = 2 * Math.log(Math.hypot(gen(t).A.re, gen(t).A.im));
      assert.ok(logScale > -EPS && logScale < logPeriod,
        `${name} log-scale ${logScale} at t=${t} leaves [0, ${logPeriod})`);
      highest = Math.max(highest, logScale);
    }
    assert.ok(highest > logPeriod / 2, `${name} flows across the period`);
  }
});

// --- preset flow structure --------------------------------------------------
// Each preset's defining coefficient shape, checked independently of its rate.

/** Times across the flow; SMALL_T is early enough that no preset has wrapped. */
const FLOW_TIMES = [0.001, 0.1, 1, Math.PI, 2.5, 5, 42];
const SMALL_T = 1e-3;

/**
 * @param {{re:number, im:number}} z - A nonzero complex value.
 * @returns {{re:number, im:number}} 1/z.
 */
const reciprocal = (z) => {
  const norm = z.re * z.re + z.im * z.im;
  return { re: z.re / norm, im: -z.im / norm };
};

/** elliptic is a pure rotation: |A| = 1, D = conj(A), B = C = 0. */
test('elliptic rotates about the origin and turns counterclockwise', () => {
  for (const t of FLOW_TIMES) {
    const c = elliptic(t);
    assert.ok(Math.abs(Math.hypot(c.A.re, c.A.im) - 1) < EPS, `|A| at t=${t}`);
    assertComplex(c.D, c.A.re, -c.A.im, `D at t=${t}`);
    assertComplex(c.B, 0, 0, `B at t=${t}`);
    assertComplex(c.C, 0, 0, `C at t=${t}`);
  }
  assert.ok(elliptic(SMALL_T).A.im > 0, 'arg A grows for small t');
});

/** hyperbolic is a pure real scaling: A real, D = 1/A, B = C = 0. */
test('hyperbolic scales along the real axis away from the origin', () => {
  for (const t of FLOW_TIMES) {
    const c = hyperbolic(t);
    assert.ok(Math.abs(c.A.im) < EPS && c.A.re > 0, `A real at t=${t}`);
    assertComplex(c.D, 1 / c.A.re, 0, `D at t=${t}`);
    assertComplex(c.B, 0, 0, `B at t=${t}`);
    assertComplex(c.C, 0, 0, `C at t=${t}`);
  }
  assert.ok(hyperbolic(SMALL_T).A.re > 1, 'A grows past 1 for small t');
});

/** loxodromic scales and rotates at once: D = 1/A, B = C = 0. */
test('loxodromic spirals with D the reciprocal of A', () => {
  for (const t of FLOW_TIMES) {
    const c = loxodromic(t);
    const inverse = reciprocal(c.A);
    assertComplex(c.D, inverse.re, inverse.im, `D at t=${t}`);
    assertComplex(c.B, 0, 0, `B at t=${t}`);
    assertComplex(c.C, 0, 0, `C at t=${t}`);
  }
  const early = loxodromic(SMALL_T).A;
  assert.ok(Math.hypot(early.re, early.im) > 1 && early.im > 0,
    'A both grows and turns for small t');
});

/** inversion rotates about the real axis: A = D real, B = C imaginary. */
test('inversion keeps A = D real and B = C imaginary', () => {
  for (const t of FLOW_TIMES) {
    const c = inversion(t);
    assert.ok(Math.abs(c.A.im) < EPS, `A real at t=${t}`);
    assertComplex(c.D, c.A.re, 0, `D at t=${t}`);
    assert.ok(Math.abs(c.B.re) < EPS, `B imaginary at t=${t}`);
    assertComplex(c.C, 0, c.B.im, `C at t=${t}`);
  }
  assert.ok(inversion(SMALL_T).B.im > 0, 'the rotation starts for small t');
});

/** tumble rotates about the imaginary axis: A = D real, B = -C real. */
test('tumble keeps A = D real and B = -C real', () => {
  for (const t of FLOW_TIMES) {
    const c = tumble(t);
    assert.ok(Math.abs(c.A.im) < EPS, `A real at t=${t}`);
    assertComplex(c.D, c.A.re, 0, `D at t=${t}`);
    assert.ok(Math.abs(c.C.im) < EPS, `C real at t=${t}`);
    assertComplex(c.B, -c.C.re, 0, `B at t=${t}`);
  }
  assert.ok(tumble(SMALL_T).C.re > 0, 'C turns positive for small t');
});

/** parabolic is a real translation: A = D = 1, C = 0, B real. */
test('parabolic translates along the real axis', () => {
  for (const t of FLOW_TIMES) {
    const c = parabolic(t);
    assertComplex(c.A, 1, 0, `A at t=${t}`);
    assertComplex(c.C, 0, 0, `C at t=${t}`);
    assertComplex(c.D, 1, 0, `D at t=${t}`);
    assert.ok(Math.abs(c.B.im) < EPS, `B real at t=${t}`);
  }
  assert.ok(parabolic(SMALL_T).B.re > 0, 'the translation starts toward +re');
});

test('parabolic translation stays inside the pad without wrap discontinuities', () => {
  for (let i = -2000; i <= 2000; ++i) {
    const t = i / 100;
    const value = parabolic(t).B.re;
    assert.ok(value >= -2 && value <= 2);
    assert.ok(Math.abs(parabolic(t + 0.001).B.re - value) < 0.01,
      'a wrap would jump across the pad');
  }
});

/** cayley blends identity toward (1, -i, 1, i) by a fraction p that only grows. */
test('cayley blends monotonically from the identity toward the Cayley map', () => {
  let previous = 0;
  for (let i = 0; i <= 400; i++) {
    const c = cayley(i / 40);
    const p = c.C.re;
    assert.ok(p >= previous - EPS && p <= 1 + EPS, `blend ${p} at t=${i / 40}`);
    assertComplex(c.A, 1, 0, 'A');
    assertComplex(c.B, 0, -p, 'B');
    assertComplex(c.C, p, 0, 'C');
    assertComplex(c.D, 1 - p, p, 'D');
    previous = p;
  }
  assert.ok(previous > 0, 'the blend moves off the identity');
});

/** cayley saturates the blend at p = 1 for large t: A=1, B=-i, C=1, D=i. */
test('cayley saturates to the Cayley map (1,-i,1,i) for large t', () => {
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
    'math::MobiusParams{1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f}');
});

/** Coefficients are emitted as real/imaginary pairs in a,b,c,d order. */
test('mobiusCodeString orders the eight floats as re/im per coefficient', () => {
  const z = (re, im) => ({ re, im });
  assert.equal(
    mobiusCodeString(z(1, 2), z(3, 4), z(5, 6), z(7, 8)),
    'math::MobiusParams{1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f, 7.0f, 8.0f}');
});

/** Fractional coefficients round-trip through the float formatter. */
test('mobiusCodeString formats fractional coefficients', () => {
  const z = (re, im) => ({ re, im });
  assert.equal(
    mobiusCodeString(z(1, 0), z(0, -0.5), z(0.5, 0), z(0.5, 0.5)),
    'math::MobiusParams{1.0f, 0.0f, 0.0f, -0.5f, 0.5f, 0.0f, 0.5f, 0.5f}');
});

/**
 * The unimodular presets keep AD - BC at 1 for every t. cayley blends toward a
 * non-unimodular map, so it only has to stay non-degenerate; its determinant
 * runs from 1 at p=0 to 2i at p=1.
 */
test('preset generators hold their determinant across a range of t', () => {
  const unimodular = { elliptic, hyperbolic, loxodromic, parabolic, inversion, tumble };
  for (const t of [0, 0.1, 1, 2.5, 5, 10, 42]) {
    for (const [name, gen] of Object.entries(unimodular)) {
      assertComplex(mobiusDeterminant(gen(t)), 1, 0, `${name}@${t} determinant`);
    }
    const d = mobiusDeterminant(cayley(t));
    assert.ok(Math.hypot(d.re, d.im) > 0.5,
      `cayley@${t} determinant (${d.re}, ${d.im}) is degenerate`);
  }
});

test('projectDiv rescales subnormal nonzero divisor magnitudes', () => {
  for (const scale of [1e-160, 3e-162]) {
    assert.ok(scale * scale > 0 && scale * scale < 2 ** -1022);
    assertComplex(projectDiv({ re: 3 * scale, im: -scale }, { re: scale, im: 0 }),
      3, -1, 'subnormal real divisor');
    assertComplex(projectDiv({ re: scale, im: 3 * scale }, { re: 0, im: scale }),
      3, -1, 'subnormal imaginary divisor');
  }
});

test('degenerate warning uses a strict determinant magnitude threshold', () => {
  const coefficients = { A: { re: 1, im: 0 }, B: { re: 0, im: 0 }, C: { re: 0, im: 0 }, D: { re: 0, im: 0 } };
  const eps = DEGENERATE_DETERMINANT_EPS;
  for (const [magnitude, expected] of [[eps * (1 - 1e-3), true], [eps, false], [eps * (1 + 1e-3), false]]) {
    assert.equal(isDegenerate({ ...coefficients, D: { re: 0, im: magnitude } }), expected);
  }
});
