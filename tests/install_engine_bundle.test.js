import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installEngineBundle } from '../scripts/install-engine-bundle.mjs';

function fixture(t) {
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
    'holosphere_wasm.toolchain', 'shader/shader_workbench.mjs', 'shader/sha256.mjs',
    'shader/engine_catalog.json', 'shader/patterns/new.shader.json',
  ].map((path) => [path, `fresh ${path}`]));
  files['holosphere_wasm.sha'] = 'b'.repeat(40);
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
