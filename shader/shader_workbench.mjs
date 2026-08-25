/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { sha256Hex } from './sha256.mjs';

export const SHADER_DOCUMENT_SCHEMA_VERSION = 2;
export const OPERATOR_CATALOG_VERSION = 2;

export const DEFAULT_LIMITS = Object.freeze({
  bytes: 1024 * 1024,
  depth: 32,
  stringLength: 4096,
  parameters: 512,
});

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const LABEL_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CLASSIFICATIONS = new Set([
  'semantic',
  'preset',
  'effect_metadata',
  'product_metadata',
  'study_metadata',
]);
const INTERPOLATION_KINDS = new Set([
  'LINEAR',
  'LOG_POSITIVE',
  'SHORTEST_PERIODIC',
  'SNAP',
  'NORMALIZED_LINEAR',
  'MIXED_ENUM',
]);
const EASING_KINDS = new Set(['LINEAR', 'EASE_IN_OUT_SIN']);
const ORIGINS = [
  'manual',
  'automatic',
  'synchronized',
  'restore',
  'authoring',
];

export class ShaderDocumentError extends Error {
  constructor(phase, code, path, message) {
    super(message);
    this.name = 'ShaderDocumentError';
    this.phase = phase;
    this.code = code;
    this.path = path;
  }

  diagnostic() {
    return {
      severity: 'error',
      phase: this.phase,
      code: this.code,
      path: this.path,
      message: this.message,
    };
  }
}

const fail = (phase, code, path, message) => {
  throw new ShaderDocumentError(phase, code, path, message);
};

const codePointCompare = (left, right) => {
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; ++i) {
    const delta = a[i].codePointAt(0) - b[i].codePointAt(0);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
};

// RFC 8259 insignificant whitespace. /\s/u would also skip NBSP, the Unicode
// space separators, U+2028/U+2029 and U+FEFF, so this reader would accept
// documents every conforming JSON parser rejects.
const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);

class JsonReader {
  constructor(source, limits) {
    this.source = source;
    this.limits = limits;
    this.index = 0;
  }

  parse() {
    this.space();
    const value = this.value(0, '$');
    this.space();
    if (this.index !== this.source.length)
      fail('parse', 'TRAILING_INPUT', '$', 'Unexpected input after the JSON value.');
    return value;
  }

  space() {
    while (JSON_WHITESPACE.has(this.source[this.index])) ++this.index;
  }

  value(depth, path) {
    if (depth > this.limits.depth)
      fail('parse', 'DEPTH_LIMIT', path, 'The document nesting limit was exceeded.');
    this.space();
    const token = this.source[this.index];
    if (token === '{') return this.object(depth, path);
    if (token === '[') return this.array(depth, path);
    if (token === '"') return this.string(path);
    if (token === '-' || (token >= '0' && token <= '9')) return this.number(path);
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length;
        return value;
      }
    }
    fail('parse', 'INVALID_JSON', path, `Unexpected token at byte ${this.index}.`);
  }

  object(depth, path) {
    ++this.index;
    // Null-prototype: a "__proto__" key must land as an own key rather than run
    // the prototype setter, which hides it from Object.keys and skews `in`.
    const result = Object.create(null);
    const keys = new Set();
    this.space();
    if (this.source[this.index] === '}') {
      ++this.index;
      return result;
    }
    while (true) {
      this.space();
      if (this.source[this.index] !== '"')
        fail('parse', 'INVALID_JSON', path, 'An object key must be a JSON string.');
      const key = this.string(path).normalize('NFC');
      if (keys.has(key))
        fail('parse', 'DUPLICATE_KEY', `${path}.${key}`, `Duplicate object key "${key}".`);
      keys.add(key);
      this.space();
      if (this.source[this.index] !== ':')
        fail('parse', 'INVALID_JSON', path, 'Expected a colon after an object key.');
      ++this.index;
      result[key] = this.value(depth + 1, `${path}.${key}`);
      this.space();
      const delimiter = this.source[this.index++];
      if (delimiter === '}') return result;
      if (delimiter !== ',')
        fail('parse', 'INVALID_JSON', path, 'Expected a comma or closing brace.');
    }
  }

  array(depth, path) {
    ++this.index;
    const result = [];
    this.space();
    if (this.source[this.index] === ']') {
      ++this.index;
      return result;
    }
    while (true) {
      result.push(this.value(depth + 1, `${path}[${result.length}]`));
      this.space();
      const delimiter = this.source[this.index++];
      if (delimiter === ']') return result;
      if (delimiter !== ',')
        fail('parse', 'INVALID_JSON', path, 'Expected a comma or closing bracket.');
    }
  }

  string(path) {
    const start = this.index++;
    let escaped = false;
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (!escaped && char === '"') {
        let value;
        try {
          value = JSON.parse(this.source.slice(start, this.index));
        } catch {
          fail('parse', 'INVALID_STRING', path, 'The JSON string escape is invalid.');
        }
        if ([...value].length > this.limits.stringLength)
          fail('parse', 'STRING_LIMIT', path, 'The document string limit was exceeded.');
        return value;
      }
      if (!escaped && char.charCodeAt(0) < 0x20)
        fail('parse', 'INVALID_STRING', path, 'A JSON string contains a control character.');
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
    }
    fail('parse', 'INVALID_STRING', path, 'The JSON string is unterminated.');
  }

  number(path) {
    const match = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match)
      fail('parse', 'INVALID_NUMBER', path, 'The JSON number is malformed.');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value))
      fail('parse', 'NONFINITE_NUMBER', path, 'JSON numbers must be finite.');
    return value;
  }
}

export function parseShaderDocument(source, limits = DEFAULT_LIMITS) {
  if (typeof source !== 'string')
    fail('parse', 'SOURCE_TYPE', '$', 'Shader document input must be text.');
  if (source.charCodeAt(0) === 0xfeff)
    fail('parse', 'BYTE_ORDER_MARK', '$', 'Shader documents must be UTF-8 without a byte-order mark.');
  const bounded = { ...DEFAULT_LIMITS, ...limits };
  if (new TextEncoder().encode(source).length > bounded.bytes)
    fail('parse', 'BYTE_LIMIT', '$', 'The document byte limit was exceeded.');
  return new JsonReader(source, bounded).parse();
}

const checkDecodedDocumentDepth = (source, limits = DEFAULT_LIMITS) => {
  const bounded = { ...DEFAULT_LIMITS, ...limits };
  const pending = [{ value: source, depth: 0, path: '$' }];
  while (pending.length > 0) {
    const { value, depth, path } = pending.pop();
    if (depth > bounded.depth)
      fail('parse', 'DEPTH_LIMIT', path, 'The document nesting limit was exceeded.');
    if (value === null || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; --index)
        pending.push({ value: value[index], depth: depth + 1, path: `${path}[${index}]` });
      continue;
    }
    const keys = Object.keys(value);
    for (let index = keys.length - 1; index >= 0; --index) {
      const key = keys[index];
      pending.push({ value: value[key], depth: depth + 1, path: `${path}.${key}` });
    }
  }
  return source;
};

const object = (value, path) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('schema', 'EXPECTED_OBJECT', path, 'Expected an object.');
  return value;
};

const array = (value, path) => {
  if (!Array.isArray(value))
    fail('schema', 'EXPECTED_ARRAY', path, 'Expected an array.');
  return value;
};

const exactKeys = (value, allowed, required, path) => {
  object(value, path);
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      fail('schema', 'UNKNOWN_FIELD', `${path}.${key}`, `Unknown field "${key}".`);
  for (const key of required)
    if (!(key in value))
      fail('schema', 'MISSING_FIELD', `${path}.${key}`, `Missing required field "${key}".`);
};

const id = (value, path) => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value))
    fail('schema', 'INVALID_ID', path, 'Expected a stable lowercase identifier.');
  return value;
};

const label = (value, path) => {
  if (typeof value !== 'string' || !LABEL_PATTERN.test(value))
    fail('schema', 'INVALID_ID', path, 'Expected a single kebab-case instance label.');
  return value;
};

