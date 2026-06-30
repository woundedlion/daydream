// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// tools/color.js mirrors the engine's perceptual pipeline (core/color.h).
const {
  srgbToLinearFloat, linearToSrgbFloat,
  linearRgbToOklab, oklabToLinearRgb,
  linearRgbToHex,
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

// --- High-level conversions ---

/** Verifies linearRgbToHex emits #rrggbb, clamping out-of-range channels rather than overflowing. */
test('linearRgbToHex produces #rrggbb with correct fixed points', () => {
  assert.equal(linearRgbToHex(0, 0, 0), '#000000');
  assert.equal(linearRgbToHex(1, 1, 1), '#ffffff');
  assert.equal(linearRgbToHex(-1, 2, 0), '#00ff00');
  assert.match(linearRgbToHex(0.5, 0.25, 0.75), /^#[0-9a-f]{6}$/);
});
