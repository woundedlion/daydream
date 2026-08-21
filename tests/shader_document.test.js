//
// shader/shader_workbench.mjs compiles an authoring document to the canonical
// descriptor and preset bank the digests are taken over, so its JSON reader,
// its validator and its canonical ordering are what decide a document's
// identity. The reader is a hand-written parser rather than JSON.parse because
// it has to reject what JSON.parse accepts — a duplicate key, a byte-order
// mark, an over-deep or over-long document — so those rejections are checked
// one by one. Schema v2 encodes the descriptor as an ordered operator chain
// validated against the engine catalog; a schema_version 1 document expands
// through expandV1Document first, the single code path both generations
// share, and the committed v2 pattern documents are pinned byte-identical to
// that expansion's canonical export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import {
  DEFAULT_LIMITS,
  ShaderDocumentError,
  applyEasing,
  canonicalDescriptor,
  classifyExport,
  compileShaderDocument,
  evaluateTransition,
  expandV1Document,
  exportShaderDocumentJson,
  interpolateValue,
  parseShaderDocument,
  stableStringify,
  v1DescriptorDigest,
  validateShaderDocument,
} from '../shader/shader_workbench.mjs';
import { sha256Hex } from '../shader/sha256.mjs';

const PATTERNS = new URL('../shader/patterns/', import.meta.url);
const FIXTURES = new URL('v1/', PATTERNS);
const CATALOG = JSON.parse(
  readFileSync(new URL('../shader/engine_catalog.json', import.meta.url), 'utf8'));
const MIGRATION = JSON.parse(
  readFileSync(new URL('digest_migration.v1v2.json', PATTERNS), 'utf8'));
const EXAMPLE = readFileSync(new URL('example.shader.json', PATTERNS), 'utf8');

/**
 * Reads a file the canonical LF export is pinned against. A CRLF working-tree
 * copy holds the same content, so line endings are normalized away and every
 * other byte still has to match.
 * @param {URL} url - File to read.
 * @returns {string} The text, LF-terminated.
 */
const readPinned = (url) => readFileSync(url, 'utf8').replaceAll('\r\n', '\n');

/** @returns {Object} A fresh parse of the v2 example document, safe to mutate. */
const example = () => JSON.parse(EXAMPLE);

/** Compiles with the pinned catalog. @param {*} source @param {Object} [options] */
const compile = (source, options = {}) =>
  compileShaderDocument(source, { catalog: CATALOG, ...options });

/** Validates with the pinned catalog. @param {Object} document */
const validate = (document) => validateShaderDocument(document, { catalog: CATALOG });

/**
 * Runs a call expected to raise a ShaderDocumentError and returns it.
 * @param {() => *} call - The call under test.
 * @returns {ShaderDocumentError} The error it raised.
 */
const raised = (call) => {
  try {
    call();
  } catch (error) {
    assert.ok(error instanceof ShaderDocumentError, `raised ${error}`);
    return error;
  }
  return assert.fail('the call was expected to raise a ShaderDocumentError');
};

/**
 * The parse-phase error code and path a source raises.
 * @param {*} source - Document source.
 * @param {Object} [limits] - Limits override.
 * @returns {[string, string]} The error's code and path.
 */
const parseFailure = (source, limits) => {
  const error = raised(() => parseShaderDocument(source, limits));
  assert.equal(error.phase, 'parse');
  return [error.code, error.path];
};

/** Verifies the reader accepts well-formed JSON as JSON.parse reads it. */
test('the reader parses a committed document as JSON.parse does', () => {
  // The reader's objects carry no prototype, so compare the values through a clone.
  const values = (source) => structuredClone(parseShaderDocument(source));
  assert.deepEqual(values(EXAMPLE), JSON.parse(EXAMPLE));
  assert.deepEqual(values('{"a":[1,-2.5,1e2,true,false,null,""]}'), {
    a: [1, -2.5, 100, true, false, null, ''],
  });
  assert.deepEqual(values(' \n\t{ "a" : { } , "b" : [ ] } '), { a: {}, b: [] });
  assert.deepEqual(values('{"a":"\\u00e9\\n\\\\"}'), { a: 'é\n\\' });
  assert.deepEqual(Object.keys(parseShaderDocument('{"é":1}')), ['é']);
});

/**
 * Verifies the rejections that separate the reader from JSON.parse. A duplicate
 * key is the load-bearing one: JSON.parse keeps the last, which would give two
 * different sources the same descriptor digest.
 */
test('the reader rejects what JSON.parse would silently accept', () => {
  assert.deepEqual(parseFailure('{"a":1,"a":2}'), ['DUPLICATE_KEY', '$.a']);
  assert.deepEqual(JSON.parse('{"a":1,"a":2}'), { a: 2 });
});

/**
 * Verifies a "__proto__" key lands in the object. Run through the prototype
 * setter it leaves no unknown field to report and no bytes in the canonical
 * form, so two different sources take one identity.
 */