// The operator catalog: the engine-exported (for now hand-pinned) table of
// operators, carriers and budgets that chain validation reads. Only existence,
// carriers, parameter schemas, enum values and budgets are consumed here, so
// the engine-emitted replacement slots in transparently.
const requireCatalog = (catalog) => {
  if (catalog === null || typeof catalog !== 'object' ||
      !Array.isArray(catalog.carriers) || !Array.isArray(catalog.operators) ||
      catalog.budgets === null || typeof catalog.budgets !== 'object')
    fail('semantic', 'CATALOG_REQUIRED', '$',
      'Chain validation needs the operator catalog (options.catalog).');
  if (catalog.catalog_version !== OPERATOR_CATALOG_VERSION)
    fail('semantic', 'UNSUPPORTED_CATALOG_SCHEMA', '$',
      `Only operator catalog ${OPERATOR_CATALOG_VERSION} is supported.`);
  return {
    budgets: catalog.budgets,
    rank: new Map(catalog.carriers.map((carrier, index) => [carrier, index])),
    operators: new Map(catalog.operators.map((operator) => [operator.id, operator])),
  };
};

const operatorField = (operator, fieldId) =>
  operator.params.find((field) => field.id === fieldId);

const scalarCurve = (parameter) => {
  if (parameter.interpolation.kind === 'LINEAR') return 'lerp';
  if (parameter.interpolation.kind === 'LOG_POSITIVE') return 'log-positive';
  if (parameter.interpolation.kind === 'SNAP') return 'snap';
  if (parameter.interpolation.kind !== 'SHORTEST_PERIODIC') return null;
  const period = Math.fround(parameter.interpolation.period);
  if (period === 1) return 'shortest-turn';
  if (period === Math.fround(2 * Math.PI)) return 'shortest-periodic';
  return null;
};

/**
 * Validates the ordered operator chain against the catalog, collecting every
 * semantic finding rather than stopping at the first.
 * @returns {Map<string, Object>} Chain label -> catalog operator, for the
 *   entries whose operator the catalog knows.
 */
const validateChain = (chain, catalog, report, guard) => {
  array(chain, '$.descriptor.chain');
  const { budgets, rank, operators } = catalog;
  if (chain.length === 0) {
    report('EMPTY_CHAIN', '$.descriptor.chain', 'A chain needs at least one operator.');
    return new Map();
  }
  if (chain.length > budgets.max_chain_ops)
    report('BUDGET_EXCEEDED', '$.descriptor.chain',
      `The chain exceeds the ${budgets.max_chain_ops}-operator budget.`);

  const known = new Map();
  const resolved = new Array(chain.length);
  const labels = new Set();
  const blockBytes = (blocks) =>
    ['param', 'prepared', 'state'].reduce((total, kind) => {
      const block = blocks?.[kind] ?? { size: 0, align: 1 };
      const align = Math.max(1, block.align);
      return total + Math.ceil(block.size / align) * align;
    }, 0);
  let arenaBytes = 0;
  chain.forEach((entry, index) => {
    const path = `$.descriptor.chain[${index}]`;
    guard(() => {
      exactKeys(entry, ['label', 'operator'], ['label', 'operator'], path);
      label(entry.label, `${path}.label`);
      id(entry.operator, `${path}.operator`);
      if (entry.label.length > budgets.max_instance_id_length)
        report('BUDGET_EXCEEDED', `${path}.label`,
          `Label "${entry.label}" exceeds ${budgets.max_instance_id_length} characters.`);
      if (labels.has(entry.label))
        report('DUPLICATE_LABEL', `${path}.label`, `Duplicate chain label "${entry.label}".`);
      labels.add(entry.label);
      const operator = operators.get(entry.operator);
      if (!operator) {
        report('UNKNOWN_OPERATOR', `${path}.operator`,
          `The catalog carries no operator "${entry.operator}".`);
        return;
      }
      resolved[index] = operator;
      known.set(entry.label, operator);
      arenaBytes += budgets.per_op_overhead_bytes + blockBytes(operator.blocks)
        + (budgets.per_param_name_bytes ?? 0) * operator.params.length;
    });
  });
  if (arenaBytes > budgets.arena_bytes)
    report('BUDGET_EXCEEDED', '$.descriptor.chain',
      `The chain needs ${arenaBytes} arena bytes of the ${budgets.arena_bytes} budget.`);

  const first = resolved[0];
  if (first && first.input !== 'sphere')
    report('ENTRY_FAMILY', '$.descriptor.chain[0]',
      `A chain enters on the sphere carrier, not "${first.input}".`);
  const last = resolved[chain.length - 1];
  if (last && last.output !== 'color')
    report('EXIT_FAMILY', `$.descriptor.chain[${chain.length - 1}]`,
      `A chain exits on the color carrier, not "${last.output}".`);
  for (let index = 0; index + 1 < chain.length; ++index) {
    const out = resolved[index];
    const next = resolved[index + 1];
    if (!out || !next || next.input === out.output) continue;
    const path = `$.descriptor.chain[${index + 1}]`;
    if (rank.get(next.input) < rank.get(out.output))
      report('FAMILY_ORDER', path,
        `"${chain[index + 1].operator}" steps back from the ${out.output} carrier to ${next.input}.`);
    else
      report('CARRIER_MISMATCH', path,
        `"${chain[index + 1].operator}" consumes ${next.input}, but the chain carries ${out.output}.`);
  }
  return known;
};

const validateParameterShape = (parameter, path) => {
  exactKeys(parameter,
    ['id', 'classification', 'storage', 'unit', 'domain', 'interpolation', 'default'],
    ['id', 'classification', 'storage', 'unit', 'domain', 'interpolation', 'default'], path);
  id(parameter.id, `${path}.id`);
  id(parameter.unit, `${path}.unit`);
  if (!CLASSIFICATIONS.has(parameter.classification))
    fail('schema', 'INVALID_CLASSIFICATION', `${path}.classification`, 'The field classification is invalid.');
  if (parameter.classification !== 'preset')
    fail('semantic', 'NON_PRESET_PARAMETER', `${path}.classification`, 'Continuous parameters must be classified as preset values.');
  if (parameter.storage !== 'binary32' && parameter.storage !== 'enum8')
    fail('semantic', 'UNSUPPORTED_STORAGE', `${path}.storage`, 'Parameter storage is binary32 or enum8.');
  object(parameter.domain, `${path}.domain`);
  if (parameter.storage === 'binary32') {
    exactKeys(parameter.domain, ['minimum', 'maximum'], ['minimum', 'maximum'], `${path}.domain`);
    if (!Number.isFinite(parameter.domain.minimum) || !Number.isFinite(parameter.domain.maximum) ||
        parameter.domain.minimum > parameter.domain.maximum)
      fail('semantic', 'INVALID_DOMAIN', `${path}.domain`, 'The parameter domain is invalid.');
  } else {
    exactKeys(parameter.domain, ['values'], ['values'], `${path}.domain`);
    const values = array(parameter.domain.values, `${path}.domain.values`);
    if (values.length < 2 || values.length > 256)
      fail('semantic', 'INVALID_ENUM_DOMAIN', `${path}.domain.values`, 'An enum8 domain needs 2 to 256 values.');
    const unique = new Set();
    values.forEach((value, valueIndex) => {
      id(value, `${path}.domain.values[${valueIndex}]`);
      if (unique.has(value))
        fail('semantic', 'DUPLICATE_ENUM_VALUE', `${path}.domain.values[${valueIndex}]`, `Duplicate enum value "${value}".`);
      unique.add(value);
    });
  }
  object(parameter.interpolation, `${path}.interpolation`);
  exactKeys(parameter.interpolation, ['kind', 'period', 'group'], ['kind'], `${path}.interpolation`);
  if (!INTERPOLATION_KINDS.has(parameter.interpolation.kind))
    fail('semantic', 'UNKNOWN_INTERPOLATION', `${path}.interpolation.kind`, 'The interpolation trait is unknown.');
  if ((parameter.storage === 'enum8') !==
      (parameter.interpolation.kind === 'MIXED_ENUM'))
    fail('semantic', 'STORAGE_INTERPOLATION_MISMATCH', `${path}.interpolation.kind`, 'enum8 values require MIXED_ENUM and MIXED_ENUM requires enum8 storage.');
  if (parameter.interpolation.kind === 'SHORTEST_PERIODIC' &&
      !(Number.isFinite(parameter.interpolation.period) && parameter.interpolation.period > 0))
    fail('semantic', 'INVALID_PERIOD', `${path}.interpolation.period`, 'Periodic interpolation requires a positive period.');
  if (parameter.interpolation.kind === 'NORMALIZED_LINEAR')
    id(parameter.interpolation.group, `${path}.interpolation.group`);
  validateStoredValue(parameter, parameter.default, `${path}.default`);
};

