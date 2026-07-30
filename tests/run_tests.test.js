// @ts-nocheck
//
// scripts/run-tests.mjs is the `test` script: it runs the suite and gates the
// total the runner reports. Driven as a subprocess with cwd set to a temp
// fixture holding its own package.json and test files, so the counts under test
// are the fixture's and not this suite's.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/run-tests.mjs');
const PATTERN = 'tests/*.test.js';

let root;

/**
 * Writes the fixture package.json, merging overrides over a floor of one.
 * @param {Object} [overrides] - Fields replacing the defaults.
 */
const writePkg = (overrides = {}) => {
  const pkg = { type: 'module', testCountFloor: 1, ...overrides };
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
};

/**
 * Fixture test file source declaring `count` passing cases.
 * @param {number} count - Number of cases to declare.
 * @returns {string} Module source.
 */
const passing = (count) =>
  ["import { test } from 'node:test';"]
    .concat(Array.from({ length: count }, (_, i) => `test('case ${i}', () => {});`))
    .join('\n');

/** Recreates the fixture repo: a package.json and two test files, three cases total. */
const buildRoot = () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writePkg();
  writeFileSync(join(root, 'tests', 'a.test.js'), passing(2));
  writeFileSync(join(root, 'tests', 'b.test.js'), passing(1));
};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'run-tests-'));
});

beforeEach(buildRoot);

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// This suite runs inside `node --test`, which marks its children with
// NODE_TEST_CONTEXT; a runner that inherits it refuses to run files at all.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

/** Runs the script against the fixture, returning its stdout. */
const run = (...args) =>
  String(
    execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );

/** Runs the script against the fixture expecting failure and returns its stderr. */
const runExpectingFailure = (...args) => {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    return String(e.stderr);
  }
  assert.fail('the script was expected to exit non-zero');
};

/**
 * The total the runner reports for the intact fixture. Measured rather than
 * hardcoded: whether a test file itself counts as a case is the runner's
 * convention, not this gate's.
 * @returns {number} Reported passing total.
 */
const intactTotal = () => {
  const total = Number(run(PATTERN).match(/run-tests: (\d+) tests passed/)?.[1]);
  assert.ok(total >= 3, `expected at least the three fixture cases, got ${total}`);
  return total;
};

/** Verifies a suite meeting the committed total passes and reports the total. */
test('a suite that meets the committed total passes', () => {
  writePkg({ testCountFloor: intactTotal() });
  assert.match(run(PATTERN), /run-tests: \d+ tests passed \(committed floor \d+\)/);
});

/** Verifies gutting a test file fails the run instead of reporting green. */
test('a test file gutted to a comment fails the total', () => {
  const total = intactTotal();
  writeFileSync(join(root, 'tests', 'a.test.js'), '// TODO: re-enable\n');
  writePkg({ testCountFloor: total });
  const err = runExpectingFailure(PATTERN);
  const reported = Number(err.match(/Only (\d+) tests passed/)?.[1]);
  assert.ok(
    reported < total,
    `the gutted run reported ${reported}, not below ${total}`,
  );
  assert.match(err, new RegExp(`committed floor is ${total}`));
});

/** Verifies the floor cannot be dropped to disable the ratchet. */
test('a missing count floor fails', () => {
  writePkg({ testCountFloor: undefined });
  assert.match(runExpectingFailure(PATTERN), /testCountFloor/);
});

/** Verifies a non-integer floor is refused rather than compared loosely. */
test('a non-integer count floor fails', () => {
  writePkg({ testCountFloor: '3' });
  assert.match(runExpectingFailure(PATTERN), /testCountFloor/);
});

/** Verifies a pattern-less invocation is refused instead of walking the tree. */
test('no test pattern fails', () => {
  assert.match(runExpectingFailure(), /test file patterns/);
});

/** Verifies a failing case still fails the run when the total clears the floor. */
test('a failing test fails the run', () => {
  writeFileSync(
    join(root, 'tests', 'c.test.js'),
    "import { test } from 'node:test';\ntest('boom', () => { throw new Error('boom'); });\n",
  );
  runExpectingFailure(PATTERN);
});
