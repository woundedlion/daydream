/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { sha256Hex } from './sha256.mjs';

export const SHADER_DOCUMENT_SCHEMA_VERSION = 1;
export const OPERATOR_CATALOG_VERSION = 1;

export const LINEAR_STAGE_ROLES = Object.freeze([
  'outer_camera',
  'surface_project',
  'planar_warp',
  'source',
  'material',
  'color',
]);

export const OPERATOR_CATALOG = Object.freeze({
  'pullback.outer_camera.v1': 'outer_camera',
  'pullback.surface_project.v1': 'surface_project',
  'pullback.planar_warp.v1': 'planar_warp',
  'pullback.source.v1': 'source',
  'pullback.material.v1': 'material',
  'pullback.color.v1': 'color',
});

export const DEFAULT_LIMITS = Object.freeze({
  bytes: 1024 * 1024,
  depth: 32,
  stringLength: 4096,
  nodes: 256,
  edges: 512,
  parameters: 512,
  resources: 128,
});

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
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
    const result = {};
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

const recordList = (value, path, limits, kind) => {
  array(value, path);
  if (kind === 'resources' && value.length > limits.resources)
    fail('schema', 'RESOURCE_LIMIT', path, 'The resource limit was exceeded.');
  const seen = new Set();
  for (let index = 0; index < value.length; ++index) {
    const entryPath = `${path}[${index}]`;
    exactKeys(value[index], ['id', 'kind', 'settings'], ['id', 'kind'], entryPath);
    id(value[index].id, `${entryPath}.id`);
    id(value[index].kind, `${entryPath}.kind`);
    if (seen.has(value[index].id))
      fail('semantic', 'DUPLICATE_ID', `${entryPath}.id`, `Duplicate ${kind} ID "${value[index].id}".`);
    seen.add(value[index].id);
    if ('settings' in value[index]) object(value[index].settings, `${entryPath}.settings`);
  }
};

const validateGraph = (graph, limits, catalog) => {
  exactKeys(graph, ['nodes', 'edges'], ['nodes', 'edges'], '$.descriptor.graph');
  const nodes = array(graph.nodes, '$.descriptor.graph.nodes');
  const edges = array(graph.edges, '$.descriptor.graph.edges');
  if (nodes.length > limits.nodes)
    fail('schema', 'NODE_LIMIT', '$.descriptor.graph.nodes', 'The graph node limit was exceeded.');
  if (edges.length > limits.edges)
    fail('schema', 'EDGE_LIMIT', '$.descriptor.graph.edges', 'The graph edge limit was exceeded.');
  if (nodes.length !== LINEAR_STAGE_ROLES.length)
    fail('semantic', 'UNSUPPORTED_GRAPH', '$.descriptor.graph.nodes', 'Version 1 requires the linear six-role graph.');

  const labels = new Map();
  const roles = new Map();
  const unsupported = [];
  nodes.forEach((node, index) => {
    const path = `$.descriptor.graph.nodes[${index}]`;
    exactKeys(node, ['label', 'role', 'operator', 'policy', 'resources'],
      ['label', 'role', 'operator'], path);
    id(node.label, `${path}.label`);
    id(node.operator, `${path}.operator`);
    if (!LINEAR_STAGE_ROLES.includes(node.role))
      fail('semantic', 'INVALID_STAGE_ROLE', `${path}.role`, `Unknown stage role "${node.role}".`);
    if (labels.has(node.label))
      fail('semantic', 'DUPLICATE_NODE', `${path}.label`, `Duplicate node label "${node.label}".`);
    if (roles.has(node.role))
      fail('semantic', 'DUPLICATE_STAGE_ROLE', `${path}.role`, `Duplicate stage role "${node.role}".`);
    labels.set(node.label, node);
    roles.set(node.role, node);
    if (catalog[node.operator] !== node.role) unsupported.push({ node, path });
    if ('policy' in node) object(node.policy, `${path}.policy`);
    if ('resources' in node) {
      array(node.resources, `${path}.resources`);
      node.resources.forEach((resource, resourceIndex) =>
        id(resource, `${path}.resources[${resourceIndex}]`));
    }
  });
  for (const role of LINEAR_STAGE_ROLES)
    if (!roles.has(role))
      fail('semantic', 'MISSING_STAGE_ROLE', '$.descriptor.graph.nodes', `Missing stage role "${role}".`);

  const expected = new Set();
  for (let index = 0; index + 1 < LINEAR_STAGE_ROLES.length; ++index)
    expected.add(`${LINEAR_STAGE_ROLES[index]}>${LINEAR_STAGE_ROLES[index + 1]}`);
  const actual = new Set();
  edges.forEach((edge, index) => {
    const path = `$.descriptor.graph.edges[${index}]`;
    exactKeys(edge, ['from', 'to'], ['from', 'to'], path);
    if (!labels.has(edge.from) || !labels.has(edge.to))
      fail('semantic', 'UNKNOWN_EDGE_NODE', path, 'An edge refers to an unknown node label.');
    const key = `${labels.get(edge.from).role}>${labels.get(edge.to).role}`;
    if (actual.has(key))
      fail('semantic', 'DUPLICATE_EDGE', path, `Duplicate edge "${key}".`);
    actual.add(key);
  });
  if (actual.size !== expected.size || [...actual].some((edge) => !expected.has(edge)))
    fail('semantic', 'INVALID_LINEAR_GRAPH', '$.descriptor.graph.edges', 'Edges must connect the six stage roles in order.');
  return unsupported;
};

