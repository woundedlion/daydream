// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {declarationFromCatalogField, isCatalogFieldLive, PLANAR_SOURCE_OPERATOR as PLANAR_SOURCE, planarSourceFamily as sourceFamily}
  from '../../../generated/shader/shader_workbench.mjs';
import {refusal} from './chain_document_edits.js';

export {PLANAR_SOURCE, sourceFamily};
export const LEGACY_PLANAR_SOURCES = Object.freeze({
  grid: 'sample.grid.v4',
  'twin-wave': 'sample.twin-wave.v3',
  bands: 'sample.bands.v1',
  spiral: 'sample.spiral.v3',
  tessellation: 'sample.tessellation.v3',
  'projected-noise': 'sample.projected-noise.v2',
});

const SOURCE_FIELDS = new Set(['edge-width', 'weight-mode', 'coverage-mode']);
const COMPOUND_FIELDS = new Set(['kind', 'fill', 'basis']);

/** @typedef {import('./chain_document_store.js').CatalogOperator} CatalogOperator */
/** @typedef {import('./chain_document_store.js').ParameterDeclaration} ParameterDeclaration */
/** @typedef {import('./chain_document_store.js').EditResult} EditResult */
/** @typedef {import('./chain_preset_bank.js').Bank} Bank */

/** @param {string} operator */
export function legacySourceFamily(operator) {
  return Object.keys(LEGACY_PLANAR_SOURCES).find((family) =>
    legacyOperator(family) === operator) ?? null;
}

/** @param {string} family */
function legacyOperator(family) {
  return /** @type {Record<string, string>} */ (LEGACY_PLANAR_SOURCES)[family];
}

/** @param {string} operator @param {string} label @param {Readonly<Record<string, *>>} values
 * @param {CatalogOperator} [definition] @returns {string|null} */
export function presetSourceKind(operator, label, values, definition) {
  if (operator === PLANAR_SOURCE) return values[label + '.source'] ?? 'grid';
  const family = legacySourceFamily(operator);
  /** @param {string} field */
  const value = (field) => values[label + '.' + field]
    ?? definition?.params.find((parameter) => parameter.id === field)?.default;
  if (family === 'tessellation')
    return family + '-' + (value('kind') ?? 'square') + '-' + (value('fill') ?? 'cells');
  if (family === 'projected-noise') return family + '-' + (value('basis') ?? 'simplex');
  return family;
}

/** @param {string} kind @returns {Record<string, string>} */
function compoundValues(kind) {
  const family = sourceFamily(kind);
  if (family === 'tessellation') {
    const [shape, fill] = kind.slice(family.length + 1).split('-');
    return {kind: shape, fill};
  }
  if (family === 'projected-noise') return {basis: kind.slice(family.length + 1)};
  return {};
}

/** @param {*} candidate @param {string} label
 * @param {(id: string) => string|null} rename @param {ParameterDeclaration[]} appended */
function rewriteDeclarations(candidate, label, rename, appended) {
  const descriptor = candidate.descriptor;
  const prefix = label + '.';
  /** @param {string} id */
  const rewrite = (id) => id.startsWith(prefix) ? rename(id) : id;
  /** @type {Map<string, string|null>} */
  const groupNames = new Map();
  const authored = [];
  for (const parameter of /** @type {ParameterDeclaration[]} */ (descriptor.parameters)) {
    const oldGroup = parameter.interpolation.group ?? parameter.id;
    const id = rewrite(parameter.id);
    if (id === null) {
      if (!groupNames.has(oldGroup)) groupNames.set(oldGroup, null);
      continue;
    }
    const group = parameter.interpolation.group;
    parameter.id = id;
    if (typeof group === 'string') parameter.interpolation.group = rewrite(group) ?? group;
    groupNames.set(oldGroup, parameter.interpolation.group ?? id);
    authored.push(parameter);
  }
  descriptor.parameters = [...authored, ...appended];
  descriptor.serialization.fields = [
    ...descriptor.serialization.fields.map(rewrite).filter(Boolean),
    ...appended.map((parameter) => parameter.id),
  ];
  for (const policy of descriptor.path_policies) {
    if (policy.kind !== 'STAGGERED_ORDERED') continue;
    policy.groups = [...new Set([
      ...policy.groups.map((/** @type {string} */ group) =>
        groupNames.has(group) ? groupNames.get(group) : group).filter(Boolean),
      ...appended.map((parameter) => parameter.interpolation.group ?? parameter.id),
    ])];
  }
  for (const preset of /** @type {Bank} */ (candidate.preset_bank).presets) {
    /** @type {Record<string, *>} */
    const values = {};
    for (const [key, value] of Object.entries(preset.values)) {
      const id = rewrite(key);
      if (id !== null) values[id] = value;
    }
    for (const parameter of appended) values[parameter.id] = parameter.default;
    preset.values = values;
  }
}

/** @param {*} candidate @param {string} label @param {CatalogOperator} legacy @param {CatalogOperator} planar */
function upgrade(candidate, label, legacy, planar) {
  const family = legacySourceFamily(legacy.id);
  const prefix = label + '.';
  /** @type {Bank} */
  const bank = candidate.preset_bank;
  const kinds = bank.presets.map((preset) => presetSourceKind(legacy.id, label, preset.values, legacy));
  const selector = planar.params.find((parameter) => parameter.id === 'source');
  const declaration = declarationFromCatalogField(label, /** @type {NonNullable<typeof selector>} */ (selector), planar.id);
  declaration.default = presetSourceKind(legacy.id, label, Object.fromEntries(
    candidate.descriptor.parameters.map((/** @type {ParameterDeclaration} */ parameter) =>
      [parameter.id, parameter.default])), legacy);
  rewriteDeclarations(candidate, label, (id) => {
    const field = id.slice(prefix.length);
    if (COMPOUND_FIELDS.has(field)) return null;
    return SOURCE_FIELDS.has(field) ? id : prefix + family + '-' + field;
  }, [declaration]);
  bank.presets.forEach((preset, index) => { preset.values[declaration.id] = kinds[index]; });
  candidate.descriptor.chain.find((/** @type {*} */ entry) => entry.label === label).operator = planar.id;
}

