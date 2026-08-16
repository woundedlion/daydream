//
// shader/shader_workbench.mjs compiles an authoring document to the canonical
// descriptor and preset bank the digests are taken over, so its JSON reader,
// its validator and its canonical ordering are what decide a document's
// identity. The reader is a hand-written parser rather than JSON.parse because
// it has to reject what JSON.parse accepts — a duplicate key, a byte-order
// mark, an over-deep or over-long document — so those rejections are checked
// one by one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import {
  DEFAULT_LIMITS,
  LINEAR_STAGE_ROLES,
  OPERATOR_CATALOG,
  ShaderDocumentError,
  applyEasing,
  canonicalDescriptor,
  classifyExport,
  compileShaderDocument,
  evaluateTransition,
  interpolateValue,
  parseShaderDocument,
  stableStringify,
  validateShaderDocument,
} from '../shader/shader_workbench.mjs';
import { sha256Hex } from '../shader/sha256.mjs';

const PATTERNS = new URL('../shader/patterns/', import.meta.url);
const EXAMPLE = readFileSync(new URL('example.shader.json', PATTERNS), 'utf8');

/** @returns {Object} A fresh parse of the example document, safe to mutate. */
const example = () => JSON.parse(EXAMPLE);

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
  assert.deepEqual(parseShaderDocument(EXAMPLE), JSON.parse(EXAMPLE));
  assert.deepEqual(parseShaderDocument('{"a":[1,-2.5,1e2,true,false,null,""]}'), {
    a: [1, -2.5, 100, true, false, null, ''],
  });
  assert.deepEqual(parseShaderDocument(' \n\t{ "a" : { } , "b" : [ ] } '), { a: {}, b: [] });
  assert.deepEqual(parseShaderDocument('{"a":"\\u00e9\\n\\\\"}'), { a: '\u00e9\n\\' });
  assert.deepEqual(Object.keys(parseShaderDocument('{"e\u0301":1}')), ['\u00e9']);
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

/** Verifies malformed JSON is refused with a phase, code and path. */
test('the reader refuses malformed JSON', () => {
  assert.deepEqual(parseFailure('\uFEFF{}'), ['BYTE_ORDER_MARK', '$']);
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
  assert.deepEqual(parseShaderDocument('{"a":{"b":1}}', { bytes: 32 }), { a: { b: 1 } });
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
  assert.equal(stableStringify({ '\u00e9': 1, a: 2 }), '{"a":2,"\u00e9":1}');
  assert.equal(stableStringify({ a: 'e\u0301' }), '{"a":"\u00e9"}');
});

/**
 * Reverses every array whose order the canonical form is supposed to erase,
 * and every object's key order with it.
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
  const baseline = compileShaderDocument(EXAMPLE);
  const shuffled = reordered(example());
  shuffled.descriptor.graph.nodes.reverse();
  shuffled.descriptor.graph.edges.reverse();
  shuffled.descriptor.parameters.reverse();
  shuffled.preset_bank.presets.reverse();
  shuffled.preset_bank.edges.reverse();
  const compiled = compileShaderDocument(shuffled);

  assert.equal(compiled.status, 'VALID');
  assert.equal(compiled.descriptor_json, baseline.descriptor_json);
  assert.equal(compiled.descriptor_digest, baseline.descriptor_digest);
  assert.equal(compiled.preset_bank_json, baseline.preset_bank_json);
  assert.equal(compiled.preset_bank_digest, baseline.preset_bank_digest);

  const changed = example();
  changed.descriptor.parameters[0].default = 2.0;
  assert.notEqual(
    compileShaderDocument(changed).descriptor_digest,
    baseline.descriptor_digest,
  );
});

/** Verifies the canonical descriptor carries the graph in stage order. */
test('the canonical descriptor orders the graph by stage role', () => {
  const shuffled = example();
  shuffled.descriptor.graph.nodes.reverse();
  const descriptor = canonicalDescriptor(shuffled);

  assert.deepEqual(descriptor.graph.nodes.map((node) => node.role), LINEAR_STAGE_ROLES);
  assert.deepEqual(
    descriptor.graph.edges,
    LINEAR_STAGE_ROLES.slice(0, -1).map((role, index) => ({
      from: role, to: LINEAR_STAGE_ROLES[index + 1],
    })),
  );
  assert.deepEqual(descriptor.parameters.map((p) => p.id), ['phase', 'scale']);
  assert.ok(descriptor.graph.nodes.every((node) => !('label' in node)));
});

