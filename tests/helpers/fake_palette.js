import { NUMERIC_ENUMS } from '../../generated/engine_contract.mjs';

const enumeration = (name) => Object.freeze(Object.fromEntries(
  Object.entries(NUMERIC_ENUMS[name]).map(([key, value]) => [key, Object.freeze({ value })])));
export const PaletteCompileCode = enumeration('PaletteCompileCode');
export const PaletteRecipeField = enumeration('PaletteRecipeField');