/** @param {*} candidate @param {string} label @param {Map<string, CatalogOperator>} operators
 * @returns {boolean} Whether a single-kind source was simplified. */
export function simplifyPlanarSource(candidate, label, operators) {
  const entry = candidate.descriptor.chain.find((/** @type {*} */ slot) => slot.label === label);
  if (entry?.operator !== PLANAR_SOURCE) return false;
  const prefix = label + '.';
  /** @type {Bank} */
  const bank = candidate.preset_bank;
  const kind = presetSourceKind(entry.operator, label, bank.presets[0].values);
  if (kind === null || !bank.presets.every((preset) =>
    presetSourceKind(entry.operator, label, preset.values) === kind)) return false;
  const family = /** @type {string} */ (sourceFamily(kind));
  const planar = operators.get(PLANAR_SOURCE);
  const legacy = operators.get(legacyOperator(family));
  if (!planar || !legacy) return false;
  const fields = planar.params.filter((field) => field.id.startsWith(family + '-'));
  const presets = new Map(bank.presets.map((preset) => [preset.preset_id, preset.values]));
  for (const edge of bank.edges) {
    const from = presets.get(edge.from);
    const to = presets.get(edge.to);
    if (from && to && fields.some((field) => {
      const id = prefix + field.id;
      return (from[id] ?? field.default) !== (to[id] ?? field.default)
        && (isCatalogFieldLive(entry, field, from) || isCatalogFieldLive(entry, field, to));
    })) return false;
  }
  const compound = compoundValues(kind);
  const selector = candidate.descriptor.parameters.find((/** @type {ParameterDeclaration} */ parameter) =>
    parameter.id === prefix + 'source');
  const defaults = selector && sourceFamily(selector.default) === family
    ? compoundValues(selector.default) : compound;
  const appended = legacy.params.filter((field) => Object.hasOwn(compound, field.id))
    .map((field) => {
      const declaration = declarationFromCatalogField(label, field, legacy.id);
      declaration.default = defaults[field.id];
      return declaration;
    });
  rewriteDeclarations(candidate, label, (id) => {
    const field = id.slice(prefix.length);
    if (SOURCE_FIELDS.has(field)) return id;
    const familyPrefix = family + '-';
    return field.startsWith(familyPrefix) ? prefix + field.slice(familyPrefix.length) : null;
  }, appended);
  for (const preset of bank.presets)
    for (const [field, value] of Object.entries(compound)) preset.values[prefix + field] = value;
  entry.operator = legacy.id;
  return true;
}

/** @param {*} candidate @param {string} label @param {string} presetId @param {string} kind
 * @param {Map<string, CatalogOperator>} operators @param {boolean} visited @returns {EditResult} */
export function changePlanarSource(candidate, label, presetId, kind, operators, visited) {
  const entry = candidate.descriptor.chain.find((/** @type {*} */ slot) => slot.label === label);
  const planar = operators.get(PLANAR_SOURCE);
  const selector = planar?.params.find((field) => field.id === 'source');
  /** @type {Bank} */
  const bank = candidate.preset_bank;
  const preset = bank.presets.find((preset) => preset.preset_id === presetId);
  if (!entry || !planar || !preset || selector?.topology !== true || !selector.values.includes(kind))
    return refusal('UNKNOWN_PLANAR_SOURCE', '$.descriptor.chain', 'The planar source is unavailable.');
  const definition = /** @type {CatalogOperator} */ (operators.get(entry.operator));
  const previous = presetSourceKind(entry.operator, label, preset.values, definition);
  if (previous === kind) return {ok: true};
  if (entry.operator !== PLANAR_SOURCE) {
    if (previous === null)
      return refusal('UNKNOWN_PLANAR_SOURCE', '$.descriptor.chain', 'The source does not read a plane.');
    upgrade(candidate, label, definition, planar);
  }
  const prefix = label + '.';
  const family = sourceFamily(kind);
  if (previous === null || sourceFamily(previous) !== family) {
    const order = bank.choreography.generated_order;
    const index = order.indexOf(presetId);
    const references = [...order.slice(0, index).reverse(), ...order.slice(index + 1)];
    const donor = references.map((id) => bank.presets.find((entry) => entry.preset_id === id))
      .find((entry) => entry && sourceFamily(String(entry.values[prefix + 'source'])) === family);
    const fields = planar.params.filter((field) => field.id.startsWith(family + '-'));
    const stored = visited || fields.some((field) => preset.values[prefix + field.id] !== undefined
      && preset.values[prefix + field.id] !== field.default);
    for (const field of fields) {
      const id = prefix + field.id;
      if (!candidate.descriptor.parameters.some((/** @type {ParameterDeclaration} */ parameter) => parameter.id === id)) {
        const declaration = declarationFromCatalogField(label, field, PLANAR_SOURCE);
        candidate.descriptor.parameters.push(declaration);
        candidate.descriptor.serialization.fields.push(id);
        for (const policy of candidate.descriptor.path_policies) {
          if (policy.kind === 'STAGGERED_ORDERED') policy.groups.push(declaration.interpolation.group ?? id);
        }
        for (const preset of bank.presets) preset.values[id] = declaration.default;
      }
      if (!stored) preset.values[id] = donor?.values[id] ?? field.default;
    }
  }
  preset.values[prefix + 'source'] = kind;
  return {ok: true};
}
