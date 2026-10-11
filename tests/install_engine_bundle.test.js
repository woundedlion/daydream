import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installEngineBundle, runtimePath, RUNTIME_PATHS } from '../scripts/install-engine-bundle.mjs';
import { scratchDir, writeEngineBundle, writeFileAt } from './helpers/fixture_repo.js';

const AMBIENT_BUNDLE_PIN = process.env.HOLOSPHERE_BUNDLE_PIN;
beforeEach(() => { delete process.env.HOLOSPHERE_BUNDLE_PIN; });
after(() => {
  if (AMBIENT_BUNDLE_PIN === undefined) delete process.env.HOLOSPHERE_BUNDLE_PIN;
  else process.env.HOLOSPHERE_BUNDLE_PIN = AMBIENT_BUNDLE_PIN;
});

/**
 * @param {import('node:test').TestContext} t - The case, for cleanup.
 * @param {(files: Object<string, string>) => void} [shape] - Alters the bundle's files before its manifest is written.
 * @returns {{bundle: string, destination: string, write: (base: string, path: string, text: string) => void}} The fixture paths and a writer.
 */
function fixture(t, shape = () => {}) {
  const root = scratchDir(t, 'daydream-bundle-');
  const bundle = join(root, 'bundle');
  const destination = join(root, 'daydream');
  const write = writeFileAt;
  write(destination, 'src/app/daydream.js', 'application');
  write(destination, 'generated/holosphere_wasm.sha', 'a'.repeat(40));
  write(destination, 'generated/shader/patterns/obsolete.shader.json', 'obsolete');
  write(destination, 'docs/screenshots/nested/obsolete.png', 'obsolete');
  write(destination, 'docs/screenshots/notes.txt', 'notes');
  const files = Object.fromEntries([
    ...RUNTIME_PATHS, 'generated/shader/patterns/new.shader.json',
  ].map((path) => [path, `fresh ${path}`]));
  files['generated/holosphere_wasm.sha'] = 'b'.repeat(40);
  shape(files);
  writeEngineBundle(bundle, files);
  return { bundle, destination, write };
}

test('install replaces stale assets and preserves consumer-owned files', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const { bundle, destination } = fixture(t);
  installEngineBundle(bundle, destination);
  assert.deepEqual(log.mock.calls.map(({ arguments: args }) => args),
    [[`Installed ${RUNTIME_PATHS.size + 1} engine assets (${'a'.repeat(40)} -> ${'b'.repeat(40)})`]]);
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.js'), 'utf8'),
    'fresh generated/holosphere_wasm.js');
  assert.equal(readFileSync(join(destination, 'generated/shader/composed_effect_roster.mjs'), 'utf8'),
    'fresh generated/shader/composed_effect_roster.mjs');
  assert.equal(existsSync(join(destination, 'generated/shader/patterns/obsolete.shader.json')), false);
  assert.equal(existsSync(join(destination, 'docs/screenshots/nested/obsolete.png')), false);
  for (const path of ['docs/screenshots/notes.txt', 'src/app/daydream.js'])
    assert.equal(existsSync(join(destination, path)), true, path);
});

test('corrupted generated documentation is rejected before any destination changes', (t) => {
  const { bundle, destination, write } = fixture(t);
  write(bundle, 'README.md', 'corrupted');
  assert.throws(() => installEngineBundle(bundle, destination), /checksum mismatch/);
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.sha'), 'utf8'), 'a'.repeat(40));
  assert.equal(existsSync(join(destination, 'generated/shader/patterns/obsolete.shader.json')), true);
});

test('bundle paths cannot overwrite assets outside the engine install set', (t) => {
  for (const path of ['src/app/daydream.js', '.git/config', 'engine/scripts/shader_workbench.mjs']) {
    const { bundle, destination } = fixture(t, (files) => { files[path] = 'unexpected'; });
    assert.throws(() => installEngineBundle(bundle, destination), /Engine bundle carries unexpected path/);
    assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.sha'), 'utf8'), 'a'.repeat(40));
  }
});

test('bundle paths cannot escape the destination', (t) => {
  const { bundle, destination, write } = fixture(t);
  write(bundle, 'holosphere_engine.sha256', `${'a'.repeat(64)}  ../escape\n`);
  assert.throws(() => installEngineBundle(bundle, destination), /Invalid engine bundle path/);
});

