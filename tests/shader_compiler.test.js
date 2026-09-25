// Local pattern fixtures and frozen v1 migration identities.
// share. Current patterns are validated independently of historical fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import {
  compileShaderDocument,
  expandV1Document,
  exportShaderDocumentJson,
  parseShaderDocument,
  v1DescriptorDigest,
} from '../shader/shader_workbench.mjs';
import { sha256Hex } from '../shader/sha256.mjs';

const PATTERNS = new URL('../shader/patterns/', import.meta.url);
const FIXTURES = new URL('v1/', PATTERNS);
const patternNames = readdirSync(PATTERNS).filter((f) => f.endsWith('.shader.json'));
const identityProjectionPatterns = [
  'alien_core.shader.json',
  'alien_ocean.shader.json',
  'cosmic_eyeball.shader.json',
  'kaleidoscope_mandala.shader.json',
  'kaleidoscope_stained_glass.shader.json',
];
const legacyV1Digests = [
  '01b1774195e402e2e9eb4bb44bb35f81cfa4adef8d501d69ae98935f9a92d7f5',
  '2ef28f241efe8419e1c0479878b86ae7dfe51b20259976e96b684a13381a12e7',
  '4240fa800444a91786eb1eda594fed9b17c02004e19cb7055cdd2499123e68aa',
  '438ff1ecb64010fe3ad681dcc17230ab6f79aa17287e61c476452851abd738d0',
  '4b0518e3b1ff62e4a79308cca18bcb6835c7ca7a3c8ea0f6ec9f3b33de0c3ca7',
  '50e31575d2d1321177800bae081bc19c6ec1c75ee826b14733ebc2a296ce62f4',
  '5a7e3585c332cbd79d12980c266a7e0aca5c57fb446697add36beeddb105cd68',
  '65d932a735dfed3ee927167cedced31939f0a3938b820b38a9ff44554733d553',
  '722b4cca46a812b8d5faba5a7884e8d2af83bcc21bd94ed7d3a4e80e8b9a086c',
  'a0f9493b9471c3e420cf64ea1d2f023b233681736af4fb6db93c564233c5e110',
  'b4719815ef06422b44ba9ec217a808f77ac988ccc54450b12677f5e383469c71',
  'c9be489d1705973480f4bc785ba5f08d7c1b38405b0c5773632b3a6534f917b7',
  'd5fd332a75b646d7446413a97269ec6818fd11305f4fc50045ed911706022ef2',
  'd7b004e7329e1e0bcc570371f66fddaf4401b3d2bbaca9f0e99ff5f04369ddeb',
  'e433245bd939ce83dab2e3510742c9c81e768a2d4f372fc7a599a84de5bc8b9f',
  'ed25629495041b434cb2d142cf0eb71ba5afee4af07ba5c6ab391f1832173349',
];
const CATALOG = JSON.parse(
  readFileSync(new URL('../shader/engine_catalog.json', import.meta.url), 'utf8'));
const MIGRATION = JSON.parse(
  readFileSync(new URL('digest_migration.v1v2.json', PATTERNS), 'utf8'));

/**
 * Reads a file the canonical LF export is pinned against. A CRLF working-tree
 * copy holds the same content, so line endings are normalized away and every
 * other byte still has to match.
 * @param {URL} url - File to read.
 * @returns {string} The text, LF-terminated.
 */
const readPinned = (url) => readFileSync(url, 'utf8').replaceAll('\r\n', '\n');


/** Compiles with the pinned catalog. @param {*} source @param {Object} [options] */
const compile = (source, options = {}) =>
  compileShaderDocument(source, { catalog: CATALOG, ...options });


