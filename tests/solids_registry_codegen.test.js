import { test } from 'node:test';
import assert from 'node:assert/strict';

const { upperSnake, opStepCpp, generateRegistryCpp, MAX_RECIPE_STEPS } =
  await import('../tools/solid_registry_codegen.js');
const { OP_DEFS, KNOWN_OPS, PARAMETERIZED_OPS, SIMPLE_SEEDS, DEFINED_SEED_CONSTANTS } =
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

test('opStepCpp rejects a relax with zero iterations', () => {
  assert.throws(() => opStepCpp({ op: 'relax', params: { iter: 0 } }),
    /relax param "iter" must be at least 1/);
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

test('generateRegistryCpp emits a Recipe mirror for a hankin-free chain too', () => {
  const item = { base: 'cube', ops: [{ op: 'truncate', params: { t: 0.33 } }] };
  assert.equal(generateRegistryCpp(item),
    '// solids.h defines no SEED_CUBE. Paste the constant and its\n'
    + '// static_assert beside the other SEED_* constants.\n'
    + 'inline constexpr uint8_t SEED_CUBE = 1;\n'
    + 'static_assert(std::string_view(simple_registry[SEED_CUBE].name) == "cube");\n'
    + '\n'
    + '/** Step table for cube_truncate33. */\n'
    + 'inline constexpr OpStep CUBE_TRUNCATE33_STEPS[] = {\n'
    + '    {Op::TRUNCATE, 0.33f}};\n'
    + '/** Recipe mirror of IslamicStarPatterns::cube_truncate33. */\n'
    + 'inline constexpr Recipe CUBE_TRUNCATE33_RECIPE = {\n'
    + '    SEED_CUBE, CUBE_TRUNCATE33_STEPS,\n'
    + '    static_cast<uint8_t>(std::size(CUBE_TRUNCATE33_STEPS))};\n'
    + '\n'
    + '    {"cube_truncate33",\n'
    + '     IslamicStarPatterns::cube_truncate33, Category::Complex,\n'
    + '     &CUBE_TRUNCATE33_RECIPE},');
});

test('generateRegistryCpp never emits a Category::Simple entry', () => {
  const chains = [
    [{ base: 'cube', ops: ['ambo'] }],
    [{ base: 'icosahedron', ops: [{ op: 'hankin', params: { angle: 62 } }] }],
    [{ base: 'icosahedron_kis', ops: ['dual'] },
      { seed: 'icosahedron', ops: [chainStep('kis')] }],
  ];
  for (const [item, baseRecipe] of chains) {
    const code = generateRegistryCpp(item, baseRecipe);
    assert.match(code, /Category::Complex/, `${item.base} must be Complex`);
    assert.doesNotMatch(code, /Category::Simple/);
  }
});

test('generateRegistryCpp refuses a Catalan seed, which no Recipe can index', () => {
  assert.throws(
    () => generateRegistryCpp({ base: 'rhombicDodecahedron', ops: ['ambo'] }),
    /is a Catalan solid/);
  assert.throws(
    () => generateRegistryCpp({ base: 'pentagonalHexecontahedron_kis', ops: ['dual'] },
      { seed: 'disdyakisTriacontahedron', ops: [chainStep('kis')] }),
    /is a Catalan solid/);
});

/**
 * The simple_registry seeds solids.h declares no SEED_* constant for, so a
 * paste on one has to define it. Pinned here so the roster the generator
 * encodes cannot drift from solids.h unnoticed.
 */
const SEEDS_WITHOUT_CONSTANTS = [
  'tetrahedron', 'cube', 'truncatedTetrahedron', 'cuboctahedron',
  'truncatedCube', 'truncatedCuboctahedron', 'snubCube',
  'truncatedDodecahedron', 'rhombicosidodecahedron',
];

test('the encoded seed roster splits simple_registry into the two cases', () => {
  assert.equal(SIMPLE_SEEDS.length, 18);
  assert.deepEqual(SIMPLE_SEEDS.filter(s => !DEFINED_SEED_CONSTANTS.has(s)),
    SEEDS_WITHOUT_CONSTANTS);
  for (const seed of DEFINED_SEED_CONSTANTS) {
    assert.ok(SIMPLE_SEEDS.includes(seed),
      `"${seed}" carries a SEED_* constant but is no simple_registry entry`);
  }
});

test('generateRegistryCpp names a declared SEED_* constant without redefining it', () => {
  for (const seed of DEFINED_SEED_CONSTANTS) {
    const code = generateRegistryCpp({ base: seed, ops: ['ambo'] });
    assert.match(code, new RegExp(`\\n {4}SEED_${upperSnake(seed)}, `),
      `the Recipe for "${seed}" must seed on its own constant`);
    assert.doesNotMatch(code, /inline constexpr uint8_t SEED_/,
      `solids.h already declares SEED_${upperSnake(seed)}`);
  }
});

test('generateRegistryCpp defines the SEED_* constant solids.h lacks', () => {
  for (const seed of SEEDS_WITHOUT_CONSTANTS) {
    const code = generateRegistryCpp({ base: seed, ops: ['ambo'] });
    const constName = `SEED_${upperSnake(seed)}`;
    const block = code.slice(0, code.indexOf('/** Step table'));
    assert.ok(block.startsWith(`// solids.h defines no ${constName}.`),
      `the paste for "${seed}" must open by naming the missing constant`);
    assert.match(block, new RegExp(
      `inline constexpr uint8_t ${constName} = ${SIMPLE_SEEDS.indexOf(seed)};`),
    `${constName} must carry its simple_registry index`);
    // The house static_assert, which fails to compile if the index moves.
    assert.match(block, new RegExp('static_assert\\(\\s*std::string_view\\('
      + `simple_registry\\[${constName}\\]\\.name\\) ==\\s*"${seed}"\\);`));
    // solids.h is clang-formatted at 80 columns and the block is pasted in.
    for (const line of block.split('\n')) {
      assert.ok(line.length <= 80, `"${line}" is ${line.length} columns`);
    }
    assert.match(code, new RegExp(`\\n {4}${constName}, `),
      `the Recipe for "${seed}" must seed on the defined constant`);
  }
});

test('generateRegistryCpp refuses a seed that indexes no simple_registry entry', () => {
  assert.throws(
    () => generateRegistryCpp({ base: 'dodecahedron_hk62_ambo', ops: ['dual'] }),
    /names no Platonic or Archimedean solid/);
  assert.throws(
    () => generateRegistryCpp({ base: 'icosahedron_kis', ops: ['dual'] },
      { seed: 'icosahedron_kis', ops: [chainStep('kis')] }),
    /names no Platonic or Archimedean solid/);
});

test('generateRegistryCpp emits a step table and Recipe mirror for a hankin chain', () => {
  const item = {
    base: 'dodecahedron',
    ops: [{ op: 'hankin', params: { angle: 62 } }, 'ambo'],
  };
  assert.equal(generateRegistryCpp(item),
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
  assert.equal(generateRegistryCpp(item, baseRecipe),
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
  const code = generateRegistryCpp(item, baseRecipe);
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
  const code = generateRegistryCpp(item, baseRecipe);
  const literal = code.match(/\{Op::TRUNCATE, ([0-9.]+)f\}/);
  assert.ok(literal, 'the base truncate step must emit a float literal');
  assert.equal(Math.fround(parseFloat(literal[1])), truncateT);
});

test('generateRegistryCpp carries a base chain snub twist', () => {
  const item = { base: 'icosahedron_snub', ops: [{ op: 'hankin', params: { angle: 62 } }] };
  const baseRecipe = { seed: 'icosahedron', ops: [chainStep('snub', 0.5, 0.25)] };
  assert.match(generateRegistryCpp(item, baseRecipe),
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
  assert.throws(() => generateRegistryCpp(item, baseRecipe),
    /bake-backed relax step/);
});

test('generateRegistryCpp emits a live base chain relax count', () => {
  const item = { base: 'icosahedron_relax', ops: [{ op: 'hankin', params: { angle: 62 } }] };
  const baseRecipe = { seed: 'icosahedron', ops: [chainStep('relax', 100)] };
  assert.match(generateRegistryCpp(item, baseRecipe),
    /\{Op::RELAX, 100\.0f\}/);
});

test('generateRegistryCpp rejects a malformed base chain', () => {
  const item = { base: 'icosahedron_kis_gyro', ops: ['dual'] };
  assert.throws(() => generateRegistryCpp(item,
    { seed: 'ico sahedron', ops: [] }), /is not a valid C\+\+ identifier/);
  assert.throws(() => generateRegistryCpp(item,
    { seed: 'icosahedron', ops: 'kis' }), /ops must be an array/);
  assert.throws(() => generateRegistryCpp(item,
    { seed: 'icosahedron', ops: [chainStep('notAnOp')] }), /unknown op "notAnOp"/);
});

test('generateRegistryCpp rejects an invalid base', () => {
  assert.throws(() => generateRegistryCpp({ base: 'ico sahedron', ops: ['ambo'] }),
    /is not a valid C\+\+ identifier/);
  assert.throws(() => generateRegistryCpp({ base: '', ops: ['ambo'] }),
    /is not a valid C\+\+ identifier/);
});

test('generateRegistryCpp rejects an empty op chain', () => {
  assert.throws(() => generateRegistryCpp({ base: 'cube', ops: [] }),
    /op chain is empty/);
});

/** A chain of `count` steps: one hankin, then parameterless ops. */
function longOps(count) {
  return [{ op: 'hankin', params: { angle: 62 } }, ...Array(count - 1).fill('dual')];
}

test('generateRegistryCpp emits a step table at the uint8_t count ceiling', () => {
  const code = generateRegistryCpp({ base: 'cube', ops: longOps(MAX_RECIPE_STEPS) });
  assert.equal(code.split('{Op::').length - 1, MAX_RECIPE_STEPS);
});

test('generateRegistryCpp rejects a chain one step past the uint8_t count ceiling', () => {
  assert.throws(() => generateRegistryCpp(
    { base: 'cube', ops: longOps(MAX_RECIPE_STEPS + 1) }),
  /has 256 steps; a Recipe carries at most 255/);
});

test('generateRegistryCpp counts a flattened base chain against the ceiling', () => {
  const item = { base: 'icosahedron_kis', ops: longOps(5) };
  const baseOps = Array(MAX_RECIPE_STEPS - 5).fill(chainStep('kis'));
  const atCeiling = { seed: 'icosahedron', ops: baseOps };
  const code = generateRegistryCpp(item, atCeiling);
  assert.equal(code.split('{Op::').length - 1, MAX_RECIPE_STEPS);

  const overCeiling = { seed: 'icosahedron', ops: [...baseOps, chainStep('kis')] };
  assert.throws(() => generateRegistryCpp(item, overCeiling),
    /has 256 steps; a Recipe carries at most 255/);
});