const validateParameters = (parameters, limits) => {
  array(parameters, '$.descriptor.parameters');
  if (parameters.length > limits.parameters)
    fail('schema', 'PARAMETER_LIMIT', '$.descriptor.parameters', 'The parameter limit was exceeded.');
  const seen = new Set();
  const groups = new Map();
  parameters.forEach((parameter, index) => {
    const path = `$.descriptor.parameters[${index}]`;
    exactKeys(parameter,
      ['id', 'binding', 'classification', 'storage', 'unit', 'domain', 'interpolation', 'default'],
      ['id', 'binding', 'classification', 'storage', 'unit', 'domain', 'interpolation', 'default'], path);
    id(parameter.id, `${path}.id`);
    id(parameter.binding, `${path}.binding`);
    if (seen.has(parameter.id))
      fail('semantic', 'DUPLICATE_PARAMETER', `${path}.id`, `Duplicate parameter ID "${parameter.id}".`);
    seen.add(parameter.id);
    if (!CLASSIFICATIONS.has(parameter.classification))
      fail('schema', 'INVALID_CLASSIFICATION', `${path}.classification`, 'The field classification is invalid.');
    if (parameter.classification !== 'preset')
      fail('semantic', 'NON_PRESET_PARAMETER', `${path}.classification`, 'Continuous parameters must be classified as preset values.');
    if (parameter.storage !== 'binary32' && parameter.storage !== 'enum8')
      fail('semantic', 'UNSUPPORTED_STORAGE', `${path}.storage`, 'Version 1 storage is binary32 or enum8.');
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
    if (parameter.interpolation.kind === 'NORMALIZED_LINEAR') {
      id(parameter.interpolation.group, `${path}.interpolation.group`);
      groups.set(parameter.interpolation.group, (groups.get(parameter.interpolation.group) ?? 0) + 1);
    }
    validateStoredValue(parameter, parameter.default, `${path}.default`);
  });
  for (const [group, count] of groups)
    if (count < 2)
      fail('semantic', 'INVALID_NORMALIZED_GROUP', '$.descriptor.parameters', `Normalized group "${group}" needs at least two fields.`);
  return new Map(parameters.map((parameter) => [parameter.id, parameter]));
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

const validatePathPolicies = (policies, parameters) => {
  array(policies, '$.descriptor.path_policies');
  const seen = new Set();
  policies.forEach((policy, index) => {
    const path = `$.descriptor.path_policies[${index}]`;
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
      const available = new Set(parameters.map((parameter) =>
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
  if (seen.size === 0)
    fail('semantic', 'MISSING_PATH_POLICY', '$.descriptor.path_policies', 'At least one path policy is required.');
  return seen;
};

const validatePresetBank = (bank, parameters, pathPolicies) => {
  exactKeys(bank, ['schema_version', 'presets', 'edges', 'absent_edge_fallback', 'choreography'],
    ['schema_version', 'presets', 'edges', 'absent_edge_fallback', 'choreography'], '$.preset_bank');
  if (bank.schema_version !== 1)
    fail('schema', 'UNSUPPORTED_BANK_SCHEMA', '$.preset_bank.schema_version', 'Only preset-bank schema 1 is supported.');
  const presets = array(bank.presets, '$.preset_bank.presets');
  if (presets.length === 0)
    fail('semantic', 'EMPTY_PRESET_BANK', '$.preset_bank.presets', 'A preset bank needs at least one preset.');
  const presetIds = new Set();
  presets.forEach((preset, index) => {
    const path = `$.preset_bank.presets[${index}]`;
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

  const edgeKeys = new Set();
  array(bank.edges, '$.preset_bank.edges').forEach((edge, index) => {
    const path = `$.preset_bank.edges[${index}]`;
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

  exactKeys(bank.absent_edge_fallback, ORIGINS, ORIGINS, '$.preset_bank.absent_edge_fallback');
  for (const origin of ORIGINS)
    if (bank.absent_edge_fallback[origin] !== 'SNAP' && bank.absent_edge_fallback[origin] !== 'REJECT')
      fail('semantic', 'INVALID_EDGE_FALLBACK', `$.preset_bank.absent_edge_fallback.${origin}`, 'The absent-edge fallback must be SNAP or REJECT.');
  exactKeys(bank.choreography, ['generated_order', 'dwell'], ['generated_order'], '$.preset_bank.choreography');
  const order = array(bank.choreography.generated_order, '$.preset_bank.choreography.generated_order');
  if (order.length !== presetIds.size || new Set(order).size !== presetIds.size ||
      order.some((presetId) => !presetIds.has(presetId)))
    fail('semantic', 'INVALID_GENERATED_ORDER', '$.preset_bank.choreography.generated_order', 'Generated order must contain every preset exactly once.');
};

export function validateShaderDocument(document, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const catalog = options.catalog ?? OPERATOR_CATALOG;
  exactKeys(document,
    ['schema_version', 'catalog_version', 'document_id', 'effect_id', 'descriptor', 'preset_bank',
      'effect_metadata', 'product_metadata', 'study_metadata', 'extensions'],
    ['schema_version', 'catalog_version', 'document_id', 'descriptor', 'preset_bank'], '$');
  if (document.schema_version !== SHADER_DOCUMENT_SCHEMA_VERSION)
    fail('schema', 'UNSUPPORTED_DOCUMENT_SCHEMA', '$.schema_version', 'Only Shader document schema 1 is supported.');
  if (document.catalog_version !== OPERATOR_CATALOG_VERSION)
    fail('schema', 'UNSUPPORTED_CATALOG_SCHEMA', '$.catalog_version', 'Only operator catalog 1 is supported.');
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
    ['graph', 'parameters', 'path_policies', 'clocks', 'preparation', 'resources',
      'serialization', 'approximation', 'handoff'],
    ['graph', 'parameters', 'path_policies', 'clocks', 'preparation', 'resources',
      'serialization', 'approximation', 'handoff'], '$.descriptor');
  const unsupported = validateGraph(descriptor.graph, limits, catalog);
  const parameters = validateParameters(descriptor.parameters, limits);
  const pathPolicies = validatePathPolicies(descriptor.path_policies, descriptor.parameters);
  recordList(descriptor.clocks, '$.descriptor.clocks', limits, 'clock');
  recordList(descriptor.preparation, '$.descriptor.preparation', limits, 'preparation policy');
  recordList(descriptor.resources, '$.descriptor.resources', limits, 'resources');
  const resourceIds = new Set(descriptor.resources.map((resource) => resource.id));
  descriptor.graph.nodes.forEach((node, nodeIndex) =>
    (node.resources ?? []).forEach((resource, resourceIndex) => {
      if (!resourceIds.has(resource))
        fail('semantic', 'UNKNOWN_RESOURCE_BINDING',
          `$.descriptor.graph.nodes[${nodeIndex}].resources[${resourceIndex}]`,
          `Unknown resource binding "${resource}".`);
    }));
  recordList(descriptor.approximation, '$.descriptor.approximation', limits, 'approximation policy');
  exactKeys(descriptor.serialization, ['schema_version', 'fields'], ['schema_version', 'fields'], '$.descriptor.serialization');
  if (!Number.isInteger(descriptor.serialization.schema_version) || descriptor.serialization.schema_version <= 0)
    fail('semantic', 'INVALID_SERIALIZATION_VERSION', '$.descriptor.serialization.schema_version', 'Serialization schema version must be positive.');
  array(descriptor.serialization.fields, '$.descriptor.serialization.fields').forEach((field, index) =>
    id(field, `$.descriptor.serialization.fields[${index}]`));
  exactKeys(descriptor.handoff, ['policy'], ['policy'], '$.descriptor.handoff');
  id(descriptor.handoff.policy, '$.descriptor.handoff.policy');
  validatePresetBank(document.preset_bank, parameters, pathPolicies);
  return unsupported;
}

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).map((key) => key.normalize('NFC')).sort(codePointCompare))
      result[key] = canonicalValue(value[key]);
    return result;
  }
  return typeof value === 'string' ? value.normalize('NFC') : value;
};

export function stableStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalDescriptor(document) {
  const source = document.descriptor;
  const roleIndex = new Map(LINEAR_STAGE_ROLES.map((role, index) => [role, index]));
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
    parameters: source.parameters.map((parameter) => {
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
    }).sort((a, b) => codePointCompare(a.id, b.id)),
  };
  for (const field of ['path_policies', 'clocks', 'preparation', 'resources', 'approximation'])
    descriptor[field] = [...descriptor[field]].sort((a, b) => codePointCompare(a.id, b.id));
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

export function compileShaderDocument(source, options = {}) {
  try {
    const document = typeof source === 'string' ? parseShaderDocument(source, options.limits) : source;
    const unsupported = validateShaderDocument(document, options);
    const descriptor = canonicalDescriptor(document);
    const descriptor_json = stableStringify(descriptor);
    const descriptor_digest = sha256Hex(descriptor_json);
    const preset_bank = canonicalPresetBank(document, descriptor);
    const preset_bank_json = stableStringify(preset_bank);
    const preset_bank_digest = sha256Hex(preset_bank_json);
    const diagnostics = unsupported.map(({ node }) => ({
      severity: 'error',
      phase: 'target',
      code: 'OPERATOR_UNAVAILABLE',
      path: `stage.${node.role}`,
      message: `Operator "${node.operator}" is unavailable in catalog ${document.catalog_version}.`,
    }));
    return {
      status: diagnostics.length === 0 ? 'VALID' : 'VALID_BUT_UNSUPPORTED',
      document,
      descriptor,
      descriptor_json,
      descriptor_digest,
      preset_bank,
      preset_bank_json,
      preset_bank_digest,
      diagnostics,
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
    let delta = ((b - a + period * 0.5) % period + period) % period - period * 0.5;
    if (delta >= period * 0.5) delta -= period;
    let value = (a + delta * t) % period;
    if (value < 0) value += period;
    const stored = Math.fround(value);
    return stored >= period ? 0 : stored;
  }
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
  const from = bank.presets.find((preset) => preset.preset_id === fromId).values;
  const to = bank.presets.find((preset) => preset.preset_id === toId).values;
  const raw = Math.fround(evaluation / edge.duration);
  const eased = applyEasing(edge.easing, raw);
  const policy = descriptor.path_policies.find((candidate) => candidate.id === edge.path_policy);
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
