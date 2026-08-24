import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedGitEnv } from './fixture_repo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, '../.githooks/pre-commit').replace(/\\/g, '/');
const SH = spawnSync('sh', ['-c', 'exit 0']).status === 0 ? 'sh' : null;
const SKIP = SH || process.env.DAYDREAM_HOOK_SH_REQUIRED
  ? false
  : 'no POSIX shell available';

test('pre-commit checks the staged tree', { skip: SKIP }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pre-commit-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...isolatedGitEnv(),
    GIT_CONFIG_GLOBAL: join(root, 'absent-config'),
    GIT_CONFIG_SYSTEM: join(root, 'absent-config'),
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, env });
  const runHook = () => {
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
    writeFileSync(eslint, '#!/bin/sh\ngrep -q BAD && exit 1\nexit 0\n');
    chmodSync(eslint, 0o755);

    writeFileSync(join(root, 'app.js'), 'BAD\n');
    git('add', 'app.js');
    writeFileSync(join(root, 'app.js'), 'GOOD working tree\n');
    assert.notEqual(runHook().status, 0);
  });
});
