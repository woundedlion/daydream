import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {engineRoot, engineSkip, engineMissing} from './helpers/engine_checkout.js';
import {generateRecipeCpp} from '../src/workbench/solids/solid_codegen.js';
import {generateRegistryCpp} from '../src/workbench/solids/solid_registry_codegen.js';

test('generated solid recipes pass clang-format', {skip: engineSkip}, (t) => {
  assert.ok(engineRoot, engineMissing);
  const formatter = process.env.CLANG_FORMAT || 'clang-format';
  const version = spawnSync(formatter, ['--version'], {encoding: 'utf8'});
  if (version.error?.code === 'ENOENT' && process.env.CLANG_FORMAT_REQUIRED !== '1') {
    t.skip('clang-format is unavailable');
    return;
  }
  assert.equal(version.status, 0, version.stderr);
  const expectedVersion = readFileSync(`${engineRoot}/requirements/clang-format.txt`, 'utf8')
    .match(/^clang-format==([\d.]+)\b/m)?.[1];
  assert.ok(expectedVersion, 'the engine must declare its clang-format pin');
  assert.equal(version.stdout.match(/\bversion ([\d.]+)\b/)?.[1], expectedVersion,
    'clang-format must match the engine requirements pin');
  const sources = [generateRecipeCpp({base: 'cube', ops: ['kis']}, 'Archimedean')];
  sources.push(generateRecipeCpp({base: 'truncatedIcosahedron', ops: [
    {op: 'hankin', params: {angle: 58}}, {op: 'chamfer', params: {t: 0.63}},
  ]}, 'Archimedean'));
  sources.push(generateRecipeCpp({base: 'pentagonalHexecontahedron', ops: [
    {op: 'truncate', params: {t: 0.33}}, 'ambo', 'dual',
  ]}, 'Catalan'));
  const registryCases = [
    [{base: 'cube', ops: ['kis']}],
    [{base: 'truncatedIcosahedron', ops: ['ambo',
      {op: 'relax', params: {iter: 100}}, {op: 'truncate', params: {t: 0.01}},
      {op: 'hankin', params: {angle: 59}}]}],
    [{base: 'icosahedron_kis_gyro', ops: [{op: 'hankin', params: {angle: 54}}]},
      {seed: 'icosahedron', ops: [{op: 'kis', param: 0, twist: 0}, {op: 'gyro', param: 0, twist: 0}]}],
    [{base: 'truncatedTetrahedron', ops: ['kis', 'gyro']}],
    [{base: 'truncatedCuboctahedron', ops: Array.from({length: 3}, () =>
      ({op: 'truncate', params: {t: 0.33}}))}],
  ];
  for (const [item, baseRecipe] of registryCases) {
    const [definitions, entry] = generateRegistryCpp(item, baseRecipe)
      .split('// Append this Entry to islamic_registry.\n');
    sources.push(`${definitions}inline constexpr Entry islamic_registry[] = {\n${entry}\n};`);
  }
  for (const source of sources) {
    const checked = spawnSync(formatter,
      ['--dry-run', '--Werror', `--style=file:${engineRoot}/.clang-format`],
      {input: source + '\n', encoding: 'utf8'});
    assert.equal(checked.status, 0, checked.stderr + '\n' + source);
  }
});