test('a __proto__ key is an ordinary field, not a prototype write', () => {
  const bare = parseShaderDocument('{"__proto__":{"schema_version":2}}');
  assert.deepEqual(Object.keys(bare), ['__proto__']);
  assert.equal('schema_version' in bare, false);

  const poisoned = compile(EXAMPLE.replace('"descriptor": {', '"descriptor": {"__proto__": {},'));
  assert.equal(poisoned.status, 'INVALID');
  assert.deepEqual(poisoned.diagnostics.map((entry) => [entry.code, entry.path]),
    [['UNKNOWN_FIELD', '$.descriptor.__proto__']]);

  // Metadata takes any key, so this document is accepted, and must stay distinct.
  const carried = compile(EXAMPLE.replace('"study_metadata": {', '"study_metadata": {"__proto__": 1,'));
  assert.equal(carried.status, 'VALID');
  assert.ok(exportShaderDocumentJson(carried.document).includes('"__proto__": 1'));
  assert.notEqual(exportShaderDocumentJson(carried.document),
    exportShaderDocumentJson(compile(EXAMPLE).document));
});

/** Verifies malformed JSON is refused with a phase, code and path. */
test('the reader refuses malformed JSON', () => {
  assert.deepEqual(parseFailure('﻿{}'), ['BYTE_ORDER_MARK', '$']);
  assert.deepEqual(parseFailure('{} {}'), ['TRAILING_INPUT', '$']);
  assert.deepEqual(parseFailure('nope'), ['INVALID_JSON', '$']);
  assert.deepEqual(parseFailure('{"a" 1}'), ['INVALID_JSON', '$']);
  assert.deepEqual(parseFailure('{a:1}'), ['INVALID_JSON', '$']);
  assert.deepEqual(parseFailure('{"a":1;'), ['INVALID_JSON', '$']);
  assert.deepEqual(parseFailure('[1;'), ['INVALID_JSON', '$']);
  assert.deepEqual(parseFailure('"abc'), ['INVALID_STRING', '$']);
  assert.deepEqual(parseFailure('{"a":"b\nc"}'), ['INVALID_STRING', '$.a']);
  assert.deepEqual(parseFailure('{"a":"\\q"}'), ['INVALID_STRING', '$.a']);
  assert.deepEqual(parseFailure('{"a":-}'), ['INVALID_NUMBER', '$.a']);
  assert.deepEqual(parseFailure('{"a":1e999}'), ['NONFINITE_NUMBER', '$.a']);
});

/** Verifies each document limit is enforced and reported by its own code. */
test('the reader enforces the document limits', () => {
  assert.deepEqual(parseFailure('{"a":{"b":{"c":1}}}', { depth: 1 }), ['DEPTH_LIMIT', '$.a.b']);
  assert.deepEqual(parseFailure('{"a":"abcd"}', { stringLength: 3 }), ['STRING_LIMIT', '$.a']);
  assert.deepEqual(parseFailure('{"a":1}', { bytes: 4 }), ['BYTE_LIMIT', '$']);
  assert.deepEqual(parseFailure(null), ['SOURCE_TYPE', '$']);
  assert.deepEqual(parseFailure(Buffer.from('{}')), ['SOURCE_TYPE', '$']);
  assert.ok(DEFAULT_LIMITS.bytes > 0 && Object.isFrozen(DEFAULT_LIMITS));
});

/** Verifies a limits override leaves the unnamed limits at their defaults. */
test('a limits override keeps the defaults it does not name', () => {
  assert.deepEqual(structuredClone(parseShaderDocument('{"a":{"b":1}}', { bytes: 32 })),
    { a: { b: 1 } });
  assert.deepEqual(
    parseFailure(`{"a":"${'x'.repeat(DEFAULT_LIMITS.stringLength + 1)}"}`, { bytes: 1 << 20 }),
    ['STRING_LIMIT', '$.a'],
  );
});

/** Verifies an error carries the diagnostic shape the workbench reports. */
test('a document error reports itself as a diagnostic', () => {
  const error = raised(() => parseShaderDocument('{"a":1,"a":2}'));
  assert.equal(error.name, 'ShaderDocumentError');
  assert.deepEqual(error.diagnostic(), {
    severity: 'error',
    phase: 'parse',
    code: 'DUPLICATE_KEY',
    path: '$.a',
    message: 'Duplicate object key "a".',
  });
});

/** Verifies stableStringify orders keys by code point and normalizes text. */
test('stableStringify orders keys by code point', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableStringify({ a: 2, b: 1 }), '{"a":2,"b":1}');
  assert.equal(stableStringify([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  assert.equal(stableStringify({ 'é': 1, a: 2 }), '{"a":2,"é":1}');
  assert.equal(stableStringify({ a: 'é' }), '{"a":"é"}');
});

/**
 * Reverses every array whose order the canonical form is supposed to erase,
 * and every object's key order with it. descriptor.chain is exempt: its order
 * is the program, so the canonical form keeps it.
 * @param {*} value - Parsed document fragment.
 * @returns {*} The same data, ordered the other way round.
 */
const reordered = (value) => {
  if (Array.isArray(value)) return value.map(reordered);
  if (value === null || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).reverse()) result[key] = reordered(value[key]);
  return result;
};

/**
 * Verifies the descriptor digest is an identity rather than a hash of the
 * source: the same document written in a different order compiles to the same
 * canonical JSON and the same digest, and a changed value does not.
 */
