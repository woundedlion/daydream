import { engineRoot, engineMissing, engineSkip } from './helpers/engine_checkout.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const text = (path) => readFileSync(resolve(REPO, path), 'utf8').replaceAll('\r\n', '\n');
const sha256 = (path) => createHash('sha256').update(readFileSync(resolve(REPO, path))).digest('hex');


const enginePin = text('generated/holosphere_wasm.sha').trim();
const committed = (root, path, revision = enginePin) => execFileSync(
  'git', ['-C', root, 'show', `${revision}:${path}`], { encoding: 'buffer' });

test('the installed WASM artifacts match their recorded hashes', () => {
  const entries = text('generated/holosphere_wasm.wasm.sha256')
    .trim().split(/\r?\n/)
    .map((line) => line.match(/^([0-9a-f]{64})\s+\*?(.+)$/));
  for (const entry of entries) assert.ok(entry, 'each checksum line has sha256sum syntax');
  assert.deepEqual(entries.map((entry) => entry[2]).sort(),
    ['holosphere_wasm.js', 'holosphere_wasm.wasm'],
    'the manifest names the glue and the binary and nothing else');
  for (const entry of entries) assert.equal(sha256(`generated/${entry[2]}`), entry[1], entry[2]);
});

test('the engine pin is one clean full commit', () => {
  assert.match(text('generated/holosphere_wasm.sha').trim(), /^[0-9a-f]{40}$/);
});

test('the toolchain record describes a release module', () => {
  const fields = Object.fromEntries(
    text('generated/holosphere_wasm.toolchain').trim().split(/\r?\n/).map((line) => line.split(/\s+/, 2)),
  );
  assert.match(fields.emsdk, /^\d+\.\d+\.\d+$/);
  assert.equal(fields.build_type, 'Release');
  assert.equal(fields.dev_bindings, 'OFF');
});

test('the installed operator catalog describes the installed WASM', async () => {
  const { default: createModule } = await import('../generated/holosphere_wasm.js');
  const module = await createModule();
  assert.deepEqual(JSON.parse(text('generated/shader/engine_catalog.json')),
    JSON.parse(module.ShaderChainBindings.getShaderChainCatalog()));
});

for (const name of ['shader_workbench.mjs', 'sha256.mjs', 'composed_effect_roster.mjs']) {
  test(`shader mirror ${name} matches the pinned engine`, { skip: engineSkip }, () => {
    assert.ok(engineRoot, engineMissing);
    assert.equal(text(`generated/shader/${name}`),
      committed(engineRoot, `scripts/${name}`).toString('utf8').replaceAll('\r\n', '\n'));
  });
}

test('pattern mirrors match the pinned engine in both content and membership', { skip: engineSkip }, () => {
  assert.ok(engineRoot, engineMissing);
  const mirrored = (name) => name.endsWith('.shader.json') || name === 'catalog.json';
  const catalog = JSON.parse(committed(engineRoot, 'patterns/catalog.json').toString('utf8'));
  const expected = ['catalog.json', ...Object.values(catalog.source_documents)].sort();
  const actual = readdirSync(resolve(REPO, 'generated/shader/patterns')).filter(mirrored).sort();
  assert.deepEqual(actual, expected);
  for (const name of expected) {
    assert.equal(text(`generated/shader/patterns/${name}`),
      committed(engineRoot, `patterns/${name}`).toString('utf8').replaceAll('\r\n', '\n'), name);
  }
});
