import { NUMERIC_ENUMS } from '../../generated/engine_contract.mjs';

export const enumeration = (name) => Object.freeze(Object.fromEntries(
  Object.entries(NUMERIC_ENUMS[name]).map(([key, value]) => [key, Object.freeze({ value })])));