test('the descriptor digest survives reordering and not a value change', () => {
  const baseline = compile(EXAMPLE);
  assert.equal(baseline.status, 'VALID');
  const shuffled = reordered(example());
  shuffled.descriptor.parameters.reverse();
  shuffled.preset_bank.presets.reverse();
  shuffled.preset_bank.edges.reverse();
  const compiled = compile(shuffled);

  assert.equal(compiled.status, 'VALID');
  assert.equal(compiled.descriptor_json, baseline.descriptor_json);
  assert.equal(compiled.descriptor_digest, baseline.descriptor_digest);
  assert.equal(compiled.preset_bank_json, baseline.preset_bank_json);
  assert.equal(compiled.preset_bank_digest, baseline.preset_bank_digest);

  const changed = example();
  changed.descriptor.parameters[0].default = 2.0;
  assert.notEqual(compile(changed).descriptor_digest, baseline.descriptor_digest);
});

/**
 * A document with the same operator twice, telling apart the three moves the
 * v1 canonical form collapsed: re-serializing is identity-preserving, while
 * swapping the two stages or renaming an instance is a different descriptor.
 */
const twinWarpExample = () => {
  const document = example();
  const chain = document.descriptor.chain;
  const at = chain.findIndex((entry) => entry.label === 'sample');
  chain.splice(at, 0,
    { label: 'warp1', operator: 'warp.mirror-tile.v2' },
    { label: 'warp2', operator: 'warp.mirror-tile.v2' });
  document.descriptor.parameters.push({
    id: 'warp1.cell-x',
    classification: 'preset',
    storage: 'binary32',
    unit: 'ratio',
    domain: { minimum: 0.015625, maximum: 8 },
    interpolation: { kind: 'LOG_POSITIVE' },
    default: 2,
  });
  document.descriptor.serialization.fields.push('warp1.cell-x');
  for (const preset of document.preset_bank.presets)
    preset.values['warp1.cell-x'] = 2;
  return document;
};

test('a duplicate-operator chain digests by order and label, not by operator set', () => {
  const baseline = compile(twinWarpExample());
  assert.equal(baseline.status, 'VALID', JSON.stringify(baseline.diagnostics));

  const shuffled = reordered(twinWarpExample());
  shuffled.descriptor.parameters.reverse();
  assert.equal(compile(shuffled).descriptor_digest, baseline.descriptor_digest,
    'a reordered serialization of the same document must keep its digest');

  const swapped = twinWarpExample();
  const chain = swapped.descriptor.chain;
  const first = chain.findIndex((entry) => entry.label === 'warp1');
  [chain[first], chain[first + 1]] = [chain[first + 1], chain[first]];
  const swappedCompiled = compile(swapped);
  assert.equal(swappedCompiled.status, 'VALID');
  assert.notEqual(swappedCompiled.descriptor_digest, baseline.descriptor_digest,
    'swapping two stages of the same operator must change the digest');

  const relabeled = twinWarpExample();
  for (const entry of relabeled.descriptor.chain)
    if (entry.label === 'warp2') entry.label = 'mirror';
  const relabeledCompiled = compile(relabeled);
  assert.equal(relabeledCompiled.status, 'VALID');
  assert.notEqual(relabeledCompiled.descriptor_digest, baseline.descriptor_digest,
    'labels are the identity parameters bind to, so a rename is a descriptor change');
});

/** Verifies the canonical descriptor keeps the chain order and its labels. */
test('the canonical descriptor keeps chain order and labels', () => {
  const document = example();
  const descriptor = canonicalDescriptor(document);

  assert.deepEqual(structuredClone(descriptor.chain), document.descriptor.chain);
  assert.ok(descriptor.chain.every((entry) => 'label' in entry && 'operator' in entry));
  assert.deepEqual(
    descriptor.parameters.map((parameter) => parameter.id),
    [...descriptor.parameters.map((parameter) => parameter.id)].sort(),
  );
});

/**
 * Verifies serialization.fields is held to a duplicate-free permutation of the
 * parameter ids and that its order is outside the descriptor identity.
 */
test('serialization fields name every parameter once and do not order the digest', () => {
  const baseline = compile(example());
  assert.equal(baseline.status, 'VALID');

  const reversed = example();
  reversed.descriptor.serialization.fields.reverse();
  assert.equal(compile(reversed).descriptor_digest, baseline.descriptor_digest,
    'field order is a spelling, not an identity');

  const codes = (mutate) => {
    const document = example();
    mutate(document.descriptor.serialization.fields);
    return validate(document).map((diagnostic) => diagnostic.code);
  };
  assert.deepEqual(codes((fields) => fields.splice(0)), ['INVALID_SERIALIZATION_FIELDS']);
  assert.deepEqual(codes((fields) => fields.pop()), ['INVALID_SERIALIZATION_FIELDS']);
  assert.deepEqual(codes((fields) => { fields[1] = fields[0]; }),
    ['INVALID_SERIALIZATION_FIELDS'], 'a duplicate hides a missing parameter');
  assert.deepEqual(codes((fields) => fields.push('sample.ghost-field')),
    ['INVALID_SERIALIZATION_FIELDS']);
});