/** Verifies every committed pattern compiles and is keyed by its own digest. */
test('every committed shader pattern compiles to a distinct digest', () => {
  const names = readdirSync(PATTERNS).filter((f) => f.endsWith('.shader.json'));
  assert.ok(names.length > 1);
  const digests = new Map();
  for (const name of names) {
    const compiled = compileShaderDocument(
      readFileSync(new URL(name, PATTERNS), 'utf8'),
    );
    assert.deepEqual(compiled.diagnostics, [], name);
    assert.equal(compiled.status, 'VALID', name);
    assert.equal(compiled.descriptor_digest, sha256Hex(compiled.descriptor_json), name);
    assert.equal(compiled.preset_bank_digest, sha256Hex(compiled.preset_bank_json), name);
    assert.equal(digests.get(compiled.descriptor_digest) ?? name, name,
      `${name} shares a descriptor digest with ${digests.get(compiled.descriptor_digest)}`);
    digests.set(compiled.descriptor_digest, name);
  }
});

/** Verifies a rejected document compiles to a single diagnostic and no digest. */
test('an invalid document compiles to a diagnostic rather than a digest', () => {
  const outOfRange = example();
  outOfRange.descriptor.parameters[0].default = 100;
  const compiled = compileShaderDocument(outOfRange);

  assert.equal(compiled.status, 'INVALID');
  assert.equal(compiled.descriptor_digest, undefined);
  assert.equal(compiled.diagnostics.length, 1);
  assert.equal(compiled.diagnostics[0].code, 'VALUE_OUT_OF_RANGE');
  assert.equal(compiled.diagnostics[0].phase, 'semantic');
  assert.equal(compiled.diagnostics[0].path, '$.descriptor.parameters[0].default');
});

/** Verifies the validator rejects each shape a document must not take. */
test('the validator rejects unsupported and incomplete documents', () => {
  const code = (mutate) => {
    const document = example();
    mutate(document);
    return raised(() => validateShaderDocument(document)).code;
  };

  assert.equal(code((d) => { d.schema_version = 2; }), 'UNSUPPORTED_DOCUMENT_SCHEMA');
  assert.equal(code((d) => { d.catalog_version = 2; }), 'UNSUPPORTED_CATALOG_SCHEMA');
  assert.equal(code((d) => { d.document_id = 'Example Study'; }), 'INVALID_ID');
  assert.equal(code((d) => { d.extensions = { vendor: {} }; }), 'UNKNOWN_EXTENSION');
  assert.equal(code((d) => { delete d.preset_bank; }), 'MISSING_FIELD');
  assert.equal(code((d) => { d.unexpected = 1; }), 'UNKNOWN_FIELD');
  assert.equal(code((d) => { d.descriptor.graph.nodes.pop(); }), 'UNSUPPORTED_GRAPH');
  assert.equal(code((d) => { d.descriptor.graph.nodes[0].role = 'source'; }),
    'DUPLICATE_STAGE_ROLE');
  assert.equal(code((d) => { d.descriptor.graph.edges.pop(); }), 'INVALID_LINEAR_GRAPH');
  assert.equal(code((d) => { d.descriptor.parameters[1].id = 'scale'; }),
    'DUPLICATE_PARAMETER');
  assert.equal(code((d) => { d.descriptor.parameters[0].interpolation.kind = 'MIXED_ENUM'; }),
    'STORAGE_INTERPOLATION_MISMATCH');
  assert.equal(code((d) => { delete d.descriptor.parameters[1].interpolation.period; }),
    'INVALID_PERIOD');
  assert.equal(code((d) => { d.descriptor.graph.nodes[0].resources = ['absent']; }),
    'UNKNOWN_RESOURCE_BINDING');
  assert.equal(code((d) => { d.descriptor.path_policies = []; }), 'MISSING_PATH_POLICY');
  assert.equal(code((d) => { delete d.preset_bank.presets[0].values.scale; }),
    'MISSING_PRESET_VALUE');
  assert.equal(code((d) => { d.preset_bank.presets[1].preset_id = 'calm'; }),
    'DUPLICATE_PRESET');
  assert.equal(code((d) => { d.preset_bank.edges[0].to = 'calm'; }),
    'INVALID_EDGE_ENDPOINT');
  assert.equal(code((d) => { d.preset_bank.edges[0].path_policy = 'absent'; }),
    'UNKNOWN_EDGE_PATH');
  assert.equal(code((d) => { d.preset_bank.choreography.generated_order = ['calm']; }),
    'INVALID_GENERATED_ORDER');
});

