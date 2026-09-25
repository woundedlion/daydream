import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { upperSnake, opStepCpp, generateRegistryCpp, MAX_RECIPE_STEPS, MAX_BUILD_STEPS } =
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

test('opStepCpp rejects non-positive hankin angles', () => {
  for (const angle of [0, -0, -1]) {
    assert.throws(() => opStepCpp({ op: 'hankin', params: { angle } }),
      /opStepCpp: hankin param "angle" must be positive/);
  }
  for (const angle of [1, 90]) {
    assert.equal(opStepCpp({ op: 'hankin', params: { angle } }),
      `{Op::HANKIN, ${angle}.0f * IslamicStarPatterns::D2R}`);
  }
});

test('generateRegistryCpp rejects an authored zero-angle hankin', () => {
  const item = { base: 'icosahedron', ops: [{ op: 'hankin', params: { angle: 0 } }] };
  assert.throws(() => generateRegistryCpp(item), /hankin param "angle"/);
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
    readFileSync(new URL('./fixtures/registry-0.cpp', import.meta.url), 'utf8').trimEnd());
});

// A short seed and step-table name leave all three Recipe elements inside the
// 80-column limit, which is the shape clang-format packs them into.
test('generateRegistryCpp packs a short Recipe body onto one continuation line', () => {
  const code = generateRegistryCpp({ base: 'cube', ops: ['kis'] });
  assert.match(code, /\n {4}make_recipe\(SEED_CUBE, CUBE_KIS_STEPS\);\n/);
  for (const line of code.split('\n')) {
    assert.ok(line.length <= 80, `"${line}" is ${line.length} columns`);
  }
});

/**
 * Adding the entry grows islamic_registry, which fails its size static_assert
 * and the NUM_ENTRIES sum until ISLAMIC_COUNT is raised to match.
 */