/** Verifies every committed pattern compiles and is keyed by its own digest. */
test('every committed shader pattern compiles to a distinct digest', () => {
  const names = readdirSync(PATTERNS).filter((f) => f.endsWith('.shader.json'));
  assert.ok(names.length > 1);
  const digests = new Map();
  for (const name of names) {
    const compiled = compile(readFileSync(new URL(name, PATTERNS), 'utf8'));
    assert.deepEqual(compiled.diagnostics, [], name);
    assert.equal(compiled.status, 'VALID', name);
    assert.equal(compiled.descriptor_digest, sha256Hex(compiled.descriptor_json), name);
    assert.equal(compiled.preset_bank_digest, sha256Hex(compiled.preset_bank_json), name);
    assert.equal(digests.get(compiled.descriptor_digest) ?? name, name,
      `${name} shares a descriptor digest with ${digests.get(compiled.descriptor_digest)}`);
    digests.set(compiled.descriptor_digest, name);
  }
});

/** Verifies a rejected document compiles to diagnostics and no digest. */
test('an invalid document compiles to a diagnostic rather than a digest', () => {
  const outOfRange = example();
  outOfRange.preset_bank.presets[0].values['project.central-meridian'] = 100;
  const compiled = compile(outOfRange);

  assert.equal(compiled.status, 'INVALID');
  assert.equal(compiled.descriptor_digest, undefined);
  assert.equal(compiled.diagnostics.length, 1);
  assert.equal(compiled.diagnostics[0].code, 'VALUE_OUT_OF_RANGE');
  assert.equal(compiled.diagnostics[0].phase, 'semantic');
});

/** Verifies compiling without the catalog is refused, not silently weakened. */
test('compiling without the operator catalog is refused', () => {
  const compiled = compileShaderDocument(EXAMPLE);
  assert.equal(compiled.status, 'INVALID');
  assert.equal(compiled.diagnostics[0].code, 'CATALOG_REQUIRED');
});

/**
 * The semantic codes of the chain validator, one construction each. The chain
 * is validated against the catalog: carrier pairs order the four families, and
 * every finding is collected rather than thrown.
 * @param {Object[]} chain @param {Object[]} [parameters] @param {Object} [values]
 */
const chainDocument = (chain, parameters = [], values = {}) => ({
  schema_version: 2,
  catalog_version: 2,
  document_id: 'chain-study',
  descriptor: {
    chain,
    parameters,
    path_policies: [{ id: 'parallel', kind: 'PARALLEL' }],
    serialization: {
      schema_version: 1,
      fields: parameters.map((parameter) => parameter.id),
    },
  },
  preset_bank: {
    schema_version: 1,
    presets: [{ preset_id: 'only', values }],
    edges: [],
    absent_edge_fallback: {
      manual: 'SNAP', automatic: 'SNAP', synchronized: 'SNAP',
      restore: 'SNAP', authoring: 'SNAP',
    },
    choreography: { generated_order: ['only'] },
  },
});

const MINIMAL_CHAIN = [
  { label: 'camera', operator: 'sphere.rotate.v2' },
  { label: 'project', operator: 'project.stereographic.v2' },
  { label: 'sample', operator: 'sample.grid.v2' },
  { label: 'colorize', operator: 'colorize.generated-palette.v2' },
];

/** @param {Object} document @returns {string[]} The collected codes. */
const codesOf = (document) => validate(document).map((diagnostic) => diagnostic.code);

test('the chain validator reports each family and carrier violation', () => {
  assert.deepEqual(codesOf(chainDocument(MINIMAL_CHAIN)), []);
  assert.deepEqual(codesOf(chainDocument([])), ['EMPTY_CHAIN']);
  assert.ok(codesOf(chainDocument(MINIMAL_CHAIN.slice(2))).includes('ENTRY_FAMILY'),
    'a chain must enter on the sphere carrier');
  assert.ok(codesOf(chainDocument(MINIMAL_CHAIN.slice(0, 3))).includes('EXIT_FAMILY'),
    'a chain must exit on the color carrier');
  const backward = [MINIMAL_CHAIN[1],
    { label: 'late-camera', operator: 'sphere.rotate.v2' },
    ...MINIMAL_CHAIN.slice(2)];
  assert.ok(codesOf(chainDocument(backward)).includes('FAMILY_ORDER'),
    'a sphere operator after the projection steps back across the crossing');
  const gap = [MINIMAL_CHAIN[0], ...MINIMAL_CHAIN.slice(2)];
  assert.ok(codesOf(chainDocument(gap)).includes('CARRIER_MISMATCH'),
    'a sample fed a sphere carrier is a carrier mismatch, not an order violation');
  assert.ok(codesOf(chainDocument([
    { label: 'camera', operator: 'sphere.vortex.v3' }, ...MINIMAL_CHAIN.slice(1),
  ])).includes('UNKNOWN_OPERATOR'));
  assert.ok(codesOf(chainDocument([
    { label: 'camera', operator: 'sphere.rotate.v2' },
    { label: 'camera', operator: 'sphere.rotate.v2' }, ...MINIMAL_CHAIN.slice(1),
  ])).includes('DUPLICATE_LABEL'));
});