// A parameter id is <label>.<field>: the label must resolve to a chain entry
// and the field to that operator's catalog schema, with '.' exclusively the
// separator between the two.
const validateParameterBinding = (parameter, path, chainOperators, report) => {
  const segments = parameter.id.split('.');
  if (segments.length !== 2 ||
      !LABEL_PATTERN.test(segments[0]) || !LABEL_PATTERN.test(segments[1])) {
    report('UNBOUND_PARAMETER', `${path}.id`,
      `Parameter "${parameter.id}" is not a <label>.<field> binding.`);
    return;
  }
  const operator = chainOperators.get(segments[0]);
  if (!operator) {
    report('UNBOUND_PARAMETER', `${path}.id`,
      `Parameter "${parameter.id}" binds no chain entry labeled "${segments[0]}".`);
    return;
  }
  const field = operatorField(operator, segments[1]);
  if (!field) {
    report('UNBOUND_PARAMETER', `${path}.id`,
      `Operator "${operator.id}" declares no field "${segments[1]}".`);
    return;
  }
  if (Boolean(field.topology) !== (parameter.storage === 'enum8')) {
    report('ENUM_DOMAIN_MISMATCH', `${path}.storage`,
      `Field "${parameter.id}" is ${field.topology ? 'an enum8 topology' : 'a binary32'} field.`);
    return;
  }
  if (field.topology &&
      JSON.stringify(parameter.domain.values) !== JSON.stringify(field.values))
    report('ENUM_DOMAIN_MISMATCH', `${path}.domain.values`,
      `Field "${parameter.id}" must carry the catalog's enum values in order.`);
  if (!field.topology) {
    const domain = parameter.domain;
    if (Math.fround(domain.minimum) !== Math.fround(field.min) ||
        Math.fround(domain.maximum) !== Math.fround(field.max))
      report('SCALAR_DOMAIN_MISMATCH', `${path}.domain`,
        `Field "${parameter.id}" must carry the catalog's numeric domain.`);
    if (scalarCurve(parameter) !== field.curve)
      report('SCALAR_DOMAIN_MISMATCH', `${path}.interpolation`,
        `Field "${parameter.id}" must use the catalog's "${field.curve}" curve.`);
  }
};

const validateParameters = (parameters, limits, budgets, chainOperators, report, guard) => {
  array(parameters, '$.descriptor.parameters');
  if (parameters.length > limits.parameters)
    fail('schema', 'PARAMETER_LIMIT', '$.descriptor.parameters', 'The parameter limit was exceeded.');
  if (parameters.length > budgets.max_params)
    report('BUDGET_EXCEEDED', '$.descriptor.parameters',
      `The document exceeds the ${budgets.max_params}-parameter budget.`);
  const seen = new Set();
  const groups = new Map();
  // Only a shape-validated parameter enters the map: every later pass reads
  // its fields unguarded.
  const validated = new Map();
  parameters.forEach((parameter, index) => {
    const path = `$.descriptor.parameters[${index}]`;
    guard(() => {
      validateParameterShape(parameter, path);
      if (seen.has(parameter.id))
        fail('semantic', 'DUPLICATE_PARAMETER', `${path}.id`, `Duplicate parameter ID "${parameter.id}".`);
      seen.add(parameter.id);
      if (parameter.interpolation.kind === 'NORMALIZED_LINEAR')
        groups.set(parameter.interpolation.group, (groups.get(parameter.interpolation.group) ?? 0) + 1);
      validateParameterBinding(parameter, path, chainOperators, report);
      validated.set(parameter.id, parameter);
    });
  });
  for (const [group, count] of groups)
    if (count < 2)
      report('INVALID_NORMALIZED_GROUP', '$.descriptor.parameters',
        `Normalized group "${group}" needs at least two fields.`);
  return validated;
};

const validateStoredValue = (parameter, value, path) => {
  if (parameter.storage === 'enum8') {
    if (typeof value !== 'string' || !parameter.domain.values.includes(value))
      fail('semantic', 'INVALID_ENUM_VALUE', path, `The value is outside parameter "${parameter.id}" options.`);
    return value;
  }
  if (!Number.isFinite(value))
    fail('semantic', 'NONFINITE_VALUE', path, 'Parameter values must be finite.');
  const stored = Math.fround(value);
  if (!Number.isFinite(stored))
    fail('semantic', 'BINARY32_OVERFLOW', path, 'The value is outside binary32 storage.');
  if (stored < parameter.domain.minimum || stored > parameter.domain.maximum)
    fail('semantic', 'VALUE_OUT_OF_RANGE', path, `The value is outside parameter "${parameter.id}" bounds.`);
  if (parameter.interpolation.kind === 'LOG_POSITIVE' && stored <= 0)
    fail('semantic', 'LOG_DOMAIN', path, 'Log-positive interpolation requires positive values.');
  return Object.is(stored, -0) ? 0 : stored;
};

const validatePathPolicies = (policies, parameters, report, guard) => {
  array(policies, '$.descriptor.path_policies');
  const seen = new Set();
  policies.forEach((policy, index) => {
    const path = `$.descriptor.path_policies[${index}]`;
    guard(() => {
      exactKeys(policy, ['id', 'kind', 'groups'], ['id', 'kind'], path);
      id(policy.id, `${path}.id`);
      if (seen.has(policy.id))
        fail('semantic', 'DUPLICATE_PATH_POLICY', `${path}.id`, `Duplicate path policy ID "${policy.id}".`);
      seen.add(policy.id);
      if (policy.kind !== 'PARALLEL' && policy.kind !== 'STAGGERED_ORDERED')
        fail('semantic', 'UNKNOWN_PATH_POLICY', `${path}.kind`, 'The path policy is unknown.');
      if (policy.kind === 'STAGGERED_ORDERED') {
        const groups = array(policy.groups, `${path}.groups`);
        if (groups.length === 0)
          fail('semantic', 'EMPTY_PATH_POLICY', `${path}.groups`, 'A staggered path needs ordered groups.');
        const available = new Set([...parameters.values()].map((parameter) =>
          parameter.interpolation.group ?? parameter.id));
        const used = new Set();
        groups.forEach((group, groupIndex) => {
          id(group, `${path}.groups[${groupIndex}]`);
          if (!available.has(group) || used.has(group))
            fail('semantic', 'INVALID_PATH_GROUP', `${path}.groups[${groupIndex}]`, `Invalid path group "${group}".`);
          used.add(group);
        });
        if (used.size !== available.size)
          fail('semantic', 'INCOMPLETE_PATH_POLICY', `${path}.groups`, 'A staggered path must schedule every interpolation group.');
      }
    });
  });
  if (seen.size === 0)
    report('MISSING_PATH_POLICY', '$.descriptor.path_policies', 'At least one path policy is required.');
  return seen;
};

