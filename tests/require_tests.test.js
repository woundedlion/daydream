// @ts-nocheck
//
// scripts/require-tests.mjs is the `pretest` gate. Driven as a subprocess with
// cwd set to a temp fixture, which is where the script reads package.json and
// resolves the test glob from.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/require-tests.mjs');

const PKG = JSON.stringify({
  scripts: { test: 'node --test "tests/*.test.js"' },
}, null, 2);

let root;

/** Recreates the fixture repo: a package.json with a test glob and one matching test file. */
const buildRoot = () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'package.json'), PKG);
  writeFileSync(join(root, 'tests', 'sample.test.js'), '');
};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'require-tests-'));
});

beforeEach(buildRoot);

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Runs the script against the fixture, asserting it exits zero. */
const run = () => execFileSync(process.execPath, [SCRIPT], { cwd: root });

/** Runs the script against the fixture expecting failure and returns its stderr. */
const runExpectingFailure = () => {
  try {
    execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    return String(e.stderr);
  }
  assert.fail('the script was expected to exit non-zero');
};

/** Verifies a populated test dir with no stray install passes. */
test('a populated test dir with no stray install passes', () => {
  assert.doesNotThrow(run);
});

/** Verifies an emptied test dir is refused rather than reported as a green run. */
test('a test dir with no matching files fails', () => {
  rmSync(join(root, 'tests', 'sample.test.js'));
  const err = runExpectingFailure();
  assert.match(err, /No files matched tests\/\*\.test\.js/);
});

/** Verifies a node_modules directly under the test dir is refused. */
test('a node_modules in the test dir fails', () => {
  mkdirSync(join(root, 'tests', 'node_modules'));
  const err = runExpectingFailure();
  assert.match(err, /shadows the pinned root install/);
  assert.match(err, /tests\/node_modules/);
});

/** Verifies the scan reaches a node_modules nested below the test dir. */
test('a nested node_modules below the test dir fails', () => {
  mkdirSync(join(root, 'tests', 'fixtures', 'app', 'node_modules'), { recursive: true });
  const err = runExpectingFailure();
  assert.match(err, /tests\/fixtures\/app\/node_modules/);
});

/** Verifies the root install the test dir is supposed to resolve to is not flagged. */
test('the root node_modules is not flagged', () => {
  mkdirSync(join(root, 'node_modules', 'three'), { recursive: true });
  assert.doesNotThrow(run);
});
