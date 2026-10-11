// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { EFFECT_IDENTITIES } from '../../generated/engine_contract.mjs';

const identities = new Map(EFFECT_IDENTITIES.map((identity) => [identity.id, identity]));
const aliases = new Map(EFFECT_IDENTITIES.flatMap((identity) =>
  [identity.id, identity.display_name, ...identity.legacy_ids].map((name) => [name, identity.id])));

/** @param {string} name @returns {string} Canonical engine ID, or the unknown input. */
export function canonicalEffectId(name) {
  return aliases.get(name) ?? name;
}

/** @param {string} name @returns {string} Engine display label, or the unknown input. */
export function effectDisplayName(name) {
  return identities.get(canonicalEffectId(name))?.display_name ?? name;
}