const validatePresetBank = (bank, parameters, pathPolicies, report, guard) => {
  exactKeys(bank, ['schema_version', 'presets', 'edges', 'absent_edge_fallback', 'choreography'],
    ['schema_version', 'presets', 'edges', 'absent_edge_fallback', 'choreography'], '$.preset_bank');
  if (bank.schema_version !== 1)
    fail('schema', 'UNSUPPORTED_BANK_SCHEMA', '$.preset_bank.schema_version', 'Only preset-bank schema 1 is supported.');
  const presets = array(bank.presets, '$.preset_bank.presets');
  if (presets.length === 0)
    report('EMPTY_PRESET_BANK', '$.preset_bank.presets', 'A preset bank needs at least one preset.');
  const presetIds = new Set();
  presets.forEach((preset, index) => {
    const path = `$.preset_bank.presets[${index}]`;
    guard(() => {
      exactKeys(preset, ['preset_id', 'display_name', 'description', 'values'], ['preset_id', 'values'], path);
      id(preset.preset_id, `${path}.preset_id`);
      if (presetIds.has(preset.preset_id))
        fail('semantic', 'DUPLICATE_PRESET', `${path}.preset_id`, `Duplicate preset ID "${preset.preset_id}".`);
      presetIds.add(preset.preset_id);
      object(preset.values, `${path}.values`);
      for (const key of Object.keys(preset.values))
        if (!parameters.has(key))
          fail('semantic', 'UNKNOWN_PRESET_VALUE', `${path}.values.${key}`, `Unknown parameter "${key}".`);
      for (const [parameterId, parameter] of parameters) {
        if (!(parameterId in preset.values))
          fail('semantic', 'MISSING_PRESET_VALUE', `${path}.values.${parameterId}`, `Missing parameter "${parameterId}".`);
        validateStoredValue(parameter, preset.values[parameterId], `${path}.values.${parameterId}`);
      }
    });
  });

  const edgeKeys = new Set();
  array(bank.edges, '$.preset_bank.edges').forEach((edge, index) => {
    const path = `$.preset_bank.edges[${index}]`;
    guard(() => {
      exactKeys(edge, ['from', 'to', 'path_policy', 'easing', 'duration'],
        ['from', 'to', 'path_policy', 'easing', 'duration'], path);
      if (!presetIds.has(edge.from) || !presetIds.has(edge.to) || edge.from === edge.to)
        fail('semantic', 'INVALID_EDGE_ENDPOINT', path, 'A transition edge needs two distinct known presets.');
      const edgeKey = `${edge.from}>${edge.to}`;
      if (edgeKeys.has(edgeKey))
        fail('semantic', 'DUPLICATE_TRANSITION_EDGE', path, `Duplicate transition edge "${edgeKey}".`);
      edgeKeys.add(edgeKey);
      if (!pathPolicies.has(edge.path_policy))
        fail('semantic', 'UNKNOWN_EDGE_PATH', `${path}.path_policy`, 'The transition edge names an unknown path policy.');
      if (!EASING_KINDS.has(edge.easing))
        fail('semantic', 'UNKNOWN_EASING', `${path}.easing`, 'The transition easing is unknown.');
      if (!Number.isInteger(edge.duration) || edge.duration <= 0)
        fail('semantic', 'INVALID_DURATION', `${path}.duration`, 'Transition duration must be a positive tick count.');
    });
  });

  guard(() => {
    exactKeys(bank.absent_edge_fallback, ORIGINS, ORIGINS, '$.preset_bank.absent_edge_fallback');
    for (const origin of ORIGINS)
      if (bank.absent_edge_fallback[origin] !== 'SNAP' && bank.absent_edge_fallback[origin] !== 'REJECT')
        fail('semantic', 'INVALID_EDGE_FALLBACK', `$.preset_bank.absent_edge_fallback.${origin}`, 'The absent-edge fallback must be SNAP or REJECT.');
    exactKeys(bank.choreography, ['generated_order', 'dwell'], ['generated_order'], '$.preset_bank.choreography');
    const order = array(bank.choreography.generated_order, '$.preset_bank.choreography.generated_order');
    if (order.length !== presetIds.size || new Set(order).size !== presetIds.size ||
        order.some((presetId) => !presetIds.has(presetId)))
      fail('semantic', 'INVALID_GENERATED_ORDER', '$.preset_bank.choreography.generated_order', 'Generated order must contain every preset exactly once.');
    if (bank.choreography.dwell !== undefined) {
      const dwell = object(bank.choreography.dwell, '$.preset_bank.choreography.dwell');
      if (Object.keys(dwell).length !== presetIds.size ||
          Object.keys(dwell).some((presetId) => !presetIds.has(presetId)))
        fail('semantic', 'INVALID_DWELL', '$.preset_bank.choreography.dwell', 'Dwell must contain every preset exactly once.');
      for (const [presetId, duration] of Object.entries(dwell))
        if (!Number.isInteger(duration) || duration <= 0)
          fail('semantic', 'INVALID_DWELL', `$.preset_bank.choreography.dwell.${presetId}`, 'Dwell must be a positive tick count.');
    }
  });
};

/**
 * Validates a version-2 chain document against the operator catalog.
 * Schema-phase malformation throws; semantic findings are collected and the
 * full list returned, so import surfaces every problem at once.
 * @returns {Object[]} Every semantic diagnostic, empty for a valid document.
 */
export function validateShaderDocument(document, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const catalog = requireCatalog(options.catalog);
  const diagnostics = [];
  const report = (code, path, message) => diagnostics.push({
    severity: 'error', phase: 'semantic', code, path, message,
  });
  const guard = (call) => {
    try {
      call();
    } catch (error) {
      if (!(error instanceof ShaderDocumentError)) throw error;
      diagnostics.push(error.diagnostic());
    }
  };

  exactKeys(document,
    ['schema_version', 'catalog_version', 'document_id', 'effect_id', 'descriptor', 'preset_bank',
      'effect_metadata', 'product_metadata', 'study_metadata', 'extensions'],
    ['schema_version', 'catalog_version', 'document_id', 'descriptor', 'preset_bank'], '$');
  if (document.schema_version !== SHADER_DOCUMENT_SCHEMA_VERSION)
    fail('schema', 'UNSUPPORTED_DOCUMENT_SCHEMA', '$.schema_version',
      `Only Shader document schema ${SHADER_DOCUMENT_SCHEMA_VERSION} is supported.`);
  if (document.catalog_version !== OPERATOR_CATALOG_VERSION)
    fail('schema', 'UNSUPPORTED_CATALOG_SCHEMA', '$.catalog_version',
      `Only operator catalog ${OPERATOR_CATALOG_VERSION} is supported.`);
  id(document.document_id, '$.document_id');
  if ('effect_id' in document && document.effect_id !== null) id(document.effect_id, '$.effect_id');
  for (const field of ['effect_metadata', 'product_metadata', 'study_metadata', 'extensions'])
    if (field in document) object(document[field], `$.${field}`);
  if ('extensions' in document)
    for (const key of Object.keys(document.extensions))
      if (!key.startsWith('nonsemantic.'))
        fail('schema', 'UNKNOWN_EXTENSION', `$.extensions.${key}`, 'Only declared nonsemantic extensions may be ignored.');

  const descriptor = document.descriptor;
  exactKeys(descriptor,
    ['chain', 'parameters', 'path_policies', 'serialization'],
    ['chain', 'parameters', 'path_policies', 'serialization'], '$.descriptor');
  const chainOperators = validateChain(descriptor.chain, catalog, report, guard);
  const parameters = validateParameters(
    descriptor.parameters, limits, catalog.budgets, chainOperators, report, guard);
  const pathPolicies = validatePathPolicies(
    descriptor.path_policies, parameters, report, guard);
  guard(() => {
    exactKeys(descriptor.serialization, ['schema_version', 'fields'], ['schema_version', 'fields'], '$.descriptor.serialization');
    if (!Number.isInteger(descriptor.serialization.schema_version) || descriptor.serialization.schema_version <= 0)
      fail('semantic', 'INVALID_SERIALIZATION_VERSION', '$.descriptor.serialization.schema_version', 'Serialization schema version must be positive.');
    const fields = array(descriptor.serialization.fields, '$.descriptor.serialization.fields');
    fields.forEach((field, index) => id(field, `$.descriptor.serialization.fields[${index}]`));
    if (fields.length !== parameters.size || new Set(fields).size !== fields.length ||
        fields.some((field) => !parameters.has(field)))
      fail('semantic', 'INVALID_SERIALIZATION_FIELDS', '$.descriptor.serialization.fields',
        'Serialization fields must name every parameter exactly once.');
  });
  validatePresetBank(document.preset_bank, parameters, pathPolicies, report, guard);
  return diagnostics;
}

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    // Null-prototype: an own "__proto__" key is copied, not applied.
    const result = Object.create(null);
    for (const key of Object.keys(value).map((key) => key.normalize('NFC')).sort(codePointCompare))
      result[key] = canonicalValue(value[key]);
    return result;
  }
  return typeof value === 'string' ? value.normalize('NFC') : value;
};

