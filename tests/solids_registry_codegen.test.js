// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { upperSnake, opStepCpp, generateRegistryCpp } =
  await import('../tools/solid_registry_codegen.js');
const { OP_DEFS, KNOWN_OPS, PARAMETERIZED_OPS } =
  await import('../tools/solid_codegen.js');

test('upperSnake splits camelCase runs and uppercases the rest', () => {
  assert.equal(upperSnake('truncatedIcosahedron_hk58_chamfer63'),
    'TRUNCATED_ICOSAHEDRON_HK58_CHAMFER63');
  assert.equal(upperSnake('cube'), 'CUBE');
  assert.equal(upperSnake('snubDodecahedron'), 'SNUB_DODECAHEDRON');
  // A digit before the capital is a boundary too, so the hk62 suffix does not
  // glue onto the next segment.
  assert.equal(upperSnake('dodecahedron_hk62_ambo'), 'DODECAHEDRON_HK62_AMBO');
});

test('opStepCpp emits the engine-unit OpStep initializer per op shape', () => {
  assert.equal(opStepCpp({ op: 'hankin', params: { angle: 62 } }),
    '{Op::HANKIN, 62.0f * IslamicStarPatterns::D2R}');
  assert.equal(opStepCpp({ op: 'snub', params: { t: 0.5, twist: 0.25 } }),
    '{Op::SNUB, 0.5f, 0.25f}');
  assert.equal(opStepCpp({ op: 'relax', params: { iter: 100 } }),
    '{Op::RELAX, 100.0f}');
  assert.equal(opStepCpp({ op: 'truncate', params: { t: 0.33 } }),
    '{Op::TRUNCATE, 0.33f}');
  assert.equal(opStepCpp({ op: 'bevel', params: { t: 0.25 } }),
    '{Op::BEVEL, 0.25f}');
  assert.equal(opStepCpp('ambo'), '{Op::AMBO}');
  assert.equal(opStepCpp({ op: 'dual' }), '{Op::DUAL}');
});

test('opStepCpp names an Op enumerator for every op the tool offers', () => {
  for (const op of KNOWN_OPS) {
    const params = {};
    for (const [key, def] of Object.entries(OP_DEFS[op].params)) params[key] = def.val;
    assert.match(opStepCpp({ op, params }),
      new RegExp(`^\\{Op::${op.toUpperCase()}[,}]`),
      `${op} must emit its own Op:: enumerator`);
  }
});

test('opStepCpp rejects an unknown op instead of dereferencing a missing entry', () => {
  assert.throws(() => opStepCpp({ op: 'notAnOp', params: {} }), /unknown op "notAnOp"/);
  assert.throws(() => opStepCpp('notAnOp'), /unknown op "notAnOp"/);
});

test('opStepCpp rejects a parameterized op with no params object', () => {
  for (const op of PARAMETERIZED_OPS) {
    assert.throws(() => opStepCpp(op), /requires a params object/,
      `bare "${op}" must be rejected`);
    assert.throws(() => opStepCpp({ op }), /requires a params object/,
      `params-less "${op}" must be rejected`);
  }
});

test('generateRegistryCpp emits a one-line Simple entry in the seed namespace', () => {
  const item = { base: 'cube', ops: [{ op: 'truncate', params: { t: 0.33 } }] };
  assert.equal(generateRegistryCpp(item, 'Archimedean', false),
    '    {"cube_truncate33",\n'
    + '     Archimedean::cube_truncate33,\n'
    + '     Category::Simple},');
});

test('generateRegistryCpp keeps a Catalan seed in its own namespace', () => {
  const item = { base: 'rhombicDodecahedron', ops: ['ambo'] };
  assert.equal(generateRegistryCpp(item, 'Catalan', false),
    '    {"rhombicDodecahedron_ambo",\n'
    + '     Catalan::rhombicDodecahedron_ambo,\n'
    + '     Category::Simple},');
});

test('generateRegistryCpp emits a step table and Recipe mirror for a hankin chain', () => {
  const item = {
    base: 'dodecahedron',
    ops: [{ op: 'hankin', params: { angle: 62 } }, 'ambo'],
  };
  assert.equal(generateRegistryCpp(item, 'Archimedean', false),
    '/** Step table for dodecahedron_hk62_ambo. */\n'
    + 'inline constexpr OpStep DODECAHEDRON_HK62_AMBO_STEPS[] = {\n'
    + '    {Op::HANKIN, 62.0f * IslamicStarPatterns::D2R},\n'
    + '    {Op::AMBO}};\n'
    + '/** Recipe mirror of IslamicStarPatterns::dodecahedron_hk62_ambo. */\n'
    + 'inline constexpr Recipe DODECAHEDRON_HK62_AMBO_RECIPE = {\n'
    + '    SEED_DODECAHEDRON, DODECAHEDRON_HK62_AMBO_STEPS,\n'
    + '    static_cast<uint8_t>(std::size(DODECAHEDRON_HK62_AMBO_STEPS))};\n'
    + '\n'
    + '    {"dodecahedron_hk62_ambo",\n'
    + '     IslamicStarPatterns::dodecahedron_hk62_ambo, Category::Complex,\n'
    + '     &DODECAHEDRON_HK62_AMBO_RECIPE},');
});

test('generateRegistryCpp lands a star-pattern base in the Complex registry', () => {
  const item = { base: 'icosahedron_kis_gyro', ops: ['ambo'] };
  const code = generateRegistryCpp(item, 'IslamicStarPatterns', true);
  assert.match(code, /Category::Complex/);
  assert.match(code, /inline constexpr Recipe ICOSAHEDRON_KIS_GYRO_AMBO_RECIPE = \{/);
});

test('generateRegistryCpp rejects an invalid seed namespace', () => {
  const item = { base: 'cube', ops: ['ambo'] };
  assert.throws(() => generateRegistryCpp(item, 'Arch imedean', false),
    /is not a valid C\+\+ identifier/);
  assert.throws(() => generateRegistryCpp(item, '', false),
    /is not a valid C\+\+ identifier/);
});

test('generateRegistryCpp rejects an empty op chain', () => {
  assert.throws(() => generateRegistryCpp({ base: 'cube', ops: [] }, 'Archimedean', false),
    /op chain is empty/);
});