test('a parameter must bind a chain label and a catalog field through one dot', () => {
  const parameter = {
    classification: 'preset', storage: 'binary32', unit: 'ratio',
    domain: { minimum: 0, maximum: 1 }, interpolation: { kind: 'LINEAR' }, default: 0,
  };
  const withId = (parameterId) => codesOf(chainDocument(MINIMAL_CHAIN,
    [{ ...parameter, id: parameterId }], { [parameterId]: 0 }));

  assert.deepEqual(withId('sample.pattern-mix'), []);
  assert.deepEqual(withId('drift'), ['UNBOUND_PARAMETER']);
  assert.deepEqual(withId('ghost.drift'), ['UNBOUND_PARAMETER']);
  assert.deepEqual(withId('sample.ghost-field'), ['UNBOUND_PARAMETER']);
  assert.deepEqual(withId('sample.drift.rate'), ['UNBOUND_PARAMETER']);
  assert.deepEqual(withId('sample.weight-mode'), ['ENUM_DOMAIN_MISMATCH'],
    'a binary32 parameter cannot bind a topology enum field');
});

test('an enum8 parameter must carry its catalog values verbatim', () => {
  const withValues = (values) => codesOf(chainDocument(MINIMAL_CHAIN, [{
    id: 'sample.weight-mode', classification: 'preset', storage: 'enum8',
    unit: 'mode', domain: { values }, interpolation: { kind: 'MIXED_ENUM' },
    default: 'projection',
  }], { 'sample.weight-mode': 'projection' }));

  assert.deepEqual(withValues(['none', 'projection']), []);
  assert.deepEqual(withValues(['projection', 'none']), ['ENUM_DOMAIN_MISMATCH']);
  assert.deepEqual(withValues(['projection', 'shadow']), ['ENUM_DOMAIN_MISMATCH']);
});

test('the validator holds a chain to the engine-exported budgets', () => {
  const cameras = Array.from({ length: 33 }, (unused, index) =>
    ({ label: `camera-${index}`, operator: 'sphere.rotate.v2' }));
  assert.ok(codesOf(chainDocument([...cameras, ...MINIMAL_CHAIN.slice(1)]))
    .includes('BUDGET_EXCEEDED'), 'chain length is budgeted');
  const longLabel = `camera-${'x'.repeat(48)}`;
  assert.ok(codesOf(chainDocument([
    { label: longLabel, operator: 'sphere.rotate.v2' }, ...MINIMAL_CHAIN.slice(1),
  ])).includes('BUDGET_EXCEEDED'), 'instance-id length is budgeted');
});

/**
 * Verifies the semantic phase collects and continues: a document broken three
 * ways surfaces all three findings in one validation, which is what makes the
 * import dialog's full diagnostic list possible.
 */
test('semantic validation surfaces the full diagnostic list', () => {
  const document = chainDocument([
    { label: 'camera', operator: 'sphere.vortex.v3' },
    { label: 'camera', operator: 'sphere.rotate.v2' },
    ...MINIMAL_CHAIN.slice(1),
  ], [{
    id: 'ghost.drift', classification: 'preset', storage: 'binary32',
    unit: 'ratio', domain: { minimum: 0, maximum: 1 },
    interpolation: { kind: 'LINEAR' }, default: 0,
  }], {});
  const codes = codesOf(document);

  assert.ok(codes.includes('UNKNOWN_OPERATOR'), codes.join());
  assert.ok(codes.includes('DUPLICATE_LABEL'), codes.join());
  assert.ok(codes.includes('UNBOUND_PARAMETER'), codes.join());
  assert.ok(codes.includes('MISSING_PRESET_VALUE'), codes.join());
  assert.ok(codes.length >= 4);

  const compiled = compile(document);
  assert.equal(compiled.status, 'INVALID');
  assert.equal(compiled.diagnostics.length, codes.length);
});

