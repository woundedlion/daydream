/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

export const LEGACY_SHADER_ALIAS = 'ShaderBall';

/**
 * Maps the retired ShaderBall identity before current effect-name validation.
 * @param {string|null} effect - Persisted effect name, null when unset.
 * @returns {{effect: string|null, migrated: boolean, notice?: string}} The live
 *   effect identity and whether it was migrated.
 */
export function importLegacyShaderSelection(effect) {
  if (effect !== LEGACY_SHADER_ALIAS) return { effect, migrated: false };
  return {
    effect: 'Shader',
    migrated: true,
    notice: 'ShaderBall is now Shader; opened with defaults.',
  };
}
