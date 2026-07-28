/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * DOM-free number formatting for on-sphere labels, extracted from driver.js so
 * the symbolic-snapping logic can be unit-tested without importing Three.js.
 */

const PHI = (1 + Math.sqrt(5)) / 2;
const INV_PHI = 1 / PHI;

/**
 * Format a number for label display, snapping near-matches (within 1e-5) to
 * symbolic names for common angles/constants (0, ±1, multiples of π, golden
 * ratio φ, 1/√3); otherwise a 3-decimal string, or 4 significant digits once
 * the magnitude is large enough that a fixed-point label would run long.
 * @param {number} r - The value to format.
 * @returns {string} The symbolic name or a short numeric representation.
 */
export const prettify = (r) => {
  if (!Number.isFinite(r)) return "0";
  if (Math.abs(r) <= 0.00001) return "0";
  if (Math.abs(r - 1) <= 0.00001) return "1";
  if (Math.abs(r + 1) <= 0.00001) return "-1";
  if (Math.abs(r - Math.PI) <= 0.00001) return "π";
  if (Math.abs(r + Math.PI) <= 0.00001) return "-π";
  if (Math.abs(r - Math.PI / 2) <= 0.00001) return "π/2";
  if (Math.abs(r + Math.PI / 2) <= 0.00001) return "-π/2";
  if (Math.abs(r - Math.PI / 4) <= 0.00001) return "π/4";
  if (Math.abs(r + Math.PI / 4) <= 0.00001) return "-π/4";
  if (Math.abs(r - 3 * Math.PI / 2) <= 0.00001) return "3π/2";
  if (Math.abs(r + 3 * Math.PI / 2) <= 0.00001) return "-3π/2";
  if (Math.abs(r - 2 * Math.PI) <= 0.00001) return "2π";
  if (Math.abs(r + 2 * Math.PI) <= 0.00001) return "-2π";
  if (Math.abs(r - PHI) <= 0.00001) return "φ";
  if (Math.abs(r - INV_PHI) <= 0.00001) return "φ⁻¹";
  if (Math.abs(r + PHI) <= 0.00001) return "-φ";
  if (Math.abs(r + INV_PHI) <= 0.00001) return "-φ⁻¹";
  if (Math.abs(r - 1 / Math.sqrt(3)) <= 0.00001) return "√3⁻¹";
  if (Math.abs(r + 1 / Math.sqrt(3)) <= 0.00001) return "-√3⁻¹";
  // Past 1e6 a 3-decimal label runs to 10+ characters; toPrecision goes
  // exponential at this magnitude, capping the label at 11.
  if (Math.abs(r) >= 1e6) return r.toPrecision(4);
  const s = r.toFixed(3);
  return s === "-0.000" ? "0.000" : s;
}
