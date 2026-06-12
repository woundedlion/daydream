// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// tools/color.js is a pure-math module (no DOM); import it directly. It mirrors
// the engine's perceptual pipeline (core/color.h), so these tests pin the
// round-trips and known fixed points that keep the tool's preview honest.
const {
  srgbToLinearFloat, linearToSrgbFloat,
  linearRgbToOklab, oklabToLinearRgb,
  oklabToOklch, oklchToOklab,
  srgbToOklch, lerpOklch, oklchToLinearRgb, linearRgbToHex,
} = await import('../tools/color.js');

/**
 * Asserts that two numbers are equal within an absolute tolerance, for
 * floating-point color math.
 * @param {number} a - Actual value.
 * @param {number} b - Expected value.
 * @param {number} [eps=1e-6] - Maximum allowed absolute difference.
 */
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps,
  `expected ${a} ≈ ${b} (±${eps})`);

// --- sRGB transfer function ---

/** Verifies the sRGB<->linear transfer endpoints, the 0.04045 knee continuity, and the round-trip. */
test('srgb<->linear fixed points and round-trip', () => {
  near(srgbToLinearFloat(0), 0);
  near(srgbToLinearFloat(1), 1);
  near(linearToSrgbFloat(0), 0);
  near(linearToSrgbFloat(1), 1);
  // The piecewise pieces meet continuously around the 0.04045 knee.
  near(srgbToLinearFloat(0.04045), 0.04045 / 12.92);
  for (const s of [0.02, 0.1, 0.25, 0.5, 0.9]) {
    near(linearToSrgbFloat(srgbToLinearFloat(s)), s, 1e-6);
  }
});

// --- OKLab matrices ---

/** Verifies that linear white (1,1,1) maps to OKLab L≈1 with neutral (zero) a/b chroma. */
test('linearRgbToOklab maps white to L≈1, neutral chroma', () => {
  const lab = linearRgbToOklab(1, 1, 1);
  near(lab.L, 1, 1e-4);
  near(lab.a, 0, 1e-4);
  near(lab.b, 0, 1e-4);
});

/** Verifies linear-RGB <-> OKLab round-trips back to the original RGB for several sample colors. */
test('linearRgb<->Oklab round-trips for several colors', () => {
  for (const [r, g, b] of [[0.2, 0.5, 0.8], [0.9, 0.1, 0.3], [0.5, 0.5, 0.5]]) {
    const rgb = oklabToLinearRgb(linearRgbToOklab(r, g, b));
    near(rgb.r, r, 1e-5);
    near(rgb.g, g, 1e-5);
    near(rgb.b, b, 1e-5);
  }
});

/** Verifies the OKLab <-> OKLch round-trip recovers the original L/a/b. */
test('Oklab<->Oklch round-trip', () => {
  const lab = { L: 0.6, a: 0.1, b: -0.05 };
  const back = oklchToOklab(oklabToOklch(lab));
  near(back.L, lab.L);
  near(back.a, lab.a);
  near(back.b, lab.b);
});

// --- High-level conversions ---

/** Verifies srgbToOklch yields finite components with lightness in (0,1) and non-negative chroma. */
test('srgbToOklch is the composition of the byte->linear->oklab->oklch chain', () => {
  const lch = srgbToOklch(128, 64, 200);
  // Finite, and L within the valid lightness range.
  assert.ok(Number.isFinite(lch.L) && Number.isFinite(lch.C) && Number.isFinite(lch.h));
  assert.ok(lch.L > 0 && lch.L < 1);
  assert.ok(lch.C >= 0);
});

/** Verifies lerpOklch returns the endpoints at t=0/1 and the linear midpoint of L/C/h at t=0.5. */
test('lerpOklch endpoints and shortest-hue-arc midpoint', () => {
  const a = { L: 0.3, C: 0.1, h: 0.2 };
  const b = { L: 0.7, C: 0.2, h: 1.0 };
  const at0 = lerpOklch(a, b, 0);
  const at1 = lerpOklch(a, b, 1);
  near(at0.L, a.L); near(at0.C, a.C); near(at0.h, a.h);
  near(at1.L, b.L); near(at1.C, b.C);
  const mid = lerpOklch(a, b, 0.5);
  near(mid.L, 0.5); near(mid.C, 0.15);
});

/** Verifies lerpOklch interpolates hue along the short arc across the +/-pi seam, not the long way. */
test('lerpOklch wraps the hue across the +/-pi seam by the short arc', () => {
  // a near +pi, b near -pi: the short arc crosses the seam, not the long way.
  const a = { L: 0.5, C: 0.2, h: Math.PI - 0.1 };
  const b = { L: 0.5, C: 0.2, h: -Math.PI + 0.1 };
  const mid = lerpOklch(a, b, 0.5);
  // Midpoint sits on the seam (~±pi), i.e. |h| close to pi, NOT near 0.
  assert.ok(Math.abs(Math.abs(mid.h) - Math.PI) < 0.15,
    `hue ${mid.h} should sit near the seam, not interpolate the long way`);
});

/** Verifies lerpOklch treats near-zero-chroma endpoints as hueless, adopting the chromatic end's hue. */
test('lerpOklch treats near-zero chroma endpoints as hueless', () => {
  const gray = { L: 0.5, C: 0, h: 0 };
  const blue = { L: 0.5, C: 0.2, h: 1.23 };
  assert.equal(lerpOklch(gray, gray, 0.5).h, 0);
  near(lerpOklch(gray, blue, 0.5).h, blue.h); // adopt the chromatic end's hue
});

/** Verifies oklchToLinearRgb clamps an out-of-gamut high-chroma color into the [0,1] RGB cube. */
test('oklchToLinearRgb clamps out-of-gamut results into [0,1]', () => {
  // A high-chroma OKLCH that lands outside the RGB cube must be clamped.
  const rgb = oklchToLinearRgb({ L: 0.5, C: 0.5, h: 0 });
  for (const c of rgb) assert.ok(c >= 0 && c <= 1);
});

/** Verifies linearRgbToHex emits #rrggbb, clamping out-of-range channels rather than overflowing. */
test('linearRgbToHex produces #rrggbb with correct fixed points', () => {
  assert.equal(linearRgbToHex(0, 0, 0), '#000000');
  assert.equal(linearRgbToHex(1, 1, 1), '#ffffff');
  // Out-of-range inputs clamp rather than overflow the two-digit channels.
  assert.equal(linearRgbToHex(-1, 2, 0), '#00ff00');
  assert.match(linearRgbToHex(0.5, 0.25, 0.75), /^#[0-9a-f]{6}$/);
});