test('the validator rejects unsupported and incomplete documents', () => {
  const code = (mutate) => {
    const document = example();
    mutate(document);
    const semantic = (() => {
      try {
        return validate(document);
      } catch (error) {
        assert.ok(error instanceof ShaderDocumentError);
        return [error.diagnostic()];
      }
    })();
    assert.ok(semantic.length > 0, 'the mutation was expected to invalidate');
    return semantic[0].code;
  };

  assert.equal(code((d) => { d.schema_version = 3; }), 'UNSUPPORTED_DOCUMENT_SCHEMA');
  assert.equal(code((d) => { d.catalog_version = 1; }), 'UNSUPPORTED_CATALOG_SCHEMA');
  assert.equal(code((d) => { d.document_id = 'Example Study'; }), 'INVALID_ID');
  assert.equal(code((d) => { d.extensions = { vendor: {} }; }), 'UNKNOWN_EXTENSION');
  assert.equal(code((d) => { delete d.preset_bank; }), 'MISSING_FIELD');
  assert.equal(code((d) => { d.unexpected = 1; }), 'UNKNOWN_FIELD');
  assert.equal(code((d) => { d.descriptor.graph = { nodes: [], edges: [] }; }),
    'UNKNOWN_FIELD');
  assert.equal(code((d) => { d.descriptor.chain[0].label = 'two.segments'; }),
    'INVALID_ID');
  assert.equal(code((d) => {
    d.descriptor.parameters[1].id = d.descriptor.parameters[0].id;
  }), 'DUPLICATE_PARAMETER');
  assert.equal(code((d) => { d.descriptor.parameters[0].interpolation.kind = 'MIXED_ENUM'; }),
    'STORAGE_INTERPOLATION_MISMATCH');
  assert.equal(code((d) => { d.descriptor.path_policies = []; }), 'MISSING_PATH_POLICY');
  assert.equal(code((d) => {
    delete d.preset_bank.presets[0].values['sample.pattern-freq'];
  }), 'MISSING_PRESET_VALUE');
  assert.equal(code((d) => { d.preset_bank.presets[1].preset_id = 'calm'; }),
    'DUPLICATE_PRESET');
  assert.equal(code((d) => { d.preset_bank.edges[0].to = 'calm'; }),
    'INVALID_EDGE_ENDPOINT');
  assert.equal(code((d) => { d.preset_bank.edges[0].path_policy = 'absent'; }),
    'UNKNOWN_EDGE_PATH');
  assert.equal(code((d) => { d.preset_bank.choreography.generated_order = ['calm']; }),
    'INVALID_GENERATED_ORDER');
});

// --- v1 expansion -----------------------------------------------------------

const fixtureNames = readdirSync(FIXTURES).filter((f) => f.endsWith('.shader.json'));

/** @param {string} name @returns {Object} A parsed v1 fixture. */
const fixture = (name) =>
  parseShaderDocument(readFileSync(new URL(name, FIXTURES), 'utf8'));

/**
 * Verifies expansion assigns the deterministic slot labels and consumes the
 * v1 policy objects into operator selection plus topology enum8 parameters.
 * equator_grid pins the interesting cases: a kaleidoscope lens variant, a
 * mirror in the second warp slot (warp1 vanishes with its identity policy),
 * and coverage folded into the sample stage.
 */
test('a v1 document expands to the deterministic chain of its slots', () => {
  const { document, parameter_ids } =
    expandV1Document(fixture('equator_grid.shader.json'), CATALOG);

  assert.equal(document.schema_version, 2);
  assert.equal(document.catalog_version, 2);
  assert.deepEqual(document.descriptor.chain, [
    { label: 'camera', operator: 'sphere.rotate.v2' },
    { label: 'lens', operator: 'sphere.lens.kaleidoscope.v2' },
    { label: 'project', operator: 'project.equirectangular.v2' },
    { label: 'warp2', operator: 'warp.mirror-tile.v2' },
    { label: 'sample', operator: 'sample.grid.v2' },
    { label: 'colorize', operator: 'colorize.generated-palette.v2' },
  ]);

  const byId = new Map(document.descriptor.parameters.map((p) => [p.id, p]));
  assert.equal(byId.get('lens.symmetry')?.default, 'dodecahedral');
  assert.equal(byId.get('sample.weight-mode')?.default, 'projection');
  assert.equal(byId.get('sample.coverage-mode')?.default, 'weight-squared');
  assert.equal(byId.get('colorize.palette-mode')?.default, 'analogous');
  assert.equal(byId.get('colorize.hue-shift-mode')?.default, 'noise');
  assert.equal(byId.get('colorize.brightness-envelope')?.default, 'none');

  assert.equal(parameter_ids['inner-cell-x'], 'warp2.cell-x');
  assert.equal(parameter_ids['camera-wander'], 'camera.wander',
    'v1 camera-wander is the camera walk, not a projection field');
  assert.equal(parameter_ids['source-angle-speed'], 'sample.angle-speed');
  assert.equal(parameter_ids['palette-mapping'], 'colorize.palette-mapping');
  for (const v1Id of fixture('equator_grid.shader.json').descriptor.parameters
    .map((parameter) => parameter.id))
    assert.ok(v1Id in parameter_ids, `rewrite map misses "${v1Id}"`);

  for (const preset of document.preset_bank.presets) {
    assert.equal(preset.values['lens.symmetry'], 'dodecahedral');
    assert.equal(preset.values['sample.coverage-mode'], 'weight-squared');
  }
  assert.ok(document.descriptor.serialization.fields.includes('lens.symmetry'));
  assert.ok(!('binding' in document.descriptor.parameters[0]));
  assert.equal(document.descriptor.clocks, undefined,
    'engine machinery records do not survive expansion');
});

/**
 * The two v1 identities that changed homes under the engine catalog: the
 * mobius lens keeps its prefix in the engine field ids, and the one v1
 * 'edge-width' splits by the material coverage policy — the sample stage's
 * fade width under edge-fade, the cutout transition width (cutout-softness)
 * under value-cutout.
 */
