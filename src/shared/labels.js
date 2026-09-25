// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @param {string} value @returns {string} The kebab-case value, title-cased. */
export const titleCase = (value) => value.split('-')
  .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
  .join(' ');