test('every paste names the static_asserts a new entry breaks', () => {
  const chains = [
    [{ base: 'cube', ops: ['ambo'] }],
    [{ base: 'icosahedron', ops: [{ op: 'hankin', params: { angle: 62 } }] }],
    [{ base: 'icosahedron_kis', ops: ['dual'] },
      { seed: 'icosahedron', ops: [chainStep('kis')] }],
  ];
  for (const [item, baseRecipe] of chains) {
    assert.match(generateRegistryCpp(item, baseRecipe), /raise ISLAMIC_COUNT by one/,
      `${item.base} pastes without the ISLAMIC_COUNT bump`);
  }
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
 * The SIMPLE_SEEDS entries outside DEFINED_SEED_CONSTANTS: the seeds whose
 * paste defines its own SEED_* constant. Both rosters are the tool's own;
 * engine_source_parity.test.js pins them to solids.h.
 */
const SEEDS_WITHOUT_CONSTANTS = [
  'tetrahedron', 'cube', 'truncatedTetrahedron', 'cuboctahedron',
  'truncatedCube', 'truncatedCuboctahedron', 'snubCube',
  'truncatedDodecahedron', 'rhombicosidodecahedron',
];

test('DEFINED_SEED_CONSTANTS splits SIMPLE_SEEDS into the two paste cases', () => {
  assert.equal(SIMPLE_SEEDS.length, 18);
  assert.deepEqual(SIMPLE_SEEDS.filter(s => !DEFINED_SEED_CONSTANTS.has(s)),
    SEEDS_WITHOUT_CONSTANTS);
  for (const seed of DEFINED_SEED_CONSTANTS) {
    assert.ok(SIMPLE_SEEDS.includes(seed),
      `"${seed}" is on DEFINED_SEED_CONSTANTS but not on SIMPLE_SEEDS`);
  }
});

test('generateRegistryCpp reuses constants on the tool roster', () => {
  for (const seed of DEFINED_SEED_CONSTANTS) {
    const code = generateRegistryCpp({ base: seed, ops: ['ambo'] });
    assert.match(code, new RegExp(`\\n {4}make_recipe\\(SEED_${upperSnake(seed)},\\s`),
      `the Recipe for "${seed}" must seed on its own constant`);
    assert.doesNotMatch(code, /inline constexpr uint8_t SEED_/,
      `the tool roster marks SEED_${upperSnake(seed)} reusable`);
  }
});

test('generateRegistryCpp defines constants absent from the tool roster', () => {
  for (const seed of SEEDS_WITHOUT_CONSTANTS) {
    const code = generateRegistryCpp({ base: seed, ops: ['ambo'] });
    const constName = `SEED_${upperSnake(seed)}`;
    const block = code.slice(0, code.indexOf('/** Step table'));
    assert.ok(block.startsWith(`// solids.h defines no ${constName}.`),
      `the paste for "${seed}" must open by naming the missing constant`);
    assert.match(block, new RegExp(
      `inline constexpr uint8_t ${constName} =\\s+static_cast<uint8_t>\\(BaseMesh::${upperSnake(seed)}\\);`),
    `${constName} must carry its simple_registry index`);
    // The house static_assert, which fails to compile if the index moves.
    assert.match(block, new RegExp('static_assert\\(\\s*std::string_view\\('
      + `simple_registry\\[${constName}\\]\\.name\\) ==\\s*"${seed}"\\);`));
    // solids.h is clang-formatted at 80 columns and the block is pasted in.
    for (const line of block.split('\n')) {
      assert.ok(line.length <= 80, `"${line}" is ${line.length} columns`);
    }
    assert.match(code, new RegExp(`\\n {4}make_recipe\\(${constName},\\s`),
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
    readFileSync(new URL('./fixtures/registry-1.cpp', import.meta.url), 'utf8').trimEnd());
});

test('generateRegistryCpp wraps a long paste in the tool format', () => {
  const item = {
    base: 'truncatedIcosahedron',
    ops: [
      'ambo',
      { op: 'relax', params: { iter: 100 } },
      { op: 'truncate', params: { t: 0.01 } },
      { op: 'hankin', params: { angle: 59 } },
    ],
  };
  assert.equal(generateRegistryCpp(item),
    readFileSync(new URL('./fixtures/registry-2.cpp', import.meta.url), 'utf8').trimEnd());
});

test('no paste line exceeds the column limit solids.h is formatted at', () => {
  const chains = [
    ['ambo'],
    [{ op: 'hankin', params: { angle: 62 } }, 'ambo'],
    ['ambo', { op: 'relax', params: { iter: 100 } },
      { op: 'truncate', params: { t: 0.01 } },
      { op: 'hankin', params: { angle: 59 } }],
    [{ op: 'bevel', params: { t: 0.5 } }, { op: 'relax', params: { iter: 100 } },
      { op: 'hankin', params: { angle: 77 } }],
  ];
  for (const base of SIMPLE_SEEDS) {
    for (const ops of chains) {
      for (const line of generateRegistryCpp({ base, ops }).split('\n')) {
        if (line.length <= 80) continue;
        // clang-format cannot break a line that offers no break: an identifier
        // long enough to overflow on its own overflows there too.
        const atom = line.replace(/^\s*(\* )?/, '');
        assert.ok(!atom.includes(' ') && (line.trimStart().startsWith('*') || !atom.includes('::')),
          `"${line}" is ${line.length} columns for base "${base}"`);
      }
    }
  }
});

/** A step chain per step-table head shape: brace on the declarator line, brace
 * alone on the continuation line, declarator moved below its type. */
const HEAD_SHAPE_CHAINS = [
  ['ambo'],
  ['kis', 'gyro'],
  [{ op: 'hankin', params: { angle: 62 } }, 'ambo'],
  [{ op: 'truncate', params: { t: 0.33 } }, { op: 'truncate', params: { t: 0.33 } },
    { op: 'truncate', params: { t: 0.33 } }],
  ['ambo', { op: 'relax', params: { iter: 100 } },
    { op: 'truncate', params: { t: 0.01 } },
    { op: 'hankin', params: { angle: 59 } }],
];

/**
 * The tool deliberately emits one step per line for readable pastes. Its
 * trailing comma keeps that format stable when clang-format runs, independent
 * of how existing engine tables happen to be packed.
 */
test('every step table emits one step per line, last step comma-terminated', () => {
  for (const base of SIMPLE_SEEDS) {
    for (const ops of HEAD_SHAPE_CHAINS) {
      const code = generateRegistryCpp({ base, ops });
      const start = code.indexOf('inline constexpr OpStep');
      const close = code.indexOf('\n};\n', start);
      assert.ok(close > start,
        `the table for "${base}" must close with '};' in column 0`);
      const steps = code.slice(start, close).split('\n')
        .filter(line => line.trimStart().startsWith('{Op::'));
      assert.equal(steps.length, ops.length,
        `the table for "${base}" must carry one step per line`);
      for (const line of steps) {
        assert.ok(line.endsWith(','), `"${line}" must end in a comma`);
      }
    }
  }
});

test('a step table head that fills the column limit breaks before its brace', () => {
  const truncate33 = { op: 'truncate', params: { t: 0.33 } };
  assert.match(
    generateRegistryCpp({ base: 'dodecahedron', ops: [truncate33, truncate33, truncate33] }),
    /inline constexpr OpStep DODECAHEDRON_TRUNCATE33_TRUNCATE33_TRUNCATE33_STEPS\[\] =\n {4}\{\n {8}\{Op::TRUNCATE, 0\.33f\},\n {8}\{Op::TRUNCATE, 0\.33f\},\n {8}\{Op::TRUNCATE, 0\.33f\},\n\};\n/);
});

test('generateRegistryCpp flattens a star-pattern base onto its own seed', () => {
  const item = { base: 'icosahedron_kis_gyro', ops: [{ op: 'hankin', params: { angle: 54 } }] };
  const baseRecipe = { seed: 'icosahedron', ops: [chainStep('kis'), chainStep('gyro')] };
  assert.equal(generateRegistryCpp(item, baseRecipe),
    readFileSync(new URL('./fixtures/registry-3.cpp', import.meta.url), 'utf8').trimEnd());
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
  assert.match(code, /\n {4}make_recipe\(SEED_DODECAHEDRON, /);
  assert.doesNotMatch(code, /SEED_DODECAHEDRON_HK62/);
  // The base's own chain leads the step table, then the tool's ops.
  assert.match(code, /\{Op::HANKIN, 62\.0f \* IslamicStarPatterns::D2R\},\n {4}\{Op::AMBO\},\n {4}\{Op::HANKIN, 62\.0f \* IslamicStarPatterns::D2R\},\n {4}\{Op::DUAL\},\n\};/);
});

test('generateRegistryCpp emits a base chain hankin angle no whole degree reproduces', () => {
  const item = { base: 'icosahedron_hkraw', ops: ['dual'] };
  const baseRecipe = { seed: 'icosahedron', ops: [chainStep('hankin', 0.5)] };
  const code = generateRegistryCpp(item, baseRecipe);
  assert.match(code, /\{Op::HANKIN, 0\.5f\},/,
    'the radian value stands in for a deg * D2R product that would not read back the same');
  assert.doesNotMatch(code, /\{Op::HANKIN, [0-9.]+f \* IslamicStarPatterns::D2R\}/);
});

test('generateRegistryCpp rejects non-positive base chain hankin angles', () => {
  const item = { base: 'icosahedron_hkbad', ops: ['dual'] };
  for (const angle of [0, -0, -0.5]) {
    const baseRecipe = { seed: 'icosahedron', ops: [chainStep('hankin', angle)] };
    assert.throws(() => generateRegistryCpp(item, baseRecipe),
      /generateRegistryCpp: base chain hankin angle must be positive/);
  }
});

test('generateRegistryCpp names the base chain hankin angle it cannot emit', () => {
  const item = { base: 'icosahedron_hkbad', ops: ['dual'] };
  const baseRecipe = { seed: 'icosahedron', ops: [chainStep('hankin', NaN)] };
  assert.throws(() => generateRegistryCpp(item, baseRecipe),
    /generateRegistryCpp: base chain hankin angle must be positive, got NaN/);
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

test('generateRegistryCpp emits a step table at the engine build ceiling', () => {
  const code = generateRegistryCpp({ base: 'cube', ops: longOps(MAX_BUILD_STEPS) });
  assert.equal(code.split('{Op::').length - 1, MAX_BUILD_STEPS);
});

test('generateRegistryCpp rejects a chain one step past the uint8_t count ceiling', () => {
  assert.throws(() => generateRegistryCpp(
    { base: 'cube', ops: longOps(MAX_RECIPE_STEPS + 1) }),
  /has 256 steps; a Recipe carries at most 255/);
});

test('generateRegistryCpp counts a flattened base chain against the ceiling', () => {
  const item = { base: 'icosahedron_kis', ops: longOps(5) };
  const baseOps = Array(MAX_BUILD_STEPS - 5).fill(chainStep('kis'));
  const atCeiling = { seed: 'icosahedron', ops: baseOps };
  const code = generateRegistryCpp(item, atCeiling);
  assert.equal(code.split('{Op::').length - 1, MAX_BUILD_STEPS);

  const overCeiling = { seed: 'icosahedron', ops: [...baseOps, chainStep('kis')] };
  assert.throws(() => generateRegistryCpp(item, overCeiling),
    /lowers to 9 primitive steps; IslamicStars supports at most 8/);
});

test('registry limits count composite operations after lowering', () => {
  const code = generateRegistryCpp({
    base: 'cube', ops: ['meta', 'meta', 'dual', 'dual'],
  });
  assert.deepEqual([...code.matchAll(/\{Op::([A-Z]+)\}/g)].map((match) => match[1]),
    ['META', 'META', 'DUAL', 'DUAL']);
  assert.throws(() => generateRegistryCpp({
    base: 'cube', ops: ['meta', 'meta', 'meta'],
  }), /lowers to 9 primitive steps/);
  assert.throws(() => generateRegistryCpp({
    base: 'cube', ops: ['gyro', 'needle', 'zip', { op: 'bevel', params: { t: 0.3 } }, 'dual'],
  }), /lowers to 9 primitive steps/);
});