/** Verifies every committed pattern compiles and is keyed by its own digest. */
test('every committed shader pattern compiles to a distinct digest', () => {
  assert.ok(patternNames.length > 1);
  const digests = new Map();
  for (const name of patternNames) {
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


const fixtureNames = readdirSync(FIXTURES).filter((f) => f.endsWith('.shader.json'));

/** @param {string} name @returns {Object} A parsed v1 fixture. */
const fixture = (name) =>
  parseShaderDocument(readFileSync(new URL(name, FIXTURES), 'utf8'));

/**
 * Verifies expansion assigns the deterministic slot labels and consumes the
 * v1 policy objects into operator selection plus topology enum8 parameters.
 * kaleidoscope_flowers pins the interesting cases: a kaleidoscope lens variant, a
 * mirror in the second warp slot (warp1 vanishes with its identity policy),
 * and coverage folded into the sample stage.
 */
test('a v1 document expands to the deterministic chain of its slots', () => {
  const { document, parameter_ids } =
    expandV1Document(fixture('kaleidoscope_flowers.shader.json'), CATALOG);

  assert.equal(document.schema_version, 2);
  assert.equal(document.catalog_version, 2);
  assert.deepEqual(document.descriptor.chain, [
    { label: 'camera', operator: 'sphere.rotate.v2' },
    { label: 'lens', operator: 'sphere.lens.kaleidoscope.v2' },
    { label: 'project', operator: 'project.equirectangular.v2' },
    { label: 'warp2', operator: 'warp.mirror-tile.v2' },
    { label: 'sample', operator: 'sample.grid.v2' },
    { label: 'colorize', operator: 'colorize.generated-palette.v3' },
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
  for (const v1Id of fixture('kaleidoscope_flowers.shader.json').descriptor.parameters
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
test('v1 renamed parameters route onto the engine field ids', () => {
  const mobius = expandV1Document(fixture('mobius_grid.shader.json'), CATALOG);
  assert.equal(mobius.parameter_ids['mobius-a-re'], 'lens.mobius-a-re');
  assert.equal(mobius.parameter_ids['mobius-d-im'], 'lens.mobius-d-im');
  assert.equal(mobius.parameter_ids['brightness-depth'], 'colorize.brightness-bottom');
  for (const preset of mobius.document.preset_bank.presets) {
    assert.equal(preset.values['colorize.brightness-bottom'], 0);
    assert.equal(preset.values['colorize.brightness-top'], 1);
  }

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
  const first = expandV1Document(fixture('kaleidoscope_hex_oil.shader.json'), CATALOG);
  const second = expandV1Document(fixture('kaleidoscope_hex_oil.shader.json'), CATALOG);
  assert.deepEqual(first.document, second.document);
  assert.deepEqual(first.parameter_ids, second.parameter_ids);

  const throughCompile = compile(fixture('kaleidoscope_hex_oil.shader.json'));
  assert.equal(throughCompile.status, 'VALID');
  assert.equal(throughCompile.descriptor_digest,
    compile(first.document).descriptor_digest,
    'compiling a v1 source must be expansion followed by v2 compilation');
});

test('every historical document compiles through its v1 expansion', () => {
  for (const name of fixtureNames) {
    const historical = fixture(name);
    const expanded = expandV1Document(historical, CATALOG).document;
    const imported = compile(historical);
    const canonical = compile(exportShaderDocumentJson(expanded));
    assert.equal(imported.status, 'VALID', name);
    assert.equal(canonical.status, 'VALID', name);
    assert.equal(imported.descriptor_digest, canonical.descriptor_digest, name);
  }
});

test('v1 projection frame policies expand into explicit frame parameters', () => {
  for (const name of identityProjectionPatterns) {
    const historical = fixture(name);
    const expanded = expandV1Document(historical, CATALOG).document;
    assert.equal(expanded.descriptor.parameters.some(
      (parameter) => parameter.id === 'project.frame'), false, name);

    const replacement = structuredClone(historical);
    const surface = replacement.descriptor.graph.nodes.find(
      (node) => node.role === 'surface_project');
    surface.policy.frame = 'identity';
    const identity = expandV1Document(replacement, CATALOG).document;
    assert.equal(compile(identity).status, 'VALID', name);
    assert.equal(identity.descriptor.parameters.find(
      (parameter) => parameter.id === 'project.frame')?.default, 'identity', name);

    const project = expanded.descriptor.chain.find((slot) => slot.label === 'project');
    const operator = CATALOG.operators.find(({ id }) => id === project.operator);
    assert.equal(operator.params.find(({ id }) => id === 'frame').default,
      'spin-wander', name);
  }
});

test('every committed pattern document is its own canonical re-export', () => {
  assert.ok(patternNames.length > 0);
  for (const name of patternNames) {
    const url = new URL(name, PATTERNS);
    assert.equal(
      exportShaderDocumentJson(parseShaderDocument(readFileSync(url, 'utf8'))),
      readPinned(url),
      `${name} is not in canonical export form`,
    );
  }
});

/**
 * The frozen migration table: every v1 descriptor digest maps to the digest of
 * the committed document of the same name, with no extra or missing entries,
 * so digest consumers can follow a v1 identity onto its v2 identity. The five
 * identity-frame replacements differ from their expansion, whose digest no
 * committed document carries, so the successor is read off the shipped file.
 */
test('the digest migration table covers exactly the v1 fixtures', () => {
  const expected = new Map();
  for (const name of fixtureNames) {
    const successor = compile(readFileSync(new URL(name, PATTERNS), 'utf8'));
    assert.equal(successor.status, 'VALID', name);
    expected.set(v1DescriptorDigest(fixture(name)), successor.descriptor_digest);
  }
  assert.deepEqual(MIGRATION, Object.fromEntries(expected));
  assert.equal(Object.keys(MIGRATION).length, fixtureNames.length);
  assert.deepEqual(Object.keys(MIGRATION).sort(), legacyV1Digests);
});

/** Verifies every migration target names a document the repository ships. */
test('every digest migration target resolves to a committed document', () => {
  const shipped = new Map();
  for (const name of patternNames) {
    const compiled = compile(readFileSync(new URL(name, PATTERNS), 'utf8'));
    assert.equal(compiled.status, 'VALID', name);
    shipped.set(compiled.descriptor_digest, name);
  }
  for (const [legacy, successor] of Object.entries(MIGRATION))
    assert.ok(shipped.has(successor), `${legacy} maps to unshipped digest ${successor}`);
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

test('v1 noise scale adopts the current logarithmic catalog curve', () => {
  const catalog = structuredClone(CATALOG);
  for (const id of ['sphere.displace.curl.v2', 'sphere.displace.direct.v2']) {
    catalog.operators.find((operator) => operator.id === id)
      .params.find((field) => field.id === 'scale').curve = 'log-positive';
  }
  for (const name of ['kaleidoscope_hex_oil.shader.json', 'lattice_melt.shader.json']) {
    const expanded = expandV1Document(fixture(name), catalog).document;
    assert.equal(expanded.descriptor.parameters.find((parameter) => parameter.id === 'surface.scale')
      .interpolation.kind, 'LOG_POSITIVE');
    assert.equal(compileShaderDocument(expanded, { catalog }).status, 'VALID');
  }
});

test('v1 Mobius coefficients adopt the current snap catalog curve', () => {
  const catalog = structuredClone(CATALOG);
  for (const field of catalog.operators.find((operator) => operator.id === 'sphere.lens.mobius.v2').params)
    if (field.id.startsWith('mobius-')) field.curve = 'snap';
  const expanded = expandV1Document(fixture('mobius_grid.shader.json'), catalog).document;
  const coefficients = expanded.descriptor.parameters.filter((parameter) => parameter.id.startsWith('lens.mobius-'));
  assert.equal(coefficients.length, 8);
  assert.ok(coefficients.every((parameter) => parameter.interpolation.kind === 'SNAP'));
  assert.equal(compileShaderDocument(expanded, { catalog }).status, 'VALID');
});