test('a bundle from another engine commit than the declared pin is refused', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const { bundle, destination } = fixture(t);
  process.env.HOLOSPHERE_BUNDLE_PIN = 'c'.repeat(40);
  assert.throws(() => installEngineBundle(bundle, destination),
    new RegExp(`source pin differs from ${'c'.repeat(40)}`));
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.sha'), 'utf8'), 'a'.repeat(40));
  assert.equal(existsSync(join(destination, 'generated/holosphere_wasm.js')), false);
  assert.equal(existsSync(join(destination, 'generated/shader/patterns/obsolete.shader.json')), true);

  process.env.HOLOSPHERE_BUNDLE_PIN = 'b'.repeat(40);
  installEngineBundle(bundle, destination);
  assert.deepEqual(log.mock.calls.map(({ arguments: args }) => args),
    [[`Installed ${RUNTIME_PATHS.size + 1} engine assets (${'a'.repeat(40)} -> ${'b'.repeat(40)})`]]);
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.sha'), 'utf8'), 'b'.repeat(40));
});

test('a bundle whose source pin is not one full commit is refused', (t) => {
  const { bundle, destination } = fixture(t, (files) => {
    files['generated/holosphere_wasm.sha'] = 'master\n';
  });
  assert.throws(() => installEngineBundle(bundle, destination),
    /Invalid engine bundle source pin/);
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.sha'), 'utf8'), 'a'.repeat(40));
  assert.equal(existsSync(join(destination, 'generated/holosphere_wasm.js')), false);
});



test('a destination without daydream.js is not a checkout', (t) => {
  const { bundle, destination } = fixture(t);
  rmSync(join(destination, 'src/app/daydream.js'));
  assert.throws(() => installEngineBundle(bundle, destination), /not a Daydream checkout/);
});

test('a publication failure restores the complete previous installation', (t) => {
  const { bundle, destination, write } = fixture(t, (files) => {
    files['docs/screenshots/blocked/new.png'] = 'new';
  });
  write(destination, 'docs/screenshots/blocked', 'consumer-owned');
  assert.throws(() => installEngineBundle(bundle, destination),
    { code: 'EEXIST', syscall: 'mkdir', path: join(destination, 'docs/screenshots/blocked') });
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.sha'), 'utf8'), 'a'.repeat(40));
  assert.equal(readFileSync(join(destination, 'generated/shader/patterns/obsolete.shader.json'), 'utf8'), 'obsolete');
  assert.equal(readFileSync(join(destination, 'docs/screenshots/blocked'), 'utf8'), 'consumer-owned');
  assert.equal(existsSync(join(destination, 'generated/holosphere_wasm.js')), false);
});

test('install initializes a checkout with no previous engine pin', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const { bundle, destination } = fixture(t);
  rmSync(join(destination, 'generated/holosphere_wasm.sha'));
  installEngineBundle(bundle, destination);
  assert.deepEqual(log.mock.calls.map(({ arguments: args }) => args),
    [[`Installed ${RUNTIME_PATHS.size + 1} engine assets (none -> ${'b'.repeat(40)})`]]);
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.sha'), 'utf8'), 'b'.repeat(40));
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.js'), 'utf8'),
    'fresh generated/holosphere_wasm.js');
});

test('runtime mirrors include engine documents but exclude Daydream sources', () => {
  for (const path of ['README.md', 'docs/screenshots/example.png', 'generated/pov_segment_map.json', 'generated/shader/shader_workbench.mjs',
    'generated/shader/composed_effect_roster.mjs',
    'generated/shader/sha256.mjs', 'generated/shader/patterns/kaleidoscope_flowers.shader.json',
    'generated/shader/patterns/catalog.json']) assert.equal(runtimePath(path), true, path);
  for (const path of ['generated/shader/shader_workbench.d.mts',
    'src/app/daydream.js',
    'src/workbench/shader/shader_documents.js']) assert.equal(runtimePath(path), false, path);
});





for (const missing of RUNTIME_PATHS) test(`a bundle missing ${missing} preserves its destination`, (t) => {
  const {bundle, destination} = fixture(t, (files) => { delete files[missing]; });
  assert.throws(() => installEngineBundle(bundle, destination),
    {message: `Engine bundle is missing ${missing}`});
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.sha'), 'utf8'), 'a'.repeat(40));
  assert.equal(existsSync(join(destination, 'generated/holosphere_wasm.js')), false);
  assert.equal(existsSync(join(destination, 'generated/shader/patterns/obsolete.shader.json')), true);
});
