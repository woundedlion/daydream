import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED_PATHS } from '../scripts/install-engine-bundle.mjs';
import { isolatedGitEnv } from './fixture_repo.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

test('source manifest checks accept absent generated assets but reject untracked frontend', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'daydream-source-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = isolatedGitEnv();
  delete env.ENGINE_BUNDLE_DIR;
  delete env.NODE_TEST_CONTEXT;
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  git('clone', '--quiet', '--shared', '--no-checkout', REPO, root);
  git('-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', 'HEAD');
  for (const path of ['tests/site_manifest.test.js', 'scripts/install-engine-bundle.mjs'])
    copyFileSync(join(REPO, path), join(root, path));
  git('rm', '--cached', '--ignore-unmatch', '--', ...GENERATED_PATHS);
  for (const path of GENERATED_PATHS) rmSync(join(root, path), { force: true });
  const run = () => spawnSync(process.execPath, ['--test', 'tests/site_manifest.test.js'], {
    cwd: root, env, encoding: 'utf8',
  });
  const absent = run();
  assert.equal(absent.status, 0, absent.stdout + absent.stderr);

  appendFileSync(join(root, 'site_manifest.txt'), '\nprivate-frontend.js\n');
  appendFileSync(join(root, '.gitignore'), '\nprivate-frontend.js\n');
  writeFileSync(join(root, 'private-frontend.js'), 'export const secret = 1;\n');
  const untracked = run();
  assert.notEqual(untracked.status, 0);
  assert.match(untracked.stdout + untracked.stderr, /entries git does not track/);
});