export function stableStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

const quantizeParameter = (parameter) => {
  const domain = parameter.storage === 'enum8'
    ? { values: [...parameter.domain.values] }
    : {
        minimum: Math.fround(parameter.domain.minimum),
        maximum: Math.fround(parameter.domain.maximum),
      };
  const quantized = {
    ...parameter,
    domain,
    interpolation: {
      ...parameter.interpolation,
      ...(parameter.interpolation.period === undefined
        ? {} : { period: Math.fround(parameter.interpolation.period) }),
    },
  };
  return {
    ...quantized,
    default: validateStoredValue(
      quantized,
      parameter.default,
      `parameter.${parameter.id}.default`,
    ),
  };
};

// The canonical descriptor keeps the chain array in document order with its
// labels: both are digest-bearing, so reordering stages or renaming an
// instance is a descriptor change while re-serializing the same document is
// not. Serialization fields are a set - a validated permutation of the
// parameter ids - so they sort with the parameters.
export function canonicalDescriptor(document) {
  const source = document.descriptor;
  const descriptor = {
    chain: source.chain.map((entry) => ({ label: entry.label, operator: entry.operator })),
    parameters: source.parameters.map(quantizeParameter)
      .sort((a, b) => codePointCompare(a.id, b.id)),
    path_policies: [...source.path_policies].sort((a, b) => codePointCompare(a.id, b.id)),
    serialization: {
      ...source.serialization,
      fields: [...source.serialization.fields].sort(codePointCompare),
    },
  };
  return canonicalValue(descriptor);
}

export function canonicalPresetBank(document, descriptor = canonicalDescriptor(document)) {
  const parameters = new Map(descriptor.parameters.map((parameter) => [parameter.id, parameter]));
  const bank = document.preset_bank;
  return canonicalValue({
    ...bank,
    presets: bank.presets.map((preset) => ({
      ...preset,
      values: Object.fromEntries(Object.entries(preset.values).map(([parameterId, value]) => [
        parameterId,
        validateStoredValue(parameters.get(parameterId), value, `preset.${preset.preset_id}.${parameterId}`),
      ])),
    })).sort((a, b) => codePointCompare(a.preset_id, b.preset_id)),
    edges: [...bank.edges].sort((a, b) =>
      codePointCompare(`${a.from}>${a.to}`, `${b.from}>${b.to}`)),
  });
}

/** The whole document in canonical form: what the committed files carry. */
export function canonicalShaderDocument(document) {
  const descriptor = canonicalDescriptor(document);
  return canonicalValue({
    ...document,
    descriptor,
    preset_bank: canonicalPresetBank(document, descriptor),
  });
}

