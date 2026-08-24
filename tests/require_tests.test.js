import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expectFailure,
  fixtureRepo,
  isolatedGitEnv,
} from './fixture_repo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/require-tests.mjs');
const writePkg = (glob = 'tests/*.test.js') => writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({ scripts: { test: `node --test "${glob}"` } }),
);
const buildRoot = () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writePkg();
  writeFileSync(join(root, 'tests/sample.test.js'), '');
  git('init', '-q');
  git('add', 'package.json', 'tests/sample.test.js');
};
const root = fixtureRepo('require-tests-', buildRoot);
const env = {
  ...isolatedGitEnv(),
  GIT_CONFIG_GLOBAL: join(root, 'absent-config'),
  GIT_CONFIG_SYSTEM: join(root, 'absent-config'),
};
const git = (...args) => execFileSync('git', args, { cwd: root, env });
const run = () => String(execFileSync(
  process.execPath, [SCRIPT], { cwd: root, env }));
const fail = () => expectFailure(
  process.execPath, [SCRIPT], { cwd: root, env });

test('a populated test directory passes', () => {
  assert.match(run(), /1 files matched/);
});

test('an empty test glob fails', () => {
  rmSync(join(root, 'tests/sample.test.js'));
  assert.match(fail(), /No files matched/);
});

test('a test below a non-recursive glob fails', () => {
  mkdirSync(join(root, 'tests/sub'));
  writeFileSync(join(root, 'tests/sub/nested.test.js'), '');
  git('add', 'tests/sub/nested.test.js');
  assert.match(fail(), /does not reach[\s\S]*nested\.test\.js/);
});

test('a recursive glob reaches nested tests', () => {
  mkdirSync(join(root, 'tests/sub'));
  writeFileSync(join(root, 'tests/sub/nested.test.js'), '');
  writePkg('tests/**/*.test.js');
  git('add', 'tests/sub/nested.test.js');
  assert.match(run(), /2 files matched/);
});

test('test and spec files outside the runner suffix fail', () => {
  writeFileSync(join(root, 'tests/webgl.test.mjs'), '');
  writeFileSync(join(root, 'tests/helper.spec.js'), '');
  git('add', 'tests/webgl.test.mjs', 'tests/helper.spec.js');

  const error = fail();
  assert.match(error, /does not reach[\s\S]*helper\.spec\.js/);
  assert.match(error, /does not reach[\s\S]*webgl\.test\.mjs/);
});

test('additional runner globs make other test shapes reachable', () => {
  writeFileSync(join(root, 'tests/webgl.test.mjs'), '');
  writeFileSync(join(root, 'tests/helper.spec.js'), '');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node --test "tests/*.test.js" "tests/*.test.mjs" "tests/*.spec.js"',
    },
  }));
  git('add', 'package.json', 'tests/webgl.test.mjs', 'tests/helper.spec.js');
  assert.match(run(), /3 files matched/);
});

test('conventional test files in excluded trees stay excluded', () => {
  mkdirSync(join(root, 'vendor'));
  writeFileSync(join(root, 'vendor/upstream.spec.js'), '');
  git('add', 'vendor/upstream.spec.js');
  assert.match(run(), /1 files matched/);
});

test('a nested node_modules fails', () => {
  mkdirSync(join(root, 'tests/node_modules'));
  assert.match(fail(), /shadows the pinned root install/);
});

test('the root node_modules is allowed', () => {
  mkdirSync(join(root, 'node_modules'));
  assert.match(run(), /1 files matched/);
});
