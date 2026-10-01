/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

export const LEGACY_SHADER_ALIASES = ['Shader', 'ShaderBall', 'ShaderWorkbench'];

/**
 * Maps a retired Shader identity before current effect-name validation.
 * @param {string|null} effect - Persisted effect name, null when unset.
 * @returns {{effect: string|null, migrated: boolean, notice?: string}} The live
 *   effect identity and whether it was migrated.
 */
export function importLegacyShaderSelection(effect) {
  if (effect === null || !LEGACY_SHADER_ALIASES.includes(effect)) {
    return { effect, migrated: false };
  }
  return {
    effect: 'ShaderChain',
    migrated: true,
    notice: `${effect} is a legacy Shader identity; its original configuration is preserved during import.`,
  };
}