/** The canonical on-disk serialization; expansion re-export is pinned to it. */
export function exportShaderDocumentJson(document) {
  return `${JSON.stringify(canonicalShaderDocument(document), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Version 1 expansion. A schema_version 1 document (the six-role nodes/edges
// graph) is expanded to a version-2 chain before validation, so v2 validation
// and canonicalization are the single code path for both generations.

const V1_STAGE_ROLES = Object.freeze([
  'outer_camera',
  'surface_project',
  'planar_warp',
  'source',
  'material',
  'color',
]);

const failV1 = (code, path, message) =>
  fail('semantic', code, path, message);

const V1_LENS_OPERATORS = {
  glitch: { operator: 'sphere.lens.glitch.v2' },
  twist: { operator: 'sphere.lens.twist.v2' },
  mobius: { operator: 'sphere.lens.mobius.v2' },
  kaleidoscope: { operator: 'sphere.lens.kaleidoscope.v2', topology: { symmetry: 'azimuthal' } },
  'tetrahedral-kaleidoscope': { operator: 'sphere.lens.kaleidoscope.v2', topology: { symmetry: 'tetrahedral' } },
  'octahedral-kaleidoscope': { operator: 'sphere.lens.kaleidoscope.v2', topology: { symmetry: 'octahedral' } },
  'dodecahedral-kaleidoscope': { operator: 'sphere.lens.kaleidoscope.v2', topology: { symmetry: 'dodecahedral' } },
  'triangular-prism-kaleidoscope': { operator: 'sphere.lens.kaleidoscope.v2', topology: { symmetry: 'triangular-prism' } },
  'square-prism-kaleidoscope': { operator: 'sphere.lens.kaleidoscope.v2', topology: { symmetry: 'square-prism' } },
  'pentagonal-prism-kaleidoscope': { operator: 'sphere.lens.kaleidoscope.v2', topology: { symmetry: 'pentagonal-prism' } },
  'hexagonal-prism-kaleidoscope': { operator: 'sphere.lens.kaleidoscope.v2', topology: { symmetry: 'hexagonal-prism' } },
  'octagonal-prism-kaleidoscope': { operator: 'sphere.lens.kaleidoscope.v2', topology: { symmetry: 'octagonal-prism' } },
};

const V1_SURFACE_OPERATORS = {
  'curl-noise-simplex-euler': {
    operator: 'sphere.displace.curl.v2',
    topology: { basis: 'simplex', integrator: 'euler' },
  },
  'direct-noise-simplex': {
    operator: 'sphere.displace.direct.v2',
    topology: { basis: 'simplex' },
  },
};

const V1_PROJECTION_OPERATORS = {
  stereographic: { operator: 'project.stereographic.v2' },
  equirectangular: { operator: 'project.equirectangular.v2' },
  'folded-sinusoidal': { operator: 'project.folded-sinusoidal.v2' },
  'gnomonic-folded': { operator: 'project.gnomonic.v2', topology: { hemisphere: 'folded' } },
};

const V1_WARP_OPERATORS = {
  'mirror-tile': { operator: 'warp.mirror-tile.v2' },
  'affine-frame': { operator: 'warp.affine.v2' },
  'wave-shear': { operator: 'warp.wave-shear.v2' },
  'vector-noise-simplex': { operator: 'warp.vector-noise.v2', topology: { basis: 'simplex' } },
  'polar-chart-linear': { operator: 'warp.polar-chart.v2', topology: { mode: 'linear' } },
};

const V1_SOURCE_OPERATORS = {
  grid: { operator: 'sample.grid.v2' },
  'twin-wave': { operator: 'sample.twin-wave.v2' },
  rings: { operator: 'sample.rings.v2' },
  spiral: { operator: 'sample.spiral.v2' },
  'primitive-lattice': { operator: 'sample.lattice.v2' },
};

const V1_TRANSFER_OPERATORS = {
  ridge: { operator: 'field.transfer.ridge.v2' },
  'iso-contour': { operator: 'field.transfer.iso-contour.v2' },
  'smooth-bands': { operator: 'field.transfer.smooth-bands.v2' },
};

const V1_COVERAGE_MODES = {
  opaque: 'none',
  projection: 'weight',
  'projection-squared': 'weight-squared',
  'edge-fade': 'edge-fade',
};

const V1_PALETTE_MODES = {
  'triadic-palette': 'triadic',
  'complementary-palette': 'complementary',
  'analogous-palette': 'analogous',
};

// The v1 identifier is bare or slot-prefixed; the target field id is the
// engine's Field::id in the owning operator's schema.
const V1_SAMPLE_FIELDS = {
  'pattern-freq': 'pattern-freq',
  speed: 'speed',
  complexity: 'complexity',
  'pattern-mix': 'pattern-mix',
  drift: 'drift',
  'source-angle-speed': 'angle-speed',
  'source-noise-scale': 'noise-scale',
  'source-noise-contrast': 'noise-contrast',
  'source-noise-speed': 'noise-speed',
  'lattice-cell-scale': 'lattice-cell-scale',
  'lattice-shape': 'lattice-shape',
  'lattice-softness': 'lattice-softness',
  'lattice-radius': 'lattice-radius',
};

const V1_PROJECT_FIELDS = {
  'pole-fade': 'singularity-fade',
  'projection-spin-speed': 'projection-spin-speed',
  'projection-wander': 'projection-wander',
  'central-meridian': 'central-meridian',
};

const V1_COLORIZE_FIELDS = new Set([
  'palette-chroma',
  'palette-mapping',
  'mapping-frequency',
  'mapping-phase',
  'phase-oscillation-depth',
  'phase-oscillation-speed',
  'brightness-depth',
  'value-opacity-low',
  'value-opacity-high',
  'hue-shift-amount',
  'hue-noise-scale',
  'hue-noise-speed',
]);

const V1_SURFACE_FIELDS = {
  'surface-noise-scale': 'scale',
  'surface-noise-strength': 'strength',
  'surface-noise-speed': 'speed',
  'surface-noise-direction': 'direction',
};

const v1PolicyPick = (table, value, path) => {
  const picked = table[value];
  if (!picked)
    failV1('V1_POLICY_UNSUPPORTED', path, `No chain operator expands v1 policy "${value}".`);
  return picked;
};

const v1Slots = (roleNodes) => {
  const surface = roleNodes.get('surface_project').policy ?? {};
  const material = roleNodes.get('material').policy ?? {};
  const color = roleNodes.get('color');
  const colorPolicy = color.policy ?? {};
  const warpPolicy = roleNodes.get('planar_warp').policy ?? {};
  const sequence = warpPolicy.sequence ??
    [warpPolicy.outer ?? 'identity', warpPolicy.inner ?? 'identity'];

  const slots = [];
  const add = (slotLabel, picked) => slots.push({
    label: slotLabel,
    operator: picked.operator,
    topology: { ...(picked.topology ?? {}) },
  });

  add('camera', { operator: 'sphere.rotate.v2' });

  const lens = surface.lens ?? 'identity';
  if (lens !== 'identity')
    add('lens', v1PolicyPick(V1_LENS_OPERATORS, lens, 'stage.surface_project.lens'));

  const pre = surface.pre_lens_surface ?? 'identity';
  const post = surface.post_lens_surface ?? 'identity';
  if (pre !== 'identity' && post !== 'identity')
    failV1('V1_POLICY_UNSUPPORTED', 'stage.surface_project',
      'A v1 document with two surface displacements has no chain expansion.');
  const displacement = pre !== 'identity' ? pre : post;
  if (displacement !== 'identity')
    add('surface', v1PolicyPick(V1_SURFACE_OPERATORS, displacement, 'stage.surface_project'));

  if (surface.projection === undefined)
    failV1('V1_POLICY_UNSUPPORTED', 'stage.surface_project.projection',
      'A v1 document must name its projection.');
  add('project',
    v1PolicyPick(V1_PROJECTION_OPERATORS, surface.projection, 'stage.surface_project.projection'));

  sequence.forEach((warp, index) => {
    if (warp === 'identity') return;
    add(`warp${index + 1}`,
      v1PolicyPick(V1_WARP_OPERATORS, warp, `stage.planar_warp.sequence[${index}]`));
  });

  const source = roleNodes.get('source').policy?.source;
  if (source === undefined)
    failV1('V1_POLICY_UNSUPPORTED', 'stage.source', 'A v1 document must name its source.');
  add('sample', v1PolicyPick(V1_SOURCE_OPERATORS, source, 'stage.source'));
  const sample = slots[slots.length - 1];
  if (material.weight !== undefined) {
    if (material.weight !== 'projection' && material.weight !== 'none')
      failV1('V1_POLICY_UNSUPPORTED', 'stage.material.weight',
        `No weight-mode expands v1 weight "${material.weight}".`);
    sample.topology['weight-mode'] = material.weight;
  }
  const coverage = material.coverage;
  if (coverage !== undefined && coverage !== 'value-cutout') {
    if (!(coverage in V1_COVERAGE_MODES))
      failV1('V1_POLICY_UNSUPPORTED', 'stage.material.coverage',
        `No coverage-mode expands v1 coverage "${coverage}".`);
    sample.topology['coverage-mode'] = V1_COVERAGE_MODES[coverage];
  }

  if (material.transfer !== undefined && material.transfer !== 'linear')
    add('transfer', v1PolicyPick(V1_TRANSFER_OPERATORS, material.transfer, 'stage.material.transfer'));
  if (coverage === 'value-cutout')
    add('cutout', { operator: 'field.coverage.value-cutout.v2' });

  const paletteKind = colorPolicy.color ?? 'generated-palette';
  if (paletteKind !== 'generated-palette' && paletteKind !== 'generated_palette')
    failV1('V1_POLICY_UNSUPPORTED', 'stage.color', `No colorize operator expands "${paletteKind}".`);
  add('colorize', { operator: 'colorize.generated-palette.v2' });
  const colorize = slots[slots.length - 1];
  for (const resource of color.resources ?? [])
    if (resource in V1_PALETTE_MODES)
      colorize.topology['palette-mode'] = V1_PALETTE_MODES[resource];
  if (colorPolicy.hue_mode !== undefined) {
    if (colorPolicy.hue_mode !== 'noise' && colorPolicy.hue_mode !== 'path-length')
      failV1('V1_POLICY_UNSUPPORTED', 'stage.color.hue_mode',
        `No hue-shift-mode expands v1 hue mode "${colorPolicy.hue_mode}".`);
    colorize.topology['hue-shift-mode'] = colorPolicy.hue_mode;
  }
  if (colorPolicy.brightness_envelope !== undefined) {
    if (colorPolicy.brightness_envelope !== 'none' && colorPolicy.brightness_envelope !== 'cup')
      failV1('V1_POLICY_UNSUPPORTED', 'stage.color.brightness_envelope',
        `No brightness-envelope expands "${colorPolicy.brightness_envelope}".`);
    colorize.topology['brightness-envelope'] = colorPolicy.brightness_envelope;
  }
  return slots;
};

const v1ParameterTarget = (parameterId, slotsByLabel) => {
  const slot = (slotLabel) => slotsByLabel.get(slotLabel);
  const bind = (slotLabel, field) => {
    if (!slot(slotLabel))
      failV1('V1_PARAMETER_UNMAPPED', `parameter.${parameterId}`,
        `Parameter "${parameterId}" binds the absent "${slotLabel}" slot.`);
    return `${slotLabel}.${field}`;
  };

  const prefixed = parameterId.match(/^(outer|inner|mirror|mobius)-(.+)$/u);
  if (prefixed) {
    const tail = prefixed[2];
    if (prefixed[1] === 'outer') return bind('warp1', tail);
    if (prefixed[1] === 'inner') return bind('warp2', tail);
    // The engine schema keeps the mobius- prefix in its field ids
    // (mobius-a-re .. mobius-d-im), so the whole v1 id is the field.
    if (prefixed[1] === 'mobius') return bind('lens', parameterId);
    const mirror = ['warp2', 'warp1'].find((slotLabel) =>
      slot(slotLabel)?.operator === 'warp.mirror-tile.v2');
    if (!mirror)
      failV1('V1_PARAMETER_UNMAPPED', `parameter.${parameterId}`,
        `Parameter "${parameterId}" binds no mirror-tile warp slot.`);
    return `${mirror}.${tail}`;
  }
  // v1 camera-wander lived on the projection slot's parameter list, but the
  // motion it drives is the camera walk: the engine carries it as
  // sphere.rotate.v2's wander field.
  if (parameterId === 'camera-wander') return bind('camera', 'wander');
  // One v1 'edge-width' had two meanings, told apart by the material coverage
  // policy: under edge-fade coverage it is the sample stage's projected-
  // coverage fade width; under value-cutout (which expands to a cutout slot)
  // it is the cutout transition width, named cutout-softness in the engine
  // schema.
  if (parameterId === 'edge-width') {
    return slot('cutout')
      ? bind('cutout', 'cutout-softness') : bind('sample', 'edge-width');
  }
  if (parameterId in V1_SURFACE_FIELDS)
    return bind('surface', V1_SURFACE_FIELDS[parameterId]);
  if (parameterId === 'iso-level' || parameterId === 'iso-width')
    return bind('transfer', parameterId);
  if (parameterId in V1_SAMPLE_FIELDS)
    return bind('sample', V1_SAMPLE_FIELDS[parameterId]);
  if (parameterId in V1_PROJECT_FIELDS)
    return bind('project', V1_PROJECT_FIELDS[parameterId]);
  if (V1_COLORIZE_FIELDS.has(parameterId)) return bind('colorize', parameterId);
  return failV1('V1_PARAMETER_UNMAPPED', `parameter.${parameterId}`,
    `Parameter "${parameterId}" has no chain field mapping.`);
};

/**
 * Expands a schema_version 1 six-role document to the version-2 chain
 * encoding: deterministic instance labels in slot order, v1 policy objects
 * consumed into operator selection plus topology enum8 parameters, and a
 * complete parameter-id rewrite applied to presets, staggered path-policy
 * groups and serialization fields. v1 documents distinct only by an identity
 * policy spelling expand to the same chain by design.
 * @param {Object} document - Parsed schema_version 1 document.
 * @param {Object} catalog - The operator catalog.
 * @returns {{document: Object, parameter_ids: Object}} The version-2 document
 *   and the complete v1-id -> v2-id rewrite map.
 */
export function expandV1Document(document, catalog) {
  const { operators } = requireCatalog(catalog);
  exactKeys(document,
    ['schema_version', 'catalog_version', 'document_id', 'effect_id', 'descriptor', 'preset_bank',
      'effect_metadata', 'product_metadata', 'study_metadata', 'extensions'],
    ['schema_version', 'catalog_version', 'document_id', 'descriptor', 'preset_bank'], '$');
  if (document.schema_version !== 1)
    fail('schema', 'UNSUPPORTED_DOCUMENT_SCHEMA', '$.schema_version',
      'Only a schema_version 1 document can be expanded.');
  const descriptor = object(document.descriptor, '$.descriptor');
  const graph = object(descriptor.graph, '$.descriptor.graph');
  const nodes = array(graph.nodes, '$.descriptor.graph.nodes');
  const roleNodes = new Map();
  nodes.forEach((node, index) => {
    const path = `$.descriptor.graph.nodes[${index}]`;
    object(node, path);
    if (!V1_STAGE_ROLES.includes(node.role))
      failV1('INVALID_STAGE_ROLE', `${path}.role`, `Unknown stage role "${node.role}".`);
    if (roleNodes.has(node.role))
      failV1('DUPLICATE_STAGE_ROLE', `${path}.role`, `Duplicate stage role "${node.role}".`);
    roleNodes.set(node.role, node);
  });
  for (const role of V1_STAGE_ROLES)
    if (!roleNodes.has(role))
      failV1('MISSING_STAGE_ROLE', '$.descriptor.graph.nodes', `Missing stage role "${role}".`);

  const slots = v1Slots(roleNodes);
  const slotsByLabel = new Map(slots.map((slot) => [slot.label, slot]));
  const chain = slots.map((slot) => ({ label: slot.label, operator: slot.operator }));

  // Null-prototype: rewriteId's `in` must answer for mapped ids only.
  const parameterIds = Object.create(null);
  const parameters = array(descriptor.parameters, '$.descriptor.parameters').map((parameter) => {
    const target = v1ParameterTarget(id(parameter.id, '$.descriptor.parameters'), slotsByLabel);
    parameterIds[parameter.id] = target;
    const { binding: droppedBinding, ...kept } = parameter;
    void droppedBinding;
    return { ...kept, id: target };
  });

  // Policy-determined topology choices become ordinary enum8 parameters whose
  // domain is the catalog's value list; every preset then carries the choice.
  const topologyParameters = [];
  for (const slot of slots) {
    const operator = operators.get(slot.operator);
    if (!operator)
      failV1('V1_POLICY_UNSUPPORTED', `chain.${slot.label}`,
        `The catalog carries no operator "${slot.operator}".`);
    for (const [field, value] of Object.entries(slot.topology)) {
      const schema = operatorField(operator, field);
      if (!schema?.topology || !schema.values.includes(value))
        failV1('V1_POLICY_UNSUPPORTED', `chain.${slot.label}.${field}`,
          `Operator "${slot.operator}" has no topology value "${field}=${value}".`);
      topologyParameters.push({
        id: `${slot.label}.${field}`,
        classification: 'preset',
        storage: 'enum8',
        unit: 'mode',
        domain: { values: [...schema.values] },
        interpolation: { kind: 'MIXED_ENUM' },
        default: value,
      });
    }
  }
  const topologyIds = topologyParameters.map((parameter) => parameter.id);
  const topologyDefaults = Object.fromEntries(
    topologyParameters.map((parameter) => [parameter.id, parameter.default]));

  const rewriteId = (parameterId, path) => {
    if (!(parameterId in parameterIds))
      failV1('V1_PARAMETER_UNMAPPED', path, `Unknown v1 parameter "${parameterId}".`);
    return parameterIds[parameterId];
  };

  const pathPolicies = array(descriptor.path_policies, '$.descriptor.path_policies')
    .map((policy) => (policy.kind !== 'STAGGERED_ORDERED' ? policy : {
      ...policy,
      groups: policy.groups.map((group) =>
        (group in parameterIds ? parameterIds[group] : group)),
    }));

  const serialization = object(descriptor.serialization, '$.descriptor.serialization');
  const fields = array(serialization.fields, '$.descriptor.serialization.fields')
    .map((field, index) => rewriteId(field, `$.descriptor.serialization.fields[${index}]`));

  const bank = object(document.preset_bank, '$.preset_bank');
  const presets = array(bank.presets, '$.preset_bank.presets').map((preset) => ({
    ...preset,
    values: {
      ...Object.fromEntries(Object.entries(object(preset.values, '$.preset_bank.presets'))
        .map(([parameterId, value]) =>
          [rewriteId(parameterId, `preset.${preset.preset_id}.${parameterId}`), value])),
      ...topologyDefaults,
    },
  }));

  const expanded = {
    ...document,
    schema_version: SHADER_DOCUMENT_SCHEMA_VERSION,
    catalog_version: OPERATOR_CATALOG_VERSION,
    descriptor: {
      chain,
      parameters: [...parameters, ...topologyParameters],
      path_policies: pathPolicies,
      serialization: {
        schema_version: serialization.schema_version,
        fields: [...fields, ...topologyIds],
      },
    },
    preset_bank: { ...bank, presets },
  };
  return { document: expanded, parameter_ids: parameterIds };
}

// The version-1 canonical form, kept frozen so v1 descriptor digests stay
// computable: the digest-migration table maps them onto the digests of the
// expanded chains.
const canonicalV1Descriptor = (document) => {
  const source = document.descriptor;
  const roleIndex = new Map(V1_STAGE_ROLES.map((role, index) => [role, index]));
  const labels = new Map(source.graph.nodes.map((node) => [node.label, node.role]));
  const graph = {
    nodes: source.graph.nodes.map((node) => {
      const result = { role: node.role, operator: node.operator };
      if ('policy' in node) result.policy = node.policy;
      if ('resources' in node) result.resources = [...node.resources].sort(codePointCompare);
      return result;
    }).sort((a, b) => roleIndex.get(a.role) - roleIndex.get(b.role)),
    edges: source.graph.edges.map((edge) => ({
      from: labels.get(edge.from),
      to: labels.get(edge.to),
    })).sort((a, b) => roleIndex.get(a.from) - roleIndex.get(b.from)),
  };
  const descriptor = {
    ...source,
    graph,
    parameters: source.parameters.map(quantizeParameter)
      .sort((a, b) => codePointCompare(a.id, b.id)),
  };
  for (const field of ['path_policies', 'clocks', 'preparation', 'resources', 'approximation'])
    descriptor[field] = [...descriptor[field]].sort((a, b) => codePointCompare(a.id, b.id));
  return canonicalValue(descriptor);
};

/** The digest a schema_version 1 document had under the version-1 compiler. */
export function v1DescriptorDigest(document) {
  return sha256Hex(stableStringify(canonicalV1Descriptor(document)));
}

export function compileShaderDocument(source, options = {}) {
  try {
    let document = typeof source === 'string'
      ? parseShaderDocument(source, options.limits)
      : checkDecodedDocumentDepth(source, options.limits);
    object(document, '$');
    let parameterIds = null;
    if (document.schema_version === 1) {
      const expansion = expandV1Document(document, options.catalog);
      document = expansion.document;
      parameterIds = expansion.parameter_ids;
    }
    const diagnostics = validateShaderDocument(document, options);
    if (diagnostics.length > 0) return { status: 'INVALID', diagnostics };
    const descriptor = canonicalDescriptor(document);
    const descriptor_json = stableStringify(descriptor);
    const descriptor_digest = sha256Hex(descriptor_json);
    const preset_bank = canonicalPresetBank(document, descriptor);
    const preset_bank_json = stableStringify(preset_bank);
    const preset_bank_digest = sha256Hex(preset_bank_json);
    return {
      status: 'VALID',
      document,
      descriptor,
      descriptor_json,
      descriptor_digest,
      preset_bank,
      preset_bank_json,
      preset_bank_digest,
      diagnostics: [],
      ...(parameterIds === null ? {} : { parameter_ids: parameterIds }),
    };
  } catch (error) {
    if (!(error instanceof ShaderDocumentError)) throw error;
    return { status: 'INVALID', diagnostics: [error.diagnostic()] };
  }
}

export function classifyExport(compiled, registry, capabilityProfile) {
  if (compiled.status !== 'VALID')
    return { kind: 'REJECTED', diagnostics: compiled.diagnostics };
  const matches = registry.effects.filter((effect) =>
    effect.descriptor_digest === compiled.descriptor_digest &&
    stableStringify(effect.descriptor) === compiled.descriptor_json);
  if (matches.length > 1)
    return {
      kind: 'REJECTED',
      diagnostics: [{ severity: 'error', phase: 'classification', code: 'AMBIGUOUS_EFFECT_MATCH',
        path: '$.descriptor', message: 'The descriptor matches more than one registered effect.' }],
    };
  if (matches.length === 0)
    return { kind: 'CREATE_EFFECT_CANDIDATE', descriptor_digest: compiled.descriptor_digest };
  const [effect] = matches;
  if (!(effect.capability_profiles ?? []).includes(capabilityProfile))
    return {
      kind: 'REJECTED',
      effect_id: effect.effect_id,
      diagnostics: [{ severity: 'error', phase: 'target', code: 'KNOWN_UNAVAILABLE',
        path: '$.effect_id', message: `Effect "${effect.effect_id}" is unavailable for "${capabilityProfile}".` }],
    };
  return { kind: 'ADD_PRESET_CANDIDATE', effect_id: effect.effect_id };
}

const clampUnit = (value) => value <= 0 ? 0 : value >= 1 ? 1 : value;

export function applyEasing(kind, progress) {
  const t = clampUnit(Math.fround(progress));
  if (t === 0 || t === 1) return t;
  if (kind === 'LINEAR') return t;
  if (kind === 'EASE_IN_OUT_SIN')
    return Math.fround((1 - Math.cos(Math.PI * t)) * 0.5);
  fail('transition', 'UNKNOWN_EASING', '$.easing', `Unknown easing "${kind}".`);
}

export function interpolateValue(parameter, from, to, progress) {
  const a = validateStoredValue(parameter, from, `from.${parameter.id}`);
  const b = validateStoredValue(parameter, to, `to.${parameter.id}`);
  const t = Math.fround(progress);
  if (t <= 0) return a;
  if (t >= 1) return b;
  if (parameter.interpolation.kind === 'MIXED_ENUM')
    return a === b ? a : { from: a, to: b, mix: t };
  switch (parameter.interpolation.kind) {
  case 'LINEAR':
    return Math.fround(a + Math.fround(Math.fround(b - a) * t));
  case 'LOG_POSITIVE':
    return Math.fround(Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t));
  case 'SHORTEST_PERIODIC': {
    const period = Math.fround(parameter.interpolation.period);
    const delta = ((b - a + period * 0.5) % period + period) % period - period * 0.5;
    let value = (a + delta * t) % period;
    if (value < 0) value += period;
    const stored = Math.fround(value);
    return stored >= period ? 0 : stored;
  }
  case 'SNAP':
    // Progress is inside (0, 1) here: the start value holds until it reaches 1.
    return a;
  case 'NORMALIZED_LINEAR':
    return fail('transition', 'GROUP_REQUIRED', `parameter.${parameter.id}`, 'Normalized-linear fields must be evaluated as a complete group.');
  default:
    return fail('transition', 'UNKNOWN_INTERPOLATION', `parameter.${parameter.id}`, 'The interpolation trait is unknown.');
  }
}

export function interpolateNormalizedGroup(parameters, from, to, progress, epsilon = 1e-6) {
  const t = Math.fround(progress);
  if (t <= 0) return Object.fromEntries(parameters.map((parameter) =>
    [parameter.id, validateStoredValue(parameter, from[parameter.id], `from.${parameter.id}`)]));
  if (t >= 1) return Object.fromEntries(parameters.map((parameter) =>
    [parameter.id, validateStoredValue(parameter, to[parameter.id], `to.${parameter.id}`)]));
  const values = parameters.map((parameter) => {
    const a = validateStoredValue(parameter, from[parameter.id], `from.${parameter.id}`);
    const b = validateStoredValue(parameter, to[parameter.id], `to.${parameter.id}`);
    return Math.fround(a + Math.fround(Math.fround(b - a) * t));
  });
  const norm = Math.hypot(...values);
  if (norm <= epsilon)
    fail('transition', 'DEGENERATE_NORMALIZED_PATH', '$.transition', 'A normalized interpolation path reached the catalog epsilon.');
  return Object.fromEntries(parameters.map((parameter, index) =>
    [parameter.id, Math.fround(values[index] / norm)]));
}

export function evaluateTransition(descriptor, bank, fromId, toId, evaluation) {
  const edge = bank.edges.find((candidate) => candidate.from === fromId && candidate.to === toId);
  if (!edge)
    fail('transition', 'ABSENT_EDGE', '$.preset_bank.edges', `No transition edge exists from "${fromId}" to "${toId}".`);
  if (!Number.isInteger(evaluation) || evaluation < 0 || evaluation > edge.duration)
    fail('transition', 'INVALID_EVALUATION', '$.transition.evaluation', 'Evaluation must be an integer in [0, duration].');
  const fromPreset = bank.presets.find((preset) => preset.preset_id === fromId);
  const toPreset = bank.presets.find((preset) => preset.preset_id === toId);
  if (!fromPreset || !toPreset)
    fail('transition', 'INVALID_EDGE_ENDPOINT', '$.preset_bank.presets', 'A transition edge names a missing preset.');
  const from = fromPreset.values;
  const to = toPreset.values;
  const raw = Math.fround(evaluation / edge.duration);
  const eased = applyEasing(edge.easing, raw);
  const policy = descriptor.path_policies.find((candidate) => candidate.id === edge.path_policy);
  if (!policy)
    fail('transition', 'UNKNOWN_EDGE_PATH', '$.descriptor.path_policies', 'A transition edge names a missing path policy.');
  const parameterGroups = new Map();
  for (const parameter of descriptor.parameters) {
    const group = parameter.interpolation.group ?? parameter.id;
    if (!parameterGroups.has(group)) parameterGroups.set(group, []);
    parameterGroups.get(group).push(parameter);
  }
  const progressFor = (group) => {
    if (policy.kind === 'PARALLEL') return eased;
    const index = policy.groups.indexOf(group);
    return Math.fround(clampUnit(eased * policy.groups.length - index));
  };
  const values = {};
  for (const [group, parameters] of parameterGroups) {
    const progress = progressFor(group);
    if (parameters[0].interpolation.kind === 'NORMALIZED_LINEAR')
      Object.assign(values, interpolateNormalizedGroup(parameters, from, to, progress));
    else
      for (const parameter of parameters)
        values[parameter.id] = interpolateValue(parameter, from[parameter.id], to[parameter.id], progress);
  }
  return { evaluation, duration: edge.duration, raw_progress: raw, eased_progress: eased, values };
}