test('v1 mobius and edge-width parameters route onto the engine field ids', () => {
  const mobius = expandV1Document(fixture('mobius_grid.shader.json'), CATALOG);
  assert.equal(mobius.parameter_ids['mobius-a-re'], 'lens.mobius-a-re');
  assert.equal(mobius.parameter_ids['mobius-d-im'], 'lens.mobius-d-im');

  const fade = expandV1Document(fixture('alien_ocean.shader.json'), CATALOG);
  assert.equal(fade.parameter_ids['edge-width'], 'sample.edge-width');

  // No committed fixture uses value-cutout coverage, so the cutout routing is
  // exercised on a mutated copy.
  const cutout = fixture('alien_ocean.shader.json');
  cutout.descriptor.graph.nodes.find((n) => n.role === 'material')
    .policy.coverage = 'value-cutout';
  const expanded = expandV1Document(cutout, CATALOG);
  assert.equal(expanded.parameter_ids['edge-width'], 'cutout.cutout-softness');
  assert.ok(expanded.document.descriptor.chain.some(
    (entry) => entry.label === 'cutout'
      && entry.operator === 'field.coverage.value-cutout.v2'));
});

test('expansion is deterministic and the compiler is one code path', () => {
  const first = expandV1Document(fixture('prism_spiral.shader.json'), CATALOG);
  const second = expandV1Document(fixture('prism_spiral.shader.json'), CATALOG);
  assert.deepEqual(first.document, second.document);
  assert.deepEqual(first.parameter_ids, second.parameter_ids);

  const throughCompile = compile(fixture('prism_spiral.shader.json'));
  assert.equal(throughCompile.status, 'VALID');
  assert.equal(throughCompile.descriptor_digest,
    compile(first.document).descriptor_digest,
    'compiling a v1 source must be expansion followed by v2 compilation');
});

/**
 * The re-export gate: the committed v2 pattern documents are by definition
 * the expansion's output, byte for byte, so the two cannot drift apart.
 */
test('every committed v2 pattern is its v1 fixture expanded, byte-identical', () => {
  assert.equal(fixtureNames.length, 16);
  for (const name of fixtureNames) {
    const expanded = expandV1Document(fixture(name), CATALOG).document;
    assert.equal(
      exportShaderDocumentJson(expanded),
      readPinned(new URL(name, PATTERNS)),
      `${name} drifted from its expansion`,
    );
  }
});

/**
 * The frozen migration table: every v1 descriptor digest maps to the digest
 * of its expanded v2 document, with no extra or missing entries, so digest
 * consumers can follow a v1 identity onto its v2 identity.
 */
test('the digest migration table covers exactly the v1 fixtures', () => {
  const expected = new Map();
  for (const name of fixtureNames) {
    const v1 = fixture(name);
    const compiled = compile(v1);
    assert.equal(compiled.status, 'VALID', name);
    expected.set(v1DescriptorDigest(v1), compiled.descriptor_digest);
  }
  assert.deepEqual(MIGRATION, Object.fromEntries(expected));
  assert.equal(Object.keys(MIGRATION).length, fixtureNames.length);
});

/**
 * v1 documents distinct only by an identity-policy spelling expand to the
 * same chain: expansion canonicalizes them, and the registry migration merges
 * their entries deliberately rather than reporting ambiguity.
 */
test('identity-spelling-distinct v1 documents collide by design', () => {
  const spelled = fixture('example.shader.json');
  const baseline = compile(fixture('example.shader.json')).descriptor_digest;
  const surface = spelled.descriptor.graph.nodes.find((n) => n.role === 'surface_project');
  surface.policy = { ...surface.policy, pre_lens_surface: 'identity', lens: 'identity' };
  const warp = spelled.descriptor.graph.nodes.find((n) => n.role === 'planar_warp');
  warp.policy = { sequence: ['identity', 'identity'] };
  const color = spelled.descriptor.graph.nodes.find((n) => n.role === 'color');
  color.policy = { ...color.policy, color: 'generated-palette' };

  assert.notEqual(v1DescriptorDigest(spelled),
    v1DescriptorDigest(fixture('example.shader.json')),
    'the two spellings are distinct v1 descriptors');
  assert.equal(compile(spelled).descriptor_digest, baseline);
});

/** Verifies a v1 document outside the expansion vocabulary is refused whole. */
test('a v1 policy or parameter without a chain home refuses to expand', () => {
  const alienPolicy = fixture('example.shader.json');
  alienPolicy.descriptor.graph.nodes.find((n) => n.role === 'source')
    .policy.source = 'perlin-clouds';
  const policyCompiled = compile(alienPolicy);
  assert.equal(policyCompiled.status, 'INVALID');
  assert.equal(policyCompiled.diagnostics[0].code, 'V1_POLICY_UNSUPPORTED');

  const alienParameter = fixture('example.shader.json');
  alienParameter.descriptor.parameters[0].id = 'mystery-knob';
  const parameterCompiled = compile(alienParameter);
  assert.equal(parameterCompiled.status, 'INVALID');
  assert.equal(parameterCompiled.diagnostics[0].code, 'V1_PARAMETER_UNMAPPED');
});

