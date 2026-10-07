import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSh, isolatedGitEnv } from './helpers/fixture_repo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, '../.githooks/pre-commit').replace(/\\/g, '/');
const SH = findSh();
const MISSING_SH = 'no POSIX shell available';
const SKIP = SH || process.env.DAYDREAM_HOOK_SH_REQUIRED
  ? false
  : MISSING_SH;

test('pre-commit checks the staged tree', { skip: SKIP }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pre-commit-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = isolatedGitEnv();
  const git = (...args) => execFileSync('git', args, { cwd: root, env });
  const runHook = () => {
    assert.ok(SH, MISSING_SH);
    const hookEnv = {
      ...env,
      GIT_DIR: join(root, '.git'),
      GIT_WORK_TREE: root,
    };
    delete hookEnv.NODE_TEST_CONTEXT;
    return spawnSync(SH, [HOOK], {
      cwd: root,
      env: hookEnv,
      encoding: 'utf8',
    });
  };

  git('init', '-q');
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'README.md'), 'valid\n');
  writeFileSync(join(root, 'tests', 'site_manifest.test.js'), [
    "const { test } = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { readFileSync } = require('node:fs');",
    "const { resolve } = require('node:path');",
    "test('documentation', () => {",
    "  assert.ok(!readFileSync(resolve(__dirname, '../README.md'), 'utf8').includes('BROKEN'));",
    '});',
    '',
  ].join('\n'));
  git('add', 'README.md', 'tests/site_manifest.test.js');
  git('commit', '-q', '-m', 'base');

  await t.test('documentation reads the index', () => {
    writeFileSync(join(root, 'README.md'), 'BROKEN\n');
    git('add', 'README.md');
    writeFileSync(join(root, 'README.md'), 'valid working tree\n');
    const stagedBroken = runHook();
    assert.notEqual(stagedBroken.status, 0,
      stagedBroken.stdout + stagedBroken.stderr);

    git('add', 'README.md');
    writeFileSync(join(root, 'README.md'), 'BROKEN working tree\n');
    const stagedValid = runHook();
    assert.equal(stagedValid.status, 0,
      stagedValid.stdout + stagedValid.stderr);
  });

  await t.test('whitespace errors fail', () => {
    writeFileSync(join(root, 'README.md'), 'trailing  \n');
    git('add', 'README.md');
    const run = runHook();
    assert.notEqual(run.status, 0);
    assert.match(run.stdout + run.stderr, /staged whitespace errors/);
  });

  await t.test('eslint reads the index', () => {
    writeFileSync(join(root, 'app.js'), 'GOOD\n');
    git('add', 'app.js');
    git('commit', '-q', '-m', 'source');
    const bin = join(root, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    const eslint = join(bin, 'eslint');
    writeFileSync(eslint, '#!/bin/sh\nif grep -q BAD; then echo staged-eslint-failed >&2; exit 1; fi\nexit 0\n');
    chmodSync(eslint, 0o755);

    writeFileSync(join(root, 'app.js'), 'BAD\n');
    git('add', 'app.js');
    writeFileSync(join(root, 'app.js'), 'GOOD working tree\n');
    const rejected = runHook();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout + rejected.stderr, /staged-eslint-failed/);
    git('add', 'app.js');
    writeFileSync(join(root, 'app.js'), 'BAD working tree\n');
    const accepted = runHook();
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.doesNotMatch(accepted.stdout + accepted.stderr, /staged-eslint-failed/);
  });

  await t.test('staged JavaScript deletion does not invoke eslint', () => {
    const eslint = join(root, 'node_modules', '.bin', 'eslint');
    writeFileSync(eslint, '#!/bin/sh\necho eslint-called >&2\nexit 1\n');
    chmodSync(eslint, 0o755);
    git('rm', '-f', 'app.js');
    const deleted = runHook();
    assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
    assert.doesNotMatch(deleted.stdout + deleted.stderr, /eslint-called/);
  });

  await t.test('JavaScript edits require the pinned eslint install', () => {
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    writeFileSync(join(root, 'new.js'), 'GOOD\n');
    git('add', 'new.js');
    const missing = runHook();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout + missing.stderr, /node_modules is missing; run npm ci/);
  });
});

const LS_FILES_MANIFEST = [
  "const { test } = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const { execFileSync } = require('node:child_process');",
  "const { resolve } = require('node:path');",
  "const repo = resolve(__dirname, '..');",
  "const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });",
  "test('tracked files match the staged tree', () => {",
  "  assert.deepEqual(git('ls-files').split('\\n').filter(Boolean),",
  "    ['README.md', 'staged.txt', 'tests/site_manifest.test.js']);",
  "  const [, blob] = git('ls-files', '-s', 'staged.txt').split(/\\s+/);",
  "  assert.equal(git('hash-object', 'staged.txt').trim(), blob);",
  '});',
  '',
].join('\n');

for (const layout of ['standard index', 'split index', 'linked worktree with split index']) {
  test(`pre-commit snapshot index is readable: ${layout}`, { skip: SKIP }, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pre-commit-index-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = isolatedGitEnv();
    delete env.NODE_TEST_CONTEXT;
    const source = join(root, 'source');
    const git = (cwd, ...args) =>
      execFileSync('git', args, { cwd, env, encoding: 'utf8' });

    mkdirSync(join(source, 'tests'), { recursive: true });
    git(source, 'init', '-q');
    if (layout !== 'standard index') git(source, 'config', 'core.splitIndex', 'true');
    writeFileSync(join(source, 'README.md'), 'valid\n');
    writeFileSync(join(source, 'tests', 'site_manifest.test.js'), LS_FILES_MANIFEST);
    git(source, 'add', 'README.md', 'tests/site_manifest.test.js');
    git(source, 'commit', '-q', '-m', 'base');
    git(source, 'config', 'core.hooksPath', dirname(HOOK));

    let checkout = source;
    if (layout.startsWith('linked worktree')) {
      checkout = join(root, 'linked');
      git(source, 'worktree', 'add', '-q', checkout);
    }
    writeFileSync(join(checkout, 'staged.txt'), 'staged\n');
    git(checkout, 'add', 'staged.txt');
    writeFileSync(join(checkout, 'staged.txt'), 'working tree\n');
    if (layout !== 'standard index') {
      const gitDir = git(checkout, 'rev-parse', '--absolute-git-dir').trim();
      assert.ok(readdirSync(gitDir).some((name) => name.startsWith('sharedindex.')));
    }
    const indexBefore = git(checkout, 'ls-files', '-s');

    const commit = spawnSync('git', ['commit', '-q', '-m', 'staged'], {
      cwd: checkout,
      env,
      encoding: 'utf8',
    });
    assert.equal(commit.status, 0, commit.stdout + commit.stderr);
    assert.equal(git(checkout, 'ls-files', '-s'), indexBefore);
  });
}
