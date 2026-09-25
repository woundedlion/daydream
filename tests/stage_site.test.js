import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installEngineBundle } from '../scripts/install-engine-bundle.mjs';
import { sitePaths, stageSite, verifiedEnginePaths } from '../scripts/stage-site.mjs';
import { isolatedGitEnv } from './fixture_repo.js';

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'stage-site-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'repo');
  const bundle = join(scratch, 'bundle');
  const site = join(scratch, 'site');
  const write = (base, path, value) => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), value); };
  write(root, 'daydream.js', 'export const app = true;\n');
  write(root, 'site_manifest.txt', '# source\n\ndaydream.js\nshader/patterns/old.shader.json\n');
  write(root, 'shader/patterns/old.shader.json', '{}');
  write(root, 'holosphere_wasm.sha', 'a'.repeat(40));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env: isolatedGitEnv(), encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '--', 'daydream.js', 'site_manifest.txt', 'shader/patterns/old.shader.json', 'holosphere_wasm.sha');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const pair = { daydream: git('rev-parse', 'HEAD'), holosphere: 'b'.repeat(40) };
  const files = Object.fromEntries(['README.md', 'holosphere_wasm.js', 'holosphere_wasm.wasm',
    'holosphere_wasm.wasm.sha256', 'holosphere_wasm.toolchain', 'pov_segment_map.json',
    'shader/shader_workbench.mjs', 'shader/sha256.mjs', 'shader/engine_catalog.json',
    'shader/patterns/new.shader.json', 'docs/screenshots/new.png'].map((path) => [path, 'new ' + path]));
  files['holosphere_wasm.sha'] = pair.holosphere;
  const manifest = Object.entries(files).map(([path, content]) => {
    write(bundle, path, content);
    return `${createHash('sha256').update(content).digest('hex')}  ${path}`;
  }).join('\n');
  write(bundle, 'holosphere_engine.sha256', manifest);
  installEngineBundle(bundle, root);
  return { root, bundle, site, pair, write, git, scratch };
}

test('site staging publishes verified additions, removes stale owned entries and records the actual pair', (t) => {
  const f = fixture(t);
  assert.ok(sitePaths(f.root).includes('shader/patterns/old.shader.json'));
  assert.ok(!sitePaths(f.root, f.bundle).includes('shader/patterns/old.shader.json'));
  stageSite(f.root, f.bundle, f.site, f.pair);
  assert.equal(existsSync(join(f.site, 'shader/patterns/old.shader.json')), false);
  assert.equal(readFileSync(join(f.site, 'shader/patterns/new.shader.json'), 'utf8'), 'new shader/patterns/new.shader.json');
  assert.equal(readFileSync(join(f.site, 'daydream.js'), 'utf8'), 'export const app = true;\n');
  assert.deepEqual(JSON.parse(readFileSync(join(f.site, 'deployment-pair.json'))), f.pair);
  assert.throws(() => stageSite(f.root, null, f.site, f.pair), /verified engine bundle/);
  for (const key of ['daydream', 'holosphere'])
    assert.throws(() => stageSite(f.root, f.bundle, f.site, { ...f.pair, [key]: 'c'.repeat(40) }), /selected sources/);
});

test('staging refuses modified frontend, manifest, or engine bytes', (t) => {
  const f = fixture(t);
  f.write(f.root, 'daydream.js', 'tampered');
  assert.throws(() => stageSite(f.root, f.bundle, f.site, f.pair), /Site source differs/);
  f.write(f.root, 'site_manifest.txt', 'daydream.js');
  assert.throws(() => stageSite(f.root, f.bundle, f.site, f.pair), /Site manifest differs/);
  f.write(f.root, 'holosphere_wasm.js', 'tampered');
  assert.throws(() => verifiedEnginePaths(f.root, f.bundle), /Installed engine asset differs/);
});

test('staging rejects unsafe committed paths and untracked source entries', (t) => {
  const f = fixture(t);
  for (const path of ['../escape.js', '/absolute.js', 'foo//bar.js', 'foo\\bar.js', './daydream.js']) {
    f.write(f.root, 'site_manifest.txt', path + '\n');
    f.git('add', '--', 'site_manifest.txt');
    f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'unsafe path');
    assert.throws(() => stageSite(f.root, f.bundle, f.site, { ...f.pair, daydream: f.git('rev-parse', 'HEAD') }), /Invalid site path/);
  }
  f.write(f.root, 'site_manifest.txt', 'private.js\n');
  f.write(f.root, 'private.js', 'private');
  f.git('add', '--', 'site_manifest.txt');
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'untracked entry');
  assert.throws(() => stageSite(f.root, f.bundle, f.site, { ...f.pair, daydream: f.git('rev-parse', 'HEAD') }), /not.*HEAD|exists on disk/i);
});

test('staging rejects symlink directories escaping the selected checkout', (t) => {
  const f = fixture(t);
  const outside = join(f.scratch, 'outside');
  f.write(outside, 'foreign.js', 'foreign');
  symlinkSync(outside, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  f.write(f.root, 'site_manifest.txt', 'linked/foreign.js\n');
  f.git('add', '--', 'site_manifest.txt');
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'linked entry');
  assert.throws(() => stageSite(f.root, f.bundle, f.site, { ...f.pair, daydream: f.git('rev-parse', 'HEAD') }), /regular repository file/);
});

test('stage CLI uses the verified bundle and pair file', (t) => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('../scripts/stage-site.mjs', import.meta.url));
  f.write(f.root, 'pair.json', JSON.stringify(f.pair));
  const env = isolatedGitEnv();
  delete env.HOLOSPHERE_BUNDLE_PIN;
  const result = spawnSync(process.execPath, [cli, f.bundle, f.site, 'pair.json'], { cwd: f.root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(spawnSync(process.execPath, [cli], { cwd: f.root, env }).status, 1);
});