/** Verifies an export is classified against the registry by descriptor digest. */
test('an export is classified by its descriptor digest', () => {
  const compiled = compile(EXAMPLE);
  const known = {
    effect_id: 'example',
    descriptor: compiled.descriptor,
    descriptor_digest: compiled.descriptor_digest,
    capability_profiles: ['simulator'],
  };

  assert.deepEqual(classifyExport(compiled, { effects: [] }, 'simulator'), {
    kind: 'CREATE_EFFECT_CANDIDATE',
    descriptor_digest: compiled.descriptor_digest,
  });
  assert.deepEqual(classifyExport(compiled, { effects: [known] }, 'simulator'), {
    kind: 'ADD_PRESET_CANDIDATE',
    effect_id: 'example',
  });

  const unavailable = classifyExport(compiled, { effects: [known] }, 'device');
  assert.equal(unavailable.kind, 'REJECTED');
  assert.equal(unavailable.diagnostics[0].code, 'KNOWN_UNAVAILABLE');

  const ambiguous = classifyExport(compiled, { effects: [known, { ...known, effect_id: 'twin' }] }, 'simulator');
  assert.equal(ambiguous.kind, 'REJECTED');
  assert.equal(ambiguous.diagnostics[0].code, 'AMBIGUOUS_EFFECT_MATCH');

  const invalid = { status: 'INVALID', diagnostics: [{ code: 'BYTE_ORDER_MARK' }] };
  assert.deepEqual(classifyExport(invalid, { effects: [known] }, 'simulator'), {
    kind: 'REJECTED',
    diagnostics: invalid.diagnostics,
  });
});

/** Verifies the easing curves are clamped to the unit interval and pinned. */
test('easing is clamped to the unit interval', () => {
  assert.equal(applyEasing('LINEAR', 0.25), 0.25);
  assert.equal(applyEasing('LINEAR', -1), 0);
  assert.equal(applyEasing('LINEAR', 2), 1);
  assert.equal(applyEasing('EASE_IN_OUT_SIN', 0), 0);
  assert.equal(applyEasing('EASE_IN_OUT_SIN', 1), 1);
  assert.equal(applyEasing('EASE_IN_OUT_SIN', 0.5), 0.5);
  assert.equal(applyEasing('EASE_IN_OUT_SIN', 0.25), Math.fround((1 - Math.SQRT1_2) * 0.5));
  assert.equal(raised(() => applyEasing('EASE_OUT_BACK', 0.5)).code, 'UNKNOWN_EASING');
});

/** Verifies an enum field crossfades as a pair rather than as a number. */
test('an enum field interpolates as a from/to mix', () => {
  const lens = {
    id: 'lens.symmetry',
    storage: 'enum8',
    domain: { values: ['azimuthal', 'dodecahedral'] },
    interpolation: { kind: 'MIXED_ENUM' },
  };

  assert.deepEqual(interpolateValue(lens, 'azimuthal', 'dodecahedral', 0.25),
    { from: 'azimuthal', to: 'dodecahedral', mix: 0.25 });
  assert.equal(interpolateValue(lens, 'dodecahedral', 'dodecahedral', 0.25), 'dodecahedral');
  assert.equal(interpolateValue(lens, 'azimuthal', 'dodecahedral', 0), 'azimuthal');
  assert.equal(interpolateValue(lens, 'azimuthal', 'dodecahedral', 1), 'dodecahedral');
  assert.equal(raised(() => interpolateValue(lens, 'azimuthal', 'absent', 0.5)).code,
    'INVALID_ENUM_VALUE');
});

/**
 * Verifies a transition lands exactly on its endpoints, eases in between, and
 * refuses an evaluation the edge does not define. The periodic meridian is
 * checked for staying inside its period rather than for a value: it wraps
 * through the seam between the two presets.
 */
test('a transition evaluates between its two presets', () => {
  const { descriptor, preset_bank: bank } = compile(EXAMPLE);
  const at = (evaluation) => evaluateTransition(descriptor, bank, 'calm', 'fast', evaluation);
  const period = Math.fround(6.2831854820251465);

  assert.equal(at(0).values['sample.pattern-freq'], 1);
  assert.equal(at(0).values['project.central-meridian'], 6);
  assert.equal(at(120).values['sample.pattern-freq'], 4);
  assert.equal(at(120).values['project.central-meridian'], Math.fround(0.2));
  assert.equal(at(120).duration, 120);

  const middle = at(60);
  assert.equal(middle.raw_progress, 0.5);
  assert.equal(middle.eased_progress, 0.5);
  assert.equal(middle.values['sample.pattern-freq'], 2,
    'the log-positive midpoint of 1 and 4 is their geometric mean');
  const meridian = middle.values['project.central-meridian'];
  assert.ok(meridian >= 0 && meridian < period);
  assert.ok(meridian > 6 || meridian < 0.2, 'the shortest path crosses the seam');
  assert.equal(middle.values['sample.weight-mode'], 'projection',
    'an unchanged topology value rides the transition as itself');

  assert.equal(raised(() => at(121)).code, 'INVALID_EVALUATION');
  assert.equal(raised(() => at(0.5)).code, 'INVALID_EVALUATION');
  assert.equal(
    raised(() => evaluateTransition(descriptor, bank, 'calm', 'calm', 0)).code,
    'ABSENT_EDGE',
  );
});
