import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectFailure, fixtureRepo } from './fixture_repo.js';

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
};
const root = fixtureRepo('require-tests-', buildRoot);
const run = () => String(execFileSync(process.execPath, [SCRIPT], { cwd: root }));
const fail = () => expectFailure(process.execPath, [SCRIPT], { cwd: root });

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
  assert.match(fail(), /does not reach[\s\S]*nested\.test\.js/);
});

test('a recursive glob reaches nested tests', () => {
  mkdirSync(join(root, 'tests/sub'));
  writeFileSync(join(root, 'tests/sub/nested.test.js'), '');
  writePkg('tests/**/*.test.js');
  assert.match(run(), /2 files matched/);
});

test('a nested node_modules fails', () => {
  mkdirSync(join(root, 'tests/node_modules'));
  assert.match(fail(), /shadows the pinned root install/);
});

test('the root node_modules is allowed', () => {
  mkdirSync(join(root, 'node_modules'));
  assert.match(run(), /1 files matched/);
});
