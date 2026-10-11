import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyEngineContracts } from '../scripts/copy-engine-contracts.mjs';
import { ENGINE_CONTRACT_PATHS } from '../scripts/install-engine-bundle.mjs';
import { scratchDir } from './helpers/fixture_repo.js';

const SCRIPT = new URL('../scripts/copy-engine-contracts.mjs', import.meta.url);

function fixture(t) {
  const root = scratchDir(t, 'engine-contract-copy-');
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(join(source, 'generated'), { recursive: true });
  mkdirSync(join(destination, 'generated'), { recursive: true });
  return {source, destination};
}

test('source snapshot receives installed contracts while retaining its existing declarations', (t) => {
  const {source, destination} = fixture(t);
  for (const path of ENGINE_CONTRACT_PATHS) writeFileSync(join(source, path), path);
  const retained = 'generated/holosphere_wasm.d.ts';
  writeFileSync(join(destination, retained), 'snapshot declaration');
  copyEngineContracts(source, destination);
  for (const path of ENGINE_CONTRACT_PATHS)
    assert.equal(readFileSync(join(destination, path), 'utf8'),
      path === retained ? 'snapshot declaration' : path);
});

test('missing installed contracts refuse snapshot checks before copying a partial set', (t) => {
  const {source, destination} = fixture(t);
  const first = [...ENGINE_CONTRACT_PATHS][0];
  writeFileSync(join(source, first), 'partial');
  assert.throws(() => copyEngineContracts(source, destination), /Install the engine bundle before pushing/);
  assert.equal(existsSync(join(destination, first)), false);
});

test('contract-copy CLI installs the complete contract set', (t) => {
  const {source, destination} = fixture(t);
  for (const path of ENGINE_CONTRACT_PATHS) writeFileSync(join(source, path), path);
  const result = spawnSync(process.execPath, [fileURLToPath(SCRIPT),
    source, destination], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const path of ENGINE_CONTRACT_PATHS)
    assert.equal(readFileSync(join(destination, path), 'utf8'), path);
});

test('contract-copy CLI requires both source and destination', () => {
  for (const args of [[], ['source-only']]) {
    const result = spawnSync(process.execPath,
      [fileURLToPath(SCRIPT), ...args], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: copy-engine-contracts/);
  }
});

test('contract-copy library import has no CLI side effect without argv', () => {
  const result = spawnSync(process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(SCRIPT.href)});`],
    {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
