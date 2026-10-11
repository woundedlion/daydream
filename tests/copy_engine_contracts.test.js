import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyEngineContracts } from '../scripts/copy-engine-contracts.mjs';
import { ENGINE_CONTRACT_PATHS } from '../scripts/install-engine-bundle.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'engine-contract-copy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
