/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { TWO_PI } from "./3dmath.js";

/**
 * Elastic easing out.
 * @param {number} x - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeOutElastic = (x) => {
    const c4 = TWO_PI / 3;
    return x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
}

/**
 * Sinusoidal easing in-out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeInOutSin = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

/**
 * Sinusoidal easing out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeInSin = (t) => 1 - Math.cos((t * Math.PI) / 2);

/**
 * Sinusoidal easing out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeOutSin = (t) => Math.sin((t * Math.PI) / 2);

/**
 * Exponential easing out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeOutExpo = (t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);

/**
 * Circular easing out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeOutCirc = (t) => Math.sqrt(1 - Math.pow(t - 1, 2));

/**
 * Cubic easing in.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeInCubic = (t) => Math.pow(t, 3);

/**
 * Circular easing in.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeInCirc = (t) => 1 - Math.sqrt(1 - Math.pow(t, 2));

/**
 * Linear easing.
 * @param {number} t - Time [0, 1].
 * @returns {number} Value.
 */
export const easeMid = (t) => t;

/**
 * Cubic easing out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
