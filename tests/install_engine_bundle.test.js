import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installEngineBundle, runtimePath } from '../scripts/install-engine-bundle.mjs';

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
  const root = mkdtempSync(join(tmpdir(), 'daydream-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle');
  const destination = join(root, 'daydream');
  const write = (base, path, text) => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  };
  write(destination, 'src/app/daydream.js', 'application');
  write(destination, 'generated/holosphere_wasm.sha', 'a'.repeat(40));
  write(destination, 'generated/shader/patterns/obsolete.shader.json', 'obsolete');
  write(destination, 'src/workbench/shader/patterns/v1/legacy.shader.json', 'legacy');
  write(destination, 'src/workbench/shader/patterns/digest_migration.v1v2.json', 'migration');
  write(destination, 'docs/screenshots/nested/obsolete.png', 'obsolete');
  write(destination, 'docs/screenshots/notes.txt', 'notes');
  const files = Object.fromEntries([
    'README.md', 'generated/holosphere_wasm.js', 'generated/holosphere_wasm.wasm', 'generated/holosphere_wasm.wasm.sha256',
    'generated/holosphere_wasm.toolchain', 'generated/pov_segment_map.json', 'generated/shader/shader_workbench.mjs',
    'generated/shader/sha256.mjs', 'generated/shader/engine_catalog.json', 'generated/shader/patterns/new.shader.json',
  ].map((path) => [path, `fresh ${path}`]));
  files['generated/holosphere_wasm.sha'] = 'b'.repeat(40);
  shape(files);
  const manifest = Object.entries(files).map(([path, text]) => {
    write(bundle, path, text);
    return `${createHash('sha256').update(text).digest('hex')}  ./${path}`;
  }).join('\n');
  write(bundle, 'holosphere_engine.sha256', manifest + '\n');
  return { bundle, destination, write };
}

test('install replaces stale assets and preserves consumer-owned files', (t) => {
  const { bundle, destination } = fixture(t);
  installEngineBundle(bundle, destination);
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.js'), 'utf8'),
    'fresh generated/holosphere_wasm.js');
  assert.equal(existsSync(join(destination, 'generated/shader/patterns/obsolete.shader.json')), false);
  assert.equal(existsSync(join(destination, 'docs/screenshots/nested/obsolete.png')), false);
  for (const path of ['src/workbench/shader/patterns/v1/legacy.shader.json',
    'src/workbench/shader/patterns/digest_migration.v1v2.json', 'docs/screenshots/notes.txt'])
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
  for (const path of ['src/workbench/shader/patterns/digest_migration.v1v2.json',
    'src/workbench/shader/patterns/v1/example.shader.json', '.git/config', 'engine/scripts/shader_workbench.mjs']) {
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

// The workflows hand the installer the consumer's own pin, so a bundle built
// from any other engine commit is refused whole.
test('a bundle from another engine commit than the declared pin is refused', (t) => {
  const { bundle, destination } = fixture(t);
  process.env.HOLOSPHERE_BUNDLE_PIN = 'c'.repeat(40);
  assert.throws(() => installEngineBundle(bundle, destination),
    new RegExp(`source pin differs from ${'c'.repeat(40)}`));
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.sha'), 'utf8'), 'a'.repeat(40));
  assert.equal(existsSync(join(destination, 'generated/holosphere_wasm.js')), false);
  assert.equal(existsSync(join(destination, 'generated/shader/patterns/obsolete.shader.json')), true);

  process.env.HOLOSPHERE_BUNDLE_PIN = 'b'.repeat(40);
  installEngineBundle(bundle, destination);
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

test('a bundle missing a required asset is refused before any destination changes', (t) => {
  const { bundle, destination } = fixture(t, (files) => {
    delete files['generated/holosphere_wasm.toolchain'];
  });
  assert.throws(() => installEngineBundle(bundle, destination),
    /Engine bundle is missing generated\/holosphere_wasm\.toolchain/);
  assert.equal(existsSync(join(destination, 'generated/holosphere_wasm.js')), false);
  assert.equal(existsSync(join(destination, 'generated/shader/patterns/obsolete.shader.json')), true);
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
  const { bundle, destination } = fixture(t);
  rmSync(join(destination, 'generated/holosphere_wasm.sha'));
  installEngineBundle(bundle, destination);
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.sha'), 'utf8'), 'b'.repeat(40));
  assert.equal(readFileSync(join(destination, 'generated/holosphere_wasm.js'), 'utf8'),
    'fresh generated/holosphere_wasm.js');
});

test('runtime mirrors exclude Daydream declarations, legacy fixtures and documents', () => {
  for (const path of ['generated/pov_segment_map.json', 'generated/shader/shader_workbench.mjs',
    'generated/shader/sha256.mjs', 'generated/shader/patterns/kaleidoscope_flowers.shader.json',
    'generated/shader/patterns/shaderball_migration.json']) assert.equal(runtimePath(path), true, path);
  for (const path of ['README.md', 'docs/screenshots/example.png',
    'generated/shader/shader_workbench.d.mts', 'generated/holosphere_wasm.d.ts',
    'src/workbench/shader/patterns/v1/example.shader.json', 'src/workbench/shader/patterns/digest_migration.v1v2.json',
    'src/workbench/shader/shader_documents.js']) assert.equal(runtimePath(path), false, path);
});
