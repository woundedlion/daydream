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

// Mirrors solids.h `static constexpr float D2R = PI_F / 180.0f`, so a test can
// state a base chain's hankin angle in the radians the engine reports.
const D2R_F32 = Math.fround(Math.fround(Math.PI) / 180);

/** A MeshOps.getRecipe() step, in the engine-native units it reports. */
function chainStep(op, param = 0, twist = 0) {
  return { op, param, twist };
}

test('generateRegistryCpp emits a one-line Simple entry in the seed namespace', () => {
  const item = { base: 'cube', ops: [{ op: 'truncate', params: { t: 0.33 } }] };
  assert.equal(generateRegistryCpp(item, 'Archimedean'),
    '    {"cube_truncate33",\n'
    + '     Archimedean::cube_truncate33,\n'
    + '     Category::Simple},');
});

test('generateRegistryCpp keeps a Catalan seed in its own namespace', () => {
  const item = { base: 'rhombicDodecahedron', ops: ['ambo'] };
  assert.equal(generateRegistryCpp(item, 'Catalan'),
    '    {"rhombicDodecahedron_ambo",\n'
    + '     Catalan::rhombicDodecahedron_ambo,\n'
    + '     Category::Simple},');
});

test('generateRegistryCpp emits a step table and Recipe mirror for a hankin chain', () => {
  const item = {
    base: 'dodecahedron',
    ops: [{ op: 'hankin', params: { angle: 62 } }, 'ambo'],
  };
  assert.equal(generateRegistryCpp(item, 'Archimedean'),
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

test('generateRegistryCpp flattens a star-pattern base onto its own seed', () => {
  const item = { base: 'icosahedron_kis_gyro', ops: [{ op: 'hankin', params: { angle: 54 } }] };
  const baseRecipe = { seed: 'icosahedron', ops: [chainStep('kis'), chainStep('gyro')] };
  assert.equal(generateRegistryCpp(item, 'IslamicStarPatterns', baseRecipe),
    '/** Step table for icosahedron_kis_gyro_hk54. */\n'
    + 'inline constexpr OpStep ICOSAHEDRON_KIS_GYRO_HK54_STEPS[] = {\n'
    + '    {Op::KIS},\n'
    + '    {Op::GYRO},\n'
    + '    {Op::HANKIN, 54.0f * IslamicStarPatterns::D2R}};\n'
    + '/** Recipe mirror of IslamicStarPatterns::icosahedron_kis_gyro_hk54. */\n'
    + 'inline constexpr Recipe ICOSAHEDRON_KIS_GYRO_HK54_RECIPE = {\n'
    + '    SEED_ICOSAHEDRON, ICOSAHEDRON_KIS_GYRO_HK54_STEPS,\n'
    + '    static_cast<uint8_t>(std::size(ICOSAHEDRON_KIS_GYRO_HK54_STEPS))};\n'
    + '\n'
    + '    {"icosahedron_kis_gyro_hk54",\n'
    + '     IslamicStarPatterns::icosahedron_kis_gyro_hk54, Category::Complex,\n'
    + '     &ICOSAHEDRON_KIS_GYRO_HK54_RECIPE},');
});

test('generateRegistryCpp never names a star pattern as the Recipe seed', () => {
  const item = { base: 'dodecahedron_hk62_ambo_hk62', ops: ['dual'] };
  const baseRecipe = {
    seed: 'dodecahedron',
    ops: [
      chainStep('hankin', Math.fround(62 * D2R_F32)),
      chainStep('ambo'),
      chainStep('hankin', Math.fround(62 * D2R_F32)),
    ],
  };
  const code = generateRegistryCpp(item, 'IslamicStarPatterns', baseRecipe);
  assert.match(code, /\n {4}SEED_DODECAHEDRON, /);
  assert.doesNotMatch(code, /SEED_DODECAHEDRON_HK62/);
  // The base's own chain leads the step table, then the tool's ops.
  assert.match(code, /\{Op::HANKIN, 62\.0f \* IslamicStarPatterns::D2R\},\n {4}\{Op::AMBO\},\n {4}\{Op::HANKIN, 62\.0f \* IslamicStarPatterns::D2R\},\n {4}\{Op::DUAL\}\}/);
});

test('generateRegistryCpp emits base chain params that read back as the same float32', () => {
  const truncateT = Math.fround(5 * D2R_F32);
  const item = { base: 'icosidodecahedron_truncate5d_ambo_dual', ops: [{ op: 'hankin', params: { angle: 40 } }] };
  const baseRecipe = {
    seed: 'icosidodecahedron',
    ops: [chainStep('truncate', truncateT), chainStep('ambo'), chainStep('dual')],
  };
  const code = generateRegistryCpp(item, 'IslamicStarPatterns', baseRecipe);
  const literal = code.match(/\{Op::TRUNCATE, ([0-9.]+)f\}/);
  assert.ok(literal, 'the base truncate step must emit a float literal');
  assert.equal(Math.fround(parseFloat(literal[1])), truncateT);
});

test('generateRegistryCpp carries a base chain snub twist', () => {
  const item = { base: 'icosahedron_snub', ops: [{ op: 'hankin', params: { angle: 62 } }] };
  const baseRecipe = { seed: 'icosahedron', ops: [chainStep('snub', 0.5, 0.25)] };
  assert.match(generateRegistryCpp(item, 'IslamicStarPatterns', baseRecipe),
    /\{Op::SNUB, 0\.5f, 0\.25f\}/);
});

test('generateRegistryCpp refuses a base chain whose relax is bake-backed', () => {
  const item = { base: 'dodecahedron_ambo_bevel33_relax_hk66', ops: ['dual'] };
  const baseRecipe = {
    seed: 'dodecahedron',
    ops: [
      chainStep('ambo'),
      chainStep('bevel', 0.33),
      // A baked relax reports param 0: the RelaxBakes symbol does not cross.
      chainStep('relax'),
      chainStep('hankin', Math.fround(66 * D2R_F32)),
    ],
  };
  assert.throws(() => generateRegistryCpp(item, 'IslamicStarPatterns', baseRecipe),
    /bake-backed relax step/);
});

test('generateRegistryCpp emits a live base chain relax count', () => {
  const item = { base: 'icosahedron_relax', ops: [{ op: 'hankin', params: { angle: 62 } }] };
  const baseRecipe = { seed: 'icosahedron', ops: [chainStep('relax', 100)] };
  assert.match(generateRegistryCpp(item, 'IslamicStarPatterns', baseRecipe),
    /\{Op::RELAX, 100\.0f\}/);
});

test('generateRegistryCpp rejects a malformed base chain', () => {
  const item = { base: 'icosahedron_kis_gyro', ops: ['dual'] };
  assert.throws(() => generateRegistryCpp(item, 'IslamicStarPatterns',
    { seed: 'ico sahedron', ops: [] }), /is not a valid C\+\+ identifier/);
  assert.throws(() => generateRegistryCpp(item, 'IslamicStarPatterns',
    { seed: 'icosahedron', ops: 'kis' }), /ops must be an array/);
  assert.throws(() => generateRegistryCpp(item, 'IslamicStarPatterns',
    { seed: 'icosahedron', ops: [chainStep('notAnOp')] }), /unknown op "notAnOp"/);
});

test('generateRegistryCpp rejects an invalid seed namespace', () => {
  const item = { base: 'cube', ops: ['ambo'] };
  assert.throws(() => generateRegistryCpp(item, 'Arch imedean'),
    /is not a valid C\+\+ identifier/);
  assert.throws(() => generateRegistryCpp(item, ''),
    /is not a valid C\+\+ identifier/);
});

test('generateRegistryCpp rejects an empty op chain', () => {
  assert.throws(() => generateRegistryCpp({ base: 'cube', ops: [] }, 'Archimedean'),
    /op chain is empty/);
});
