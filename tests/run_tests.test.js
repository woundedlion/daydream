//
// scripts/run-tests.mjs is the `test` script: it runs the suite and gates each
// file against two committed floors, the cases it runs and the assertions those
// cases make. Driven as a subprocess with cwd set to a temp fixture holding its
// own package.json, floors and test files, so the counts under test are the
// fixture's and not this suite's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureRepo, expectFailure } from './fixture_repo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/run-tests.mjs');
const PATTERN = 'tests/*.test.js';
const FLOORS = 'tests/assertion-floors.json';
/** Fixture test files: cases declared per file, assertions run per case. */
const FILES = {
  'a.test.js': { cases: 2, asserts: 3 },
  'b.test.js': { cases: 1, asserts: 2 },
};

/** Writes the fixture package.json, which only has to mark the files ESM. */
const writePkg = () => {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ type: 'module' }, null, 2),
  );
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
 * Fixture test file source whose whole suite skips, as a platform-gated suite
 * does when its prerequisite is missing: the cases never run and the file
 * measures no assertions at all.
 * @param {number} cases - Cases the suite declares.
 * @param {number} asserts - Assertions each case would have run.
 * @returns {string} Module source.
 */
const skipping = (cases, asserts) =>
  [
    "import { describe, test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "describe('gated', { skip: 'no POSIX sh available' }, () => {",
  ]
    .concat(
      Array.from(
        { length: cases },
        (_, i) =>
          `test('case ${i}', () => {${' assert.ok(true);'.repeat(asserts)} });`,
      ),
    )
    .concat(['});'])
    .join('\n');

/**
 * Writes the fixture floors, merging overrides over the counts FILES describes.
 * An override of undefined drops the file's entry.
 * @param {Object} [overrides] - Entries replacing the defaults.
 */
const writeFloors = (overrides = {}) => {
  const floors = {};
  for (const [name, { cases, asserts }] of Object.entries(FILES))
    floors[`tests/${name}`] = { cases, assertions: cases * asserts };
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

const root = fixtureRepo('run-tests-', buildRoot);

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
const runExpectingFailure = (...args) =>
  expectFailure(process.execPath, [SCRIPT, ...args], { cwd: root, env });

/** Verifies a suite meeting both committed floors passes and reports them. */
test('a suite that meets the committed floors passes', () => {
  assert.match(
    run(PATTERN),
    /run-tests: \d+ tests passed, 8 assertions across 2 files, each above its committed floor/,
  );
});

/**
 * Verifies gutting a test file drops it below its case floor. A file with no
 * cases still scores the one pass node reports for the file itself, so the
 * count is one rather than zero.
 */
test('a test file gutted to a comment fails its case floor', () => {
  writeFileSync(join(root, 'tests', 'a.test.js'), '// TODO: re-enable\n');
  const err = runExpectingFailure(PATTERN);
  assert.match(
    err,
    /cases ran below the committed floor:\n {2}tests\/a\.test\.js: 1 ran, floor 2/,
  );
  assert.match(
    err,
    /assertions ran below the committed floor:\n {2}tests\/a\.test\.js: 0 ran, floor 6/,
  );
});

/** Verifies dropping one case of a file fails, not just emptying the file. */
test('a test file that lost a case fails its case floor', () => {
  writeFileSync(join(root, 'tests', 'a.test.js'), passing(1, 3));
  assert.match(
    runExpectingFailure(PATTERN),
    /cases ran below the committed floor:\n {2}tests\/a\.test\.js: 1 ran, floor 2/,
  );
});

/**
 * Verifies emptying every case body while leaving the shells fails — the hole
 * the case floors cannot see, since every shell still scores as a passing test.
 */
test('cases gutted to empty bodies fail the assertion floors', () => {
  for (const [name, { cases }] of Object.entries(FILES))
    writeFileSync(join(root, 'tests', name), passing(cases, 0));
  const err = runExpectingFailure(PATTERN);
  assert.doesNotMatch(err, /tests passed/);
  assert.doesNotMatch(err, /cases ran below/);
  assert.match(err, /tests\/a\.test\.js: 0 ran, floor 6/);
  assert.match(err, /tests\/b\.test\.js: 0 ran, floor 2/);
});

/** Verifies deleting a test file reports zero against both committed floors. */
test('a deleted test file falls below its floors', () => {
  rmSync(join(root, 'tests', 'a.test.js'));
  const err = runExpectingFailure(PATTERN);
  assert.match(
    err,
    /cases ran below the committed floor:\n {2}tests\/a\.test\.js: 0 ran, floor 2/,
  );
  assert.match(
    err,
    /assertions ran below the committed floor:\n {2}tests\/a\.test\.js: 0 ran, floor 6/,
  );
});

/**
 * Verifies a suite the platform cannot run is exempt from both floors: it
 * reported results, so unlike a deleted file it is still there, and a gated
 * suite runs nothing by design.
 */
test('a declared wholly skipped suite keeps its floors', () => {
  const { cases, asserts } = FILES['a.test.js'];
  writeFileSync(join(root, 'tests', 'a.test.js'), skipping(cases, asserts));
  writeFloors({
    'tests/a.test.js': { cases, assertions: cases * asserts, skippable: true },
  });
  const out = run(PATTERN);
  assert.match(out, /2 assertions across 2 files/);
  assert.match(out, /wholly skipped:\n {2}tests\/a\.test\.js/);
});

/**
 * Verifies the exemption is opt-in: an unconditional skip on a file whose
 * floors do not declare it retires the file from gating, so it fails instead.
 */
test('an undeclared wholly skipped suite fails', () => {
  const { cases, asserts } = FILES['a.test.js'];
  writeFileSync(join(root, 'tests', 'a.test.js'), skipping(cases, asserts));
  const err = runExpectingFailure(PATTERN);
  assert.match(
    err,
    /every result was a skip[^]*\n {2}tests\/a\.test\.js/,
  );
  assert.match(err, /"skippable": true/);
});

/** Verifies a declaration of the wrong type is refused as malformed. */
test('a non-boolean skippable declaration is malformed', () => {
  writeFloors({
    'tests/a.test.js': { cases: 2, assertions: 6, skippable: 'yes' },
  });
  const err = runExpectingFailure(PATTERN);
  assert.match(err, /tests\/a\.test\.js/);
});

/** Verifies one skipped case does not exempt the cases that did run. */
test('a partly skipped file still fails its floors', () => {
  writeFileSync(
    join(root, 'tests', 'a.test.js'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('gated', { skip: 'no POSIX sh' }, () => { assert.ok(true); });",
      "test('live', () => {});",
    ].join('\n'),
  );
  const err = runExpectingFailure(PATTERN);
  assert.match(err, /cases ran below[^]*tests\/a\.test\.js: 1 ran, floor 2/);
  assert.match(
    err,
    /assertions ran below[^]*tests\/a\.test\.js: 0 ran, floor 6/,
  );
});

/** Verifies re-measuring does not retire a skipped file's floors to zero. */
test('--update-floors keeps a wholly skipped floor', () => {
  writeFileSync(join(root, 'tests', 'a.test.js'), skipping(2, 3));
  writeFloors({
    'tests/a.test.js': { cases: 2, assertions: 6, skippable: true },
  });
  run('--update-floors', PATTERN);
  assert.deepEqual(readFloors(), {
    'tests/a.test.js': { cases: 2, assertions: 6, skippable: true },
    'tests/b.test.js': { cases: 1, assertions: 2 },
  });
});

/**
 * Verifies re-measuring on a machine that holds the prerequisite carries the
 * declaration over rather than stripping it from the file that ran.
 */
test('--update-floors keeps a skippable declaration on a file that ran', () => {
  writeFloors({
    'tests/a.test.js': { cases: 1, assertions: 1, skippable: true },
  });
  run('--update-floors', PATTERN);
  assert.deepEqual(readFloors(), {
    'tests/a.test.js': { cases: 2, assertions: 6, skippable: true },
    'tests/b.test.js': { cases: 1, assertions: 2 },
  });
});

/** Verifies a test file with no committed floors is refused, not defaulted. */
test('a test file with no committed floor fails', () => {
  writeFileSync(join(root, 'tests', 'c.test.js'), passing(1, 1));
  assert.match(
    runExpectingFailure(PATTERN),
    /no floors committed for:\n {2}tests\/c\.test\.js: \{"cases":1,"assertions":1\}/,
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

/** Verifies the pre-pair entry shape is refused rather than read as a floor. */
test('a bare number floor entry fails', () => {
  writeFloors({ 'tests/a.test.js': 6 });
  assert.match(runExpectingFailure(PATTERN), /pair of non-negative integers/);
});

/** Verifies half an entry is refused rather than defaulting the other half. */
test('a floor entry missing its case count fails', () => {
  writeFloors({ 'tests/a.test.js': { assertions: 6 } });
  assert.match(runExpectingFailure(PATTERN), /pair of non-negative integers/);
});

/** Verifies a non-integer floor is refused rather than compared loosely. */
test('a non-integer floor fails', () => {
  writeFloors({ 'tests/a.test.js': { cases: 2, assertions: '6' } });
  assert.match(runExpectingFailure(PATTERN), /pair of non-negative integers/);
});

/** Verifies re-measuring writes the counts actually run, one file at a time. */
test('--update-floors writes the measured counts', () => {
  writeFloors({ 'tests/a.test.js': { cases: 99, assertions: 999 } });
  assert.match(run('--update-floors', PATTERN), /wrote 2 floors/);
  assert.deepEqual(readFloors(), {
    'tests/a.test.js': { cases: 2, assertions: 6 },
    'tests/b.test.js': { cases: 1, assertions: 2 },
  });
  run(PATTERN);
});

/**
 * Verifies a re-measurement on a Node major other than the one CI measures on
 * is refused. node:test retallies cases across majors, so floors written there
 * are not reproducible and red CI on files nobody touched.
 */
test('--update-floors refuses a Node major CI does not measure on', () => {
  const pinNode = (version) => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'js-unit-suite.yml'),
      `jobs:\n  suite:\n    steps:\n      - with:\n          node-version: '${version}'\n`);
  };
  const major = Number(process.versions.node.split('.')[0]);

  pinNode(`${major - 1}.0.0`);
  assert.match(runExpectingFailure('--update-floors', PATTERN),
    new RegExp(`must run on Node ${major - 1}\\.x`));
  assert.deepEqual(readFloors()['tests/a.test.js'], { cases: 2, assertions: 6 },
    'a refused re-measurement must leave the committed floors alone');

  pinNode(`${major}.0.0`);
  assert.match(run('--update-floors', PATTERN), /wrote 2 floors/);
});

/**
 * Verifies a file that ran cases and measured no assertions is refused rather
 * than ratcheted: a floor of zero assertions gates nothing, and it is also what
 * a file asserting through the counter's blind spot measures.
 */
test('--update-floors refuses a file that counted no assertions', () => {
  writeFileSync(join(root, 'tests', 'a.test.js'), passing(2, 0));
  const err = runExpectingFailure('--update-floors', PATTERN);
  assert.match(err, /counted no assertions[^]*\n {2}tests\/a\.test\.js/);
  assert.doesNotMatch(err, /tests\/b\.test\.js/);
  assert.deepEqual(readFloors(), {
    'tests/a.test.js': { cases: 2, assertions: 6 },
    'tests/b.test.js': { cases: 1, assertions: 2 },
  });
});

/** Verifies the uncounted `assert(x)` call style is refused, not floored at zero. */
test('--update-floors refuses a file calling assert as a function', () => {
  writeFileSync(
    join(root, 'tests', 'a.test.js'),
    [
      "import { test } from 'node:test';",
      "import check from 'node:assert/strict';",
      "test('case 0', () => { check(true); check(1, 1); });",
      "test('case 1', () => { check(true); });",
    ].join('\n'),
  );
  assert.match(
    runExpectingFailure('--update-floors', PATTERN),
    /counted no assertions[^]*\n {2}tests\/a\.test\.js/,
  );
});

/**
 * Verifies cases above their floors are reported, and refused past the bound:
 * a floor left behind covers none of the cases that landed since, so those can
 * be deleted again without tripping the per-file floors.
 */
test('cases above the committed floors are reported and bounded', () => {
  writeFileSync(join(root, 'tests', 'a.test.js'), passing(4, 3));
  assert.match(run(PATTERN), /2 cases above their committed floors \(bound 64\)/);
  writeFileSync(join(root, 'tests', 'a.test.js'), passing(80, 3));
  const err = runExpectingFailure(PATTERN);
  assert.match(err, /78 cases above their committed floors, past the bound of 64/);
  assert.match(err, /tests\/a\.test\.js: 80 ran, floor 2/);
});

/** Verifies a pattern-less invocation is refused instead of walking the tree. */
test('no test pattern fails', () => {
  assert.match(runExpectingFailure(), /test file patterns/);
});

/**
 * Verifies a failing case still fails the run when every floor is met. The
 * injected file is floored too, so the child's exit status is the only reason
 * left for the run to fail: every gate of its own reports under a `run-tests:`
 * heading, and none is expected here.
 */
test('a failing test fails the run', () => {
  writeFileSync(
    join(root, 'tests', 'c.test.js'),
    "import { test } from 'node:test';\ntest('boom', () => { throw new Error('boom'); });\n",
  );
  writeFloors({ 'tests/c.test.js': { cases: 1, assertions: 0 } });
  const err = runExpectingFailure(PATTERN);
  assert.doesNotMatch(err, /^run-tests:/m,
    'the run failed on a gate of its own rather than on the failing case');
});
