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

let root;

/**
 * Writes the fixture package.json, merging overrides over a non-recursive glob
 * and a floor of one.
 * @param {Object} [overrides] - Fields replacing the defaults.
 */
const writePkg = (overrides = {}) => {
  const pkg = {
    scripts: { test: 'node --test "tests/*.test.js"' },
    testFileFloor: 1,
    ...overrides,
  };
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
};

/** Recreates the fixture repo: a package.json with a test glob and one matching test file. */
const buildRoot = () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writePkg();
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
  assert.match(String(run()), /require-tests: 1 files matched/);
});

/** Verifies an emptied test dir is refused rather than reported as a green run. */
test('a test dir with no matching files fails', () => {
  rmSync(join(root, 'tests', 'sample.test.js'));
  const err = runExpectingFailure();
  assert.match(err, /No files matched tests\/\*\.test\.js/);
});

/** Verifies a surviving file is not enough once the committed floor is higher. */
test('a match count below the committed floor fails', () => {
  writePkg({ testFileFloor: 2 });
  const err = runExpectingFailure();
  assert.match(err, /Only 1 files matched/);
  assert.match(err, /floor is 2/);
});

/** Verifies the floor cannot be dropped to disable the ratchet. */
test('a missing floor fails', () => {
  writePkg({ testFileFloor: undefined });
  const err = runExpectingFailure();
  assert.match(err, /testFileFloor/);
});

/** Verifies a test file the non-recursive glob cannot reach is refused. */
test('a test file below the glob depth fails', () => {
  mkdirSync(join(root, 'tests', 'sub'));
  writeFileSync(join(root, 'tests', 'sub', 'nested.test.js'), '');
  const err = runExpectingFailure();
  assert.match(err, /does not reach/);
  assert.match(err, /tests\/sub\/nested\.test\.js/);
});

/** Verifies a root-level test outside the tests/ glob is refused. */
test('a root-level test file fails as unreachable', () => {
  writeFileSync(join(root, 'stray.test.js'), '');
  const err = runExpectingFailure();
  assert.match(err, /does not reach/);
  assert.match(err, /stray\.test\.js/);
});

/** Verifies a test file in a directory beside the test dir is refused. */
test('a test file in a sibling directory fails as unreachable', () => {
  mkdirSync(join(root, 'tools', 'nested'), { recursive: true });
  writeFileSync(join(root, 'tools', 'nested', 'stray.test.js'), '');
  const err = runExpectingFailure();
  assert.match(err, /does not reach/);
  assert.match(err, /tools\/nested\/stray\.test\.js/);
});

/** Verifies the sweep does not enter git metadata or the vendored drops. */
test('test files under skipped directories are not flagged', () => {
  for (const dir of ['.git', 'three.js', 'vendor', 'node_modules']) {
    mkdirSync(join(root, dir, 'nested'), { recursive: true });
    writeFileSync(join(root, dir, 'nested', 'vendored.test.js'), '');
  }
  assert.doesNotThrow(run);
});

/** Verifies a `**` glob counts the nested file instead of refusing it. */
test('a recursive glob reaches a nested test file', () => {
  mkdirSync(join(root, 'tests', 'sub'));
  writeFileSync(join(root, 'tests', 'sub', 'nested.test.js'), '');
  writePkg({
    scripts: { test: 'node --test "tests/**/*.test.js"' },
    testFileFloor: 2,
  });
  assert.doesNotThrow(run);
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
