import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installEngineBundle } from '../scripts/install-engine-bundle.mjs';

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
  write(destination, 'daydream.js', 'application');
  write(destination, 'holosphere_wasm.sha', 'a'.repeat(40));
  write(destination, 'shader/patterns/obsolete.shader.json', 'obsolete');
  write(destination, 'shader/patterns/v1/legacy.shader.json', 'legacy');
  write(destination, 'shader/patterns/digest_migration.v1v2.json', 'migration');
  write(destination, 'docs/screenshots/nested/obsolete.png', 'obsolete');
  write(destination, 'docs/screenshots/notes.txt', 'notes');
  const files = Object.fromEntries([
    'README.md', 'holosphere_wasm.js', 'holosphere_wasm.wasm', 'holosphere_wasm.wasm.sha256',
    'holosphere_wasm.toolchain', 'pov_segment_map.json', 'shader/shader_workbench.mjs',
    'shader/sha256.mjs', 'shader/engine_catalog.json', 'shader/patterns/new.shader.json',
  ].map((path) => [path, `fresh ${path}`]));
  files['holosphere_wasm.sha'] = 'b'.repeat(40);
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
  assert.equal(readFileSync(join(destination, 'holosphere_wasm.js'), 'utf8'),
    'fresh holosphere_wasm.js');
  assert.equal(existsSync(join(destination, 'shader/patterns/obsolete.shader.json')), false);
  assert.equal(existsSync(join(destination, 'docs/screenshots/nested/obsolete.png')), false);
  for (const path of ['shader/patterns/v1/legacy.shader.json',
    'shader/patterns/digest_migration.v1v2.json', 'docs/screenshots/notes.txt'])
    assert.equal(existsSync(join(destination, path)), true, path);
});

test('corrupted generated documentation is rejected before any destination changes', (t) => {
  const { bundle, destination, write } = fixture(t);
  write(bundle, 'README.md', 'corrupted');
  assert.throws(() => installEngineBundle(bundle, destination), /checksum mismatch/);
  assert.equal(readFileSync(join(destination, 'holosphere_wasm.sha'), 'utf8'), 'a'.repeat(40));
  assert.equal(existsSync(join(destination, 'shader/patterns/obsolete.shader.json')), true);
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
  t.after(() => { delete process.env.HOLOSPHERE_BUNDLE_PIN; });
  process.env.HOLOSPHERE_BUNDLE_PIN = 'c'.repeat(40);
  assert.throws(() => installEngineBundle(bundle, destination),
    new RegExp(`source pin differs from ${'c'.repeat(40)}`));
  assert.equal(readFileSync(join(destination, 'holosphere_wasm.sha'), 'utf8'), 'a'.repeat(40));
  assert.equal(existsSync(join(destination, 'holosphere_wasm.js')), false);
  assert.equal(existsSync(join(destination, 'shader/patterns/obsolete.shader.json')), true);

  process.env.HOLOSPHERE_BUNDLE_PIN = 'b'.repeat(40);
  installEngineBundle(bundle, destination);
  assert.equal(readFileSync(join(destination, 'holosphere_wasm.sha'), 'utf8'), 'b'.repeat(40));
});

test('a bundle whose source pin is not one full commit is refused', (t) => {
  const { bundle, destination } = fixture(t, (files) => {
    files['holosphere_wasm.sha'] = 'master\n';
  });
  assert.throws(() => installEngineBundle(bundle, destination),
    /Invalid engine bundle source pin/);
  assert.equal(readFileSync(join(destination, 'holosphere_wasm.sha'), 'utf8'), 'a'.repeat(40));
  assert.equal(existsSync(join(destination, 'holosphere_wasm.js')), false);
});

test('a bundle missing a required asset is refused before any destination changes', (t) => {
  const { bundle, destination } = fixture(t, (files) => {
    delete files['holosphere_wasm.toolchain'];
  });
  assert.throws(() => installEngineBundle(bundle, destination),
    /Engine bundle is missing holosphere_wasm\.toolchain/);
  assert.equal(existsSync(join(destination, 'holosphere_wasm.js')), false);
  assert.equal(existsSync(join(destination, 'shader/patterns/obsolete.shader.json')), true);
});

test('a destination without daydream.js is not a checkout', (t) => {
  const { bundle, destination } = fixture(t);
  rmSync(join(destination, 'daydream.js'));
  assert.throws(() => installEngineBundle(bundle, destination), /not a Daydream checkout/);
});