/**
 * Verifies an operator the target catalog does not carry compiles to a digest
 * and a per-stage diagnostic rather than to a rejection.
 */
test('an operator outside the catalog compiles but reports its stage', () => {
  const catalog = { ...OPERATOR_CATALOG };
  delete catalog['pullback.color.v1'];
  const compiled = compileShaderDocument(EXAMPLE, { catalog });

  assert.equal(compiled.status, 'VALID_BUT_UNSUPPORTED');
  assert.equal(compiled.descriptor_digest, compileShaderDocument(EXAMPLE).descriptor_digest);
  assert.equal(compiled.diagnostics.length, 1);
  assert.equal(compiled.diagnostics[0].code, 'OPERATOR_UNAVAILABLE');
  assert.equal(compiled.diagnostics[0].path, 'stage.color');
});

/** Verifies an export is classified against the registry by descriptor digest. */
test('an export is classified by its descriptor digest', () => {
  const compiled = compileShaderDocument(EXAMPLE);
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
    id: 'lens',
    storage: 'enum8',
    domain: { values: ['identity', 'glitch'] },
    interpolation: { kind: 'MIXED_ENUM' },
  };

  assert.deepEqual(interpolateValue(lens, 'identity', 'glitch', 0.25),
    { from: 'identity', to: 'glitch', mix: 0.25 });
  assert.equal(interpolateValue(lens, 'glitch', 'glitch', 0.25), 'glitch');
  assert.equal(interpolateValue(lens, 'identity', 'glitch', 0), 'identity');
  assert.equal(interpolateValue(lens, 'identity', 'glitch', 1), 'glitch');
  assert.equal(raised(() => interpolateValue(lens, 'identity', 'absent', 0.5)).code,
    'INVALID_ENUM_VALUE');
});

/**
 * Verifies a transition lands exactly on its endpoints, eases in between, and
 * refuses an evaluation the edge does not define. A periodic field is checked
 * for staying inside its period rather than for a value: it wraps through the
 * seam between the two presets.
 */
test('a transition evaluates between its two presets', () => {
  const { descriptor, preset_bank: bank } = compileShaderDocument(EXAMPLE);
  const at = (evaluation) => evaluateTransition(descriptor, bank, 'calm', 'fast', evaluation);

  assert.deepEqual(at(0).values, { scale: 1, phase: Math.fround(0.9) });
  assert.deepEqual(at(120).values, { scale: 4, phase: Math.fround(0.1) });
  assert.equal(at(120).duration, 120);

  const middle = at(60);
  assert.equal(middle.raw_progress, 0.5);
  assert.equal(middle.eased_progress, 0.5);
  assert.equal(middle.values.scale, 2);
  assert.ok(middle.values.phase >= 0 && middle.values.phase < 1);

  assert.equal(raised(() => at(121)).code, 'INVALID_EVALUATION');
  assert.equal(raised(() => at(0.5)).code, 'INVALID_EVALUATION');
  assert.equal(
    raised(() => evaluateTransition(descriptor, bank, 'calm', 'calm', 0)).code,
    'ABSENT_EDGE',
  );
});
