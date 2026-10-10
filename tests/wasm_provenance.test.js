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

test('deploy consumes one checksummed engine bundle at the module pin', () => {
  const workflow = text('.github/workflows/engine-bundle.yml');
  assert.match(workflow, /holosphere-engine-\$PIN/);
  assert.match(workflow, /head_sha=\$PIN&branch=master&per_page=10/);
  assert.match(workflow,
    /select\(\.event == "push" or \.event == "workflow_dispatch"\)/);
  assert.match(workflow, /sha256sum -c holosphere_engine\.sha256/);
  assert.match(workflow, /node scripts\/install-engine-bundle\.mjs engine-bundle/);
  assert.doesNotMatch(workflow, /cmp -s/);
  assert.doesNotMatch(workflow, /cmake --build|path: engine\s*$/m);
});

// A served Content-Type needs a live URL, so only the assets behind it can be
// checked ahead of the deployment; the presence check is that half.
test('deploy checks the engine assets it stages before it publishes them', () => {
  const workflow = text('.github/workflows/deploy.yml');
  const staged = workflow.indexOf('name: Verify the staged engine assets');
  const published = workflow.indexOf('uses: actions/deploy-pages@');
  const served = workflow.indexOf('name: Verify published engine MIME types');
  assert.ok(staged >= 0 && published >= 0 && served >= 0,
    `staged ${staged}, published ${published}, served ${served}`);
  assert.ok(staged < published, 'the staged assets are checked before publication');
  assert.ok(published < served, 'a served Content-Type exists only once published');
});

test('deploy stops waiting when the pinned engine run cannot publish', () => {
  const workflow = text('.github/workflows/engine-bundle.yml');
  assert.doesNotMatch(workflow, /\|\| true/);
  assert.match(workflow, /if \[ "\$run_status" = completed \]/);
  assert.match(workflow, /POV CI for \$PIN concluded \$run_conclusion/);
  assert.match(workflow, /published no verified engine bundle/);
});

test('the engine checkout can fetch a pin after master advances', () => {
  const workflow = text('.github/workflows/js-unit-suite.yml');
  const checkout = workflow.match(
    /- name: Checkout the pinned engine\n[\s\S]*?(?=\n\s{6}- )/,
  )?.[0] ?? '';
  assert.match(checkout, /fetch-depth: 1/);
  assert.match(checkout, /^\s+ref: \$\{\{ steps\.engine\.outputs\.pin \}\}$/m);
});

// The engine-parity and hook cases skip without their flags.
test('the JS unit suite arms the engine-parity and hook cases', () => {
  const workflow = text('.github/workflows/js-unit-suite.yml');
  const checkout = workflow.match(
    /- name: Checkout the pinned engine\n[\s\S]*?(?=\n\s{6}- )/,
  )?.[0] ?? '';
  assert.match(checkout, /^\s+path: engine$/m);
  const step = workflow.match(/- name: Test\n[\s\S]*?(?=\n\s{6}- |\s*$)/)?.[0] ?? '';
  assert.match(step, /^\s+HOLOSPHERE_ENGINE_REQUIRED: '1'$/m);
  assert.match(step, /^\s+DAYDREAM_HOOK_SH_REQUIRED: '1'$/m);
  assert.match(step, /^\s+run: npm test$/m);
});

test('CI checks source parity after installing the selected runtime', () => {
  const suite = text('.github/workflows/js-unit-suite.yml');
  const install = suite.indexOf('name: Install the verified engine package');
  const resolve = suite.indexOf('name: Resolve engine pin');
  const checkout = suite.indexOf('name: Checkout the pinned engine');
  assert.ok(install >= 0, 'verified package install step exists');
  assert.ok(resolve >= 0, 'engine pin resolution step exists');
  assert.ok(checkout >= 0, 'pinned engine checkout step exists');
  assert.ok(install < resolve);
  assert.ok(resolve < checkout);
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
