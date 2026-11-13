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
  const bases = ['cube', 'dodecahedron_hk62_ambo_hk62',
    'truncatedIcosidodecahedron_hk62_ambo_hk62',
    'truncatedIcosahedron_hk58_chamfer63',
    'truncatedIcosahedron_ambo_relax_truncate33_hk64',
    'truncatedIcosahedron_ambo_relax_truncate001_hankin59'];
  const sources = bases.map((base) => generateRecipeCpp({base, ops: ['kis']}, 'IslamicStarPatterns'));
  const [definitions, entry] = generateRegistryCpp({base: 'cube', ops: ['kis']})
    .split('// Append this Entry to islamic_registry.\n');
  sources.push(`${definitions}inline constexpr Entry islamic_registry[] = {\n${entry}\n};`);
  for (const source of sources) {
    const checked = spawnSync(formatter,
      ['--dry-run', '--Werror', `--style=file:${engineRoot}/.clang-format`],
      {input: source + '\n', encoding: 'utf8'});
    assert.equal(checked.status, 0, checked.stderr + '\n' + source);
  }
});
