//
// scripts/run-tests.mjs is the `test` script: it runs the suite and gates both
// the case total the runner reports and the per-file assertion counts
// scripts/count-assertions.mjs measures. Driven as a subprocess with cwd set to
// a temp fixture holding its own package.json, floors and test files, so the
// counts under test are the fixture's and not this suite's.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/run-tests.mjs');
const PATTERN = 'tests/*.test.js';
const FLOORS = 'tests/assertion-floors.json';
/** Fixture test files: cases declared per file, assertions run per case. */
const FILES = {
  'a.test.js': { cases: 2, asserts: 3 },
  'b.test.js': { cases: 1, asserts: 2 },
};

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
 * Fixture test file source declaring `cases` passing cases.
 * @param {number} cases - Number of cases to declare.
 * @param {number} asserts - Assertions each case runs.
 * @returns {string} Module source.
 */
const passing = (cases, asserts) =>
  [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
  ]
    .concat(
      Array.from(
        { length: cases },
        (_, i) =>
          `test('case ${i}', () => {${' assert.ok(true);'.repeat(asserts)} });`,
      ),
    )
    .join('\n');

/**
 * Writes the fixture assertion floors, merging overrides over the counts FILES
 * describes. An override of undefined drops the file's floor.
 * @param {Object} [overrides] - Floors replacing the defaults.
 */
const writeFloors = (overrides = {}) => {
  const floors = {};
  for (const [name, { cases, asserts }] of Object.entries(FILES))
    floors[`tests/${name}`] = cases * asserts;
  writeFileSync(
    join(root, FLOORS),
    JSON.stringify({ ...floors, ...overrides }, null, 2),
  );
};

/** Reads the fixture's committed floors. */
const readFloors = () => JSON.parse(readFileSync(join(root, FLOORS), 'utf8'));

/** Recreates the fixture repo: package.json, floors, and two test files. */
const buildRoot = () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writePkg();
  writeFloors();
  for (const [name, { cases, asserts }] of Object.entries(FILES))
    writeFileSync(join(root, 'tests', name), passing(cases, asserts));
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

/** Verifies a suite meeting both committed floors passes and reports them. */
test('a suite that meets the committed floors passes', () => {
  writePkg({ testCountFloor: intactTotal() });
  assert.match(
    run(PATTERN),
    /run-tests: \d+ tests passed \(committed floor \d+\), 8 assertions across 2 files/,
  );
});

/** Verifies gutting a test file fails the total. */
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

/**
 * Verifies emptying every case body while leaving the shells fails — the hole
 * the case total cannot see, since every shell still scores as a passing test.
 */
test('cases gutted to empty bodies fail the assertion floors', () => {
  writePkg({ testCountFloor: intactTotal() });
  for (const [name, { cases }] of Object.entries(FILES))
    writeFileSync(join(root, 'tests', name), passing(cases, 0));
  const err = runExpectingFailure(PATTERN);
  assert.doesNotMatch(err, /tests passed/);
  assert.match(err, /tests\/a\.test\.js: 0 ran, floor 6/);
  assert.match(err, /tests\/b\.test\.js: 0 ran, floor 2/);
});

/** Verifies deleting a test file reports zero against its committed floor. */
test('a deleted test file falls below its assertion floor', () => {
  rmSync(join(root, 'tests', 'a.test.js'));
  assert.match(
    runExpectingFailure(PATTERN),
    /tests\/a\.test\.js: 0 ran, floor 6/,
  );
});

/** Verifies a test file with no committed floor is refused, not defaulted. */
test('a test file with no committed floor fails', () => {
  writeFileSync(join(root, 'tests', 'c.test.js'), passing(1, 1));
  assert.match(
    runExpectingFailure(PATTERN),
    /no assertion floor committed for:\n {2}tests\/c\.test\.js: 1/,
  );
});

/** Verifies a missing floors file fails rather than leaving the ratchet off. */
test('a missing floors file fails', () => {
  rmSync(join(root, FLOORS));
  assert.match(
    runExpectingFailure(PATTERN),
    /assertion-floors\.json is missing/,
  );
});

/** Verifies a non-integer floor is refused rather than compared loosely. */
test('a non-integer assertion floor fails', () => {
  writeFloors({ 'tests/a.test.js': '6' });
  assert.match(runExpectingFailure(PATTERN), /non-negative integers/);
});

/** Verifies re-measuring writes the counts actually run, one file at a time. */
test('--update-floors writes the measured counts', () => {
  writeFloors({ 'tests/a.test.js': 999 });
  assert.match(run('--update-floors', PATTERN), /wrote 2 floors/);
  assert.deepEqual(readFloors(), {
    'tests/a.test.js': 6,
    'tests/b.test.js': 2,
  });
  run(PATTERN);
});

/** Verifies an empty test body is measured as no assertions at all. */
test('an empty test contributes no assertions', () => {
  for (const [name, { cases }] of Object.entries(FILES))
    writeFileSync(join(root, 'tests', name), passing(cases, 0));
  run('--update-floors', PATTERN);
  assert.deepEqual(readFloors(), {
    'tests/a.test.js': 0,
    'tests/b.test.js': 0,
  });
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
